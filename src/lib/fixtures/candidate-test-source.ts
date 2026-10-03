/** Explicit fixture builder for the current generation contract. Never used by the product parser. */
import type { ExtractedPage } from '@/types/summaryMetadata';
import type { VerifiedFact } from '../fact-contract';
import { proseQuantities, CANDIDATE_VERSION, type Candidate } from '../fact-candidates';
import { assertionId, sourceTableId } from '../source-provenance';
import { normalized } from '../document-structure';
import { parseExactQuantity } from '../quantity';
export function candidateFixture(
  fact: VerifiedFact,
  pages: ExtractedPage[],
  candidateId = 'c1'
): Candidate {
  const ev = fact.evidence;
  const { subject, scope, basis, periodKind, metricKind, state, polarity } = fact.semantics;
  const source: Candidate['source'] =
    ev.kind === 'table'
      ? {
          kind: 'table',
          valueId: ev.valueId,
          tableId: sourceTableId(pages.find((p) => p.pageNumber === fact.page)!, ev.valueId),
          contextBindingId: `ctx:${ev.valueId}`,
        }
      : (() => {
          const block = pages
            .find((p) => p.pageNumber === fact.page)
            ?.blocks.find((b) => b.id === ev.blockId);
          const numeric = fact.kind === 'number' || fact.kind === 'range';
          const quantity = block
            ? proseQuantities(block).find((q) =>
                fact.kind === 'range'
                  ? fact.quantity?.raw === q.raw
                  : Number(parseExactQuantity(q.raw)?.decimal) === fact.value
              )
            : undefined;
          // Malformed/missing source fixtures remain malformed, rather than fixing them.
          return {
            kind: 'prose',
            blockId: ev.blockId,
            assertionId: assertionId(ev.blockId),
            quantityId: numeric ? (quantity?.id ?? `${ev.blockId}:q0`) : null,
            metric: numeric ? normalized(fact.label) : null,
            contextBindingId: `ctx:${ev.blockId}`,
          };
        })();
  return {
    candidateId,
    importance: fact.importance,
    kind: fact.kind,
    source,
    meaning: {
      subject,
      scope,
      basis,
      period: fact.period,
      periodKind,
      metricKind,
      state,
      polarity,
    },
  };
}
export function candidateResponse(
  facts: VerifiedFact[],
  pages: ExtractedPage[],
  documentType = 'other'
) {
  return JSON.stringify({
    candidateVersion: CANDIDATE_VERSION,
    documentType,
    candidates: facts.map((f, i) => candidateFixture(f, pages, `c${i + 1}`)),
    unverified: [],
  });
}
