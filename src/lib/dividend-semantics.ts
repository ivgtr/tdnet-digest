/** An unchanged forecast cites a prior announcement, not a dividend payment date.
 * The bounded grammar proves the principal per-share amount and retains the
 * breakdown and unchanged predicate in the original assertion.
 */
export function unchangedDividendReference(
  text: string
): { raw: string; start: number; breakdown: string | null } | null {
  const source = text.normalize('NFKC').replace(/\s/g, '');
  const match = source.match(
    /^なお、?配当予想につきましては20\d{2}年\d{1,2}月\d{1,2}日公表の1株当たり(\d+(?:\.\d+)?円)(?:\((普通配当\d+(?:\.\d+)?円、記念配当\d+(?:\.\d+)?円)\))?より変更はございません。?$/
  );
  if (!match) return null;
  const start = source.indexOf('1株当たり') + '1株当たり'.length;
  return { raw: match[1], start, breakdown: match[2] ?? null };
}
export function unchangedDividend(text: string): boolean {
  return (
    /配当予想の変更はありません/.test(text.normalize('NFKC').replace(/\s/g, '')) ||
    unchangedDividendReference(text) !== null
  );
}
export function quantityPeriodAxis(text: string, label: string): string {
  return label === '配当予想' && unchangedDividendReference(text)
    ? text.normalize('NFKC').replace(/20\d{2}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日(?=\s*公表)/, '')
    : text;
}
