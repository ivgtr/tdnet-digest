import {
  exact,
  record,
  canonicalJSON,
  type FactSummary,
  type FactSemantics,
  type VerifiedFact,
} from './fact-contract';
import { reportingMetricKey } from './metric-semantics';
import { summaryComparison } from './summary-comparison';
import {
  checkText,
  quantitySourceClosure,
  type NarrativeLine,
  type NarrativeValue,
} from './summary-narrative';
import { literalValue, quantityChange } from './summary-narrative-renderer';
import type { SourceExcerpt } from './summary-source-inventory';
import type { ContentRole } from './summary-content-policy';

/** Meaning, not a table layout. Company-specific metrics and periods remain named data. */
export const OBSERVATION_TOPICS = [
  'performance',
  'business',
  'orders',
  'cash',
  'position',
  'forecast',
  'dividend',
  'transaction',
  'other',
] as const;
export const OBSERVATION_MEASURES = [
  'revenue',
  'profit',
  'loss',
  'flow',
  'stock',
  'rate',
  'other',
] as const;
export const OBSERVATION_STATES = [
  'actual',
  'forecast',
  'forecastBefore',
  'forecastAfter',
  'planned',
  'decided',
  'contracted',
  'completed',
  'unspecified',
] as const;
export const COMPARISON_AXES = ['yearOnYear', 'periodEnd', 'sequential', 'revision'] as const;
export type ObservationTopic = (typeof OBSERVATION_TOPICS)[number];
export interface ObservationComparison {
  axis: (typeof COMPARISON_AXES)[number];
  period: string;
  valueId: string;
  rateId: string | null;
}
export interface DisclosureObservation {
  id: string;
  topic: ObservationTopic;
  entity: string | null;
  scope: string | null;
  basis: string | null;
  metric: string;
  measure: (typeof OBSERVATION_MEASURES)[number];
  period: string | null;
  state: FactSemantics['state'];
  valueId: string;
  comparison: ObservationComparison | null;
  conditions: string[];
  sourceIds: string[];
}
export interface DisclosureExplanation extends NarrativeLine {
  topic: ObservationTopic;
  entity: string | null;
}
const named = (v: unknown): v is string => typeof v === 'string' && !!v.trim() && v.length <= 1000;
export const nullableName = (v: unknown) => v === null || named(v);
const member = (list: readonly string[], v: unknown) => typeof v === 'string' && list.includes(v);
const keys = [
  'topic',
  'entity',
  'scope',
  'basis',
  'metric',
  'measure',
  'period',
  'state',
  'valueId',
  'comparison',
  'conditions',
  'sourceIds',
];
export function observationShape(value: unknown, saved = false): value is DisclosureObservation {
  return (
    record(value) &&
    exact(value, saved ? ['id', ...keys] : keys) &&
    (!saved || (typeof value.id === 'string' && /^observation-\d+$/.test(value.id))) &&
    member(OBSERVATION_TOPICS, value.topic) &&
    nullableName(value.entity) &&
    nullableName(value.scope) &&
    nullableName(value.basis) &&
    named(value.metric) &&
    member(OBSERVATION_MEASURES, value.measure) &&
    nullableName(value.period) &&
    member(OBSERVATION_STATES, value.state) &&
    named(value.valueId) &&
    Array.isArray(value.conditions) &&
    value.conditions.every(named) &&
    (value.comparison === null ||
      (record(value.comparison) &&
        exact(value.comparison, ['axis', 'period', 'valueId', 'rateId']) &&
        member(COMPARISON_AXES, value.comparison.axis) &&
        named(value.comparison.period) &&
        named(value.comparison.valueId) &&
        nullableName(value.comparison.rateId)))
  );
}
export function observationTokens(value: DisclosureObservation): string {
  return [value.valueId, value.comparison?.valueId, value.comparison?.rateId]
    .filter(Boolean)
    .map((id) => `{{value:${id}}}`)
    .join(' ');
}
export function observationLine(value: DisclosureObservation): NarrativeLine {
  return {
    id: value.id,
    sourceIds: value.sourceIds,
    text: JSON.stringify({
      ...value,
      sourceIds: undefined,
      id: undefined,
      quantities: observationTokens(value),
    }),
  };
}
/** Bind quantities to their native owners; meanings are independently reviewed as a tuple. */
export function checkObservation(
  value: DisclosureObservation,
  values: NarrativeValue[],
  excerpts: SourceExcerpt[],
  facts: FactSummary,
  compile = false
): string[] {
  const tokens = observationTokens(value);
  const sourceIds = compile
    ? quantitySourceClosure(
        [tokens, ...value.conditions].join(' '),
        value.sourceIds,
        values,
        excerpts,
        facts
      )
    : value.sourceIds;
  checkText(tokens, sourceIds, values, excerpts, facts, true);
  for (const text of [
    value.entity,
    value.scope,
    value.basis,
    value.metric,
    value.period,
    value.comparison?.period,
    ...value.conditions,
  ].filter((s): s is string => !!s))
    checkText(text, sourceIds, values, excerpts, facts, true);
  const current = values.find((q) => q.id === value.valueId)!;
  const previous = value.comparison
    ? values.find((q) => q.id === value.comparison!.valueId)!
    : null;
  if (!current.unit || (previous && (current.unit !== previous.unit || current.id === previous.id)))
    throw new Error('OBSERVATION_QUANTITY:数量の単位・比較対象を確認できません');
  if (
    value.comparison?.rateId &&
    values.find((q) => q.id === value.comparison!.rateId)?.unit !== '%'
  )
    throw new Error('OBSERVATION_QUANTITY:開示増減率の単位が不正です');
  if (value.measure === 'loss' && [current, previous].some((q) => q?.decimal?.startsWith('-')))
    throw new Error('OBSERVATION_QUANTITY:正の損失額と符号付き損益を混同しています');
  return sourceIds;
}
export function observationRole(topic: ObservationTopic): ContentRole | null {
  return {
    performance: 'performance',
    business: 'performance',
    orders: 'operations',
    cash: 'finance',
    position: 'finance',
    forecast: 'outlook',
    dividend: 'dividend',
    transaction: 'content',
    other: null,
  }[topic] as ContentRole | null;
}
export const observationTitles: Record<ObservationTopic, string> = {
  performance: '業績',
  business: '事業別業績',
  orders: '受注・需要の動き',
  cash: 'キャッシュフロー',
  position: '財政状態',
  forecast: '業績予想',
  dividend: '配当',
  transaction: '取引・実施内容',
  other: '開示された指標',
};
export const comparisonAxisLabels: Record<ObservationComparison['axis'], string> = {
  yearOnYear: '前年同期',
  periodEnd: '前期末',
  sequential: '前期間',
  revision: '修正前',
};
export function observationGroup(value: DisclosureObservation): string {
  return canonicalJSON([
    value.topic,
    value.period,
    value.state,
    value.scope,
    value.basis,
    value.conditions,
  ]);
}
export function observationChange(
  value: DisclosureObservation,
  values: NarrativeValue[]
): { text: string; calculated: boolean } {
  if (!value.comparison) return { text: '', calculated: false };
  const current = values.find((q) => q.id === value.valueId)!;
  const previous = values.find((q) => q.id === value.comparison!.valueId)!;
  if (current.decimal === null || previous.decimal === null)
    return { text: '範囲値の比較', calculated: false };
  const rate = value.comparison.rateId
    ? values.find((q) => q.id === value.comparison!.rateId)!
    : null;
  const change = quantityChange(
    current,
    previous,
    value.measure === 'rate' || value.measure === 'other' ? 'flow' : value.measure
  );
  // A loss transition or a zero/negative base cannot be evaluated as ordinary growth.
  if (
    rate &&
    value.measure !== 'flow' &&
    value.measure !== 'rate' &&
    value.measure !== 'other' &&
    !current.decimal.startsWith('-') &&
    /[1-9]/.test(current.decimal) &&
    !previous.decimal.startsWith('-') &&
    /[1-9]/.test(previous.decimal)
  )
    return {
      text: change.replace(/ 約[^（]+/, `（原文 ${literalValue(rate)}）`),
      calculated: false,
    };
  return {
    text: value.measure === 'rate' ? change.replace(/%/g, 'ポイント') : change,
    calculated: change.includes('約'),
  };
}
export function canPair(amount: VerifiedFact, rate: VerifiedFact): boolean {
  if (
    rate.semantics.metricKind !== 'rate' ||
    amount.semantics.metricKind === 'rate' ||
    amount.label !== rate.label ||
    amount.evidence.kind !== 'table' ||
    rate.evidence.kind !== 'table'
  )
    return false;
  const key = (f: VerifiedFact) =>
    canonicalJSON([
      f.period,
      f.valueKind,
      f.semantics.subject,
      f.semantics.scope,
      f.semantics.basis,
      f.evidence.kind === 'table'
        ? [f.evidence.metricIds, f.evidence.periodIds, f.evidence.contextIds]
        : null,
      f.provenance?.tableId,
      f.semantics.qualifiers,
      f.semantics.conditions,
      f.provenance?.adjustments,
    ]);
  return key(amount) === key(rate);
}
/** Existing verified facts enter the same view model without reinterpreting their evidence. */
export function factObservation(
  fact: VerifiedFact,
  facts: FactSummary,
  excerpts: SourceExcerpt[],
  values: NarrativeValue[]
): DisclosureObservation {
  const pair = summaryComparison(fact, facts.facts);
  const metric = reportingMetricKey(fact.label);
  const rates = facts.facts.filter((rate) => canPair(fact, rate));
  const measure =
    fact.semantics.metricKind === 'rate'
      ? 'rate'
      : metric === 'revenue' || metric === 'MRR' || metric === 'ARR'
        ? 'revenue'
        : metric && (metric.endsWith('Profit') || metric.startsWith('eps:'))
          ? /損失$/.test(fact.label) &&
            !fact.quantity!.decimal?.startsWith('-') &&
            !pair?.reference.quantity!.decimal?.startsWith('-')
            ? 'loss'
            : 'profit'
          : 'other';
  const owner = fact.evidence.kind === 'table' ? fact.evidence.valueId : fact.evidence.blockId;
  const sourceIds = [
    ...new Set([
      ...excerpts.filter((e) => e.blockId === owner || e.spanIds.includes(owner)).map((e) => e.id),
      ...values
        .filter(
          (q) =>
            q.id === fact.id ||
            q.id === pair?.reference.id ||
            (rates.length === 1 && q.id === rates[0].id)
        )
        .flatMap((q) => q.sourceIds),
    ]),
  ];
  return {
    id: fact.id,
    topic: fact.semantics.state.startsWith('forecast') ? 'forecast' : 'performance',
    entity: fact.semantics.subject,
    scope: fact.semantics.scope,
    basis: fact.semantics.basis,
    metric: fact.label,
    measure,
    period: fact.period,
    state: fact.semantics.state,
    valueId: fact.id,
    comparison: pair
      ? {
          axis: pair.axis === 'revision' ? 'revision' : 'yearOnYear',
          period: pair.reference.period ?? '比較期間',
          valueId: pair.reference.id,
          rateId: rates.length === 1 ? rates[0].id : null,
        }
      : null,
    conditions: [
      ...new Set([
        ...fact.semantics.qualifiers,
        ...fact.semantics.conditions,
        ...(pair
          ? [...pair.reference.semantics.qualifiers, ...pair.reference.semantics.conditions]
          : []),
      ]),
    ],
    sourceIds,
  };
}
