import type { DocumentType } from './document-type';

/** Display vocabulary only. This policy does not assign financial meaning to PDF text. */
export const CONTENT_TITLES: Record<DocumentType, string> = {
  earnings: '業績・見通し',
  earningsRevision: '業績予想の修正',
  shareholderBenefit: '優待の変更・対象条件',
  dividend: '配当内容・方針',
  shareRepurchase: '取得内容・取得状況',
  stockSplit: '分割・併合内容',
  capitalPolicy: '調達・発行・資金使途',
  ma: '取引内容・目的・影響',
  businessUpdate: '主要KPI・事業進捗',
  governance: '変更内容・体制・対応',
  other: '開示内容',
};

/** Only complete administrative blocks are excluded, never a substantive continuation. */
export function isAdministrativeBlock(text: string): boolean {
  const lines = text
    .normalize('NFKC')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  return (
    lines.length > 0 &&
    lines.every(
      (line) =>
        !/[。;；|]/.test(line) &&
        (/^(?:上場会社名|会社名|コード番号|証券コード|代表者名?|問合せ先|問い合わせ先|電話番号|TEL|URL)(?:\s|[:：])/i.test(
          line
        ) ||
          /^(?:https?:\/\/\S+|各位|以上)$/i.test(line))
    )
  );
}
