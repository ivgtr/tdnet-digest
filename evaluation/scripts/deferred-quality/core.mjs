/** Offline only: no dotenv, provider client, dynamic imports, or network dependencies. */
import { createHash } from 'node:crypto';
import { mkdir, open, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

export const DIMENSIONS = [
  'sourceReading',
  'factualAccuracy',
  'reasoning',
  'usefulness',
  'uncertainty',
];
const HEX = /^[a-f0-9]{64}$/;
const ID = /^[a-z0-9][a-z0-9-]{0,99}$/;
const assert = (ok, message) => {
  if (!ok) throw new Error(message);
};
const object = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const finite = (x) => typeof x === 'number' && Number.isFinite(x) && x >= 0;
const exactKeys = (x, keys, name) => {
  assert(
    object(x) && Object.keys(x).every((k) => keys.includes(k)),
    `${name}: unknown field (do not include credentials)`
  );
};
export const canonical = (x) =>
  JSON.stringify(x, (_, value) =>
    object(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, value[key]])
        )
      : value
  );
export const sha256 = (x) =>
  createHash('sha256')
    .update(typeof x === 'string' || Buffer.isBuffer(x) ? x : canonical(x))
    .digest('hex');

/** Same public-source digest as vite.config.ts, without loading Vite or environment files. */
export async function buildDigest(directory) {
  const hash = createHash('sha256');
  for (const relative of ['src/lib', 'src/background', 'src/offscreen']) {
    const files = (await readdir(path.join(directory, relative)))
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .sort();
    for (const file of files)
      hash
        .update(`${relative}/${file}`)
        .update(await readFile(path.join(directory, relative, file)));
  }
  return hash.digest('hex');
}

export function freezePlan(config, corpus) {
  exactKeys(
    config,
    ['suite', 'caseIds', 'workflow', 'provider', 'model', 'repeats', 'variants', 'reservation'],
    'config'
  );
  assert(
    ['known-pilot', 'known-regression', 'holdout'].includes(config.suite),
    'Choose a bounded suite'
  );
  assert(config.repeats === 3, 'Exactly three fixed repeats are required; do not replace failures');
  assert(['summary', 'summary-and-analysis'].includes(config.workflow), 'Unknown workflow');
  assert(
    Array.isArray(config.caseIds) &&
      config.caseIds.length > 0 &&
      config.caseIds.length <= (config.suite === 'known-pilot' ? 2 : 4),
    'Select 1–2 pilot cases or at most 4 explicit regression/holdout cases'
  );
  assert(new Set(config.caseIds).size === config.caseIds.length, 'Duplicate case');
  assert(
    typeof config.provider === 'string' &&
      ID.test(config.provider) &&
      typeof config.model === 'string' &&
      config.model.length > 0 &&
      config.model.length < 160,
    'Explicit provider and exact model required'
  );
  exactKeys(config.variants, ['baseline', 'candidate'], 'variants');
  for (const name of ['baseline', 'candidate']) {
    const variant = config.variants[name];
    exactKeys(variant, ['revision', 'buildDigest', 'settings'], name);
    assert(
      /^[a-f0-9]{40}$/.test(variant.revision) && HEX.test(variant.buildDigest),
      `${name}: freeze revision and build digest before generation`
    );
    exactKeys(
      variant.settings,
      [
        'extractionMode',
        'temperature',
        'reasoningPolicy',
        'maxRequestsPerRun',
        'maxOutputTokensPerRequest',
        'maxTotalOutputTokens',
      ],
      `${name}.settings`
    );
    const settings = variant.settings;
    assert(
      settings.extractionMode === 'full' &&
        finite(settings.temperature) &&
        settings.temperature <= 2 &&
        typeof settings.reasoningPolicy === 'string' &&
        settings.reasoningPolicy.length > 0,
      'Freeze full extraction and generation settings'
    );
    for (const key of ['maxRequestsPerRun', 'maxOutputTokensPerRequest', 'maxTotalOutputTokens'])
      assert(Number.isSafeInteger(settings[key]) && settings[key] > 0, `Invalid ${key}`);
    assert(
      settings.maxRequestsPerRun <= 8 &&
        settings.maxTotalOutputTokens <= 262144 &&
        settings.maxOutputTokensPerRequest <= settings.maxTotalOutputTokens,
      'Unbounded request/output policy'
    );
  }
  assert(
    config.variants.baseline.buildDigest !== config.variants.candidate.buildDigest,
    'Baseline and candidate must be distinct frozen builds'
  );
  const cases = config.caseIds.map((id) => {
    const item = corpus.cases.find((c) => c.id === id);
    assert(
      item && ID.test(item.id) && HEX.test(item.pdfSha256),
      `Unknown case or missing PDF hash: ${id}`
    );
    assert(
      config.suite === 'holdout' ? item.role === 'holdout' : item.role === 'known',
      'Investigated cases cannot be relabeled as holdout'
    );
    assert(
      Array.isArray(item.checks) &&
        item.checks.length &&
        new Set(item.checks.map((c) => c.id)).size === item.checks.length,
      'Case needs unique independent checks'
    );
    assert(
      item.checks.every((c) => ID.test(c.id) && DIMENSIONS.includes(c.dimension)),
      'Invalid rubric dimension'
    );
    return structuredClone(item);
  });
  exactKeys(
    config.reservation,
    ['maxInputTokensPerRequest', 'inputUsdPerMillion', 'outputUsdPerMillion', 'approvedTotalUsd'],
    'reservation'
  );
  const reservation = config.reservation;
  assert(
    Number.isSafeInteger(reservation.maxInputTokensPerRequest) &&
      reservation.maxInputTokensPerRequest > 0,
    'A conservative input ceiling is required'
  );
  for (const key of ['inputUsdPerMillion', 'outputUsdPerMillion', 'approvedTotalUsd'])
    assert(reservation[key] === null || finite(reservation[key]), `Invalid ${key}`);
  const runs = cases.flatMap((item) =>
    [1, 2, 3].flatMap((repeat) =>
      ['baseline', 'candidate'].map((variant) => ({
        id: `${item.id}-${variant}-${repeat}`,
        caseId: item.id,
        variant,
        repeat,
      }))
    )
  );
  const maxApiRequests = runs.reduce(
    (sum, run) => sum + config.variants[run.variant].settings.maxRequestsPerRun,
    0
  );
  const maxOutputTokens = runs.reduce(
    (sum, run) => sum + config.variants[run.variant].settings.maxTotalOutputTokens,
    0
  );
  const estimatedReservationUsd =
    reservation.inputUsdPerMillion === null || reservation.outputUsdPerMillion === null
      ? null
      : Math.ceil(
          ((maxApiRequests * reservation.maxInputTokensPerRequest * reservation.inputUsdPerMillion +
            maxOutputTokens * reservation.outputUsdPerMillion) /
            1e6) *
            1.25 *
            1e6
        ) / 1e6;
  const body = {
    version: 1,
    mode: 'offline-manual-import',
    createdAt: new Date().toISOString(),
    ...structuredClone(config),
    cases,
    runs,
    settingsMatch:
      canonical(config.variants.baseline.settings) ===
      canonical(config.variants.candidate.settings),
    budget: {
      fullGenerations: runs.length,
      maxApiRequests,
      maxOutputTokens,
      estimatedReservationUsd,
      reservationSufficient:
        estimatedReservationUsd !== null &&
        reservation.approvedTotalUsd !== null &&
        reservation.approvedTotalUsd >= estimatedReservationUsd,
      safetyMargin: 1.25,
      enforcedByThisTool: false,
    },
    notice:
      'This tool never executes model requests. Manual settings are declarations, not verified request parameters. Approval and actual budget enforcement remain prerequisites for live testing.',
  };
  return { ...body, planHash: sha256(body) };
}

export function validatePlan(plan) {
  const { planHash, ...body } = plan;
  assert(
    HEX.test(planHash) && sha256(body) === planHash,
    'Plan was changed; create a new plan, do not replace old failures'
  );
  return plan;
}
export function findRun(plan, runId) {
  validatePlan(plan);
  const run = plan.runs.find((r) => r.id === runId);
  assert(run, 'Run is not in frozen plan');
  return run;
}
const nullableCount = (x) => x === null || (Number.isSafeInteger(x) && x >= 0);
function usageEntries(value) {
  const entries = Array.isArray(value)
    ? value
    : value === null || value === undefined
      ? []
      : [value];
  for (const u of entries)
    assert(
      object(u) &&
        nullableCount(u.inputTokens) &&
        nullableCount(u.outputTokens) &&
        finite(u.elapsedMs),
      'Malformed usage; unknown is null, never zero'
    );
  return entries.map((u) => ({
    inputTokens: u.inputTokens,
    outputTokens: u.outputTokens,
    elapsedMs: u.elapsedMs,
    finishReason: typeof u.finishReason === 'string' ? u.finishReason : null,
  }));
}

/** Accepts the actual "診断をコピー" SummaryTrace / AnalysisTrace v1 envelopes. */
export function normalizeDiagnostic(
  plan,
  runId,
  summary,
  analysis = null,
  evidenceKind = 'recorded-response'
) {
  const run = findRun(plan, runId);
  assert(['recorded-response', 'live-generation'].includes(evidenceKind), 'Unknown evidence kind');
  const item = plan.cases.find((c) => c.id === run.caseId);
  const variant = plan.variants[run.variant];
  assert(
    object(summary) && summary.version === 1 && !summary.stage && typeof summary.runId === 'string',
    'Expected copied summary diagnostic v1'
  );
  assert(
    ['running', 'firstSuccess', 'repairSuccess', 'partialSuccess', 'failure'].includes(
      summary.outcome
    ),
    'Unknown summary outcome'
  );
  const checkCommon = (trace, stage) => {
    assert(
      trace.provider === plan.provider && trace.model === plan.model,
      `${stage}: provider/model mismatch`
    );
    assert(trace.buildDigest === variant.buildDigest, `${stage}: frozen build mismatch`);
    assert(trace.pdfUrl === item.pdfUrl, `${stage}: PDF URL mismatch`);
    assert(finite(trace.elapsedMs), `${stage}: missing latency`);
  };
  checkCommon(summary, 'summary');
  if (evidenceKind === 'live-generation')
    assert(
      Number.isFinite(Date.parse(summary.startedAt)) &&
        Date.parse(summary.startedAt) >= Date.parse(plan.createdAt),
      'Live generation must start after the frozen plan; import older diagnostics as recorded-response'
    );
  assert(summary.extractionMode === variant.settings.extractionMode, 'Extraction setting mismatch');
  // Early extraction failures have no document hash. Retain failure but never certify source identity.
  assert(
    summary.documentHash === item.pdfSha256 ||
      (summary.outcome === 'failure' && summary.documentHash === null),
    'PDF SHA-256 mismatch'
  );
  assert(
    Array.isArray(summary.attempts) &&
      summary.attempts.every(
        (a) => object(a) && typeof a.phase === 'string' && typeof a.response === 'string'
      ),
    'Missing summary attempts'
  );
  if (analysis !== null) {
    assert(plan.workflow === 'summary-and-analysis', 'Unplanned additional analysis');
    assert(
      object(analysis) &&
        analysis.version === 1 &&
        analysis.stage === 'analysis' &&
        typeof analysis.runId === 'string',
      'Expected copied analysis diagnostic v1'
    );
    assert(
      ['running', 'success', 'partialSuccess', 'failure'].includes(analysis.outcome),
      'Unknown analysis outcome'
    );
    checkCommon(analysis, 'analysis');
    if (evidenceKind === 'live-generation')
      assert(
        Date.parse(analysis.startedAt) >= Date.parse(summary.startedAt),
        'Analysis timestamp precedes summary'
      );
    assert(
      summary.resultId && analysis.summaryResultId === summary.resultId,
      'Analysis belongs to another summary'
    );
  }
  const sumUsage = usageEntries(summary.usage);
  const analysisUsage = analysis ? usageEntries(analysis.usage) : [];
  const usage = [...sumUsage, ...analysisUsage];
  const requests = [
    ...summary.attempts.map((attempt, i) => ({
      stage: 'summary',
      ordinal: i + 1,
      phase: attempt.phase,
      response: attempt.response,
      error: typeof attempt.error === 'string' ? attempt.error : null,
      usage: sumUsage[i] ?? null,
    })),
    ...(analysis
      ? [
          {
            stage: 'analysis',
            ordinal: 1,
            phase: 'analysis',
            response: typeof analysis.response === 'string' ? analysis.response : null,
            error: typeof analysis.error?.message === 'string' ? analysis.error.message : null,
            usage: analysisUsage[0] ?? null,
          },
        ]
      : []),
  ];
  const status =
    summary.outcome === 'failure' || analysis?.outcome === 'failure'
      ? 'failure'
      : summary.outcome === 'running' || analysis?.outcome === 'running'
        ? 'interrupted'
        : plan.workflow === 'summary-and-analysis' && !analysis
          ? 'incomplete'
          : 'generated';
  const sumKnown = (key) => usage.reduce((sum, u) => sum + (u[key] ?? 0), 0);
  const accountingComplete =
    status === 'generated' &&
    sumUsage.length === summary.attempts.length &&
    (!analysis || analysisUsage.length === 1);
  const receipt = {
    version: 1,
    planHash: plan.planHash,
    ...run,
    status,
    evidenceKind,
    sourceIdentityVerified: summary.documentHash === item.pdfSha256,
    diagnosticIdentityHash: sha256([summary.runId, analysis?.runId ?? null]),
    summaryIdentityHash: sha256(summary.runId),
    analysisIdentityHash: analysis ? sha256(analysis.runId) : null,
    diagnosticHash: sha256({ summary, analysis }),
    provider: summary.provider,
    model: summary.model,
    buildDigest: summary.buildDigest,
    documentHash: summary.documentHash,
    inputHashes: { summary: summary.inputHash ?? null, analysis: analysis?.inputHash ?? null },
    partial: summary.outcome === 'partialSuccess' || analysis?.outcome === 'partialSuccess',
    compacted: !!summary.compaction || !!analysis?.compaction,
    summaryOutcome: summary.outcome,
    analysisOutcome: analysis?.outcome ?? null,
    requests,
    usage,
    apiRequestsObserved: usage.length,
    apiRequestAccountingComplete: accountingComplete,
    inputTokensKnown: sumKnown('inputTokens'),
    outputTokensKnown: sumKnown('outputTokens'),
    tokenAccountingComplete:
      accountingComplete && usage.every((u) => u.inputTokens !== null && u.outputTokens !== null),
    elapsedMs: summary.elapsedMs + (analysis?.elapsedMs ?? 0),
    errors: [summary.error, analysis?.error?.message].filter((e) => typeof e === 'string'),
    // Do not imply response presence means rendered content was correct.
    sourceInputs: {
      summary: summary.sourceFirst?.modelInput ?? null,
      analysis: analysis?.modelInput ?? analysis?.input ?? null,
    },
    contracts: {
      summary: summary.sourceFirst?.contract ?? null,
      analysis: analysis?.contract ?? null,
    },
    review: null,
  };
  return { ...receipt, recordHash: sha256(receipt) };
}

export function validateRecord(plan, record) {
  const run = findRun(plan, record.id);
  const { recordHash, ...body } = record;
  assert(
    HEX.test(recordHash) && sha256(body) === recordHash,
    'Record was changed; retain original checkpoint and use a separate review'
  );
  assert(
    record.planHash === plan.planHash &&
      ['caseId', 'variant', 'repeat'].every((key) => record[key] === run[key]),
    'Run identity mismatch'
  );
  return record;
}

export function reviewTemplate(plan, runId) {
  const run = findRun(plan, runId);
  const item = plan.cases.find((c) => c.id === run.caseId);
  return {
    version: 1,
    planHash: plan.planHash,
    runId,
    rendered: null,
    actualCostUsd: null,
    settingsAttested: false,
    checks: item.checks.map((c) => ({ id: c.id, result: 'unreviewed', evidence: '' })),
    notes: '',
  };
}
export function validateReview(plan, runId, review) {
  const template = reviewTemplate(plan, runId);
  exactKeys(
    review,
    [
      'version',
      'planHash',
      'runId',
      'rendered',
      'actualCostUsd',
      'settingsAttested',
      'checks',
      'notes',
    ],
    'review'
  );
  assert(
    review.version === 1 && review.planHash === plan.planHash && review.runId === runId,
    'Review identity mismatch'
  );
  assert(
    [null, true, false].includes(review.rendered) &&
      typeof review.settingsAttested === 'boolean' &&
      (review.actualCostUsd === null || finite(review.actualCostUsd)),
    'Invalid review status/cost'
  );
  assert(
    Array.isArray(review.checks) &&
      review.checks.length === template.checks.length &&
      new Set(review.checks.map((c) => c.id)).size === review.checks.length,
    'Review must retain every planned check'
  );
  for (const check of review.checks) {
    assert(
      template.checks.some((c) => c.id === check.id) &&
        ['pass', 'fail', 'unreviewed'].includes(check.result) &&
        typeof check.evidence === 'string',
      'Unknown check/result'
    );
    assert(
      check.result === 'unreviewed' || check.evidence.trim().length > 0,
      'Pass/fail needs source page and output evidence, not a bare verdict'
    );
  }
  return structuredClone(review);
}

/** Exclusive durable write: reruns cannot overwrite a failed attempt. */
export async function writeOnce(filename, value) {
  await mkdir(path.dirname(filename), { recursive: true });
  const file = await open(filename, 'wx', 0o600);
  try {
    await file.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await file.sync();
  } finally {
    await file.close();
  }
}
export async function importDiagnostic(
  plan,
  runId,
  summary,
  analysis,
  outDir,
  review = null,
  evidenceKind = 'recorded-response'
) {
  const receipt = normalizeDiagnostic(plan, runId, summary, analysis, evidenceKind);
  const directory = path.join(outDir, runId);
  // Complete request receipts are persisted BEFORE review/render handling.
  await writeOnce(path.join(directory, 'checkpoint.json'), receipt);
  for (let i = 0; i < receipt.requests.length; i++)
    await writeOnce(path.join(directory, `request-${i + 1}.json`), receipt.requests[i]);
  if (review) {
    receipt.review = validateReview(plan, runId, review);
    const { recordHash: _old, ...body } = receipt;
    receipt.recordHash = sha256(body);
  }
  await writeOnce(path.join(directory, 'record.json'), receipt);
  return receipt;
}

export function comparisonReport(plan, records, reviews = []) {
  validatePlan(plan);
  const seen = new Set();
  const byRun = new Map();
  for (const record of records) {
    validateRecord(plan, record);
    assert(
      record.planHash === plan.planHash && !byRun.has(record.id),
      'Duplicate or foreign run record'
    );
    for (const hash of [record.summaryIdentityHash, record.analysisIdentityHash].filter(Boolean)) {
      assert(!seen.has(hash), 'Same model generation reused as another repeat');
      seen.add(hash);
    }
    byRun.set(record.id, record);
  }
  const byReview = new Map();
  for (const review of reviews) {
    validateReview(plan, review.runId, review);
    assert(!byReview.has(review.runId), 'Duplicate review');
    byReview.set(review.runId, review);
  }
  const rows = plan.runs.map((run) => {
    const record = byRun.get(run.id);
    const review = byReview.get(run.id) ?? record?.review ?? null;
    if (review) validateReview(plan, run.id, review);
    const item = plan.cases.find((c) => c.id === run.caseId);
    const eligible =
      record?.status === 'generated' &&
      record.evidenceKind === 'live-generation' &&
      record.sourceIdentityVerified &&
      !record.compacted &&
      review?.rendered === true;
    return {
      ...run,
      status: record?.status ?? 'unrun',
      evidenceKind: record?.evidenceKind ?? null,
      partial: record?.partial ?? false,
      rendered: review?.rendered ?? null,
      compacted: record?.compacted ?? false,
      sourceIdentityVerified: record?.sourceIdentityVerified ?? false,
      settingsAttested: review?.settingsAttested ?? false,
      recordedGenerationPolicies: {
        summary: record?.contracts?.summary?.generation ?? null,
        analysis: record?.contracts?.analysis?.generation ?? null,
      },
      actualTemperatureAndReasoning: 'unknown (not recorded by these diagnostic envelopes)',
      apiRequestsObserved: record?.apiRequestsObserved ?? 0,
      apiRequestAccountingComplete: record?.apiRequestAccountingComplete ?? false,
      inputTokensKnown: record?.inputTokensKnown ?? 0,
      outputTokensKnown: record?.outputTokensKnown ?? 0,
      tokenAccountingComplete: record?.tokenAccountingComplete ?? false,
      actualCostUsd: review?.actualCostUsd ?? null,
      elapsedMs: record?.elapsedMs ?? null,
      checks: item.checks.map((check) => ({
        id: check.id,
        dimension: check.dimension,
        result: eligible
          ? (review?.checks.find((c) => c.id === check.id)?.result ?? 'unreviewed')
          : 'unreviewed',
      })),
    };
  });
  const variants = Object.fromEntries(
    ['baseline', 'candidate'].map((name) => {
      const own = rows.filter((r) => r.variant === name);
      const dimensions = Object.fromEntries(
        DIMENSIONS.map((dimension) => {
          const checks = own.flatMap((r) => r.checks.filter((c) => c.dimension === dimension));
          const pass = checks.filter((c) => c.result === 'pass').length;
          return [
            dimension,
            {
              pass,
              fail: checks.filter((c) => c.result === 'fail').length,
              unreviewed: checks.filter((c) => c.result === 'unreviewed').length,
              denominator: checks.length,
              passRateOverPlanned: checks.length ? pass / checks.length : null,
            },
          ];
        })
      );
      return [
        name,
        {
          declaredRequestPolicy: plan.variants[name].settings,
          planned: own.length,
          generated: own.filter((r) => r.status === 'generated').length,
          liveGenerations: own.filter((r) => r.evidenceKind === 'live-generation').length,
          recordedResponses: own.filter((r) => r.evidenceKind === 'recorded-response').length,
          failures: own.filter((r) => ['failure', 'interrupted', 'incomplete'].includes(r.status))
            .length,
          unrun: own.filter((r) => r.status === 'unrun').length,
          renderFailures: own.filter((r) => r.rendered === false).length,
          partial: own.filter((r) => r.partial).length,
          dimensions,
          apiRequestsObserved: own.reduce((n, r) => n + r.apiRequestsObserved, 0),
          inputTokensKnown: own.reduce((n, r) => n + r.inputTokensKnown, 0),
          outputTokensKnown: own.reduce((n, r) => n + r.outputTokensKnown, 0),
          actualCostUsdKnown: own.reduce((n, r) => n + (r.actualCostUsd ?? 0), 0),
          runsMissingCost: own.filter((r) => r.actualCostUsd === null).length,
          elapsedMsByRun: own.map((r) => r.elapsedMs),
        },
      ];
    })
  );
  return {
    version: 1,
    planHash: plan.planHash,
    suite: plan.suite,
    workflow: plan.workflow,
    fullGenerationsPlanned: rows.length,
    settingsMatch: plan.settingsMatch,
    comparisonConditions: plan.settingsMatch
      ? 'settings declared equal; actual per-request settings require separate verification'
      : 'product-path comparison; generation settings/output policies differ',
    allSettingsAttested: rows.every((r) => r.settingsAttested),
    rows,
    variants,
    conclusion:
      'No automatic quality certification. Fixed replay, source retention and parser tests do not measure future model quality. Errors, interrupted and unrun cases remain in the planned denominator.',
  };
}
