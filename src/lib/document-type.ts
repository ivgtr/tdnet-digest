/**
 * TDnet文書タイプ判別
 *
 * タイトルから文書タイプを判別する。
 * 判定順序が重要：誤判定を防ぐため、特定の順序で判定を行う。
 */

/**
 * 決算期区分
 */
export type EarningsPeriod = 'q1' | 'q2' | 'q3' | 'fullYear';

/**
 * 会計基準
 */
export type AccountingStandard = 'jpGaap' | 'ifrs' | 'usGaap';

/**
 * 決算短信のコンテキスト情報
 */
export interface EarningsContext {
  period: EarningsPeriod;
  accountingStandard: AccountingStandard;
  isConsolidated: boolean;
}

/**
 * 文書タイプ
 */
export type DocumentType =
  | 'earnings' // 決算短信
  | 'earningsRevision' // 業績修正
  | 'shareholderBenefit' // 株主優待
  | 'dividend' // 配当
  | 'shareRepurchase' // 自己株式取得
  | 'stockSplit' // 株式分割・併合
  | 'capitalPolicy' // 資本政策・資本業務提携
  | 'ma' // M&A（株式取得・譲渡等）
  | 'businessUpdate' // 月次・受注・事業進捗
  | 'governance' // 役員・ガバナンス
  | 'other'; // その他

/**
 * タイトルから文書タイプを判別
 *
 * 判定順序（重要）：
 * 1. 業績修正（`業績予想` + `修正`）
 * 2. 決算短信（`決算短信` or `四半期`、ただし`通期`単独は除外）
 * 3. 配当
 * 4. 自己株式取得（M&Aより優先）
 * 5. M&A（`自己株式`を含む場合は除外）
 * 6. その他（デフォルト）
 *
 * @param title 開示情報のタイトル
 * @returns 文書タイプ
 */
export function detectDocumentType(title: string): DocumentType {
  const normalizedTitle = title.normalize('NFKC');

  // 1. 業績修正（`業績予想` + `修正`）
  if (normalizedTitle.includes('業績予想') && normalizedTitle.includes('修正')) {
    return 'earningsRevision';
  }

  // 2. 決算短信（`決算短信` or `四半期`、ただし`通期`単独は除外）
  // 注意: `通期`は他の文書タイプでも使われるため除外
  if (normalizedTitle.includes('決算短信') || normalizedTitle.includes('四半期')) {
    return 'earnings';
  }

  // 3. 株主優待
  if (/株主優待|優待制度/.test(normalizedTitle)) {
    return 'shareholderBenefit';
  }

  // 4. 自己株式取得（資本政策・M&Aより優先）
  if (/自己株式.{0,20}(取得|消却)|自己株買い/.test(normalizedTitle)) {
    return 'shareRepurchase';
  }

  // 5. 株式分割・併合（配当予想修正との複合開示では主取引を優先）
  if (/株式分割|株式併合|単元株式数|単元株/.test(normalizedTitle)) {
    return 'stockSplit';
  }

  // 6. 配当
  if (normalizedTitle.includes('配当')) {
    return 'dividend';
  }

  // 7. 資本政策・資本業務提携
  if (
    /資本業務提携|業務資本提携|第三者割当|新株予約権|公募増資|株式の発行|資本政策|自己株式の処分/.test(
      normalizedTitle
    )
  ) {
    return 'capitalPolicy';
  }

  // 8. M&A
  if (
    normalizedTitle.includes('株式取得') ||
    normalizedTitle.includes('株式譲渡') ||
    normalizedTitle.includes('子会社') ||
    normalizedTitle.includes('合併') ||
    normalizedTitle.includes('買収') ||
    normalizedTitle.includes('会社分割') ||
    normalizedTitle.includes('事業譲渡') ||
    normalizedTitle.includes('公開買付') ||
    /M&A/i.test(normalizedTitle)
  ) {
    return 'ma';
  }

  // 9. 月次・受注・事業進捗
  if (/月次|受注状況|受注残|事業進捗|売上速報|販売状況|稼働率|主要KPI/i.test(normalizedTitle)) {
    return 'businessUpdate';
  }

  // 10. 役員・ガバナンス
  if (
    /人事異動|取締役|執行役員|代表取締役|役員|ガバナンス|内部統制|不祥事|再発防止|監査法人|会計監査人/.test(
      normalizedTitle
    )
  ) {
    return 'governance';
  }

  // 11. その他（デフォルト）
  return 'other';
}

/**
 * 決算短信タイトルからコンテキスト情報を検出
 *
 * @param title 開示情報のタイトル
 * @returns 決算コンテキスト（期区分・会計基準・連結/個別）
 */
export function detectEarningsContext(title: string): EarningsContext {
  const normalizedTitle = title.normalize('NFKC');

  // 期区分の判定
  let period: EarningsPeriod;
  if (/第1四半期|1Q/i.test(normalizedTitle)) {
    period = 'q1';
  } else if (/第2四半期|2Q|中間/i.test(normalizedTitle)) {
    period = 'q2';
  } else if (/第3四半期|3Q/i.test(normalizedTitle)) {
    period = 'q3';
  } else {
    period = 'fullYear';
  }

  // 会計基準の判定
  let accountingStandard: AccountingStandard;
  if (/IFRS|国際会計基準/i.test(normalizedTitle)) {
    accountingStandard = 'ifrs';
  } else if (/米国基準/.test(normalizedTitle)) {
    accountingStandard = 'usGaap';
  } else {
    accountingStandard = 'jpGaap';
  }

  // 連結/個別の判定
  const isConsolidated = !/個別|単体|非連結/.test(normalizedTitle);

  return { period, accountingStandard, isConsolidated };
}

/**
 * 文書タイプの表示名を取得（UI表示用）
 *
 * @param type 文書タイプ
 * @returns 表示名
 */
export function getDocumentTypeName(type: DocumentType): string {
  switch (type) {
    case 'earnings':
      return '決算短信';
    case 'earningsRevision':
      return '業績修正';
    case 'shareholderBenefit':
      return '株主優待';
    case 'dividend':
      return '配当';
    case 'shareRepurchase':
      return '自己株式取得';
    case 'stockSplit':
      return '株式分割・併合';
    case 'capitalPolicy':
      return '資本政策';
    case 'ma':
      return 'M&A';
    case 'businessUpdate':
      return '事業進捗・月次';
    case 'governance':
      return 'ガバナンス';
    case 'other':
      return 'その他';
  }
}
