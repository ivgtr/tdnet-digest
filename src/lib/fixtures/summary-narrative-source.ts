/** Fixed display content for contract/UI tests, never a production synthesis fallback. */
import type { ExtractedPage } from '@/types/summaryMetadata';
import type { FactSummary } from '../fact-contract';
import {
  buildPresentation as draftPresentation,
  type SummaryPresentation,
} from '../summary-presentation';
import {
  narrativeClaims,
  narrativeHash,
  type NarrativeContent,
  type NarrativeReview,
} from '../summary-narrative';

export function fixedNarrativeContent(
  facts: FactSummary,
  display: Pick<SummaryPresentation, 'excerpts' | 'sections'>
): NarrativeContent {
  const sourceIds = display.excerpts.map((e) => e.id);
  return {
    version: 1,
    overview: [],
    sections: [
      {
        id: 'section',
        title: display.sections.find((s) => s.factIds.length)?.title ?? '開示内容',
        sourceIds,
        summary: [{ id: 'explanation', text: '開示された数値と条件を確認する。', sourceIds }],
        tables: facts.facts.some((f) => f.quantity)
          ? [
              {
                caption: { id: 'caption', text: '開示に記載された数値。', sourceIds },
                headers: ['指標', '値'],
                rows: facts.facts
                  .filter((f) => f.quantity)
                  .map((f, i) => ({
                    id: `row-${i}`,
                    cells: [f.label, `{{value:${f.id}}}`],
                    sourceIds,
                  })),
              },
            ]
          : [],
      },
    ],
  };
}
export function fixedNarrativeReview(
  content: NarrativeContent,
  facts: FactSummary,
  display: Pick<SummaryPresentation, 'values' | 'excerpts'>
): NarrativeReview {
  return {
    version: 1,
    contentHash: narrativeHash(content, display.values, facts),
    reviewedClaimIds: narrativeClaims(content).map((c) => c.id),
    reviewedSourceIds: display.excerpts.map((e) => e.id),
    issues: [],
  };
}
export function completePresentation(
  display: SummaryPresentation,
  facts: FactSummary,
  content = fixedNarrativeContent(facts, display)
): SummaryPresentation {
  return {
    ...display,
    narrative: { content, review: fixedNarrativeReview(content, facts, display) },
  };
}
export function buildPresentation(facts: FactSummary, pages: ExtractedPage[]): SummaryPresentation {
  return completePresentation(draftPresentation(facts, pages), facts);
}
