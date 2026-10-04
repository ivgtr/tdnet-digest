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
/** Literal syntax only: the source's range is never reduced to one endpoint. */
export function parseExactNumeric(
  raw: string
): ({ kind: 'number' } & ExactQuantity) | ({ kind: 'range' } & ExactRange) | null {
  const range = parseExactRange(raw);
  if (range) return { kind: 'range', ...range };
  const quantity = parseExactQuantity(raw);
  return quantity ? { kind: 'number', ...quantity } : null;
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
/** A bare prose token needs unit evidence, not merely letters that could form a unit.
 * Currency scales, counters and measurement notation are closed lexical forms.
 * A caption identifies the token but cannot turn a bound into a unit.
 * Unknown units remain unverified.
 */
export function isUncaptionedUnit(text: string): boolean {
  const atom =
    /^(?:(?:十|百|千|万|百万|千万|億|兆)?(?:円|ドル|株|個|件|台|人|名|口|店|棟|社|回|本|枚|冊|箱|日|週|月|年|倍|人日|人月|店舗|時間|か月|カ月|ヶ月|箇月|ポイント|トン|キログラム|メートル|リットル|JPY|USD|EUR|GBP|CNY|(?:[afpnumcdhkMGT]|da)?(?:m|g|s|A|K|mol|cd|Hz|N|Pa|J|Wh|W|C|V|F|S|Wb|T|H|L|l|B|bit)[23]?)|bps|pt|px|h|min|d|[\p{Sc}%])$/u;
  return isUnitToken(text) && text.split(/[/·]/).every((part) => atom.test(part));
}

function provedProseUnitLength(text: string): number {
  for (let length = text.length; length > 0; length--)
    if (isUncaptionedUnit(text.slice(0, length))) return length;
  return 0;
}
/** Keep offsets in the NFKC source; whitespace separates quantity tokens, never digits. */
export function proseQuantities(block: { id: string; text: string }) {
  const source = block.text.normalize('NFKC');
  // Calendar references are period/date options, not scalar quantity candidates.
  const calendar = [
    ...source.matchAll(
      /20\d{2}年\s*\d{1,2}月(?:\s*\d{1,2}日|期(?:第[1-4]四半期|中間期|通期)?|度)?/g
    ),
  ].map((m) => ({ start: m.index, end: m.index + m[0].length }));
  const found = [
    ...source.matchAll(
      /((?:[△▲−-]\s*)?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:\s*[～〜~]\s*(?:[△▲−-]\s*)?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)?\s*)(円\s*\d{2}\s*銭|[A-Za-z%/·]+\d+|(?:[\p{L}\p{Sc}%/·](?:[^\S\n]*[\p{L}\p{Sc}%/·])*))/gu
    ),
  ].flatMap((m) => {
    if (calendar.some((c) => m.index < c.end && m.index + m[1].length > c.start)) return [];
    const unitRun = m[2];
    const compactUnit = unitRun.replace(/\s/g, '');
    if (/^円\d{2}銭$/.test(compactUnit) && parseExactQuantity(m[0]))
      return [{ raw: m[0], start: m.index }];
    const boundary = provedProseUnitLength(compactUnit);
    let count = 0,
      end = 0;
    for (; end < unitRun.length && count < boundary; end++) if (!/\s/.test(unitRun[end])) count++;
    const rawUnit = unitRun.slice(0, end);
    if (!isUnitToken(rawUnit.replace(/\s/g, ''))) return [];
    return [{ raw: m[1] + rawUnit, start: m.index }];
  });
  return found.map((q, i) => ({ id: `${block.id}:q${i + 1}`, ...q }));
}
