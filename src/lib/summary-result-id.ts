import { canonicalJSON, type FactSummary } from './fact-contract';
import type { SummaryPresentation } from './summary-presentation';
import { normalizeTdnetPdfUrl } from './tdnet-url';

export async function summaryResultId(
  pdfUrl: string,
  fingerprint: string,
  facts: FactSummary,
  documentHash: string,
  presentation: SummaryPresentation
): Promise<string> {
  const bytes = new TextEncoder().encode(
    canonicalJSON([normalizeTdnetPdfUrl(pdfUrl), fingerprint, documentHash, facts, presentation])
  );
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
