import {
  canonicalJSON,
  hashText,
  type FactSummary,
  type FactSemantics,
  type VerifiedFact,
} from './fact-contract';
import { classifyMetric, reportingMetricKey } from './metric-semantics';
import { sourceQualifiers } from './fact-validation';
import { isUncaptionedUnit } from './quantity';
import { factPeriodName, type DisclosureObservation } from './disclosure-observation';
import {
  periodKind,
  REPORTING_FISCAL_PERIOD_PATTERN,
  reportingPeriodText,
} from './period-semantics';
import { summaryComparison } from './summary-comparison';
import { supportedObservations } from './summary-organization';
import type { NarrativeValue } from './summary-narrative';
import type { SummaryPresentation } from './summary-presentation';

/** Calculated references are not additional verified facts or company forecasts. */
export interface AnalysisCalculation {
  id: string;
  kind: 'difference' | 'progress' | 'remaining' | 'cashFlowTotal';
  label: string;
  value: string;
  unit: string;
  formula: string;
  sourceFactIds: string[];
  sourceObservationIds: string[];
  sourceIds: string[];
  caveat: string;
}
interface FiscalPeriod {
  year: number;
  month: number;
  kind: FactSemantics['periodKind'];
}
interface Operand {
  nativeId: string;
  label: string;
  metric: string;
  income: boolean;
  loss: boolean;
  cash: 'operating' | 'investing' | null;
  entity: string | null;
  documentCompany: boolean;
  scope: string | null;
  basis: string | null;
  conditions: string[];
  adjustments: unknown[];
  period: string;
  fiscal: FiscalPeriod;
  state: FactSemantics['state'];
  decimal: string;
  unit: string;
  sourceFactIds: string[];
  sourceObservationIds: string[];
  sourceIds: string[];
}
const unique = (values: string[]) => [...new Set(values)].sort();
const compact = (value: string) => value.normalize('NFKC').replace(/\s/g, '');

/** No interval/uncertainty propagation is implemented. Bounds, approximations and
 * preliminary amounts therefore never enter exact point-value arithmetic. */
function nonPoint(texts: string[]): boolean {
  return texts.some((raw) => {
    const text = compact(raw);
    return (
      sourceQualifiers(raw).some((q) =>
        ['上限', '下限', '概算額', '概算', '速報値', '約'].includes(q)
      ) ||
      /^(?:約|以上|以下|未満|超|超過)$/.test(text) ||
      [
        ...text.matchAll(/(?:[0-9]|\}\})([\p{L}\p{Sc}%/·]*?)(?:以上|以下|未満|超|程度|前後)/gu),
      ].some((m) => !m[1] || isUncaptionedUnit(m[1])) ||
      /(?:およそ|約)(?=[0-9]|\{\{value:)/.test(text) ||
      /[≤≥≦≧<>]|最大|最小|少なくとも|多くとも/.test(text)
    );
  });
}

function fiscalPeriod(period: string | null, fact?: VerifiedFact): FiscalPeriod | null {
  if (!period) return null;
  const text = reportingPeriodText(period);
  if (!new RegExp(`^${REPORTING_FISCAL_PERIOD_PATTERN}$`).test(text)) return null;
  const match = text.match(/^(20\d{2})年(\d{1,2})月期/);
  if (!match || Number(match[2]) < 1 || Number(match[2]) > 12) return null;
  try {
    // A verified fact can prove a cumulative qualifier in its source rather than its label.
    const kind = periodKind(period, fact ? (factPeriodName(fact) ?? period) : period);
    if (fact && kind !== fact.semantics.periodKind) return null;
    return { year: Number(match[1]), month: Number(match[2]), kind };
  } catch {
    return null;
  }
}

function metric(label: string) {
  const name = compact(label);
  const key = reportingMetricKey(label);
  // Keep ownership and profit/loss definitions; only the reporting-period word may differ.
  const identity = key === 'netProfit' ? name.replace(/当期|四半期|中間/g, '') : name;
  // The only additional metric vocabulary needed by this component is the two CF totals.
  const cash = name.match(
    /^(営業|投資)(?:活動によるキャッシュ[・･]?フロー|CF|キャッシュ[・･]?フロー)$/i
  );
  return {
    metric: canonicalJSON([key, identity]),
    income: ['revenue', 'operatingProfit', 'ordinaryProfit', 'netProfit'].includes(key ?? ''),
    cash: cash ? (cash[1] === '営業' ? 'operating' : 'investing') : null,
  } as Pick<Operand, 'metric' | 'income' | 'cash'>;
}

function aligned(a: string, b: string) {
  const scale = Math.max(a.split('.')[1]?.length ?? 0, b.split('.')[1]?.length ?? 0);
  const integer = (decimal: string) => {
    const [whole, fraction = ''] = decimal.split('.');
    return BigInt(whole + fraction.padEnd(scale, '0'));
  };
  return { a: integer(a), b: integer(b), scale };
}
function decimal(integer: bigint, scale: number): string {
  const digits = (integer < 0n ? -integer : integer).toString().padStart(scale + 1, '0');
  const value = scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits;
  return (integer < 0n ? '-' : '') + value.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}
const scalar = (
  value: NarrativeValue | undefined
): value is NarrativeValue & { decimal: string; unit: string } =>
  !!value &&
  !!value.unit &&
  value.decimal !== null &&
  value.decimal.length <= 128 &&
  /^-?\d+(?:\.\d+)?$/.test(value.decimal) &&
  value.sourceIds.length > 0 &&
  !nonPoint([value.raw]);
const amount = (label: string, unit: string) => classifyMetric(label, unit) === 'amount';
const context = (operand: Operand, includeMetric = true) =>
  canonicalJSON([
    operand.entity,
    operand.documentCompany,
    operand.scope,
    operand.basis,
    operand.unit,
    includeMetric ? operand.metric : null,
    includeMetric ? operand.loss : null,
    operand.conditions,
    operand.adjustments,
  ]);
const explicitContext = (operand: Operand) =>
  (!!operand.entity || operand.documentCompany) && !!operand.scope && !!operand.basis;
const samePeriod = (a: Operand, b: Operand) => canonicalJSON(a.fiscal) === canonicalJSON(b.fiscal);
const title = (operand: Operand) =>
  [
    operand.entity ?? (operand.documentCompany ? '全社' : null),
    operand.scope,
    operand.period,
    operand.label,
  ]
    .filter(Boolean)
    .join(' ');

/** Safe, bounded arithmetic over checked meanings and their presentation quantity registry. */
export function buildAnalysisCalculations(
  facts: FactSummary,
  presentation: SummaryPresentation
): AnalysisCalculation[] {
  const values = new Map<string, NarrativeValue>();
  const duplicateValues = new Set<string>();
  for (const value of presentation.values) {
    if (values.has(value.id)) duplicateValues.add(value.id);
    values.set(value.id, value);
  }
  const lookup = (id: string) => (duplicateValues.has(id) ? undefined : values.get(id));
  const native = (id: string) => {
    const fact = facts.facts.find((f) => f.id === id);
    return fact?.evidence.kind === 'table'
      ? fact.evidence.valueId
      : fact?.evidence.kind === 'prose'
        ? (fact.evidence.quantityId ?? fact.id)
        : id;
  };
  const knownFacts = new Map<string, VerifiedFact[]>();
  for (const fact of facts.facts) {
    const id = native(fact.id);
    knownFacts.set(id, [...(knownFacts.get(id) ?? []), fact]);
  }
  const factOperands = new Map<string, Operand>();
  for (const fact of facts.facts) {
    const value = lookup(fact.id);
    const fiscal = fiscalPeriod(fact.period, fact);
    if (
      fact.kind !== 'number' ||
      fact.semantics.metricKind !== 'amount' ||
      fact.semantics.polarity !== 'affirmative' ||
      nonPoint([
        ...fact.semantics.qualifiers,
        ...fact.semantics.conditions,
        fact.label,
        fact.quote,
        fact.quantity?.raw ?? '',
      ]) ||
      fact.quantity?.decimal == null ||
      !scalar(value) ||
      !amount(fact.label, value.unit) ||
      value.unit !== fact.unit ||
      value.decimal !== fact.quantity.decimal ||
      !fiscal
    )
      continue;
    factOperands.set(fact.id, {
      nativeId: native(fact.id),
      label: fact.label,
      ...metric(fact.label),
      loss: /損失(?:\(△\))?$/.test(compact(fact.label)),
      entity: fact.semantics.subject,
      documentCompany: false,
      scope: fact.semantics.scope,
      basis: fact.semantics.basis,
      conditions: unique([...fact.semantics.qualifiers, ...fact.semantics.conditions]),
      adjustments: fact.provenance?.adjustments ?? [],
      period: factPeriodName(fact)!,
      fiscal,
      state: fact.semantics.state,
      decimal: value.decimal,
      unit: value.unit,
      sourceFactIds: [fact.id],
      sourceObservationIds: [],
      sourceIds: unique(value.sourceIds),
    });
  }
  const fromObservation = (
    observation: DisclosureObservation,
    comparison = false
  ): Operand | null => {
    const selected = comparison ? observation.comparison : observation;
    if (!selected) return null;
    const value = lookup(selected.valueId);
    const fiscal = fiscalPeriod(selected.period);
    const nativeId = native(selected.valueId);
    const references = knownFacts.get(nativeId) ?? [];
    const known = references.length === 1 ? factOperands.get(references[0].id) : undefined;
    if (
      (references.length > 0 && !known) ||
      nonPoint([...observation.conditions, observation.metric]) ||
      !scalar(value) ||
      !amount(observation.metric, value.unit) ||
      observation.measure === 'rate' ||
      !fiscal
    )
      return null;
    const meaning = metric(observation.metric);
    const operand: Operand = {
      nativeId,
      label: observation.metric,
      ...meaning,
      income: meaning.income && ['revenue', 'profit'].includes(observation.measure),
      cash: observation.measure === 'flow' ? meaning.cash : null,
      loss: observation.measure === 'loss' || /損失(?:\(△\))?$/.test(compact(observation.metric)),
      entity: observation.entity,
      // The observation contract explicitly uses null for whole-company context.
      // This is distinct from a verified fact whose subject was not established.
      documentCompany: observation.entity === null,
      scope: observation.scope,
      basis: observation.basis,
      conditions: unique(observation.conditions),
      adjustments: [],
      period: selected.period!,
      fiscal,
      state: selected.state,
      decimal: value.decimal,
      unit: value.unit,
      sourceFactIds: [],
      sourceObservationIds: [observation.id],
      sourceIds: unique([...observation.sourceIds, ...value.sourceIds]),
    };
    if (!known) return operand;
    // Native cell/prose aliases carry the same eligibility and verified context as
    // fact IDs, including comparison operands. Review cannot erase a fact's bounds,
    // conditions, scope or adjustment basis by selecting its presentation alias.
    if (
      context({ ...operand, adjustments: known.adjustments }) !== context(known) ||
      !samePeriod(operand, known) ||
      operand.state !== known.state ||
      operand.decimal !== known.decimal
    )
      return null;
    return {
      ...known,
      sourceObservationIds: operand.sourceObservationIds,
      sourceIds: unique([...known.sourceIds, ...operand.sourceIds]),
    };
  };
  const observations = supportedObservations(
    presentation.organization,
    facts,
    presentation.values,
    presentation.excerpts
  );
  const observationOperands = observations.flatMap((o) => {
    const operand = fromObservation(o);
    return operand ? [operand] : [];
  });
  // The same native quantity may also appear as a reviewed observation. Prefer the
  // verified fact; an optional, less-specific observation must not replace its context.
  const factsByNative = new Set([...factOperands.values()].map((o) => o.nativeId));
  const operands = [
    ...factOperands.values(),
    ...observationOperands.filter((o) => !factsByNative.has(o.nativeId)),
  ];
  const calculations = new Map<string, AnalysisCalculation>();
  const emit = (
    kind: AnalysisCalculation['kind'],
    label: string,
    value: string,
    unit: string,
    formula: string,
    caveat: string,
    inputs: Operand[]
  ) => {
    const id = `calc:${kind}:${hashText(canonicalJSON(inputs.map((o) => o.nativeId)))}`;
    const existing = calculations.get(id);
    calculations.set(id, {
      id,
      kind,
      label,
      value,
      unit,
      formula,
      caveat,
      sourceFactIds: unique([
        ...inputs.flatMap((o) => o.sourceFactIds),
        ...(existing?.sourceFactIds ?? []),
      ]),
      sourceObservationIds: unique([
        ...inputs.flatMap((o) => o.sourceObservationIds),
        ...(existing?.sourceObservationIds ?? []),
      ]),
      sourceIds: unique([...inputs.flatMap((o) => o.sourceIds), ...(existing?.sourceIds ?? [])]),
    });
  };
  const difference = (now: Operand, before: Operand, axis: 'year' | 'revision') => {
    if (now.nativeId === before.nativeId || context(now) !== context(before)) return;
    const valid =
      axis === 'revision'
        ? now.state === 'forecastAfter' &&
          before.state === 'forecastBefore' &&
          samePeriod(now, before)
        : now.state === 'actual' &&
          before.state === 'actual' &&
          now.fiscal.year === before.fiscal.year + 1 &&
          now.fiscal.month === before.fiscal.month &&
          now.fiscal.kind === before.fiscal.kind;
    if (!valid) return;
    const numbers = aligned(now.decimal, before.decimal);
    const value = decimal(numbers.a - numbers.b, numbers.scale);
    emit(
      'difference',
      `${title(now)}：${axis === 'year' ? '前年同期' : '予想修正'}差額`,
      value,
      now.unit,
      `${now.decimal}${now.unit} − ${before.decimal}${before.unit} = ${value}${now.unit}`,
      now.loss
        ? '開示された損失額の単純差額です。符号付き利益や増減率ではありません。'
        : '確認済みの同条件の数量を差し引いた参考値です。',
      [now, before]
    );
  };
  for (const fact of facts.facts) {
    const now = factOperands.get(fact.id);
    if (!now) continue;
    const comparison = summaryComparison(fact, facts.facts);
    const before = comparison && factOperands.get(comparison.reference.id);
    if (comparison && before) difference(now, before, comparison.axis);
  }
  for (const observation of observations) {
    const axis = observation.comparison?.axis;
    if (axis !== 'yearOnYear' && axis !== 'revision') continue;
    const now = fromObservation(observation),
      before = fromObservation(observation, true);
    if (now && before) difference(now, before, axis === 'revision' ? 'revision' : 'year');
  }
  for (const actual of operands) {
    if (
      !explicitContext(actual) ||
      !actual.income ||
      actual.loss ||
      actual.state !== 'actual' ||
      !/^cumulativeQ[1-3]$/.test(actual.fiscal.kind)
    )
      continue;
    const compatible = (other: Operand) =>
      context(actual) === context(other) &&
      actual.fiscal.year === other.fiscal.year &&
      actual.fiscal.month === other.fiscal.month;
    const current = operands.filter(
      (o) => compatible(o) && o.state === 'actual' && samePeriod(actual, o)
    );
    const forecasts = operands.filter(
      (o) =>
        compatible(o) &&
        o.fiscal.kind === 'fullYear' &&
        (o.state === 'forecast' || o.state === 'forecastAfter')
    );
    if (current.length !== 1 || forecasts.length !== 1) continue;
    const forecast = forecasts[0];
    if (actual.nativeId === forecast.nativeId) continue;
    const numbers = aligned(forecast.decimal, actual.decimal);
    const remaining = decimal(numbers.a - numbers.b, numbers.scale);
    emit(
      'remaining',
      `${title(actual)}：通期予想との差し引き残額`,
      remaining,
      actual.unit,
      `通期予想 ${forecast.decimal}${forecast.unit} − 累計実績 ${actual.decimal}${actual.unit} = ${remaining}${actual.unit}`,
      '通期予想−累計実績の機械的な差し引きです。会社が開示した残り期間の予想や業績予想の修正を意味しません。',
      [forecast, actual]
    );
    if (numbers.a <= 0n || numbers.b < 0n) continue;
    const tenths = (numbers.b * 1000n + numbers.a / 2n) / numbers.a;
    const progress = `${tenths / 10n}.${tenths % 10n}`;
    emit(
      'progress',
      `${title(actual)}：通期予想に対する進捗率`,
      progress,
      '%',
      `${actual.decimal}${actual.unit} ÷ ${forecast.decimal}${forecast.unit} × 100 ≈ ${progress}%`,
      '累計実績÷通期予想×100を小数第1位に丸めた参考値です。季節性や今後の達成を評価したものではありません。',
      [actual, forecast]
    );
  }
  for (const operating of operands) {
    if (
      operating.cash !== 'operating' ||
      operating.state !== 'actual' ||
      !explicitContext(operating)
    )
      continue;
    const compatible = (o: Operand) =>
      o.state === 'actual' &&
      samePeriod(operating, o) &&
      context(o, false) === context(operating, false);
    const sources = operands.filter((o) => o.cash === 'operating' && compatible(o));
    const targets = operands.filter((o) => o.cash === 'investing' && compatible(o));
    if (sources.length !== 1 || targets.length !== 1 || targets[0].nativeId === operating.nativeId)
      continue;
    const investing = targets[0],
      numbers = aligned(operating.decimal, investing.decimal);
    const total = decimal(numbers.a + numbers.b, numbers.scale);
    emit(
      'cashFlowTotal',
      `${operating.entity ?? '全社'} ${operating.scope} ${operating.period}：営業CF＋投資CF`,
      total,
      operating.unit,
      `${operating.decimal}${operating.unit} + (${investing.decimal}${investing.unit}) = ${total}${operating.unit}`,
      '営業CFと投資CFの単純合計です。会社が定義したフリーキャッシュフローや現金残高の増減ではありません。',
      [operating, investing]
    );
  }
  return [...calculations.values()].sort((a, b) => a.id.localeCompare(b.id));
}
