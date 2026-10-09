import type { CoverageSlot } from './fact-coverage';
import type { Diagnostic } from './fact-candidates';
import type { LLMConfig } from './llm-client';
import { record } from './fact-contract';
import { normalizeTdnetPdfUrl } from './tdnet-url';
import { readPdfExtractionError, type PdfExtractionErrorDetails } from './pdf-extraction-error';

/** Compatibility with versions that retained only the last run; never written anew. */
export const SUMMARY_TRACE_KEY = 'summaryLastRunV1';
export const SUMMARY_DIAGNOSTICS_KEY = 'summaryDiagnosticsV1';
export const SUMMARY_DIAGNOSTICS_LIMITS = {
  records: 12,
  bytes: 2 * 1024 * 1024,
  recordBytes: 192 * 1024,
} as const;
export type DiagnosticPersistence = 'saved' | 'failed';
export type Usage = Parameters<NonNullable<LLMConfig['onUsage']>>[0];
export interface SummaryAttempt {
  phase: 'first' | 'repair' | 'summary' | 'summaryRepair' | 'summaryReview' | 'summaryReviewRepair';
  response: string;
  error: string | null;
  diagnostics?: Diagnostic[];
  slots?: CoverageSlot[];
  confirmedIds?: string[];
  repairMode?: 'delta' | 'complete';
}
export interface SummaryTrace {
  version: 1;
  runId: string;
  resultId: string | null;
  startedAt: string;
  pdfUrl: string;
  documentType: string;
  provider: string | null;
  model: string | null;
  extractionMode: string | null;
  fingerprint: string | null;
  buildDigest: string;
  documentHash: string | null;
  inputHash: string | null;
  selectedPages: number[];
  attempts: SummaryAttempt[];
  usage: Usage[];
  elapsedMs: number;
  outcome: 'running' | 'firstSuccess' | 'repairSuccess' | 'partialSuccess' | 'failure';
  error: string | null;
  pdfExtractionError?: PdfExtractionErrorDetails;
  compaction?: { reason: 'storage-limit'; originalBytes: number };
}
interface DiagnosticStore {
  version: 1;
  // Oldest updated run first. Replacing a run and pruning happen in one set.
  traces: SummaryTrace[];
}
const successOutcomes = ['firstSuccess', 'repairSuccess', 'partialSuccess'];
const unavailable =
  'この要約結果に対応する診断がありません。保存上限で削除されたか、保存されていません';
const nullableString = (value: unknown) => value === null || typeof value === 'string';
function isSummaryTrace(value: unknown): value is SummaryTrace {
  return (
    record(value) &&
    value.version === 1 &&
    typeof value.runId === 'string' &&
    value.runId.length > 0 &&
    nullableString(value.resultId) &&
    ['startedAt', 'pdfUrl', 'documentType', 'buildDigest'].every(
      (key) => typeof value[key] === 'string'
    ) &&
    [
      'provider',
      'model',
      'extractionMode',
      'fingerprint',
      'documentHash',
      'inputHash',
      'error',
    ].every((key) => nullableString(value[key])) &&
    [...successOutcomes, 'running', 'failure'].includes(String(value.outcome)) &&
    typeof value.elapsedMs === 'number' &&
    Number.isFinite(value.elapsedMs) &&
    Array.isArray(value.selectedPages) &&
    value.selectedPages.every(Number.isInteger) &&
    Array.isArray(value.attempts) &&
    value.attempts.every(
      (attempt) =>
        record(attempt) &&
        [
          'first',
          'repair',
          'summary',
          'summaryRepair',
          'summaryReview',
          'summaryReviewRepair',
        ].includes(String(attempt.phase)) &&
        typeof attempt.response === 'string' &&
        nullableString(attempt.error) &&
        (attempt.diagnostics === undefined || Array.isArray(attempt.diagnostics)) &&
        (attempt.slots === undefined || Array.isArray(attempt.slots)) &&
        (attempt.confirmedIds === undefined ||
          (Array.isArray(attempt.confirmedIds) &&
            attempt.confirmedIds.every((id) => typeof id === 'string')))
    ) &&
    Array.isArray(value.usage) &&
    value.usage.every(
      (usage) =>
        record(usage) &&
        [usage.inputTokens, usage.outputTokens, usage.elapsedMs].every(
          (n) => n === null || (typeof n === 'number' && Number.isFinite(n))
        )
    ) &&
    (value.pdfExtractionError === undefined ||
      readPdfExtractionError(value.pdfExtractionError) !== null)
  );
}
/** Match both identifiers when available, never substitute a newer same-PDF run. */
export function matchingSummaryTrace(
  value: unknown,
  pdfUrl: string,
  runId: string | null,
  resultId: string | null
): SummaryTrace {
  if (
    !isSummaryTrace(value) ||
    (runId !== null ? value.runId !== runId : !resultId) ||
    (resultId !== null && (value.resultId !== resultId || !successOutcomes.includes(value.outcome)))
  )
    throw new Error(unavailable);
  // A rejected URL remains raw in its failed run. Export does not fetch it.
  if (
    runId !== null &&
    value.outcome === 'failure' &&
    value.resultId === null &&
    value.pdfUrl === pdfUrl
  )
    return value;
  if (value.pdfUrl !== normalizeTdnetPdfUrl(pdfUrl)) throw new Error(unavailable);
  return value;
}

function readStore(value: unknown): DiagnosticStore {
  if (value === undefined) return { version: 1, traces: [] };
  if (
    !record(value) ||
    value.version !== 1 ||
    !Array.isArray(value.traces) ||
    !value.traces.every(isSummaryTrace)
  )
    throw new Error('保存された診断の形式が不正です');
  return { version: 1, traces: value.traces };
}
function bytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}
/** Explicit projection: settings, endpoints, credentials and headers are never copied. */
function diagnosticSnapshot(trace: SummaryTrace): SummaryTrace {
  return {
    version: 1,
    runId: trace.runId,
    resultId: trace.resultId,
    startedAt: trace.startedAt,
    pdfUrl: trace.pdfUrl,
    documentType: trace.documentType,
    provider: trace.provider,
    model: trace.model,
    extractionMode: trace.extractionMode,
    fingerprint: trace.fingerprint,
    buildDigest: trace.buildDigest,
    documentHash: trace.documentHash,
    inputHash: trace.inputHash,
    selectedPages: [...trace.selectedPages],
    elapsedMs: trace.elapsedMs,
    outcome: trace.outcome,
    error: trace.error,
    attempts: trace.attempts.map((attempt) => ({
      phase: attempt.phase,
      response: attempt.response,
      error: attempt.error,
      ...(attempt.repairMode ? { repairMode: attempt.repairMode } : {}),
      ...(attempt.confirmedIds ? { confirmedIds: [...attempt.confirmedIds] } : {}),
      ...(attempt.diagnostics
        ? {
            diagnostics: attempt.diagnostics.map((d) => ({
              candidateId: d.candidateId,
              sourceKey: d.sourceKey,
              check: d.check,
              status: d.status,
              message: d.message,
            })),
          }
        : {}),
      ...(attempt.slots
        ? {
            slots: attempt.slots.map((slot) => ({
              id: slot.id,
              requirement: slot.requirement,
              sourceIds: [...slot.sourceIds],
              status: slot.status,
              expected: Object.fromEntries(
                [
                  'label',
                  'kind',
                  'state',
                  'metricKind',
                  'periodKind',
                  'period',
                  'subject',
                  'scope',
                  'basis',
                  'polarity',
                ]
                  .filter((key) => key in slot.expected)
                  .map((key) => [key, slot.expected[key as keyof CoverageSlot['expected']]])
              ),
            })),
          }
        : {}),
    })),
    usage: trace.usage.map((u) => ({
      inputTokens: u.inputTokens,
      outputTokens: u.outputTokens,
      elapsedMs: u.elapsedMs,
      ...(u.finishReason !== undefined ? { finishReason: u.finishReason } : {}),
      ...(u.reasoningTokens !== undefined ? { reasoningTokens: u.reasoningTokens } : {}),
    })),
    ...(trace.pdfExtractionError
      ? { pdfExtractionError: readPdfExtractionError(trace.pdfExtractionError)!.details }
      : {}),
    ...(trace.compaction
      ? {
          compaction: {
            reason: 'storage-limit',
            originalBytes: trace.compaction.originalBytes,
          } as const,
        }
      : {}),
  };
}
function boundedTrace(trace: SummaryTrace): SummaryTrace {
  const snapshot = diagnosticSnapshot(trace);
  const originalBytes = bytes(snapshot);
  if (originalBytes <= SUMMARY_DIAGNOSTICS_LIMITS.recordBytes) return snapshot;
  // Only oversized records lose detail; identity/hash/outcome are never truncated.
  // Fixed passes bound work even for a provider returning an enormous response.
  for (const limit of [8192, 2048, 512]) {
    const clip = (value: string | null) =>
      value === null || value.length <= limit ? value : value.slice(0, limit) + '…[省略]';
    const compact: SummaryTrace = {
      ...snapshot,
      documentType: clip(snapshot.documentType)!,
      provider: clip(snapshot.provider),
      model: clip(snapshot.model),
      error: clip(snapshot.error),
      selectedPages: snapshot.selectedPages.slice(0, 1000),
      attempts: snapshot.attempts.slice(0, 8).map((a) => ({
        phase: a.phase,
        response: clip(a.response)!,
        error: clip(a.error),
        ...(a.repairMode ? { repairMode: a.repairMode } : {}),
        // Source diagnostics remain readable excerpts, without retaining unbounded nested payloads.
        ...(a.diagnostics
          ? {
              diagnostics: a.diagnostics.slice(0, 8).map((d) => ({
                ...d,
                candidateId: clip(d.candidateId),
                sourceKey: clip(d.sourceKey),
                check: clip(d.check)!,
                message: clip(d.message)!,
              })),
            }
          : {}),
        ...(a.confirmedIds
          ? { confirmedIds: a.confirmedIds.slice(0, 32).map((id) => clip(id)!) }
          : {}),
      })),
      usage: snapshot.usage.slice(0, 16).map((u) => ({
        ...u,
        ...(u.finishReason !== undefined ? { finishReason: clip(u.finishReason) } : {}),
      })),
      ...(snapshot.pdfExtractionError
        ? {
            pdfExtractionError: {
              ...snapshot.pdfExtractionError,
              name: clip(snapshot.pdfExtractionError.name)!,
              message: clip(snapshot.pdfExtractionError.message)!,
              code:
                typeof snapshot.pdfExtractionError.code === 'string'
                  ? clip(snapshot.pdfExtractionError.code)
                  : snapshot.pdfExtractionError.code,
            },
          }
        : {}),
      compaction: { reason: 'storage-limit', originalBytes },
    };
    if (bytes(compact) <= SUMMARY_DIAGNOSTICS_LIMITS.recordBytes) return compact;
  }
  throw new Error('診断の識別情報が保存上限を超えています');
}

// Background is the sole writer. One queue and one atomic key prevent parallel
// read/modify/write loss and partially committed eviction/index updates.
let writeQueue: Promise<void> = Promise.resolve();
export function saveSummaryTrace(trace: SummaryTrace): Promise<{ cleanupWarning?: string }> {
  const write = writeQueue.then(async () => {
    const snapshot = boundedTrace(trace);
    const saved = await chrome.storage.local.get([SUMMARY_DIAGNOSTICS_KEY, SUMMARY_TRACE_KEY]);
    const store = readStore(saved[SUMMARY_DIAGNOSTICS_KEY]);
    const legacy = saved[SUMMARY_TRACE_KEY];
    if (isSummaryTrace(legacy) && !store.traces.some((item) => item.runId === legacy.runId)) {
      try {
        // Upgrade the former unbounded single record under the same limits.
        store.traces.unshift(boundedTrace(legacy));
      } catch {
        // An oversized identity cannot be truncated into a different run/result.
        // Retire it like an evicted record instead of preventing current saves.
      }
    }
    store.traces = store.traces.filter((item) => item.runId !== snapshot.runId);
    store.traces.push(snapshot);
    while (
      store.traces.length > SUMMARY_DIAGNOSTICS_LIMITS.records ||
      bytes(store) > SUMMARY_DIAGNOSTICS_LIMITS.bytes
    ) {
      const completed = store.traces.findIndex(
        (item) => item.runId !== snapshot.runId && item.outcome !== 'running'
      );
      // Prefer completed history over active runs; never evict the incoming run.
      store.traces.splice(completed < 0 ? 0 : completed, 1);
    }
    await chrome.storage.local.set({ [SUMMARY_DIAGNOSTICS_KEY]: store });
    if (legacy !== undefined) {
      try {
        // Commit first: failed cleanup cannot lose the migrated/current records.
        await chrome.storage.local.remove(SUMMARY_TRACE_KEY);
      } catch {
        return { cleanupWarning: '以前の診断を整理できませんでした。今回の診断は保存済みです' };
      }
    }
    return {};
  });
  // A read/write/cleanup failure cannot poison later runs. Cleanup retries at
  // the next ordinary snapshot save; it never triggers another generation.
  writeQueue = write.then(
    () => {},
    () => {}
  );
  return write;
}
export async function loadSummaryTrace(
  pdfUrl: string,
  runId: string | null,
  resultId: string | null,
  persistence?: DiagnosticPersistence
): Promise<SummaryTrace> {
  if (!runId && !resultId) throw new Error(unavailable);
  const saved = await chrome.storage.local.get([SUMMARY_DIAGNOSTICS_KEY, SUMMARY_TRACE_KEY]);
  const store = readStore(saved[SUMMARY_DIAGNOSTICS_KEY]);
  const trace = [...store.traces]
    .reverse()
    .find((item) =>
      runId !== null
        ? item.runId === runId
        : item.resultId === resultId && successOutcomes.includes(item.outcome)
    );
  if (trace && trace.outcome !== 'running') {
    // An intermediate snapshot is not the diagnostic of a successful result.
    try {
      return matchingSummaryTrace(trace, pdfUrl, runId, resultId);
    } catch {
      /* Try exact legacy match. */
    }
  }
  try {
    const legacy = matchingSummaryTrace(saved[SUMMARY_TRACE_KEY], pdfUrl, runId, resultId);
    if (legacy.outcome === 'running') throw new Error(unavailable);
    return legacy;
  } catch {
    throw new Error(
      persistence === 'failed' ? 'この実行の診断を保存できませんでした' : unavailable
    );
  }
}

declare const __SUMMARY_BUILD_DIGEST__: string;
export function summaryBuildDigest(): string {
  return typeof __SUMMARY_BUILD_DIGEST__ === 'string' ? __SUMMARY_BUILD_DIGEST__ : 'unbundled';
}
