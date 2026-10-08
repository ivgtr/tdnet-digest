/** Source vocabulary shared by reporting declarations and their consumers. */
export const reportingScope = '非連結|個別|単体|連結';
export const reportingBasis = '日本基準|IFRS(?:会計基準)?|国際会計基準|米国基準';

/** Read paired source brackets without assigning meaning to an absent capture. */
export function bracketedReportingBases(text: string): string[] {
  return [
    ...text
      .normalize('NFKC')
      .replace(/\s/g, '')
      .matchAll(new RegExp(`〔(${reportingBasis})〕|\\[(${reportingBasis})\\]`, 'gi')),
  ].map((match) => match[1] ?? match[2]);
}

/** Compare supported aliases; source declarations and verified facts keep their wording. */
export function reportingAttributeKey(role: 'subject' | 'scope' | 'basis', value: string): string {
  const text = value.normalize('NFKC').replace(/\s/g, '');
  if (role === 'scope' && /^(?:個別|単体|非連結)$/.test(text)) return '非連結';
  if (role === 'basis' && /^(?:IFRS(?:会計基準)?|国際会計基準)$/i.test(text)) return 'IFRS';
  return text;
}

/** Metadata projection only: a named field can own its immediately adjacent value cell.
 * Never join rows, arbitrary cells, or the source text used for numeric validation.
 */
export function reportingFieldSegments(text: string): string[] {
  const names = '上場会社名|会社名|名称|範囲|会計基準|株式種類|取得対象株式(?:の)?種類';
  const unnumbered = (part: string) => part.replace(/^(?:\(\d+\)|\d+[.．])\s*/, '');
  const fieldName = (part: string) =>
    new RegExp(`^(?:${names}):?$`).test(unnumbered(part.replace(/\s/g, '')));
  const fieldStart = (part: string) =>
    new RegExp(
      `^(?:${names}|上場取引所|コード番号|証券コード|URL|代表者名?|問合せ先|問い合わせ先|電話番号|TEL)`,
      'i'
    ).test(unnumbered(part.replace(/\s/g, '')));
  return text
    .normalize('NFKC')
    .split('\n')
    .flatMap((line) => {
      const cells = line.split(/[|│]/).map((cell) => cell.trim());
      const parts: string[] = [];
      let blockedValue = false;
      for (let i = 0; i < cells.length; i++) {
        if (!cells[i]) continue;
        if (fieldStart(cells[i])) blockedValue = false;
        if (blockedValue) continue;
        const next = cells[i + 1];
        if (fieldName(cells[i]) && next && !fieldStart(next))
          parts.push(`${cells[i]} ${cells[++i]}`);
        else {
          // Bare table-column atoms are not independent metadata declarations.
          if (fieldStart(cells[i]) || !/[|│]/.test(line)) parts.push(cells[i]);
          // A blank or unproved cell relationship cannot lend a later bare value.
          if (fieldName(cells[i]) && next === '') blockedValue = true;
        }
      }
      return parts;
    });
}
