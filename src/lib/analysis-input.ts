import { canonicalJSON, hashText, type FactSummary } from './fact-contract';
import type { SummaryPresentation } from './summary-presentation';
import {
  supportedExplanations,
  reconciledOrganizationObservations,
  unresolvedExplanationSources,
  unresolvedTableSources,
} from './summary-organization';
import { comparisonAxisLabels, factPeriodName } from './disclosure-observation';
import { renderNarrativeText, literalValue } from './summary-narrative-renderer';
import { stateLabels } from './summary-renderer';
import { buildAnalysisCalculations } from './analysis-calculations';

export interface AnalysisEvidence {
  id: string;
  kind: 'fact' | 'observation' | 'explanation' | 'calculation';
  text: string;
  context: string;
  sourceIds: string[];
  pages: number[];
}
export interface AnalysisCoverage {
  facts: number;
  explanations: number;
  observations: number;
  calculations: number;
  pages: number[];
  organizationStatus: SummaryPresentation['organization']['status'];
  unresolvedSources: number;
  unverifiedFacts: number;
  unverifiedItems: number;
  unverifiedSourcePages: number[];
  limitations: string[];
}
export interface AnalysisInput {
  documentType: FactSummary['documentType'];
  inputHash: string;
  evidence: AnalysisEvidence[];
  coverage: AnalysisCoverage;
}
const unique = <T>(values: T[]) => [...new Set(values)];

/** Callers revalidate the presentation against the PDF before generation. No raw
 * excerpt or unreviewed claim is silently promoted to analytical evidence. */
export function buildAnalysisInput(
  facts: FactSummary,
  presentation: SummaryPresentation
): AnalysisInput {
  const pagesOf = (ids: string[]) =>
    unique(
      ids.flatMap((id) => {
        const excerpt = presentation.excerpts.find(
          (e) => e.id === id || e.blockId === id || e.spanIds.includes(id)
        );
        const fact = facts.facts.find((f) => f.id === id);
        return excerpt ? [excerpt.page] : fact ? [fact.page] : [];
      })
    ).sort((a, b) => a - b);
  const evidence: AnalysisEvidence[] = facts.facts.map((f) => {
    const sourceIds = unique([
      f.id,
      ...(f.quantity?.sourceIds ?? []),
      ...f.evidence.contextIds,
      ...f.evidence.scopeIds,
      ...f.evidence.qualifierIds,
      ...(f.evidence.kind === 'prose'
        ? [f.evidence.blockId]
        : [
            f.evidence.valueId,
            ...f.evidence.metricIds,
            ...f.evidence.periodIds,
            ...f.evidence.unitIds,
          ]),
      ...(f.provenance?.denominator?.sourceIds ?? []),
      ...(f.provenance?.adjustments.map((a) => a.noteId) ?? []),
      ...(f.dateRoles?.map((d) => d.sourceId) ?? []),
    ]);
    const quantity =
      f.quantity?.decimal != null
        ? `${f.quantity.decimal}${f.unit ?? ''}`
        : f.quantity && 'lower' in f.quantity
          ? `${f.quantity.lower}～${f.quantity.upper}${f.unit ?? ''}`
          : `${f.value ?? ''}${f.unit ?? ''}`;
    return {
      id: `fact:${f.id}`,
      kind: 'fact',
      text: f.statement ?? `${f.label}: ${quantity}`,
      context: [
        f.semantics.subject,
        f.semantics.scope,
        f.semantics.basis,
        factPeriodName(f),
        stateLabels[f.semantics.state],
        ...(f.semantics.polarity === 'affirmative'
          ? []
          : [f.semantics.polarity === 'negative' ? '否定' : '肯定・否定混在']),
        ...f.semantics.qualifiers,
        ...f.semantics.conditions,
        ...(f.provenance?.denominator ? ['1株当たり'] : []),
        ...(f.provenance?.adjustments.map((a) => a.text) ?? []),
        ...(f.dateRoles?.map((d) => `${d.state}: ${d.date}`) ?? []),
      ]
        .filter(Boolean)
        .join(' / '),
      sourceIds,
      pages: unique([f.page, ...pagesOf(sourceIds)]).sort((a, b) => a - b),
    };
  });

  const explanations = supportedExplanations(presentation.organization);
  const reconciled = reconciledOrganizationObservations(
    presentation.organization,
    facts,
    presentation.values,
    presentation.excerpts
  );
  const observations = reconciled.accepted;
  for (const [kind, items] of [
    ['explanation', explanations],
    ['observation', observations],
  ] as const) {
    for (const item of items) {
      const mergedFactId = kind === 'observation' ? reconciled.merged.get(item.id) : undefined;
      const text =
        'metric' in item
          ? `${item.metric}: ${
              mergedFactId
                ? `確定事実 fact:${mergedFactId} の同じ原数量への補足（区分: ${item.measure}）`
                : literalValue(presentation.values.find((v) => v.id === item.valueId)!)
            }${item.comparison ? ` / ${comparisonAxisLabels[item.comparison.axis]} ${item.comparison.period} ${stateLabels[item.comparison.state]}: ${literalValue(presentation.values.find((v) => v.id === item.comparison!.valueId)!)}` : ''}`
          : renderNarrativeText(item.text, presentation.values);
      evidence.push({
        id: `${kind}:${item.id}`,
        kind,
        text,
        context: [
          item.entity,
          item.scope,
          item.basis,
          item.period,
          stateLabels[item.state],
          ...item.conditions.map((c) => renderNarrativeText(c, presentation.values)),
        ]
          .filter(Boolean)
          .join(' / '),
        sourceIds: unique([...item.sourceIds, ...(mergedFactId ? [mergedFactId] : [])]),
        pages: pagesOf([...item.sourceIds, ...(mergedFactId ? [mergedFactId] : [])]),
      });
    }
  }
  const calculations = buildAnalysisCalculations(facts, presentation);
  for (const c of calculations) {
    const parents = evidence.filter(
      (e) =>
        c.sourceFactIds.some((id) => e.id === `fact:${id}`) ||
        c.sourceObservationIds.some((id) => e.id === `observation:${id}`)
    );
    evidence.push({
      id: c.id,
      kind: 'calculation',
      text: `${c.label}: ${c.value}${c.unit}（${c.formula}）。${c.caveat}`,
      context: unique(parents.map((e) => e.context)).join(' / '),
      sourceIds: unique([...c.sourceIds, ...parents.flatMap((e) => e.sourceIds)]),
      pages: unique([...pagesOf(c.sourceIds), ...parents.flatMap((e) => e.pages)]).sort(
        (a, b) => a - b
      ),
    });
  }
  // Rejection coverage is independent of paragraph coverage: a surviving claim
  // about progress does not restore a rejected explanation of one-off profit.
  const unverified = [
    ...presentation.organization.issues,
    ...[...presentation.organization.claims, ...presentation.organization.observations].filter(
      (item) => typeof presentation.organization.review?.claims[item.id] === 'string'
    ),
    ...reconciled.conflicts,
  ];
  const limitations: string[] = [];
  if (unverified.length)
    limitations.push(
      '説明・指標の生成・点検に未確認または不採用の項目があります。同じ原文の別の説明が採用されても、増減要因・一時要因・時期・条件の全体が確認済みになったわけではありません。不採用部分の内容を推測したり、資料に記載がないと断定したりしないでください。'
    );
  if (presentation.organization.status !== 'ready')
    limitations.push(
      '今回の確認済み入力は資料全体の説明・指標を網羅していません。継続性や達成見込みの判断には、未確認の要因・条件が影響する可能性があります。'
    );
  const coverage: AnalysisCoverage = {
    facts: facts.facts.length,
    explanations: explanations.length,
    observations: observations.length,
    calculations: calculations.length,
    pages: unique(evidence.flatMap((e) => e.pages)).sort((a, b) => a - b),
    organizationStatus: presentation.organization.status,
    unresolvedSources: unique([
      ...unresolvedExplanationSources(presentation.organization, presentation.excerpts).map(
        (e) => e.id
      ),
      ...unresolvedTableSources(
        presentation.organization,
        facts,
        presentation.values,
        presentation.excerpts
      ).map((e) => e.id),
    ]).length,
    unverifiedFacts: facts.unverified.length,
    unverifiedItems: unverified.length,
    unverifiedSourcePages: pagesOf(unverified.flatMap((item) => item.sourceIds)),
    limitations,
  };
  return {
    documentType: facts.documentType,
    evidence,
    coverage,
    inputHash: hashText(
      canonicalJSON({ version: 3, sourceHash: presentation.sourceHash, evidence, coverage })
    ),
  };
}
