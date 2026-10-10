import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  freezePlan,
  validatePlan,
  normalizeDiagnostic,
  importDiagnostic,
  reviewTemplate,
  comparisonReport,
  sha256,
  buildDigest,
} from './core.mjs';
import { parseArgs } from '../deferred-quality.mjs';

const corpus = JSON.parse(
  await readFile(new URL('../../fixtures/source-first-quality-cases.json', import.meta.url), 'utf8')
);
const sample = JSON.parse(
  await readFile(
    new URL('../../fixtures/source-first-quality-plan.example.json', import.meta.url),
    'utf8'
  )
);
function config() {
  const copy = structuredClone(sample);
  copy.variants.baseline.buildDigest = 'a'.repeat(64);
  copy.variants.candidate.buildDigest = 'b'.repeat(64);
  copy.variants.candidate.revision = 'b'.repeat(40);
  return copy;
}
function diagnostics(plan, run, overrides = {}) {
  const item = plan.cases.find((c) => c.id === run.caseId);
  const summary = {
    version: 1,
    runId: `synthetic-summary-${run.id}`,
    resultId: `synthetic-result-${run.id}`,
    startedAt: new Date().toISOString(),
    pdfUrl: item.pdfUrl,
    documentType: 'earnings',
    provider: plan.provider,
    model: plan.model,
    extractionMode: 'full',
    fingerprint: 'synthetic',
    buildDigest: plan.variants[run.variant].buildDigest,
    documentHash: item.pdfSha256,
    inputHash: 'c'.repeat(64),
    selectedPages: [1],
    attempts: [{ phase: 'summary', response: '{"synthetic":true}', error: null }],
    usage: [{ inputTokens: 10, outputTokens: 20, elapsedMs: 30 }],
    elapsedMs: 50,
    outcome: 'firstSuccess',
    error: null,
    ...overrides,
  };
  const analysis = {
    version: 1,
    stage: 'analysis',
    runId: `synthetic-analysis-${run.id}`,
    summaryResultId: summary.resultId,
    startedAt: summary.startedAt,
    pdfUrl: item.pdfUrl,
    provider: plan.provider,
    model: plan.model,
    buildDigest: summary.buildDigest,
    inputHash: 'd'.repeat(64),
    input: null,
    contract: null,
    response: '{"synthetic":true}',
    usage: { inputTokens: 7, outputTokens: 8, elapsedMs: 9 },
    outcome: 'success',
    error: null,
    elapsedMs: 15,
  };
  return { summary, analysis };
}

test('plan freezes three repeats and distinguishes full generations, API reservations and unmatched settings', () => {
  const plan = freezePlan(config(), corpus);
  assert.equal(plan.runs.length, 6);
  assert.equal(plan.budget.fullGenerations, 6);
  assert.equal(plan.budget.maxApiRequests, 21);
  assert.equal(plan.settingsMatch, false);
  assert.equal(plan.budget.estimatedReservationUsd, null);
  assert.equal(plan.budget.reservationSufficient, false);
  const priced = config();
  Object.assign(priced.reservation, {
    inputUsdPerMillion: 1,
    outputUsdPerMillion: 2,
    approvedTotalUsd: 1,
  });
  const cost = freezePlan(priced, corpus);
  assert(cost.budget.estimatedReservationUsd > 1);
  assert.equal(cost.budget.reservationSufficient, false);
  const tampered = structuredClone(plan);
  tampered.model = 'another-model';
  assert.throws(() => validatePlan(tampered), /changed/);
  assert.throws(() => freezePlan({ ...config(), repeats: 1 }, corpus), /three/);
  assert.throws(() => freezePlan({ ...config(), suite: 'holdout' }, corpus), /holdout/);
  assert.throws(() => freezePlan({ ...config(), apiKey: 'TEST_ONLY' }, corpus), /unknown field/);
});

test('real diagnostic envelopes require same PDF, model, build and matching summary-analysis pair', () => {
  const plan = freezePlan(config(), corpus);
  const run = plan.runs[0];
  const { summary, analysis } = diagnostics(plan, run);
  const receipt = normalizeDiagnostic(plan, run.id, summary, analysis);
  assert.equal(receipt.status, 'generated');
  assert.equal(receipt.apiRequestsObserved, 2);
  assert.equal(receipt.inputTokensKnown, 17);
  assert.equal(receipt.elapsedMs, 65);
  assert.equal(JSON.stringify(receipt).includes(summary.runId), false);
  for (const [key, value] of [
    ['documentHash', 'f'.repeat(64)],
    ['model', 'other'],
    ['buildDigest', 'e'.repeat(64)],
  ])
    assert.throws(
      () => normalizeDiagnostic(plan, run.id, { ...summary, [key]: value }, analysis),
      /mismatch/
    );
  assert.throws(
    () => normalizeDiagnostic(plan, run.id, summary, { ...analysis, summaryResultId: 'unrelated' }),
    /another summary/
  );
  assert.equal(normalizeDiagnostic(plan, run.id, summary).status, 'incomplete');
  const failure = normalizeDiagnostic(plan, run.id, {
    ...summary,
    outcome: 'failure',
    documentHash: null,
    attempts: [],
    usage: [],
  });
  assert.equal(failure.status, 'failure');
  assert.equal(failure.sourceIdentityVerified, false);
});

test('failed downstream review leaves durable request checkpoints; duplicate import cannot overwrite them', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'tdnet-quality-'));
  const plan = freezePlan(config(), corpus);
  const run = plan.runs[0];
  const { summary, analysis } = diagnostics(plan, run);
  const badReview = reviewTemplate(plan, run.id);
  badReview.checks[0].result = 'pass';
  await assert.rejects(
    importDiagnostic(plan, run.id, summary, analysis, directory, badReview),
    /needs source/
  );
  const checkpoint = JSON.parse(
    await readFile(path.join(directory, run.id, 'checkpoint.json'), 'utf8')
  );
  assert.equal(checkpoint.requests.length, 2);
  assert.equal(
    JSON.parse(await readFile(path.join(directory, run.id, 'request-1.json'), 'utf8')).response,
    summary.attempts[0].response
  );
  await assert.rejects(importDiagnostic(plan, run.id, summary, analysis, directory), /EEXIST/);
  assert.equal(comparisonReport(plan, [checkpoint]).variants.baseline.generated, 1);
});

test('failures, render failures and unrun repeats remain denominators; evidence/cost/latency are separate', () => {
  const plan = freezePlan(config(), corpus);
  const goodRun = plan.runs[0];
  const errorRun = plan.runs[1];
  const good = diagnostics(plan, goodRun);
  const bad = diagnostics(plan, errorRun, { outcome: 'failure', error: 'synthetic API failure' });
  const receipt = normalizeDiagnostic(
    plan,
    goodRun.id,
    good.summary,
    good.analysis,
    'live-generation'
  );
  const failure = normalizeDiagnostic(plan, errorRun.id, bad.summary);
  const review = reviewTemplate(plan, goodRun.id);
  review.rendered = true;
  review.settingsAttested = true;
  review.checks = review.checks.map((c) => ({
    ...c,
    result: 'pass',
    evidence: 'Synthetic test only: physical p1 / output paragraph 1',
  }));
  const report = comparisonReport(plan, [receipt, failure], [review]);
  assert.equal(report.variants.baseline.planned, 3);
  assert.equal(report.variants.baseline.unrun, 2);
  assert.equal(report.variants.candidate.failures, 1);
  assert.equal(report.variants.candidate.unrun, 2);
  assert.equal(report.variants.baseline.dimensions.factualAccuracy.passRateOverPlanned, 1 / 3);
  const replay = normalizeDiagnostic(plan, goodRun.id, good.summary, good.analysis);
  assert.equal(
    comparisonReport(plan, [replay], [review]).variants.baseline.dimensions.factualAccuracy.pass,
    0
  );
  assert.throws(
    () =>
      normalizeDiagnostic(
        plan,
        goodRun.id,
        { ...good.summary, startedAt: '2020-01-01T00:00:00Z' },
        good.analysis,
        'live-generation'
      ),
    /after the frozen plan/
  );
  assert.equal(report.variants.candidate.dimensions.factualAccuracy.passRateOverPlanned, 0);
  assert.equal(report.variants.baseline.actualCostUsdKnown, 0);
  assert.equal(report.variants.baseline.runsMissingCost, 3);
  assert.deepEqual(report.variants.baseline.elapsedMsByRun, [65, null, null]);
  review.rendered = false;
  const renderFailed = comparisonReport(plan, [receipt], [review]);
  assert.equal(renderFailed.variants.baseline.renderFailures, 1);
  assert.equal(renderFailed.variants.baseline.dimensions.factualAccuracy.pass, 0);
  assert.equal(renderFailed.variants.baseline.apiRequestsObserved, 2);
  const changed = structuredClone(receipt);
  changed.status = 'failure';
  assert.throws(() => comparisonReport(plan, [changed]), /Record was changed/);
});

test('unknown token usage is not zero cost; compaction and duplicate/cached outputs do not become fresh quality evidence', () => {
  const plan = freezePlan(config(), corpus);
  const run = plan.runs[0];
  const { summary, analysis } = diagnostics(plan, run, {
    compaction: { reason: 'storage-limit', originalBytes: 300000 },
    usage: [{ inputTokens: null, outputTokens: null, elapsedMs: 30 }],
  });
  const record = normalizeDiagnostic(plan, run.id, summary, analysis);
  assert.equal(record.tokenAccountingComplete, false);
  const next = plan.runs[2];
  const duplicate = normalizeDiagnostic(plan, next.id, summary, analysis);
  assert.throws(() => comparisonReport(plan, [record, duplicate]), /reused/);
  const review = reviewTemplate(plan, run.id);
  review.rendered = true;
  review.checks = review.checks.map((c) => ({
    ...c,
    result: 'pass',
    evidence: 'Synthetic response',
  }));
  assert.equal(
    comparisonReport(plan, [record], [review]).variants.baseline.dimensions.factualAccuracy.pass,
    0
  );
});

test('CLI is offline with network poisoned and keys present; live/blanket/unknown options fail closed', async () => {
  assert.equal(parseArgs([]).command, 'help');
  assert.throws(() => parseArgs(['--execute']), /no live/);
  assert.throws(() => parseArgs(['plan', '--execute', 'true']), /Unknown/);
  const directory = await mkdtemp(path.join(tmpdir(), 'tdnet-offline-'));
  const guard = path.join(directory, 'guard.mjs');
  await writeFile(
    guard,
    `import http from 'node:http'; import https from 'node:https'; import net from 'node:net';
    const fail = () => { throw new Error('NETWORK_FORBIDDEN'); };
    globalThis.fetch = fail; http.request = fail; http.get = fail; https.request = fail; https.get = fail; net.connect = fail; net.createConnection = fail;`
  );
  const cli = fileURLToPath(new URL('../deferred-quality.mjs', import.meta.url));
  const env = {
    ...process.env,
    OPENROUTER_API_KEY: 'TEST_NOT_A_CREDENTIAL',
    TDNET_DIGEST_API_KEY: 'TEST_NOT_A_CREDENTIAL',
  };
  const result = spawnSync(process.execPath, ['--import', guard, cli], {
    cwd: directory,
    env,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /no API requests/);
  const blocked = spawnSync(
    process.execPath,
    ['--import', guard, cli, 'plan', '--execute', 'true'],
    { cwd: directory, env, encoding: 'utf8' }
  );
  assert.equal(blocked.status, 1);
  // Small synthetic PDF only tests identity/planning I/O, not extraction or quality.
  const bytes = Buffer.from('%PDF-synthetic-offline-test');
  const fixture = structuredClone(corpus);
  fixture.cases[0].pdfSha256 = sha256(bytes);
  await writeFile(path.join(directory, 'cases.json'), JSON.stringify(fixture));
  await writeFile(path.join(directory, `${fixture.cases[0].id}.pdf`), bytes);
  await writeFile(path.join(directory, 'config.json'), JSON.stringify(config()));
  const planFile = path.join(directory, 'plan.json');
  const planned = spawnSync(
    process.execPath,
    [
      '--import',
      guard,
      cli,
      'plan',
      '--config',
      path.join(directory, 'config.json'),
      '--pdf-dir',
      directory,
      '--cases',
      path.join(directory, 'cases.json'),
      '--out',
      planFile,
    ],
    { cwd: directory, env, encoding: 'utf8' }
  );
  assert.equal(planned.status, 0, planned.stderr);
  assert.equal(JSON.parse(await readFile(planFile, 'utf8')).runs.length, 6);
  const frozen = JSON.parse(await readFile(planFile, 'utf8'));
  const copied = diagnostics(frozen, frozen.runs[0]);
  await writeFile(path.join(directory, 'summary.json'), JSON.stringify(copied.summary));
  await writeFile(path.join(directory, 'analysis.json'), JSON.stringify(copied.analysis));
  const offlineCLI = (args) => {
    const execution = spawnSync(process.execPath, ['--import', guard, cli, ...args], {
      cwd: directory,
      env,
      encoding: 'utf8',
    });
    assert.equal(execution.status, 0, execution.stderr);
  };
  offlineCLI([
    'import',
    '--plan',
    planFile,
    '--run',
    frozen.runs[0].id,
    '--summary',
    path.join(directory, 'summary.json'),
    '--analysis',
    path.join(directory, 'analysis.json'),
    '--out',
    path.join(directory, 'records'),
  ]);
  offlineCLI([
    'review-template',
    '--plan',
    planFile,
    '--run',
    frozen.runs[0].id,
    '--out',
    path.join(directory, 'reviews', 'one.json'),
  ]);
  offlineCLI([
    'report',
    '--plan',
    planFile,
    '--records',
    path.join(directory, 'records'),
    '--reviews',
    path.join(directory, 'reviews'),
    '--out',
    path.join(directory, 'report.json'),
  ]);
  const compared = JSON.parse(await readFile(path.join(directory, 'report.json'), 'utf8'));
  assert.equal(compared.variants.baseline.recordedResponses, 1);
  assert.equal(compared.variants.baseline.unrun, 2);
  const checkout = path.join(directory, 'checkout');
  for (const relative of ['src/lib', 'src/background', 'src/offscreen']) {
    await mkdir(path.join(checkout, relative), { recursive: true });
    await writeFile(path.join(checkout, relative, 'index.ts'), '// public source');
  }
  await writeFile(path.join(checkout, '.env'), 'PRIVATE_MUST_NOT_BE_READ');
  const before = await buildDigest(checkout);
  await writeFile(path.join(checkout, '.env'), 'DIFFERENT_PRIVATE_VALUE');
  assert.equal(await buildDigest(checkout), before);
});
