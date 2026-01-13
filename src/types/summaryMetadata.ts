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
