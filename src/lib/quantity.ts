/** 単位は原文の文字列で照合する。通貨・株式等の指標別リストには依存しない。 */
export function isUnitToken(text: string): boolean {
  return (
    text.length > 0 && text.length <= 32 && /^(?:[\p{L}\p{Sc}%/·]+|[A-Za-z%/·]+\d+)$/u.test(text)
  );
}

export function parseQuantity(text: string): { value: number; unit: string | null } | null {
  const normalized = text
    .normalize('NFKC')
    .replace(/[\s,，]/g, '')
    .replace(/^[△▲]/, '-');
  const yenSen = normalized.match(/^(-?\d+)円(\d{2})銭$/);
  if (yenSen) return { value: Number(`${yenSen[1]}.${yenSen[2]}`), unit: '円' };
  const match = normalized.match(/^(-?\d+(?:\.\d+)?)(.*)$/);
  if (!match || (match[2] && !isUnitToken(match[2]))) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? { value, unit: match[2] || null } : null;
}
