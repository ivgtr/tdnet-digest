/** Fixed display content for contract/UI tests, never a production synthesis fallback. */
import type { ExtractedPage } from '@/types/summaryMetadata';
import type { FactSummary } from '../fact-contract';
import {
  buildPresentation as draftPresentation,
  type SummaryPresentation,
} from '../summary-presentation';
import type { NarrativeLine } from '../summary-narrative';
interface NarrativeContent {
  version: 1;
  overview: NarrativeLine[];
  sections: Array<{
    id: string;
    title: string;
    sourceIds: string[];
    summary: NarrativeLine[];
  }>;
}
import {
  organizationHash,
  organizationClaims,
  explanationSources,
  unresolvedTableSources,
} from '../summary-organization';

export function fixedNarrativeContent(
  _facts: FactSummary,
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
      },
    ],
  };
}
export function fixedOrganization(
  facts: FactSummary,
  display: Pick<SummaryPresentation, 'values' | 'excerpts' | 'sections'>,
  content = fixedNarrativeContent(facts, display)
): import('../summary-organization').SummaryOrganization {
  const organization = {
    version: 3 as const,
    status: 'ready' as 'ready' | 'partial',
    claims: content.sections
      .flatMap((s) => s.summary)
      .map((c, i) => ({
        ...c,
        topic: 'other' as const,
        entity: null,
        scope: null,
        basis: null,
        period: null,
        state: 'unspecified' as const,
        conditions: [],
        id: `explanation-${i}`,
      })),
    observations: [],
    review: null as import('../summary-organization').ExplanationReview | null,
    issues: [],
  };
  organization.review = {
    contentHash: organizationHash(organization, facts, display.values, display.excerpts),
    claims: Object.fromEntries(organizationClaims(organization).map((c) => [c.id, null])),
    sources: Object.fromEntries(explanationSources(display.excerpts).map((e) => [e.id, null])),
  };
  if (unresolvedTableSources(organization, facts, display.values, display.excerpts).length)
    organization.status = 'partial';
  return organization;
}
export function completePresentation(
  display: SummaryPresentation,
  facts: FactSummary,
  content = fixedNarrativeContent(facts, display)
): SummaryPresentation {
  return { ...display, organization: fixedOrganization(facts, display, content) };
}

export function buildPresentation(facts: FactSummary, pages: ExtractedPage[]): SummaryPresentation {
  return completePresentation(draftPresentation(facts, pages), facts);
}
