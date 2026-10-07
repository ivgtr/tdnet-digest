import type { SourceItem, TextBlock, QuantityCell } from '../lib/document-structure';
import type { PdfSpan } from '../lib/pdf-layout';
import type { DocumentType } from '../lib/document-type';
import type { FactSummary } from '../lib/fact-summary';
import type { DrawingOperation, DrawingLine } from '../lib/pdf-drawing';
import type { TableRegion } from '../lib/table-layout';
import type { SummaryPresentation } from '../lib/summary-presentation';

export type ExtractionMode = 'smart' | 'full';

export interface ExtractedPage {
  pageNumber: number;
  text: string;
  spans: PdfSpan[];
  sourceItems: SourceItem[];
  status: 'ok' | 'empty' | 'failed';
  selection: 'selected' | 'omitted';
  blocks: TextBlock[];
  quantities: QuantityCell[];
  drawingOperations: DrawingOperation[];
  drawingLines: DrawingLine[];
  tableRegions: TableRegion[];
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
  persistenceWarning?: string;
  documentHash?: string;
  totalPages: number;
  extractedPages: number[];
  sectionsUsed?: string[];
  extractionMode: ExtractionMode;
  documentType?: DocumentType;
  qualityWarning?: QualityWarning;
  analysisSchemaVersion?: number;
  provider?: string;
  model?: string;
  summaryMode?: 'sourced-summary';
  generationCalls?: number;
  analysisFingerprint?: string;
}

export interface PdfExtractionResult {
  text: string;
  pages: ExtractedPage[];
  metadata: SummaryMetadata;
}

export interface CachedSummary {
  summary: string;
  facts: FactSummary;
  presentation: SummaryPresentation;
  resultId: string;
  metadata: SummaryMetadata;
  companyName: string;
  title: string;
  code: string;
  cachedAt: number;
}

export type SummaryCacheStore = Record<string, CachedSummary>;
