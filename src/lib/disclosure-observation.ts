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
  REPORTING_FISCAL_PERIOD_PATTERN,
  reportingPeriodText,
  reportingPeriodShapes,
} from './period-semantics';
import {
  checkText,
  quantitySourceClosure,
  type NarrativeLine,
  type NarrativeValue,
} from './summary-narrative';
import { literalValue, quantityChange } from './summary-narrative-renderer';
import type { SourceExcerpt } from './summary-source-inventory';
import type { ContentRole } from './summary-content-policy';
import type { SourceProvenance } from './source-provenance';

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
  state: FactSemantics['state'];
  valueId: string;
  rateId: string | null;
}
export interface DisclosureContext {
  topic: ObservationTopic;
  entity: string | null;
  scope: string | null;
  basis: string | null;
  period: string | null;
  state: FactSemantics['state'];
  conditions: string[];
  sourceIds: string[];
}
export interface DisclosureObservation extends DisclosureContext {
  id: string;
  metric: string;
  measure: (typeof OBSERVATION_MEASURES)[number];
  valueId: string;
  comparison: ObservationComparison | null;
}
/** Derived only from saved, confirmed facts; never accepted from the model's wire format. */
export interface ConfirmedObservation extends DisclosureObservation {
  sourceBasis: Pick<SourceProvenance, 'denominator' | 'adjustments'>;
  comparisonSourceBasis: Pick<SourceProvenance, 'denominator' | 'adjustments'> | null;
  unresolved: boolean;
}
export const adjustmentLabels: Record<SourceProvenance['adjustments'][number]['basis'], string> = {
  splitAdjusted: '株式分割調整済み',
  beforeSplit: '株式分割前',
  afterSplit: '株式分割後',
};
export function observationBasis(
  value: DisclosureObservation | ConfirmedObservation,
  comparison = false
): string[] {
  if (!('sourceBasis' in value)) return [];
  const basis = comparison ? value.comparisonSourceBasis : value.sourceBasis;
  if (!basis) return [];
  return [
    ...(basis.denominator && !/[1１]株(?:当たり|あたり)/.test(value.metric) ? ['1株当たり'] : []),
    ...new Set(basis.adjustments.map((a) => adjustmentLabels[a.basis])),
  ];
}
export interface DisclosureExplanation extends NarrativeLine, DisclosureContext {}
const named = (v: unknown): v is string => typeof v === 'string' && !!v.trim() && v.length <= 1000;
export const nullableName = (v: unknown) => v === null || named(v);
const member = (list: readonly string[], v: unknown) => typeof v === 'string' && list.includes(v);
export const contextKeys = [
  'topic',
  'entity',
  'scope',
  'basis',
  'period',
  'state',
  'conditions',
  'sourceIds',
];
export function contextShape(value: unknown): value is DisclosureContext {
  return (
    record(value) &&
    member(OBSERVATION_TOPICS, value.topic) &&
    nullableName(value.entity) &&
    nullableName(value.scope) &&
    nullableName(value.basis) &&
    nullableName(value.period) &&
    member(OBSERVATION_STATES, value.state) &&
    Array.isArray(value.conditions) &&
    value.conditions.every(named)
  );
}
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
    contextShape(value) &&
    named(value.metric) &&
    member(OBSERVATION_MEASURES, value.measure) &&
    nullableName(value.period) &&
    member(OBSERVATION_STATES, value.state) &&
    named(value.valueId) &&
    Array.isArray(value.conditions) &&
    value.conditions.every(named) &&
    (value.comparison === null ||
      (record(value.comparison) &&
        exact(value.comparison, ['axis', 'period', 'state', 'valueId', 'rateId']) &&
        member(OBSERVATION_STATES, value.comparison.state) &&
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
  // An explicit fiscal quarter is a period coordinate, regardless of its label spelling.
  // Unknown company-specific periods remain for independent review; no date is invented.
  if (value.period && value.comparison) {
    const coordinate = (label: string) => {
      const text = reportingPeriodText(label);
      if (!new RegExp(`^${REPORTING_FISCAL_PERIOD_PATTERN}$`).test(text)) return null;
      const fiscal = [...text.matchAll(/(20\d{2})年(\d{1,2})月期/g)];
      const shapes = reportingPeriodShapes(text);
      return fiscal.length === 1 && shapes.length <= 1
        ? { year: Number(fiscal[0][1]), month: Number(fiscal[0][2]), shape: shapes[0] ?? '通期' }
        : null;
    };
    const now = coordinate(value.period),
      before = coordinate(value.comparison.period);
    if (now && before) {
      const yearly =
        now.year === before.year + 1 && now.month === before.month && now.shape === before.shape;
      const same =
        now.year === before.year && now.month === before.month && now.shape === before.shape;
      if (
        (value.comparison.axis === 'yearOnYear' && !yearly) ||
        (value.comparison.axis === 'revision' && !same) ||
        (value.comparison.axis === 'periodEnd' && yearly && before.shape !== '通期')
      )
        throw new Error('OBSERVATION_PERIOD:比較軸と明示された報告期間の組が不一致です');
    }
  }
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
  if (value.measure === 'profit' || value.measure === 'flow') {
    const compact = (text: string) => text.normalize('NFKC').replace(/[\s・･]/g, '');
    const rows = excerpts.filter(
      (e) =>
        sourceIds.includes(e.id) &&
        e.kind === 'row' &&
        compact(e.text).includes(compact(value.metric))
    );
    for (const selected of [current, previous]) {
      if (!selected?.decimal || selected.decimal.startsWith('-')) continue;
      const witnesses = values.filter(
        (q) =>
          q.unit === selected.unit &&
          q.decimal?.replace(/^-/, '') === selected.decimal &&
          rows.some((e) => e.spanIds.includes(q.id))
      );
      if (
        witnesses.some((q) => q.decimal!.startsWith('-')) &&
        !witnesses.some((q) => !q.decimal!.startsWith('-'))
      )
        throw new Error('OBSERVATION_QUANTITY:符号付き収支の根拠表と正の数量が矛盾しています');
    }
  }
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
  return canonicalJSON([value.topic, value.scope, value.basis, value.conditions]);
}
export function observationChange(
  value: DisclosureObservation | ConfirmedObservation,
  values: NarrativeValue[]
): { text: string; calculated: boolean } {
  if ('unresolved' in value && value.unresolved)
    return { text: '指標区分・比較は未確認', calculated: false };
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
export const factPeriodName = (f: VerifiedFact) =>
  f.period && f.semantics.periodKind.startsWith('cumulativeQ') && !/累計|中間期/.test(f.period)
    ? `${f.period}累計`
    : f.period && f.semantics.periodKind.startsWith('standaloneQ') && !/単独/.test(f.period)
      ? `${f.period}単独`
      : f.period;
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
): ConfirmedObservation {
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
  const sourceBasis = {
    denominator: fact.provenance?.denominator ?? null,
    adjustments: fact.provenance?.adjustments ?? [],
  };
  const basisSources = new Set([
    ...(sourceBasis.denominator?.sourceIds ?? []),
    ...sourceBasis.adjustments.map((a) => a.noteId),
  ]);
  const sourceIds = [
    ...new Set([
      ...excerpts.filter((e) => e.blockId === owner || e.spanIds.includes(owner)).map((e) => e.id),
      ...excerpts
        .filter((e) => basisSources.has(e.blockId) || e.spanIds.some((id) => basisSources.has(id)))
        .map((e) => e.id),
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
    period: factPeriodName(fact),
    state: fact.semantics.state,
    valueId: fact.id,
    comparison: pair
      ? {
          axis: pair.axis === 'revision' ? 'revision' : 'yearOnYear',
          period: factPeriodName(pair.reference) ?? '比較期間',
          state: pair.reference.semantics.state,
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
    sourceBasis,
    comparisonSourceBasis: pair
      ? {
          denominator: pair.reference.provenance?.denominator ?? null,
          adjustments: pair.reference.provenance?.adjustments ?? [],
        }
      : null,
    unresolved: false,
  };
}

/** Only disjoint, explicitly understood meanings are contradictions. Free-form labels,
 * aliases and missing metadata still belong to the independent semantic review. */
function contradictsConfirmedContext(
  confirmed: DisclosureObservation,
  claimed: DisclosureObservation
): boolean {
  const compact = (value: string | null) => value?.normalize('NFKC').replace(/\s/g, '') ?? null;
  const scope = (value: string | null) => {
    const text = compact(value);
    return text === '連結'
      ? 'consolidated'
      : /^(個別|単体|非連結)$/.test(text ?? '')
        ? 'separate'
        : null;
  };
  const basis = (value: string | null) => {
    const text = compact(value)?.toUpperCase();
    return text === 'IFRS' || text === '国際会計基準'
      ? 'IFRS'
      : text === '日本基準' || text === '米国基準'
        ? text
        : null;
  };
  const period = (value: string | null) => {
    if (!value) return null;
    const text = reportingPeriodText(value);
    if (!new RegExp(`^${REPORTING_FISCAL_PERIOD_PATTERN}$`).test(text)) return null;
    const fiscal = text
      .match(/^(20\d{2})年(\d{1,2})月期/)!
      .slice(1)
      .map(Number)
      .join(':');
    const shape = reportingPeriodShapes(text)[0] ?? '通期';
    const qualifier = /単独/.test(text)
      ? '単独'
      : /累計|中間期/.test(text) || shape === '第1四半期'
        ? '累計'
        : null;
    return { fiscal, shape, qualifier };
  };
  const different = (a: string | null, b: string | null) => a !== null && b !== null && a !== b;
  const numericStates = ['actual', 'forecast', 'forecastBefore', 'forecastAfter'];
  const stateConflict =
    numericStates.includes(confirmed.state) &&
    numericStates.includes(claimed.state) &&
    confirmed.state !== claimed.state &&
    !(
      [confirmed.state, claimed.state].includes('forecast') &&
      confirmed.state.startsWith('forecast') &&
      claimed.state.startsWith('forecast')
    );
  const before = period(confirmed.period),
    after = period(claimed.period);
  const periodConflict =
    before &&
    after &&
    (before.fiscal !== after.fiscal ||
      before.shape !== after.shape ||
      different(before.qualifier, after.qualifier));
  return (
    stateConflict ||
    (confirmed.measure !== 'other' &&
      claimed.measure !== 'other' &&
      confirmed.measure !== claimed.measure) ||
    different(reportingMetricKey(confirmed.metric), reportingMetricKey(claimed.metric)) ||
    different(scope(confirmed.scope), scope(claimed.scope)) ||
    different(basis(confirmed.basis), basis(claimed.basis)) ||
    !!periodConflict
  );
}

/** Join independently reviewed relationships with confirmed amounts by native identity. */
export function reconcileObservations(
  facts: FactSummary,
  observations: DisclosureObservation[],
  excerpts: SourceExcerpt[],
  values: NarrativeValue[]
): {
  primary: Map<string, ConfirmedObservation>;
  supplement: DisclosureObservation[];
  conflicts: DisclosureObservation[];
} {
  const native = (id: string) => {
    const fact = facts.facts.find((f) => f.id === id);
    return fact?.evidence.kind === 'table'
      ? fact.evidence.valueId
      : fact?.evidence.kind === 'prose'
        ? (fact.evidence.quantityId ?? id)
        : id;
  };
  const primary = new Map(
    facts.facts
      .filter((f) => f.quantity)
      .map((f) => [f.id, factObservation(f, facts, excerpts, values)])
  );
  const supplement: DisclosureObservation[] = [];
  const conflicts: DisclosureObservation[] = [];
  const periodKey = (period: string | null) =>
    period &&
    reportingPeriodText(period)
      .replace(/(20\d{2})年0?(\d{1,2})月期/, '$1年$2月期')
      .replace(/^(20\d{2}年\d{1,2}月期)通期$/, '$1')
      .replace(/中間期(?:累計)?(?:期間)?$/, '第2四半期累計')
      .replace(/\((累計|単独)\)(?:期間)?$/, '$1')
      .replace(/(累計|単独)期間$/, '$1');
  const grouped = new Map<string, DisclosureObservation[]>();
  const owners = new Map<string, ConfirmedObservation[]>();
  for (const confirmed of primary.values()) {
    const id = native(confirmed.valueId);
    owners.set(id, [...(owners.get(id) ?? []), confirmed]);
  }
  const contradicted = (claim: DisclosureObservation) => {
    const confirmed = owners.get(native(claim.valueId)) ?? [];
    // One physical quantity may legitimately have several confirmed contexts.
    // A compatible or ambiguous owner prevents declaring a clear contradiction.
    return (
      confirmed.length > 0 && confirmed.every((value) => contradictsConfirmedContext(value, claim))
    );
  };
  for (const observation of observations) {
    // Resolve physical identity before semantic matching: a changed state/metric
    // must not escape reconciliation as a supposedly new quantity. Apply the same
    // rule to comparison operands, even when the current quantity is supplemental.
    if (
      contradicted(observation) ||
      (observation.comparison && contradicted({ ...observation, ...observation.comparison }))
    ) {
      conflicts.push(observation);
      continue;
    }
    const matches = [...primary.values()].filter(
      (p) =>
        native(p.valueId) === native(observation.valueId) &&
        (observation.entity === null || observation.entity === p.entity) &&
        observation.metric === p.metric &&
        observation.state === p.state &&
        (observation.period === null || periodKey(observation.period) === periodKey(p.period)) &&
        (observation.scope === null || observation.scope === p.scope) &&
        (observation.basis === null || observation.basis === p.basis)
    );
    if (matches.length !== 1) {
      supplement.push(observation);
      continue;
    }
    const current = matches[0];
    grouped.set(current.id, [...(grouped.get(current.id) ?? []), observation]);
  }
  const comparisonKey = (comparison: ObservationComparison) =>
    canonicalJSON([
      native(comparison.valueId),
      comparison.axis,
      periodKey(comparison.period),
      comparison.state,
    ]);
  for (const [id, reviewed] of grouped) {
    const current = primary.get(id)!;
    const measures = new Set(
      [current, ...reviewed].map((o) => o.measure).filter((measure) => measure !== 'other')
    );
    const comparisons = [current, ...reviewed].flatMap((o) => (o.comparison ? [o.comparison] : []));
    const rateIds = new Set(comparisons.flatMap((c) => (c.rateId ? [native(c.rateId)] : [])));
    const comparisonBasis = (fact: VerifiedFact) =>
      canonicalJSON([
        fact.semantics.subject,
        fact.semantics.scope,
        fact.semantics.basis,
        fact.semantics.metricKind,
        fact.semantics.qualifiers,
        fact.semantics.conditions,
        fact.provenance?.denominator
          ? [fact.provenance.denominator.value, fact.provenance.denominator.unit]
          : null,
        fact.provenance?.adjustments ?? [],
      ]);
    const fact = facts.facts.find((f) => f.id === id)!;
    const compatibleReference = (c: ObservationComparison, f: VerifiedFact) =>
      native(f.id) === native(c.valueId) &&
      comparisonBasis(fact) === comparisonBasis(f) &&
      periodKey(c.period) === periodKey(factPeriodName(f)) &&
      c.state === f.semantics.state;
    const incompatibleReference = comparisons.some((c) => {
      const references = facts.facts.filter((f) => native(f.id) === native(c.valueId));
      return references.length > 0 && !references.some((f) => compatibleReference(c, f));
    });
    if (
      measures.size > 1 ||
      new Set(reviewed.map((o) => o.topic)).size > 1 ||
      new Set(comparisons.map(comparisonKey)).size > 1 ||
      rateIds.size > 1 ||
      incompatibleReference
    ) {
      // Never let order decide which independently reviewed meaning wins. The
      // confirmed amounts remain visible; incompatible review stays unresolved.
      conflicts.push(...reviewed);
      primary.set(id, { ...current, unresolved: true });
      continue;
    }
    const comparison = comparisons[0] ?? null;
    const reference = comparison && facts.facts.find((f) => compatibleReference(comparison, f));
    primary.set(current.id, {
      ...current,
      topic: reviewed[0].topic,
      measure: [...measures][0] ?? 'other',
      comparison: comparison
        ? { ...comparison, rateId: comparisons.find((c) => c.rateId)?.rateId ?? null }
        : null,
      comparisonSourceBasis: reference
        ? {
            denominator: reference.provenance?.denominator ?? null,
            adjustments: reference.provenance?.adjustments ?? [],
          }
        : null,
      conditions: [...new Set([current, ...reviewed].flatMap((o) => o.conditions))],
      sourceIds: [...new Set([current, ...reviewed].flatMap((o) => o.sourceIds))],
    });
  }
  // A comparison value already has a visible place in its owning observation.
  const displayed = [...primary.values(), ...supplement];
  return {
    primary,
    conflicts,
    supplement: supplement.filter(
      (p) =>
        p.comparison ||
        !displayed.some(
          (owner) =>
            owner.comparison &&
            native(owner.comparison.valueId) === native(p.valueId) &&
            owner.entity === p.entity &&
            owner.metric === p.metric &&
            owner.scope === p.scope &&
            owner.basis === p.basis &&
            owner.comparison.state === p.state
        )
    ),
  };
}
