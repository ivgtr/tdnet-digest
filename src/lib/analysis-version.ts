import { effectiveApiUrl } from './llm-endpoint';
import type { ExtractionMode } from '@/types/summaryMetadata';

export const ANALYSIS_SCHEMA_VERSION = 125;

export interface AnalysisFingerprintSettings {
  provider: string;
  model: string;
  baseUrl?: string;
  extractionMode: ExtractionMode;
}

export async function buildAnalysisFingerprint(
  settings: AnalysisFingerprintSettings
): Promise<string> {
  // Only a digest enters cache keys/metadata/diagnostics; never API keys or raw URLs.
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(effectiveApiUrl(settings))
  );
  const endpoint = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join(
    ''
  );
  return [
    `v${ANALYSIS_SCHEMA_VERSION}`,
    encodeURIComponent(settings.provider),
    encodeURIComponent(settings.model),
    settings.extractionMode,
    endpoint,
  ].join(':');
}

export function buildSummaryCacheKey(pdfUrl: string, fingerprint: string): string {
  return `${fingerprint}:${pdfUrl}`;
}
