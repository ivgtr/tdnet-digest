import type { DocumentType } from './document-type';
import type { VerifiedFact } from './fact-contract';

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

export type ContentRole =
  | 'content'
  | 'performance'
  | 'outlook'
  | 'dividend'
  | 'finance'
  | 'operations'
  | 'reason'
  | 'purpose'
  | 'target'
  | 'impact'
  | 'timing'
  | 'conditions'
  | 'notes'
  | 'document'
  | 'unclassified';
type SectionPolicy = readonly [ContentRole, string];
export const SECTION_POLICIES: Record<DocumentType, readonly SectionPolicy[]> = {
  earnings: [
    ['performance', '業績と増減要因'],
    ['outlook', '通期見通し・前提'],
    ['dividend', '配当'],
    ['finance', '財政状態・資金の動き'],
    ['operations', '事業・施策'],
    ['notes', 'その他の重要事項'],
  ],
  earningsRevision: [
    ['content', '修正内容'],
    ['reason', '修正理由'],
    ['dividend', '配当'],
    ['impact', '関連する影響'],
    ['conditions', '前提・条件'],
    ['timing', '適用時期'],
  ],
  shareholderBenefit: [
    ['content', '優待内容と変更点'],
    ['target', '対象・保有条件'],
    ['timing', '基準日・適用時期'],
    ['reason', '理由・補足'],
  ],
  dividend: [
    ['dividend', '配当内容と変更点'],
    ['purpose', '方針・理由'],
    ['timing', '基準日・支払日'],
    ['conditions', '条件・補足'],
  ],
  shareRepurchase: [
    ['content', '取得内容・取得状況'],
    ['purpose', '取得目的'],
    ['conditions', '取得方法・条件'],
    ['timing', '取得期間・日程'],
  ],
  stockSplit: [
    ['content', '分割・併合内容'],
    ['timing', '日程'],
    ['target', '対象条件'],
    ['impact', '配当・優待等への影響'],
    ['purpose', '目的'],
  ],
  capitalPolicy: [
    ['content', '調達・発行内容'],
    ['purpose', '資金使途・目的'],
    ['impact', '株式・財務への影響'],
    ['timing', '日程'],
    ['conditions', '条件'],
  ],
  ma: [
    ['content', '取引内容・相手先'],
    ['purpose', '目的・背景'],
    ['conditions', '価格・資金・取引条件'],
    ['impact', '業績等への影響'],
    ['timing', '日程'],
  ],
  businessUpdate: [
    ['content', 'KPIと比較'],
    ['operations', '事業の動き・背景'],
    ['outlook', '見通し・速報性・条件'],
  ],
  governance: [
    ['content', '変更・対応内容'],
    ['reason', '背景・理由'],
    ['impact', '体制・影響'],
    ['timing', '日程・今後の対応'],
  ],
  other: [
    ['content', '開示内容'],
    ['reason', '背景・理由'],
    ['impact', '影響'],
    ['conditions', '条件'],
    ['timing', '日程'],
  ],
};
export const COMMON_SECTIONS: readonly SectionPolicy[] = [
  ['content', '関連する開示内容'],
  ['performance', '業績'],
  ['dividend', '配当'],
  ['finance', '財政状態・資金の動き'],
  ['operations', '事業・施策'],
  ['outlook', '見通し・前提'],
  ['reason', '背景・理由'],
  ['purpose', '目的'],
  ['target', '対象'],
  ['impact', '影響'],
  ['timing', '日程'],
  ['conditions', '条件'],
  ['notes', 'その他の重要事項'],
  ['document', '資料情報'],
  ['unclassified', '未分類の原文'],
];
export function sectionPolicies(type: DocumentType): readonly SectionPolicy[] {
  const own = SECTION_POLICIES[type];
  return [...own, ...COMMON_SECTIONS.filter(([role]) => !own.some(([r]) => r === role))];
}

/** Assign a reading topic, never financial meaning. An unknown heading stays unclassified. */
export function headingRole(text: string, type: DocumentType): ContentRole | null {
  const title = text.normalize('NFKC').replace(/\s/g, '');
  if (/目次|決算短信〔|決算短信\[|^※注記事項$/.test(title)) return 'document';
  if (/配当|株主還元/.test(title)) return 'dividend';
  if (/財政状態|貸借対照表|キャッシュ.?フロー|純資産|資産の部|負債の部/.test(title))
    return 'finance';
  if (/会計|注記事項|継続企業|株主資本|セグメント情報/.test(title)) return 'notes';
  if (/業績予想|将来予測|今後の見通し|通期見通し/.test(title))
    return type === 'earningsRevision' ? 'content' : 'outlook';
  if (/経営成績|損益計算書|中間期.*業績|四半期.*業績/.test(title))
    return type === 'earnings' ? 'performance' : 'content';
  if (/理由|要因/.test(title)) return type === 'earnings' ? 'performance' : 'reason';
  if (/目的|背景|資金使途/.test(title)) return 'purpose';
  if (/日程|時期|期間|予定日|基準日|支払日|効力発生/.test(title)) return 'timing';
  if (/影響|希薄化/.test(title)) return 'impact';
  if (/条件|取得方法|取引方法|速報/.test(title))
    return type === 'businessUpdate' ? 'outlook' : 'conditions';
  if (/対象|保有/.test(title)) return 'target';
  if (/事業|施策|店舗/.test(title))
    return type === 'earnings' || type === 'businessUpdate' ? 'operations' : null;
  if (/優待|取得|分割|併合|発行|調達|譲渡|譲受|取引|変更|対応|KPI|月次|月度|MRR|ARR/.test(title))
    return 'content';
  return null;
}
export function factRole(
  f: VerifiedFact,
  type: DocumentType,
  sourceRole: ContentRole
): ContentRole {
  if (/配当/.test(f.label)) return 'dividend';
  if (type === 'earnings' || type === 'earningsRevision') {
    if (/資産|負債|自己資本比率|キャッシュ.?フロー/.test(f.label)) return 'finance';
    if (f.kind === 'number' || f.kind === 'range')
      return type === 'earningsRevision'
        ? 'content'
        : f.valueKind?.startsWith('forecast')
          ? 'outlook'
          : 'performance';
  }
  if (sourceRole !== 'unclassified' && sourceRole !== 'document') return sourceRole;
  if (f.kind === 'number' || f.kind === 'range') return 'content';
  return headingRole(f.label, type) ?? 'content';
}

/** Visible company excerpts have explicit reasons or conditions; no causal paraphrase is generated. */
export function explanationRole(text: string): 'reason' | 'condition' | 'change' | null {
  const source = text.normalize('NFKC').replace(/\s/g, '');
  if (/季節|偏る|条件|場合|可能性|不確実|速報|未定|困難/.test(source)) return 'condition';
  if (/要因|理由|ため|により|による|減収|減益|増収|増益|(?:費|コスト)の上昇分.*吸収/.test(source))
    return 'reason';
  if (/変更はありません|修正の有無[:：]無/.test(source)) return 'change';
  return null;
}

/** Complete navigation/standard notice blocks only. Mixed substantive paragraphs stay readable. */
export function isSourceMetadata(text: string): boolean {
  const source = text.normalize('NFKC').replace(/\s/g, '');
  if (!/。/.test(source) && /(?:\.{3,}|…{2,}|⋯{2,}|‥{2,})\d/.test(source)) return true;
  // Known administrative prefixes can be joined to the disclaimer by PDF line grouping.
  // Remove only their complete forms before checking every remaining sentence.
  const body = source
    .replace(
      /^※?添付される(?:四半期|中間)?連結財務諸表に対する公認会計士又は監査法人によるレビュー[:：](?:無|有)/,
      ''
    )
    .replace(/^※?業績予想の適切な利用に関する説明、その他特記事項/, '')
    .replace(/^\(将来に関する記述等についてのご注意\)/, '');
  if (!body && body !== source) return true;
  const sentences = body.match(/[^。]+。?/g) ?? [];
  return (
    sentences.length > 0 &&
    sentences.every(
      (sentence) =>
        /^(?:本資料|本決算短信)に記載.*(?:業績見通し|業績予想).*将来.*(?:約束|保証).*ありません。?$/.test(
          sentence
        ) ||
        /^(?:また、)?実際の業績.*(?:様々|さまざま)な要因.*異なる可能性があります。?$/.test(
          sentence
        ) ||
        /^本資料に記載されている業績予想につきましては発表日現在のデータに基づき作成.*(?:様々|さまざま)な不確定要素.*実際の業績はこれらの予想数値と異なる可能性があります。?$/.test(
          sentence
        ) ||
        /^(?:本資料|本決算短信)に記載されている業績予想は、現時点.*(?:判断した見通し|不確実性).*含んでおります。?$/.test(
          sentence
        ) ||
        /^従いまして、これらの業績予想.*依拠して投資判断.*お控え.*。?$/.test(sentence) ||
        /^業績予想の前提となる条件及び業績予想のご利用にあたっての注意事項等については、添付資料[^。]*「[^」]*業績予想などの将来予測情報に関する説明」をご覧ください。?$/.test(
          sentence
        ) ||
        /^なお、上記予想に関する事項は、[（(]添付資料[）)]\d+ページ「[（(]\d+[）)]連結業績予想などの将来予測情報に関する説明」をご参照ください。?$/.test(
          sentence
        )
    )
  );
}

export function isRoutineExplanation(text: string): boolean {
  const source = text.normalize('NFKC').replace(/\s/g, '');
  const body = source
    .replace(
      /[（(](?:継続企業の前提に関する注記|株主資本の金額に著しい変動があった場合の注記|セグメント情報等の注記)[）)]|【セグメント情報】/g,
      ''
    )
    .replace(
      /^(?:前|当)(?:中間|四半期)?(?:連結)?会計期間[（(]自\d{4}年\d{1,2}月\d{1,2}日至\d{4}年\d{1,2}月\d{1,2}日[）)]/,
      ''
    );
  return (
    /^純損益に振替えられる(?:可能性のある|ことのない)項目$/.test(body) ||
    /^(?:該当事項はありません。?)+$/.test(body) ||
    /^当社(?:グループ)?(?:は|の報告セグメントは)[^。]*(?:のみ|単一)[^。]*記載(?:を)?省略[^。]*。?$/.test(
      body
    )
  );
}

/** Literal cover field, not a verified date claim or an inferred dividend period. */
export function dividendPaymentExcerpt(text: string): string | null {
  const fields =
    text.match(
      /配当(?:金)?支払開始予定日[^\S\r\n\u2028\u2029]*(?:[|｜│][^\S\r\n\u2028\u2029]*)?[0-9０-９]{4}年[0-9０-９]{1,2}月[0-9０-９]{1,2}日/g
    ) ?? [];
  return fields.length === 1 ? fields[0] : null;
}

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
        !/[。;；|│]/.test(line) &&
        (/^(?:上場会社名|会社名|コード番号|証券コード|代表者名?|問合せ先|問い合わせ先|電話番号|TEL|URL)(?:\s|[:：])/i.test(
          line
        ) ||
          /^(?:https?:\/\/\S+|各位|以上)$/i.test(line))
    )
  );
}
