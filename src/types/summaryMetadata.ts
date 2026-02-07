import type { DocumentType } from '../lib/document-type';

export type ExtractionMode = 'smart' | 'full';

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
