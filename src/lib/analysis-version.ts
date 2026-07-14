import type { ExtractionMode } from '@/types/summaryMetadata';

export const ANALYSIS_SCHEMA_VERSION = 2;

export interface AnalysisFingerprintSettings {
  provider: string;
  model: string;
  extractionMode: ExtractionMode;
  twoPassMode: boolean;
}

export function buildAnalysisFingerprint(settings: AnalysisFingerprintSettings): string {
  const mode = settings.twoPassMode ? 'two-pass' : 'one-pass';
  return [
    `v${ANALYSIS_SCHEMA_VERSION}`,
    encodeURIComponent(settings.provider),
    encodeURIComponent(settings.model),
    settings.extractionMode,
    mode,
  ].join(':');
}

export function buildSummaryCacheKey(pdfUrl: string, fingerprint: string): string {
  return `${fingerprint}:${pdfUrl}`;
}
