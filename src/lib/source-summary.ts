import { chunkFactDiagnostics } from './fact-diagnostics';
import type { ExtractedPage } from '@/types/summaryMetadata';
import type { DocumentType } from './document-type';
import type { LLMConfig } from './llm-client';
import { FACT_SCHEMA_VERSION, type FactSummary } from './fact-contract';
import { buildDirectSourcePresentation, type SummaryPresentation } from './summary-presentation';
import {
  analyzeFacts,
  AnalysisValidationError,
  analysisPrompt,
  assertAnalysisInputBudget,
  type AdditionalAnalysis,
} from './additional-analysis';
import { buildAnalysisInput } from './analysis-input';
import type { NativeDisclosure } from './native-disclosure-contract';
import type { AnalysisGenerationDiagnostic } from './analysis-trace';

/** An explicit compatibility anchor, not a claim that raw source is a verified fact. */
export const SOURCE_SUMMARY_ANCHOR =
  '原資料を直接要約しています。構造化事実の抽出は行っていません。';
export interface SourceFirstSummary {
  version: 1;
  summary: AdditionalAnalysis | null;
  warnings: string[];
  native?: NativeDisclosure;
  nativeMode?: 'included' | 'pdf-only';
}
export function buildSourcePresentation(
  documentType: DocumentType,
  pages: ExtractedPage[],
  options: { native?: NativeDisclosure; warnings?: string[] } = {}
) {
  const facts: FactSummary = {
    version: FACT_SCHEMA_VERSION,
    documentType,
    facts: [],
    unverified: [SOURCE_SUMMARY_ANCHOR],
  };
  // Full source has already been extracted in both modes. Selection is a legacy
  // summary hint, never permission to remove rows from the direct-reading path.
  const presentation = buildDirectSourcePresentation(
    facts,
    pages.map((page) => ({ ...page, selection: 'selected' }))
  );
  presentation.sourceFirst = {
    version: 1,
    summary: null,
    warnings: chunkFactDiagnostics(options.warnings ?? []),
    ...(options.native
      ? {
          native: options.native,
          nativeMode: options.native.status === 'eligible' ? 'included' : 'pdf-only',
        }
      : {}),
  };
  return { facts, presentation };
}
export async function generateSourceSummary(
  config: LLMConfig,
  documentType: DocumentType,
  pages: ExtractedPage[],
  onDiagnostic?: (snapshot: AnalysisGenerationDiagnostic) => void | Promise<void>,
  options: { native?: NativeDisclosure; warnings?: string[] } = {}
): Promise<{ facts: FactSummary; presentation: SummaryPresentation }> {
  const result = buildSourcePresentation(documentType, pages, options);
  if (result.presentation.sourceFirst?.nativeMode === 'included') {
    try {
      assertAnalysisInputBudget(
        analysisPrompt(buildAnalysisInput(result.facts, result.presentation), 'summary')
      );
    } catch (error) {
      if (!(error instanceof AnalysisValidationError) || error.code !== 'input_limit') throw error;
      // Do not silently truncate native or PDF evidence. Keep the native archive
      // provenance in the result, but explicitly read the complete PDF alone.
      result.presentation.sourceFirst.nativeMode = 'pdf-only';
      result.presentation.sourceFirst.warnings.push(
        'XBRL/HTMLを含む入力が上限を超えるため、PDF全文のみで要約・分析します。XBRL/HTMLの出典情報は保存しています。'
      );
    }
  }
  result.presentation.sourceFirst!.summary = await analyzeFacts(
    config,
    result.facts,
    result.presentation,
    onDiagnostic,
    undefined,
    'summary'
  );
  return result;
}
