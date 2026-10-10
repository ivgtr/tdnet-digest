import type { ExtractedPage } from '@/types/summaryMetadata';
import type { DocumentType } from './document-type';
import type { DocumentContext } from './document-context';
import { canonicalJSON } from './fact-contract';
import {
  reviewCandidates,
  CANDIDATE_VERSION,
  type Candidate,
  type CandidateReview,
} from './fact-candidates';
import { sourceDeclaredTables } from './source-declared-tables';
import { reportingPeriodText } from './period-semantics';
import { summaryComparison } from './summary-comparison';

/** Complete a selected headline's comparison from its own declared source axis.
 * A copied meaning is only a proposal: ordinary candidate review must prove the
 * other cell's period, entity, scope, accounting basis and all source qualifiers.
 * This never repairs a rejected model candidate or promotes an unrelated table.
 */
export function acquireSourceComparisons(
  review: CandidateReview,
  documentType: DocumentType,
  pages: ExtractedPage[],
  context: DocumentContext
): CandidateReview {
  if (!review.envelopeValid || documentType !== 'earnings') return review;
  const tables = sourceDeclaredTables(pages, context).filter(
    (table) => table.selectionRole === 'financialPerformance'
  );
  const attempted = new Set([
    ...[...review.candidateSources.values()].flatMap((source) =>
      source.kind === 'table' ? [source.valueId] : []
    ),
    ...review.diagnostics.flatMap((diagnostic) =>
      diagnostic.sourceKey ? [diagnostic.sourceKey] : []
    ),
  ]);
  const result = {
    ...review,
    facts: [...review.facts],
    diagnostics: [...review.diagnostics],
    unverified: [...review.unverified],
    candidateSources: new Map(review.candidateSources),
    candidateKinds: new Map(review.candidateKinds),
  };
  let nextId = Math.max(
    0,
    ...[
      ...review.candidateSources.keys(),
      ...review.diagnostics.flatMap((d) => (d.candidateId ? [d.candidateId] : [])),
    ].map((id) => Number(id.slice(1)) || 0)
  );
  for (const current of review.facts) {
    if (
      current.kind !== 'number' ||
      current.semantics.state !== 'actual' ||
      current.semantics.metricKind !== 'amount' ||
      current.evidence.kind !== 'table' ||
      summaryComparison(current, result.facts)
    )
      continue;
    const period = reportingPeriodText(current.period ?? '');
    const year = period.match(/^(20\d{2})年\d{1,2}月期/);
    if (!year) continue;
    const previousPeriod = period.replace(year[1], String(Number(year[1]) - 1));
    const fiscal = previousPeriod.match(/^20\d{2}年\d{1,2}月期/)![0];
    const table = tables.find((table) => table.tableId === current.provenance?.tableId);
    const metricIds = current.evidence.metricIds;
    const axis = table?.metricAxes.find(
      (axis) => canonicalJSON([...axis.sourceIds].sort()) === canonicalJSON([...metricIds].sort())
    );
    if (!axis || !table) continue;
    const candidates: Candidate[] = axis.valueIds.flatMap((valueId) => {
      if (attempted.has(valueId)) return [];
      // The prior year must be explicitly owned by this cell's source period axis.
      // Review below independently proves the quarter, cumulative/standalone and state.
      const periodAxis = table.periodAxes.find((axis) => axis.valueIds.includes(valueId));
      if (reportingPeriodText(periodAxis?.text ?? '').match(/20\d{2}年\d{1,2}月期/)?.[0] !== fiscal)
        return [];
      attempted.add(valueId);
      const { qualifiers: _qualifiers, conditions: _conditions, ...meaning } = current.semantics;
      void _qualifiers;
      void _conditions;
      return [
        {
          candidateId: `c${++nextId}`,
          importance: current.importance,
          kind: 'number',
          source: {
            kind: 'table',
            valueId,
            tableId: table.tableId,
            contextBindingId: `ctx:${valueId}`,
          },
          meaning: { ...meaning, period: previousPeriod },
        },
      ];
    });
    if (!candidates.length) continue;
    const checked = reviewCandidates(
      JSON.stringify({
        candidateVersion: CANDIDATE_VERSION,
        documentType,
        candidates,
        unverified: [],
      }),
      documentType,
      pages,
      context
    );
    const pair = summaryComparison(current, [...result.facts, ...checked.facts]);
    // A valid cell alone is insufficient: preserve uniqueness and full comparison semantics.
    if (pair && checked.facts.some((fact) => fact.id === pair.reference.id))
      result.facts.push(pair.reference);
    result.diagnostics.push(
      ...checked.diagnostics.map((diagnostic) => ({
        ...diagnostic,
        check: `comparison.${diagnostic.check}`,
      }))
    );
    result.unverified.push(...checked.unverified);
    for (const [id, source] of checked.candidateSources) result.candidateSources.set(id, source);
    for (const [id, kind] of checked.candidateKinds) result.candidateKinds.set(id, kind);
  }
  return result;
}
