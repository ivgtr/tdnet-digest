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
  | 'earnings'           // 決算短信
  | 'earningsRevision'   // 業績修正
  | 'dividend'           // 配当
  | 'ma'                 // M&A（株式取得・譲渡等）
  | 'shareRepurchase'    // 自己株式取得
  | 'other';             // その他

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
  // 1. 業績修正（`業績予想` + `修正`）
  if (title.includes('業績予想') && title.includes('修正')) {
    return 'earningsRevision';
  }

  // 2. 決算短信（`決算短信` or `四半期`、ただし`通期`単独は除外）
  // 注意: `通期`は他の文書タイプでも使われるため除外
  if (title.includes('決算短信') || title.includes('四半期')) {
    return 'earnings';
  }

  // 3. 配当
  if (title.includes('配当')) {
    return 'dividend';
  }

  // 4. 自己株式取得（M&Aより優先）
  // 注意: `自己株式`は`株式`を含むため、M&Aの前に判定する必要がある
  if (title.includes('自己株式')) {
    return 'shareRepurchase';
  }

  // 5. M&A（`自己株式`を含む場合は除外）
  // 注意: 自己株式取得は既に判定済みなので、ここでは`株式取得`や`株式譲渡`などが対象
  if (
    title.includes('株式取得') ||
    title.includes('株式譲渡') ||
    title.includes('子会社') ||
    title.includes('合併') ||
    title.includes('買収')
  ) {
    return 'ma';
  }

  // 6. その他（デフォルト）
  return 'other';
}

/**
 * 決算短信タイトルからコンテキスト情報を検出
 *
 * @param title 開示情報のタイトル
 * @returns 決算コンテキスト（期区分・会計基準・連結/個別）
 */
export function detectEarningsContext(title: string): EarningsContext {
  // 期区分の判定
  let period: EarningsPeriod;
  if (/第1四半期|1Q/.test(title)) {
    period = 'q1';
  } else if (/第2四半期|2Q|中間/.test(title)) {
    period = 'q2';
  } else if (/第3四半期|3Q/.test(title)) {
    period = 'q3';
  } else {
    period = 'fullYear';
  }

  // 会計基準の判定
  let accountingStandard: AccountingStandard;
  if (/IFRS|国際会計基準/.test(title)) {
    accountingStandard = 'ifrs';
  } else if (/米国基準/.test(title)) {
    accountingStandard = 'usGaap';
  } else {
    accountingStandard = 'jpGaap';
  }

  // 連結/個別の判定
  const isConsolidated = !/個別|単体/.test(title);

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
    case 'dividend':
      return '配当';
    case 'ma':
      return 'M&A';
    case 'shareRepurchase':
      return '自己株式取得';
    case 'other':
      return 'その他';
  }
}
