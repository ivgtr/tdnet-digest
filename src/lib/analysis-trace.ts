import type { AnalysisNotice } from './additional-analysis';
import type { AnalysisInput } from './analysis-input';
import { projectSourceModelInput } from './source-ledger';
import { exact, record } from './fact-contract';
import { normalizeTdnetPdfUrl } from './tdnet-url';
import type { DiagnosticPersistence, Usage } from './summary-trace';

// Envelope v1 is retained: contract.version identifies generation semantics.
// partialSuccess and optional notices/resourceLimits extend v1; legacy records remain readable.
export const ANALYSIS_DIAGNOSTICS_KEY = 'analysisDiagnosticsV1';
export const ANALYSIS_CACHE_DIAGNOSTIC_PREFIX = 'analysisDiagnosticRefV1:';
export const ANALYSIS_DIAGNOSTICS_LIMITS = {
  records: 12,
  bytes: 1024 * 1024,
  recordBytes: 256 * 1024,
} as const;
export interface AnalysisDiagnosticError {
  code: string;
  path: string;
  message: string;
}
export interface AnalysisDiagnosticContract {
  version: number;
  allowedEvidenceIds: string[];
  limits: { issues: number; references: number; title: number; text: number };
  inputBudget?: { characters: number; bytes: number; characterLimit: number; byteLimit: number };
  resourceLimits?: {
    responseBytes: number;
    savedBytes: number;
    issues: number;
    text: number;
    references: number;
    depth: number;
    nodes: number;
    savedNodes: number;
  };
}
export interface AnalysisGenerationDiagnostic {
  contract: AnalysisDiagnosticContract;
  input: AnalysisInput;
  response: string | null;
  usage: Usage | null;
  outcome: 'running' | 'success' | 'partialSuccess' | 'failure';
  notices?: AnalysisNotice[];
  error: AnalysisDiagnosticError | null;
}
export interface AnalysisTrace {
  version: 1;
  stage: 'analysis';
  runId: string;
  summaryResultId: string;
  startedAt: string;
  intentAt: number;
  pdfUrl: string;
  provider: string | null;
  model: string | null;
  buildDigest: string;
  fingerprint: string;
  inputHash: string | null;
  input: AnalysisInput | null;
  contract: AnalysisDiagnosticContract | null;
  response: string | null;
  usage: Usage | null;
  outcome: AnalysisGenerationDiagnostic['outcome'];
  notices?: AnalysisNotice[];
  error: AnalysisDiagnosticError | null;
  elapsedMs: number;
  compaction?: { reason: 'storage-limit'; originalBytes: number };
}
export interface AnalysisDiagnosticReference {
  runId: string;
  summaryResultId: string;
  inputHash: string;
  persistence: DiagnosticPersistence;
}
export interface AnalysisLastAttempt extends AnalysisDiagnosticReference {
  version: 1;
  pdfUrl: string;
  intentAt: number;
  outcome: AnalysisGenerationDiagnostic['outcome'];
  error: AnalysisDiagnosticError | null;
}
interface AnalysisDiagnosticStore {
  version: 1;
  traces: AnalysisTrace[];
  lastAttempts: AnalysisLastAttempt[];
}
let lastIntentAt = 0;
/** Ordered when a request is accepted, never when its slow response arrives. */
export function nextAnalysisIntentAt(): number {
  lastIntentAt = Math.max(Date.now(), lastIntentAt + 0.001);
  return lastIntentAt;
}
const unavailable =
  'この追加分析に対応する診断がありません。保存上限で削除されたか、保存されていません';
const nullableString = (value: unknown) => value === null || typeof value === 'string';
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
const resourceKeys = [
  'responseBytes',
  'savedBytes',
  'issues',
  'text',
  'references',
  'depth',
  'nodes',
  'savedNodes',
] as const;
function validNotices(value: unknown): value is AnalysisNotice[] {
  return (
    Array.isArray(value) &&
    value.length <= 1024 &&
    value.every(
      (notice) =>
        record(notice) &&
        exact(notice, ['issueIndex', 'code', 'path', 'message', 'severity']) &&
        Number.isInteger(notice.issueIndex) &&
        Number(notice.issueIndex) >= -1 &&
        Number(notice.issueIndex) < 16 &&
        ['warning', 'quarantined'].includes(String(notice.severity)) &&
        typeof notice.code === 'string' &&
        notice.code.length > 0 &&
        notice.code.length <= 128 &&
        typeof notice.path === 'string' &&
        notice.path.length > 0 &&
        notice.path.length <= 256 &&
        typeof notice.message === 'string' &&
        notice.message.length > 0 &&
        notice.message.length <= 1024
    )
  );
}
function isTrace(value: unknown): value is AnalysisTrace {
  return (
    record(value) &&
    value.version === 1 &&
    value.stage === 'analysis' &&
    ['runId', 'summaryResultId', 'startedAt', 'pdfUrl', 'buildDigest', 'fingerprint'].every(
      (key) => typeof value[key] === 'string' && value[key].length > 0
    ) &&
    ['provider', 'model', 'inputHash', 'response'].every((key) => nullableString(value[key])) &&
    ['running', 'success', 'partialSuccess', 'failure'].includes(String(value.outcome)) &&
    (value.notices === undefined || validNotices(value.notices)) &&
    typeof value.intentAt === 'number' &&
    Number.isFinite(value.intentAt) &&
    typeof value.elapsedMs === 'number' &&
    Number.isFinite(value.elapsedMs) &&
    (value.contract === null ||
      (record(value.contract) &&
        typeof value.contract.version === 'number' &&
        Array.isArray(value.contract.allowedEvidenceIds) &&
        value.contract.allowedEvidenceIds.every((id) => typeof id === 'string') &&
        (value.contract.resourceLimits === undefined ||
          (record(value.contract.resourceLimits) &&
            exact(value.contract.resourceLimits, [...resourceKeys]) &&
            resourceKeys.every((key) => {
              const limit = (value.contract as AnalysisDiagnosticContract).resourceLimits![key];
              return Number.isSafeInteger(limit) && limit > 0;
            }))) &&
        record(value.contract.limits) &&
        ['issues', 'references', 'title', 'text'].every(
          (key) =>
            typeof (value.contract as { limits: Record<string, unknown> }).limits[key] === 'number'
        ))) &&
    (value.input === null ||
      (record(value.input) &&
        value.input.inputHash === value.inputHash &&
        Array.isArray(value.input.evidence) &&
        record(value.input.coverage))) &&
    (value.error === null ||
      (record(value.error) &&
        ['code', 'path', 'message'].every(
          (key) =>
            typeof value.error === 'object' &&
            value.error !== null &&
            typeof (value.error as Record<string, unknown>)[key] === 'string'
        ))) &&
    (value.usage === null ||
      (record(value.usage) &&
        [value.usage.inputTokens, value.usage.outputTokens, value.usage.elapsedMs].every(
          (n) => n === null || (typeof n === 'number' && Number.isFinite(n))
        )))
  );
}
function isLastAttempt(value: unknown): value is AnalysisLastAttempt {
  return (
    record(value) &&
    exact(value, [
      'version',
      'runId',
      'summaryResultId',
      'inputHash',
      'persistence',
      'pdfUrl',
      'intentAt',
      'outcome',
      'error',
    ]) &&
    value.version === 1 &&
    ['runId', 'summaryResultId', 'inputHash', 'pdfUrl'].every(
      (key) => typeof value[key] === 'string' && value[key].length > 0
    ) &&
    value.persistence === 'saved' &&
    typeof value.intentAt === 'number' &&
    Number.isFinite(value.intentAt) &&
    ['running', 'success', 'partialSuccess', 'failure'].includes(String(value.outcome)) &&
    (value.error === null ||
      (record(value.error) &&
        exact(value.error, ['code', 'path', 'message']) &&
        Object.values(value.error).every((part) => typeof part === 'string')))
  );
}
function readStore(value: unknown): AnalysisDiagnosticStore {
  if (value === undefined) return { version: 1, traces: [], lastAttempts: [] };
  if (
    !record(value) ||
    !exact(value, ['version', 'traces', 'lastAttempts']) ||
    value.version !== 1 ||
    !Array.isArray(value.traces) ||
    !value.traces.every(isTrace) ||
    !Array.isArray(value.lastAttempts) ||
    !value.lastAttempts.every(isLastAttempt)
  )
    throw new Error('保存された追加分析診断の形式が不正です');
  return { version: 1, traces: value.traces, lastAttempts: value.lastAttempts };
}
/** Allow-listed projection, never config, endpoint, headers or credentials. */
function snapshot(trace: AnalysisTrace): AnalysisTrace {
  const notices = trace.notices?.map((notice) => ({
    issueIndex: notice.issueIndex,
    code: notice.code,
    path: notice.path,
    message: notice.message,
    severity: notice.severity,
  }));
  if (notices !== undefined && !validNotices(notices))
    throw new Error('追加分析診断の通知形式が不正です');
  const input = trace.input;
  return {
    version: 1,
    stage: 'analysis',
    runId: trace.runId,
    summaryResultId: trace.summaryResultId,
    startedAt: trace.startedAt,
    intentAt: trace.intentAt,
    pdfUrl: trace.pdfUrl,
    provider: trace.provider,
    model: trace.model,
    buildDigest: trace.buildDigest,
    fingerprint: trace.fingerprint,
    inputHash: trace.inputHash,
    input: input
      ? {
          documentType: input.documentType,
          inputHash: input.inputHash,
          evidence: input.evidence.map((e) => ({
            id: e.id,
            kind: e.kind,
            text: e.text,
            context: e.context,
            sourceIds: [...e.sourceIds],
            pages: [...e.pages],
          })),
          ...(input.sourceDocument
            ? { sourceDocument: projectSourceModelInput(input.sourceDocument) }
            : {}),
          coverage: {
            facts: input.coverage.facts,
            explanations: input.coverage.explanations,
            observations: input.coverage.observations,
            calculations: input.coverage.calculations,
            pages: [...input.coverage.pages],
            organizationStatus: input.coverage.organizationStatus,
            unresolvedSources: input.coverage.unresolvedSources,
            unverifiedFacts: input.coverage.unverifiedFacts,
            unverifiedItems: input.coverage.unverifiedItems,
            unverifiedSourcePages: [...input.coverage.unverifiedSourcePages],
            limitations: [...input.coverage.limitations],
            ...(input.coverage.sourceLedger
              ? {
                  sourceLedger: {
                    sourceHash: input.coverage.sourceLedger.sourceHash,
                    pages: [...input.coverage.sourceLedger.pages],
                    failedPages: [...input.coverage.sourceLedger.failedPages],
                    emptyPages: [...input.coverage.sourceLedger.emptyPages],
                    omittedPages: [...input.coverage.sourceLedger.omittedPages],
                    rows: input.coverage.sourceLedger.rows,
                    spans: input.coverage.sourceLedger.spans,
                    status: input.coverage.sourceLedger.status,
                  },
                }
              : {}),
          },
        }
      : null,
    contract: trace.contract
      ? {
          version: trace.contract.version,
          ...(trace.contract.inputBudget
            ? {
                inputBudget: {
                  characters: trace.contract.inputBudget.characters,
                  bytes: trace.contract.inputBudget.bytes,
                  characterLimit: trace.contract.inputBudget.characterLimit,
                  byteLimit: trace.contract.inputBudget.byteLimit,
                },
              }
            : {}),
          ...(trace.contract.resourceLimits
            ? {
                resourceLimits: Object.fromEntries(
                  resourceKeys.map((key) => [key, trace.contract!.resourceLimits![key]])
                ) as NonNullable<AnalysisDiagnosticContract['resourceLimits']>,
              }
            : {}),
          allowedEvidenceIds: [...trace.contract.allowedEvidenceIds],
          limits: {
            issues: trace.contract.limits.issues,
            references: trace.contract.limits.references,
            title: trace.contract.limits.title,
            text: trace.contract.limits.text,
          },
        }
      : null,
    response: trace.response,
    usage: trace.usage
      ? {
          inputTokens: trace.usage.inputTokens,
          outputTokens: trace.usage.outputTokens,
          elapsedMs: trace.usage.elapsedMs,
          ...(trace.usage.finishReason !== undefined
            ? { finishReason: trace.usage.finishReason }
            : {}),
          ...(trace.usage.reasoningTokens !== undefined
            ? { reasoningTokens: trace.usage.reasoningTokens }
            : {}),
        }
      : null,
    outcome: trace.outcome,
    ...(notices !== undefined ? { notices } : {}),
    error: trace.error
      ? { code: trace.error.code, path: trace.error.path, message: trace.error.message }
      : null,
    elapsedMs: trace.elapsedMs,
    ...(trace.compaction
      ? {
          compaction: {
            reason: 'storage-limit' as const,
            originalBytes: trace.compaction.originalBytes,
          },
        }
      : {}),
  };
}
function boundedTrace(trace: AnalysisTrace): AnalysisTrace {
  const original = snapshot(trace);
  const originalBytes = bytes(original);
  if (originalBytes <= ANALYSIS_DIAGNOSTICS_LIMITS.recordBytes) return original;
  for (const limit of [8192, 2048, 256]) {
    const clip = (text: string) => (text.length <= limit ? text : text.slice(0, limit) + '…[省略]');
    const compact: AnalysisTrace = {
      ...original,
      response: original.response === null ? null : clip(original.response),
      ...(original.notices
        ? {
            notices: original.notices
              .slice(0, 128)
              .map((notice) => ({ ...notice, message: clip(notice.message) })),
          }
        : {}),
      error: original.error ? { ...original.error, message: clip(original.error.message) } : null,
      input: original.input
        ? {
            ...original.input,
            ...(limit < 8192 ? { sourceDocument: undefined } : {}),
            evidence: original.input.evidence.slice(0, 24).map((e) => ({
              ...e,
              text: clip(e.text),
              context: clip(e.context),
              sourceIds: e.sourceIds.slice(0, 32).map(clip),
              pages: e.pages.slice(0, 100),
            })),
            coverage: {
              ...original.input.coverage,
              pages: original.input.coverage.pages.slice(0, 1000),
              unverifiedSourcePages: original.input.coverage.unverifiedSourcePages.slice(0, 1000),
              limitations: original.input.coverage.limitations.slice(0, 16).map(clip),
            },
          }
        : null,
      compaction: { reason: 'storage-limit', originalBytes },
    };
    if (bytes(compact) <= ANALYSIS_DIAGNOSTICS_LIMITS.recordBytes) return compact;
  }
  throw new Error('追加分析診断の識別情報が保存上限を超えています');
}
let writeQueue: Promise<void> = Promise.resolve();
export function saveAnalysisTrace(trace: AnalysisTrace): Promise<void> {
  // Snapshot when invoked, before queued work observes a later mutation.
  const copy = boundedTrace(trace);
  const write = writeQueue.then(async () => {
    const saved = await chrome.storage.local.get(ANALYSIS_DIAGNOSTICS_KEY);
    const store = readStore(saved[ANALYSIS_DIAGNOSTICS_KEY]);
    store.traces = store.traces.filter((item) => item.runId !== copy.runId);
    store.traces.push(copy);
    if (copy.inputHash) {
      const prior = store.lastAttempts.find(
        (item) => item.summaryResultId === copy.summaryResultId && item.inputHash === copy.inputHash
      );
      if (!prior || copy.intentAt > prior.intentAt || prior.runId === copy.runId) {
        store.lastAttempts = store.lastAttempts.filter((item) => item !== prior);
        store.lastAttempts.push({
          version: 1,
          runId: copy.runId,
          summaryResultId: copy.summaryResultId,
          inputHash: copy.inputHash,
          pdfUrl: copy.pdfUrl,
          intentAt: copy.intentAt,
          persistence: 'saved',
          outcome: copy.outcome,
          error: copy.error,
        });
        store.lastAttempts.sort((a, b) => a.intentAt - b.intentAt);
      }
    }
    store.lastAttempts = store.lastAttempts.slice(-ANALYSIS_DIAGNOSTICS_LIMITS.records);
    while (
      store.traces.length > ANALYSIS_DIAGNOSTICS_LIMITS.records ||
      bytes(store) > ANALYSIS_DIAGNOSTICS_LIMITS.bytes
    ) {
      const completed = store.traces.findIndex(
        (item) => item.runId !== copy.runId && item.outcome !== 'running'
      );
      if (store.traces.length > 1) store.traces.splice(completed < 0 ? 0 : completed, 1);
      else if (store.lastAttempts.length > 1) store.lastAttempts.shift();
      else throw new Error('追加分析診断の識別情報が保存上限を超えています');
    }
    await chrome.storage.local.set({ [ANALYSIS_DIAGNOSTICS_KEY]: store });
  });
  writeQueue = write.then(
    () => {},
    () => {}
  );
  return write;
}
export async function loadAnalysisTrace(
  pdfUrl: string,
  runId: string,
  summaryResultId: string,
  persistence?: DiagnosticPersistence,
  expectedInputHash?: string
): Promise<AnalysisTrace> {
  const saved = await chrome.storage.local.get(ANALYSIS_DIAGNOSTICS_KEY);
  const trace = readStore(saved[ANALYSIS_DIAGNOSTICS_KEY]).traces.find(
    (item) => item.runId === runId
  );
  if (
    !trace ||
    trace.summaryResultId !== summaryResultId ||
    trace.pdfUrl !== normalizeTdnetPdfUrl(pdfUrl) ||
    (expectedInputHash !== undefined && trace.inputHash !== expectedInputHash)
  )
    throw new Error(
      persistence === 'failed' ? 'この追加分析の診断を保存できませんでした' : unavailable
    );
  // A saved running snapshot is useful after interruption, but must not pretend
  // to be the missing terminal outcome following a failed final write.
  if (persistence === 'failed')
    throw new Error(
      '追加分析の最終診断を保存できませんでした。途中の記録だけが残っている可能性があります'
    );
  return snapshot(trace);
}
export function readAnalysisDiagnosticReference(
  value: unknown,
  summaryResultId: string,
  inputHash: string
): AnalysisDiagnosticReference | null {
  if (
    !record(value) ||
    typeof value.runId !== 'string' ||
    !value.runId ||
    value.summaryResultId !== summaryResultId ||
    value.inputHash !== inputHash ||
    !['saved', 'failed'].includes(String(value.persistence))
  )
    return null;
  return {
    runId: value.runId,
    summaryResultId,
    inputHash,
    persistence: value.persistence as DiagnosticPersistence,
  };
}

/** The pointer is intentionally independent of a cached successful analysis.
 * An evicted trace stays unavailable; never substitute another same-PDF run. */
export function readLastAnalysisAttempt(
  value: unknown,
  pdfUrl: string,
  summaryResultId: string,
  inputHash: string
): AnalysisLastAttempt | null {
  const store = readStore(value);
  return (
    store.lastAttempts.find(
      (item) =>
        item.pdfUrl === normalizeTdnetPdfUrl(pdfUrl) &&
        item.summaryResultId === summaryResultId &&
        item.inputHash === inputHash
    ) ?? null
  );
}
