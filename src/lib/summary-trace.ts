import type { CoverageSlot } from './fact-coverage';
import type { Diagnostic } from './fact-candidates';
import type { LLMConfig } from './llm-client';
import { record } from './fact-contract';
import { normalizeTdnetPdfUrl } from './tdnet-url';
export const SUMMARY_TRACE_KEY = 'summaryLastRunV1';
export type Usage = Parameters<NonNullable<LLMConfig['onUsage']>>[0];
export interface SummaryAttempt {
  phase: 'first' | 'repair';
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
  provider: string;
  model: string;
  extractionMode: string;
  fingerprint: string;
  buildDigest: string;
  documentHash: string;
  inputHash: string;
  selectedPages: number[];
  attempts: SummaryAttempt[];
  usage: Usage[];
  elapsedMs: number;
  outcome: 'running' | 'firstSuccess' | 'repairSuccess' | 'failure';
  error: string | null;
}
/** A fresh attempt must match its run; cached success must match its exact result. */
export function matchingSummaryTrace(
  value: unknown,
  pdfUrl: string,
  runId: string | null,
  resultId: string | null
): SummaryTrace {
  if (
    !record(value) ||
    value.version !== 1 ||
    typeof value.runId !== 'string' ||
    !value.runId ||
    value.pdfUrl !== normalizeTdnetPdfUrl(pdfUrl) ||
    (runId !== null
      ? value.runId !== runId
      : !resultId ||
        value.resultId !== resultId ||
        !['firstSuccess', 'repairSuccess'].includes(String(value.outcome)))
  )
    throw new Error('この要約結果に対応する診断がありません');
  return value as unknown as SummaryTrace;
}
declare const __SUMMARY_BUILD_DIGEST__: string;
export function summaryBuildDigest(): string {
  return typeof __SUMMARY_BUILD_DIGEST__ === 'string' ? __SUMMARY_BUILD_DIGEST__ : 'unbundled';
}
