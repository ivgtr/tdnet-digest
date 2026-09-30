import type { FactSemantics } from './fact-contract';

const compact = (text: string) => text.normalize('NFKC').replace(/\s/g, '');
const perShare = /1株|一株|株当たり|EPS/i;
const currency = /^(?:千|百万|億)?円$|^(?:ドル|USD|EUR)$/;

/** 単位と分母の明記を優先し、配当総額を1株配当へ読み替えない。 */
export function isPerShareDividend(label: string, unit: string | null): boolean {
  const text = compact(label),
    normalizedUnit = unit === null ? '' : compact(unit);
  if (
    !/配当/.test(text) ||
    /率|比率|前年比|前年同期比/.test(text) ||
    !currency.test(normalizedUnit)
  )
    return false;
  if (perShare.test(text)) return true;
  return normalizedUnit === '円' && /配当金/.test(text) && !/総額|合計額|支払額|総配当/.test(text);
}

export function classifyMetric(label: string, unit: string | null): FactSemantics['metricKind'] {
  const text = compact(label),
    normalizedUnit = unit === null ? '' : compact(unit);
  if (/率|比率|前年比|前年同期比/.test(text) || /[%％]/.test(normalizedUnit)) return 'rate';
  if (perShare.test(text) || isPerShareDividend(label, unit)) return 'perShare';
  if (/円|ドル|USD|EUR/.test(normalizedUnit)) return 'amount';
  if (/^(株|人|件|店舗|社|個)$/.test(normalizedUnit)) return 'count';
  return unit ? 'other' : 'none';
}
