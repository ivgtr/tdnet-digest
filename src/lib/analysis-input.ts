import { nativeAnalysisEvidence, nativeAnalysisCalculations } from './native-analysis';
import { nativeDisclosureModelInput } from './native-disclosure';
import type { ExtractedPage } from '@/types/summaryMetadata';
import { sameSourceLedgerContent } from './source-ledger-identity';
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
import {
  buildSourceLedger,
  sourceLedgerModelInput,
  unrepresentedSourceItems,
  type SourceModelInput,
} from './source-ledger';

export interface AnalysisEvidence {
  id: string;
  kind:
    | 'fact'
    | 'observation'
    | 'explanation'
    | 'calculation'
    | 'source'
    | 'nativeFact'
    | 'nativeSource';
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
  sourceLedger?: {
    sourceHash: string;
    pages: number[];
    failedPages: number[];
    emptyPages: number[];
    /** Original summary selection, not a claim that the retained source was unread. */
    omittedPages: number[];
    rows: number;
    spans: number;
    /** Physical extraction coverage is not semantic completeness. */
    status: 'extracted-source';
  };
}
export interface AnalysisInput {
  documentType: FactSummary['documentType'];
  inputHash: string;
  evidence: AnalysisEvidence[];
  coverage: AnalysisCoverage;
  sourceDocument?: SourceModelInput;
  nativeDocument?: ReturnType<typeof nativeDisclosureModelInput>;
}
const unique = <T>(values: T[]) => [...new Set(values)];

/** Callers revalidate the presentation against the PDF before generation. Raw
 * excerpts remain a distinct unreviewed source kind, never verified operands. */
export function buildAnalysisInput(
  facts: FactSummary,
  presentation: SummaryPresentation,
  sourcePages?: ExtractedPage[]
): AnalysisInput {
  if (
    sourcePages &&
    presentation.sourceLedger &&
    !sameSourceLedgerContent(
      buildSourceLedger(sourcePages, facts.documentType),
      presentation.sourceLedger
    )
  )
    throw new Error('分析用原資料と再抽出したPDFが一致しません');
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
  const factEvidence = new Map(evidence.map((item) => [item.id, item]));
  for (const [kind, items] of [
    ['explanation', explanations],
    ['observation', observations],
  ] as const) {
    for (const item of items) {
      const mergedFactId = kind === 'observation' ? reconciled.merged.get(item.id) : undefined;
      // Each selectable reference must stand on its own. A model may cite this
      // supplement without citing its parent fact (or put the parent in a rejected
      // issue), so retain the parent's value and complete verified context here.
      const mergedFact = mergedFactId ? factEvidence.get(`fact:${mergedFactId}`)! : undefined;
      const text =
        'metric' in item
          ? `${
              mergedFact
                ? `${mergedFact.text}（同じ原数量への補足・区分: ${item.measure}）`
                : `${item.metric}: ${literalValue(presentation.values.find((v) => v.id === item.valueId)!)}`
            }${item.comparison ? ` / ${comparisonAxisLabels[item.comparison.axis]} ${item.comparison.period} ${stateLabels[item.comparison.state]}: ${literalValue(presentation.values.find((v) => v.id === item.comparison!.valueId)!)}` : ''}`
          : renderNarrativeText(item.text, presentation.values);
      evidence.push({
        id: `${kind}:${item.id}`,
        kind,
        text,
        context: [
          mergedFact?.context,
          item.entity,
          item.scope,
          item.basis,
          item.period,
          stateLabels[item.state],
          ...item.conditions.map((c) => renderNarrativeText(c, presentation.values)),
        ]
          .filter(Boolean)
          .join(' / '),
        sourceIds: unique([...item.sourceIds, ...(mergedFact?.sourceIds ?? [])]),
        pages: unique([...pagesOf(item.sourceIds), ...(mergedFact?.pages ?? [])]).sort(
          (a, b) => a - b
        ),
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
  const ledger = presentation.sourceLedger;
  // Literal source rows are readable/citable without silently promoting them to
  // verified facts or admitting their quantities into verified-only arithmetic.
  if (ledger) {
    for (const row of ledger.rows) {
      evidence.push({
        id: `raw:${row.id}`,
        kind: 'source',
        text: row.text,
        context: '抽出原文（意味未点検）',
        sourceIds: [row.id, ...row.spanIds],
        pages: [row.page],
      });
    }
  }
  if (ledger) {
    const owned = new Set(ledger.rows.flatMap((row) => row.spanIds));
    for (const page of ledger.pages) {
      for (const item of unrepresentedSourceItems(page)) {
        evidence.push({
          id: `rawitem:${item.id}`,
          kind: 'source',
          text: item.text,
          context: '原抽出文字（行・表への対応・意味未点検）',
          sourceIds: [item.id],
          pages: [page.pageNumber],
        });
      }
      for (const span of page.spans.filter((span) => !owned.has(span.id))) {
        evidence.push({
          id: `rawspan:${span.id}`,
          kind: 'source',
          text: span.text,
          context: '抽出文字セル（行への対応・意味未点検）',
          sourceIds: [span.id],
          pages: [page.pageNumber],
        });
      }
    }
  }
  const sourceDocument = ledger ? sourceLedgerModelInput(ledger) : undefined;
  const native =
    presentation.sourceFirst?.nativeMode === 'included'
      ? presentation.sourceFirst.native
      : undefined;
  const nativeCalculations = native ? nativeAnalysisCalculations(native) : [];
  if (native) evidence.push(...nativeAnalysisEvidence(native), ...nativeCalculations);
  const nativeDocument = native ? nativeDisclosureModelInput(native) : undefined;
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
  if (!presentation.sourceFirst && presentation.organization.status !== 'ready')
    limitations.push(
      '今回の確認済み入力は資料全体の説明・指標を網羅していません。継続性や達成見込みの判断には、未確認の要因・条件が影響する可能性があります。'
    );
  if (presentation.sourceFirst)
    limitations.push(
      '原資料を直接読んだAI文章です。構造化事実の未抽出を資料の未開示と扱いません。数値と指標・期間の対応や因果の意味は原資料で確認してください。',
      ...presentation.sourceFirst.warnings
    );
  const coverage: AnalysisCoverage = {
    facts: facts.facts.length,
    explanations: explanations.length,
    observations: observations.length,
    calculations: calculations.length + nativeCalculations.length,
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
    unverifiedFacts: presentation.sourceFirst ? 0 : facts.unverified.length,
    unverifiedItems: unverified.length,
    unverifiedSourcePages: pagesOf(unverified.flatMap((item) => item.sourceIds)),
    limitations,
    ...(ledger
      ? {
          sourceLedger: {
            sourceHash: ledger.sourceHash,
            pages: ledger.pages.map((p) => p.pageNumber),
            failedPages: ledger.pages.filter((p) => p.status === 'failed').map((p) => p.pageNumber),
            emptyPages: ledger.pages.filter((p) => p.status === 'empty').map((p) => p.pageNumber),
            omittedPages: ledger.pages
              .filter((p) => p.selection === 'omitted')
              .map((p) => p.pageNumber),
            rows: ledger.rows.length,
            spans: ledger.pages.reduce((n, p) => n + p.spans.length, 0),
            status: 'extracted-source' as const,
          },
        }
      : {}),
  };
  return {
    documentType: facts.documentType,
    evidence,
    coverage,
    ...(sourceDocument ? { sourceDocument } : {}),
    ...(nativeDocument ? { nativeDocument } : {}),
    inputHash: hashText(
      canonicalJSON({
        version: 5,
        sourceHash: presentation.sourceHash,
        evidence,
        coverage,
        ...(sourceDocument ? { sourceDocument } : {}),
        ...(nativeDocument ? { nativeDocument } : {}),
      })
    ),
  };
}
