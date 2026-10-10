import { TSE } from './native-disclosure-xml';
import { canonicalJSON, hashText } from './fact-contract';
import type { AnalysisEvidence } from './analysis-input';
import type {
  NativeDisclosure,
  NativeFact,
  NativeContext,
  NativeUnit,
} from './native-disclosure-contract';

const unique = (items: string[]) => [...new Set(items)].sort();
const period = (c: NativeContext) =>
  c.period.instant ?? `${c.period.start ?? '?'}～${c.period.end ?? '?'}`;
const unitName = (u: NativeUnit | undefined) => {
  const name = (value: string) =>
    value.replace(/^\{http:\/\/www\.xbrl\.org\/2003\/(?:iso4217|instance)\}/, '');
  return u
    ? `${u.numerator.map(name).join('×')}${u.denominator.length ? '/' + u.denominator.map(name).join('×') : ''}`
    : '';
};
const contextName = (c: NativeContext | undefined) =>
  c
    ? [
        c.entity.identifier,
        period(c),
        c.valueKind ?? '実績/予想未特定',
        c.consolidation ?? '連結/単体未特定',
        ...c.otherContent,
        ...c.dimensions
          .filter(
            (d) =>
              ![`{${TSE}}ResultForecastAxis`, `{${TSE}}ConsolidatedNonconsolidatedAxis`].includes(
                d.axis
              )
          )
          .map((d) => `${d.axis}=${d.member ?? d.typedValue}`),
      ].join(' / ')
    : '文脈未解決';

/** Exact native bindings remain source values, not broad PDF or prose semantic proof. */
export function nativeAnalysisEvidence(native: NativeDisclosure): AnalysisEvidence[] {
  if (native.status !== 'eligible') return [];
  const contexts = new Map(native.contexts.map((c) => [c.id, c]));
  const units = new Map(native.units.map((u) => [u.id, u]));
  return [
    ...native.facts.map((fact, index) => ({
      id: `native:f${index + 1}`,
      kind: 'nativeFact' as const,
      text: `${fact.concept.qname}: ${fact.value ?? fact.literal} ${unitName(units.get(fact.unitId ?? ''))}（原表記: ${fact.literal} / ${fact.status}）`,
      context: `${contextName(contexts.get(fact.contextId))} / ${fact.file} / ${native.source.zipUrl}`,
      sourceIds: [
        fact.id,
        fact.contextId,
        ...(fact.unitId ? [fact.unitId] : []),
        ...(fact.cellId ? [fact.cellId] : []),
      ],
      pages: [],
    })),
    ...native.passages.map((passage, index) => ({
      id: `native:p${index + 1}`,
      kind: 'nativeSource' as const,
      text: passage.text,
      context: `${passage.file} / HTML原文・意味未点検 / ${native.source.zipUrl}`,
      sourceIds: [passage.id],
      pages: [],
    })),
    ...native.tables.flatMap((table, tableIndex) =>
      table.rows.map((row, rowIndex) => ({
        id: `native:t${tableIndex + 1}r${rowIndex + 1}`,
        kind: 'nativeSource' as const,
        text: row.text,
        context: `${table.file} / ${table.caption ?? 'HTML表'} / ${native.source.zipUrl}`,
        sourceIds: [row.id, ...row.cellIds],
        pages: [],
      }))
    ),
  ];
}
function subtract(a: string, b: string): string {
  const scale = Math.max(a.split('.')[1]?.length ?? 0, b.split('.')[1]?.length ?? 0);
  const integer = (v: string) => {
    const sign = v.startsWith('-') ? -1n : 1n;
    const [whole, fraction = ''] = v.replace(/^-/, '').split('.');
    return sign * BigInt(whole + fraction.padEnd(scale, '0'));
  };
  const value = integer(a) - integer(b);
  const digits = (value < 0n ? -value : value).toString().padStart(scale + 1, '0');
  const text = scale
    ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}`.replace(/\.?0+$/, '')
    : digits;
  return `${value < 0n ? '-' : ''}${text}`;
}
interface Operand {
  f: NativeFact;
  c: NativeContext;
  unit: string;
  key: string;
  additive: boolean;
}
/** All concepts remain readable. Same-period differences use exact source identities;
 * only annotated additive income totals support forecast-minus-cumulative residuals. */
export function nativeAnalysisCalculations(native: NativeDisclosure): AnalysisEvidence[] {
  if (native.status !== 'eligible') return [];
  const contexts = new Map(native.contexts.map((c) => [c.id, c]));
  const units = new Map(native.units.map((u) => [u.id, u]));
  const indices = new Map(native.facts.map((f, index) => [f, index + 1]));
  const operands: Operand[] = native.facts.flatMap((f) => {
    const c = contexts.get(f.contextId);
    const u = units.get(f.unitId ?? '');
    if (
      f.kind !== 'number' ||
      f.status !== 'parsed' ||
      f.value === null ||
      !/^-?\d+(?:\.\d+)?$/.test(f.value) ||
      f.value.length > 100 ||
      !c ||
      !u ||
      !c.valueKind ||
      !c.consolidation ||
      !c.period.start ||
      !c.period.end ||
      c.period.instant ||
      !c.entity.identifier ||
      c.otherContent.length > 0 ||
      c.dimensions.some((d) => d.typedValue !== null)
    )
      return [];
    // Only explicit actual/forecast axis differs across actual/forecast comparisons.
    const dimensions = c.dimensions
      .filter((d) => d.axis !== `{${TSE}}ResultForecastAxis`)
      .map((d) => [d.axis, d.member])
      .sort();
    return [
      {
        f,
        c,
        unit: unitName(u),
        additive:
          f.concept.namespace === TSE &&
          [
            'NetSales',
            'Revenue',
            'OperatingIncome',
            'OrdinaryIncome',
            'ProfitAttributableToOwnersOfParent',
            'ProfitBeforeTax',
            'ProfitBeforeTaxIFRS',
            'OperatingProfitIFRS',
            'OperatingIncomeIFRS',
            'RevenueIFRS',
            'ProfitIFRS',
            'ProfitAttributableToOwnersOfParentIFRS',
          ].includes(f.concept.localName) &&
          u.denominator.length === 0 &&
          u.numerator.length === 1 &&
          /^\{http:\/\/www\.xbrl\.org\/2003\/iso4217\}[A-Z]{3}$/.test(u.numerator[0]),
        key: canonicalJSON([
          f.documentSetId,
          f.concept.namespace,
          f.concept.localName,
          c.entity,
          c.consolidation,
          dimensions,
          [...u.numerator].sort(),
          [...u.denominator].sort(),
        ]),
      },
    ];
  });
  // Duplicate semantic slots (even equal amounts) are ambiguous provenance, so withhold locally.
  const slot = (o: Operand) => canonicalJSON([o.key, o.c.period, o.c.valueKind]);
  const counts = new Map<string, number>();
  for (const o of operands) counts.set(slot(o), (counts.get(slot(o)) ?? 0) + 1);
  const selected = operands.filter((o) => counts.get(slot(o)) === 1);
  const result: AnalysisEvidence[] = [];
  const add = (a: Operand, b: Operand, label: string, caveat: string) => {
    const value = subtract(a.f.value!, b.f.value!);
    const formula = `${a.f.value} − (${b.f.value}) = ${value} ${a.unit}`;
    result.push({
      id: `calc:native:${hashText(canonicalJSON([label, a.f.id, b.f.id, value]))}`,
      kind: 'calculation',
      text: `${a.f.concept.qname} ${label}: ${formula}。${caveat}`,
      context: `${contextName(a.c)} [native:f${indices.get(a.f)}] / 比較対象: ${contextName(b.c)} [native:f${indices.get(b.f)}] / iXBRLの期間・単位・範囲で計算`,
      sourceIds: unique([a.f.id, b.f.id, a.c.id, b.c.id, a.f.unitId!, b.f.unitId!]),
      pages: [],
    });
  };
  const byPeriod = new Map(
    selected.map((o) => [
      canonicalJSON([o.key, o.c.valueKind, o.c.period.start, o.c.period.end]),
      o,
    ])
  );
  const priorYear = (date: string) => `${Number(date.slice(0, 4)) - 1}${date.slice(4)}`;
  // Exact prior-year lookup, not quadratic all-pairs scanning.
  for (const a of selected.filter((o) => o.c.valueKind === 'actual')) {
    const b = byPeriod.get(
      canonicalJSON([a.key, 'actual', priorYear(a.c.period.start!), priorYear(a.c.period.end!)])
    );
    if (b)
      add(
        a,
        b,
        '前年同期間差',
        '会社公表値の差です。端数・会計方針変更・一時要因・継続性を保証しません。'
      );
  }
  const forecasts = new Map<string, Operand[]>();
  const days = (start: string, end: string) => (Date.parse(end) - Date.parse(start)) / 86400000;
  for (const o of selected.filter((o) => o.additive && o.c.valueKind === 'forecast')) {
    if (
      days(o.c.period.start!, o.c.period.end!) < 330 ||
      days(o.c.period.start!, o.c.period.end!) > 370
    )
      continue;
    const key = canonicalJSON([o.key, o.c.period.start]);
    forecasts.set(key, [...(forecasts.get(key) ?? []), o]);
  }
  for (const b of selected.filter((o) => o.additive && o.c.valueKind === 'actual')) {
    const candidates = forecasts.get(canonicalJSON([b.key, b.c.period.start])) ?? [];
    // Multiple annual forecasts are not resolved by proximity, order or amount.
    if (candidates.length !== 1) continue;
    const a = candidates[0];
    if (
      a.c.period.end! > b.c.period.end! &&
      days(b.c.period.start!, b.c.period.end!) > 30 &&
      days(b.c.period.start!, b.c.period.end!) < 330
    )
      add(
        a,
        b,
        '残期間に必要な水準',
        '加算可能な売上・利益の通期予想−累計実績の参考値。独立した会社予想や季節性を調整した達成確率ではありません。'
      );
  }
  return result;
}
