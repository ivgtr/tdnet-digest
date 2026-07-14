import type { DocumentType } from '../lib/document-type';

export type ExtractionMode = 'smart' | 'full';

export interface ExtractedPage {
  pageNumber: number;
  text: string;
}

export interface EvidenceFact {
  text: string;
  page: number | null;
}

export interface QualityWarning {
  message: string;
  missingKeywords: string[];
  matchRate: number;
}

export interface SummaryMetadata {
  totalPages: number;
  extractedPages: number[];
  sectionsUsed?: string[];
  extractionMode: ExtractionMode;
  documentType?: DocumentType;
  qualityWarning?: QualityWarning;
  analysisSchemaVersion?: number;
  provider?: string;
  model?: string;
  summaryMode?: 'one-pass' | 'two-pass';
  analysisFingerprint?: string;
}

export interface PdfExtractionResult {
  text: string;
  pages: ExtractedPage[];
  metadata: SummaryMetadata;
}

export interface CachedSummary {
  summary: string;
  metadata: SummaryMetadata;
  companyName: string;
  title: string;
  code: string;
  cachedAt: number;
}

export type SummaryCacheStore = Record<string, CachedSummary>;
