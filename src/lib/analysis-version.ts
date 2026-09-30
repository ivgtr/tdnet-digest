import type { ExtractionMode } from '@/types/summaryMetadata';

export const ANALYSIS_SCHEMA_VERSION = 19;

export interface AnalysisFingerprintSettings {
  provider: string;
  model: string;
  extractionMode: ExtractionMode;
}

export function buildAnalysisFingerprint(settings: AnalysisFingerprintSettings): string {
  return [
    `v${ANALYSIS_SCHEMA_VERSION}`,
    encodeURIComponent(settings.provider),
    encodeURIComponent(settings.model),
    settings.extractionMode,
  ].join(':');
}

export function buildSummaryCacheKey(pdfUrl: string, fingerprint: string): string {
  return `${fingerprint}:${pdfUrl}`;
}
