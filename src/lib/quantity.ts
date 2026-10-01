/** Unit syntax is separate from unit meaning. */
export function isUnitToken(text: string): boolean {
  return (
    text.length > 0 && text.length <= 32 && /^(?:[\p{L}\p{Sc}%/·]+|[A-Za-z%/·]+\d+)$/u.test(text)
  );
}
export interface ExactQuantity {
  raw: string;
  decimal: string;
  unit: string | null;
}
export interface ExactRange {
  raw: string;
  lower: string;
  upper: string;
  unit: string | null;
}
export function parseExactRange(raw: string): ExactRange | null {
  const text = raw.normalize('NFKC').replace(/\s/g, ''),
    m = text.match(
      /^([△▲−-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)[～〜~]([△▲−-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)(.*)$/
    );
  if (!m || (m[3] && !isUnitToken(m[3]))) return null;
  const lower = parseExactQuantity(m[1])?.decimal,
    upper = parseExactQuantity(m[2])?.decimal;
  if (!lower || !upper) return null;
  const scale = Math.max(lower.split('.')[1]?.length ?? 0, upper.split('.')[1]?.length ?? 0);
  const integer = (decimal: string) => {
    const [whole, fraction = ''] = decimal.split('.');
    return BigInt(whole + (fraction + '0'.repeat(scale)).slice(0, scale));
  };
  if (integer(lower) > integer(upper)) return null;
  return { raw, lower, upper, unit: m[3] || null };
}
export function parseExactQuantity(raw: string): ExactQuantity | null {
  const text = raw
    .normalize('NFKC')
    .replace(/\s/g, '')
    .replace(/^[△▲−]/, '-');
  const yen = text.match(/^(-?\d+)円(\d{2})銭$/);
  if (yen) return { raw, decimal: `${yen[1]}.${yen[2]}`, unit: '円' };
  const match = text.match(/^(-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)(.*)$/);
  if (!match || (match[2] && !isUnitToken(match[2]))) return null;
  const decimal = match[1].replace(/,/g, '');
  if (!Number.isFinite(Number(decimal))) return null;
  return { raw, decimal, unit: match[2] || null };
}
export function parseQuantity(text: string): { value: number; unit: string | null } | null {
  const parsed = parseExactQuantity(text);
  if (!parsed) return null;
  const value = Number(parsed.decimal);
  // A number claim must survive the decimal round trip; exact source is retained separately.
  if (!quantityNumber(parsed.decimal)) return null;
  return { value, unit: parsed.unit };
}
/** Number conversion must preserve the decimal quantity, including fractions and signs. */
export function quantityNumber(decimal: string): { value: number } | null {
  const value = Number(decimal);
  if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) return null;
  const canonical = (text: string) =>
    text
      .replace(/^(-?)0+(?=\d)/, '$1')
      .replace(/(\.\d*?)0+$/, '$1')
      .replace(/\.$/, '')
      .replace(/^-0$/, '0');
  if (canonical(decimal) !== canonical(String(value))) return null;
  return { value };
}
/** Prefixes may be incomplete; completion is checked only after collecting the entire run. */
export function isQuantityPrefix(text: string): boolean {
  return /^[△▲−-]?(?:\d[\d,]*(?:\.\d*)?)?(?:[～〜~][△▲−-]?(?:\d[\d,]*(?:\.\d*)?)?)?$/.test(
    text.normalize('NFKC').replace(/\s/g, '')
  );
}

/** Explicit unit-caption grammar shared by composition and verification. */
export function declaredQuantityUnit(raw: string): string | null {
  const text = raw.normalize('NFKC').replace(/\s/g, '');
  let unit = text;
  if (text.startsWith('(単位')) {
    const caption = text.match(/^\(単位[:：]?([^()]+)\)$/);
    if (!caption) return null;
    unit = caption[1];
  } else if (text.startsWith('単位')) unit = text.replace(/^単位[:：]?/, '');
  if (unit === '円銭') return '円';
  return isUnitToken(unit) ? unit : null;
}
