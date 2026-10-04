import type { FactSemantics } from './fact-contract';
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
/** Direct metric occurrences are shared by declaration, allocation and quantity boundaries. */
export const PROSE_REPORTING_METRIC_PATTERN = `(?:${PER_SHARE_PROFIT_METRIC}|(?:売上高)?営業利益率|年間配当金|売上高|売上収益|営業収益|営業利益|営業損失|経常利益|経常損失|${NET_PROFIT_METRIC}|MRR|ARR)`;
export function proseReportingMetrics(
  text: string,
  extraPattern = ''
): Array<{ label: string; start: number; end: number }> {
  const pattern = `(${PROSE_REPORTING_METRIC_PATTERN}${extraPattern ? '|' + extraPattern : ''})(?:について(?:は|が)?|は|が|[:：]|(?=[0-9]))`;
  return [...compact(text).matchAll(new RegExp(pattern, 'gi'))].map((m) => ({
    label: m[1],
    start: m.index!,
    end: m.index! + m[0].length,
  }));
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
