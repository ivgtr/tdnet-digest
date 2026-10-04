import type { FactSemantics } from './fact-contract';
import { REPORTING_FISCAL_PERIOD_PATTERN, reportingPeriodText } from './period-semantics';
import { unchangedDividendReference } from './dividend-semantics';

const compact = (text: string) => text.normalize('NFKC').replace(/\s/g, '');
// A bare profit/loss does not prove net profit. Require an owner, reporting
// period qualifier, or explicit 純, shared by source and coverage checks.
const netProfitOwner = '(?:親会社株主に帰属する|親会社の所有者に帰属する)';
const netProfitPeriod = '(?:当期|四半期|中間)';
export const NET_PROFIT_METRIC = `(?:${netProfitOwner}${netProfitPeriod}?純?|${netProfitPeriod}純?|純)(?:利益|損失)`;

const perShare = /1株|一株|株当たり|EPS/i;
const currency = /^(?:千|百万|億)?円$|^(?:ドル|USD|EUR)$/;

/** Full EPS names preserve the basic/diluted qualifier during prose searches. */
const perShareProfitName = '1株(?:当たり|あたり)(?:当期|四半期|中間)?純?(?:利益|損失)|\\bEPS\\b';
export const PER_SHARE_PROFIT_METRIC = `(?:(?:基本的|希薄化後|潜在株式調整後)?(?:${perShareProfitName}))`;
export const BASIC_PER_SHARE_PROFIT_METRIC = `(?:(?:基本的)?(?:${perShareProfitName}))`;
/** A numbered field at a physical line start is a boundary, unlike a wrapped noun. */
export const proseFieldText = (text: string) =>
  text.normalize('NFKC').replace(/\n(?=\s*\(\d+\))/g, '；');
/** Only explicit owners, calendar/fiscal axes and field punctuation may precede a bare metric. */
export function proseMetricPrefixMatches(prefix: string, owners: string[] = []): boolean {
  let rest = reportingPeriodText(prefix)
    .replace(/^\(\d+\)/, '')
    .replace(/^\(+/, '');
  const declared = [
    ...new Set([...owners, '当社グループ', '当社', '当グループ'].map(compact)),
  ].sort((a, b) => b.length - a.length);
  const removeOwners = () => {
    for (const owner of declared) {
      const escaped = compact(owner).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      rest = rest.replace(new RegExp(`^${escaped}(?:の|は)?`), '');
    }
  };
  removeOwners();
  rest = rest.replace(
    new RegExp(
      `^(?:${REPORTING_FISCAL_PERIOD_PATTERN}|20\\d{2}年\\d{1,2}月(?:\\d{1,2}日|度)?)(?:の|は|における)?`
    ),
    ''
  );
  removeOwners();
  return rest === '';
}
/** Standard profit/loss alternatives and loss markers remain part of the full label. */
const profitLabel = (name: string) => `(?:${name})(?:又は(?:${name}|利益|損失))?(?:\\(△\\))?`;
const amountProfitMetrics = [
  ['operatingProfit', profitLabel('営業(?:利益|損失)')],
  ['ordinaryProfit', profitLabel('経常(?:利益|損失)')],
  ['netProfit', profitLabel(NET_PROFIT_METRIC)],
] as const;
export const PROSE_METRIC_BRIDGE_PATTERN =
  '(?:について|に関して|に対して|において|として|[はがをにでと、:()])';
/** Direct metric occurrences are shared by declaration, allocation and quantity boundaries. */
export const PROSE_REPORTING_METRIC_PATTERN = `(?:${PER_SHARE_PROFIT_METRIC}|(?:売上高)?営業利益率|年間配当金|売上高|売上収益|営業収益|${amountProfitMetrics.map(([, pattern]) => pattern).join('|')}|MRR|ARR)`;
export function proseReportingMetrics(
  text: string,
  extraPattern = '',
  owners: string[] = []
): Array<{ label: string; start: number; end: number }> {
  const pattern = `(${PROSE_REPORTING_METRIC_PATTERN}${extraPattern ? '|' + extraPattern : ''})(?:${PROSE_METRIC_BRIDGE_PATTERN}{1,6}|(?=[0-9]))`;
  const source = compact(proseFieldText(text));
  return [...source.matchAll(new RegExp(pattern, 'gi'))]
    .filter((m) => {
      // A suffix of an adjusted/qualified name is not a declaration of the bare metric.
      const prefix = source
        .slice(0, m.index)
        .split(/[、,。;；:「」]/)
        .slice(-1)[0]!;
      return proseMetricPrefixMatches(prefix, owners);
    })
    .map((m) => ({
      label: m[1],
      start: m.index!,
      end: m.index! + m[0].length,
    }));
}
/** Reporting aliases share an identity; EPS basis, period and profit/loss remain distinct. */
export function reportingMetricKey(label: string): string | null {
  const text = compact(label);
  if (new RegExp(`^${PER_SHARE_PROFIT_METRIC}$`, 'i').test(text))
    return `eps:${perShareProfitKeys(text)[0]}`;
  if (/^(売上高|売上収益|営業収益)$/.test(text)) return 'revenue';
  const amount = amountProfitMetrics.find(([, pattern]) => new RegExp(`^${pattern}$`).test(text));
  if (amount) return amount[0];
  if (/^(?:売上高)?営業利益率$/.test(text)) return 'operatingMargin';
  if (text === '年間配当金') return 'annualDividend';
  if (/^(MRR|ARR)$/i.test(text)) return text.toUpperCase();
  return null;
}
/** Bare EPS denotes basic annual profit; explicit qualifiers remain distinct. */
export function perShareProfitKeys(text: string): string[] {
  return [...compact(text).matchAll(new RegExp(PER_SHARE_PROFIT_METRIC, 'gi'))].map(
    (m) =>
      `${/^(?:希薄化後|潜在株式調整後)/.test(m[0]) ? 'diluted' : 'basic'}:${m[0].match(/当期|四半期|中間/)?.[0] ?? '当期'}:${m[0].match(/利益|損失/)?.[0] ?? '利益'}`
  );
}
export function isPerShareProfit(label: string): boolean {
  return perShareProfitKeys(label).length > 0;
}

/** 単位と分母の明記を優先し、配当総額を1株配当へ読み替えない。 */
export function isPerShareDividend(label: string, unit: string | null, source = ''): boolean {
  const text = compact(label),
    normalizedUnit = unit === null ? '' : compact(unit);
  if (
    !/配当/.test(text) ||
    /率|比率|前年比|前年同期比/.test(text) ||
    !currency.test(normalizedUnit)
  )
    return false;
  if (perShare.test(text)) return true;
  if (text === '配当予想' && normalizedUnit === '円' && unchangedDividendReference(source))
    return true;
  return normalizedUnit === '円' && /配当金/.test(text) && !/総額|合計額|支払額|総配当/.test(text);
}

export function classifyMetric(
  label: string,
  unit: string | null,
  source = ''
): FactSemantics['metricKind'] {
  const text = compact(label),
    normalizedUnit = unit === null ? '' : compact(unit);
  if (/率|比率|前年比|前年同期比/.test(text) || /[%％]/.test(normalizedUnit)) return 'rate';
  if (perShare.test(text) || isPerShareDividend(label, unit, source)) return 'perShare';
  if (/円|ドル|USD|EUR/.test(normalizedUnit)) return 'amount';
  if (/^(株|人|件|店舗|社|個)$/.test(normalizedUnit)) return 'count';
  return unit ? 'other' : 'none';
}
