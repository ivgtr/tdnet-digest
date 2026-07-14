/**
 * セクション検出・ページスコアリング・品質ゲート
 *
 * PDFから抽出したテキストをセクションに分割し、
 * 重要なセクションやページを選択する機能を提供する。
 */

import type { DocumentType } from './document-type';

/**
 * セクション情報
 */
export interface Section {
  heading: string; // 見出し
  text: string; // 本文
  pageNumber: number; // ページ番号（開始位置）
}

/**
 * ページスコア情報
 */
export interface PageScore {
  pageNumber: number;
  score: number;
}

/**
 * 品質チェック結果
 */
export interface QualityCheckResult {
  passed: boolean; // 品質基準を満たしているか
  matchedKeywords: string[]; // マッチしたキーワード
  missingKeywords: string[]; // 不足しているキーワード
  matchRate: number; // マッチ率（0-1）
}

/**
 * 削減率パラメータ（文書タイプ別）
 *
 * 計算式: 抽出ページ数 = summaryPages + topK + (neighbor × 2)
 */
export const EXTRACTION_PARAMS: Record<
  DocumentType,
  { summaryPages: number; topK: number; neighbor: number }
> = {
  earnings: { summaryPages: 2, topK: 8, neighbor: 1 },
  earningsRevision: { summaryPages: 1, topK: 3, neighbor: 1 },
  dividend: { summaryPages: 1, topK: 2, neighbor: 1 },
  ma: { summaryPages: 2, topK: 4, neighbor: 1 },
  shareRepurchase: { summaryPages: 1, topK: 2, neighbor: 1 },
  other: { summaryPages: 2, topK: 5, neighbor: 1 },
};

/**
 * 重要セクションのキーワード（文書タイプ別）
 */
const IMPORTANT_SECTION_KEYWORDS: Record<DocumentType, string[]> = {
  earnings: [
    '業績',
    '経営成績',
    '財政状態',
    '連結業績',
    '業績予想',
    '配当',
    '今後の見通し',
    '経営方針',
    '売上収益',
    '事業利益',
    '経常収益',
    '業務純益',
  ],
  earningsRevision: ['業績予想', '修正', '理由', '業績', '見通し'],
  dividend: ['配当', '株主還元', '剰余金', '配当予想'],
  ma: ['取得', '譲渡', '子会社', '関連会社', '目的', '取得価額', '業績', '日程'],
  shareRepurchase: ['自己株式', '取得', '株数', '取得価額', '取得期間', '取得方法'],
  other: [],
};

/**
 * ページスコアリング用キーワード（文書タイプ別）
 */
const PAGE_SCORING_KEYWORDS: Record<DocumentType, string[]> = {
  earnings: [
    '売上高',
    '営業利益',
    '経常利益',
    '当期純利益',
    '親会社株主に帰属',
    '純資産',
    '総資産',
    '配当',
    '1株当たり',
    'EPS',
    '売上収益',
    '税引前利益',
    '事業利益',
    'コア営業利益',
    '親会社の所有者に帰属',
    '経常収益',
    '業務純益',
    '保険引受利益',
    '資金利益',
    '業績予想',
    '通期予想',
    '修正',
  ],
  earningsRevision: ['売上高', '営業利益', '経常利益', '当期純利益', '修正', '理由', '前回予想'],
  dividend: ['配当', '1株当たり', '配当金', '期末配当', '中間配当'],
  ma: ['取得価額', '譲渡価額', '取得株数', '議決権', '子会社', '関連会社', '業績'],
  shareRepurchase: ['自己株式', '取得株数', '取得価額', '取得期間', '取得方法', '消却'],
  other: [],
};

/**
 * 品質ゲート用キーワードセット（同義語セット）
 *
 * 同義語セットで定義し、いずれかがマッチすればOK
 */
const QUALITY_GATE_KEYWORD_SETS: Record<DocumentType, string[][]> = {
  earnings: [
    ['売上高', '営業収益', '売上収益', '経常収益'],
    ['営業利益', '営業損失', '事業利益', 'コア営業利益', '業務純益'],
    ['経常利益', '経常損失', '税引前利益'],
    ['当期純利益', '純利益', '親会社株主に帰属', '親会社の所有者に帰属する当期利益'],
  ],
  earningsRevision: [
    ['売上高', '営業収益'],
    ['営業利益', '営業損失'],
    ['修正', '変更'],
    ['理由', '要因'],
  ],
  dividend: [
    ['配当', '配当金'],
    ['1株当たり', '1株'],
  ],
  ma: [
    ['取得価額', '譲渡価額', '対価'],
    ['取得株数', '議決権'],
    ['業績への影響', '業績'],
    ['日程', 'スケジュール', '予定'],
  ],
  shareRepurchase: [
    ['取得株数', '株数'],
    ['取得価額', '取得総額'],
    ['取得期間', '期間'],
    ['取得方法', '方法'],
  ],
  other: [],
};

/**
 * 品質ゲートの閾値（マッチ率）
 */
const QUALITY_GATE_THRESHOLD = 0.6;

/**
 * 見出しパターンの正規表現
 *
 * 検出するパターン:
 * - 【見出し】
 * - 1. 見出し
 * - (1) 見出し
 * - １．見出し（全角）
 * - （１）見出し（全角）
 */
const HEADING_PATTERNS = [
  /^【(.+?)】/m, // 【見出し】
  /^(\d+)\.\s*(.+)/m, // 1. 見出し
  /^（(\d+)）\s*(.+)/m, // （1）見出し
  /^\((\d+)\)\s*(.+)/m, // (1) 見出し
  /^([０-９]+)．\s*(.+)/m, // １．見出し（全角）
];

/**
 * テキストをセクションに分割
 *
 * @param text PDFから抽出した全文テキスト
 * @returns セクション配列
 */
export function detectSections(text: string): Section[] {
  const sections: Section[] = [];
  const lines = text.split('\n');

  let currentHeading = '';
  let currentText = '';
  let currentPageNumber = 1;
  let currentSectionPageNumber = 1;

  for (const line of lines) {
    // ページ番号の検出（行が数字のみの場合）
    if (/^\d+$/.test(line.trim())) {
      const pageNum = parseInt(line.trim(), 10);
      if (pageNum > currentPageNumber) {
        currentPageNumber = pageNum;
      }
      continue;
    }

    // 見出しパターンの検出
    let isHeading = false;
    for (const pattern of HEADING_PATTERNS) {
      const match = line.match(pattern);
      if (match) {
        // 前のセクションを保存
        if (currentHeading || currentText) {
          sections.push({
            heading: currentHeading,
            text: currentText.trim(),
            pageNumber: currentSectionPageNumber,
          });
        }

        // 新しいセクション開始
        currentHeading = match[1] || match[2] || '';
        currentText = '';
        currentSectionPageNumber = currentPageNumber;
        isHeading = true;
        break;
      }
    }

    // 見出しでなければ本文に追加
    if (!isHeading) {
      currentText += line + '\n';
    }
  }

  // 最後のセクションを保存
  if (currentHeading || currentText) {
    sections.push({
      heading: currentHeading,
      text: currentText.trim(),
      pageNumber: currentSectionPageNumber,
    });
  }

  return sections;
}

/**
 * 重要なセクションをフィルタ
 *
 * @param sections セクション配列
 * @param documentType 文書タイプ
 * @returns 重要なセクション配列
 */
export function filterImportantSections(
  sections: Section[],
  documentType: DocumentType
): Section[] {
  const keywords = IMPORTANT_SECTION_KEYWORDS[documentType];
  if (keywords.length === 0) {
    return sections;
  }

  return sections.filter((section) => {
    // 見出しにキーワードが含まれているか
    const headingMatch = keywords.some((keyword) => section.heading.includes(keyword));

    // 本文にキーワードが含まれているか（ボーナススコア）
    const textMatch = keywords.some((keyword) => section.text.includes(keyword));

    return headingMatch || textMatch;
  });
}

/**
 * ページごとにスコアリング
 *
 * @param text PDFから抽出した全文テキスト
 * @param documentType 文書タイプ
 * @returns ページスコア配列（スコア降順）
 */
export function scorePages(text: string, documentType: DocumentType): PageScore[] {
  const keywords = PAGE_SCORING_KEYWORDS[documentType];
  if (keywords.length === 0) {
    return [];
  }

  const lines = text.split('\n');
  const pageTexts: Map<number, string> = new Map();
  let currentPageNumber = 1;

  // ページごとにテキストを分割
  for (const line of lines) {
    // ページ番号の検出（行が数字のみの場合）
    if (/^\d+$/.test(line.trim())) {
      const pageNum = parseInt(line.trim(), 10);
      if (pageNum > currentPageNumber) {
        currentPageNumber = pageNum;
      }
      continue;
    }

    // 現在のページにテキストを追加
    const existingText = pageTexts.get(currentPageNumber) || '';
    pageTexts.set(currentPageNumber, existingText + line + '\n');
  }

  // 各ページのスコアを計算
  const pageScores: PageScore[] = [];
  for (const [pageNumber, pageText] of pageTexts.entries()) {
    let score = 0;
    for (const keyword of keywords) {
      // キーワードの出現回数をカウント
      const regex = new RegExp(escapeRegExp(keyword), 'g');
      const matches = pageText.match(regex);
      if (matches) {
        score += matches.length;
      }
    }
    pageScores.push({ pageNumber, score });
  }

  // スコア降順でソート
  return pageScores.sort((a, b) => b.score - a.score);
}

/**
 * 正規表現のメタ文字をエスケープ
 *
 * @param str エスケープする文字列
 * @returns エスケープ済み文字列
 */
function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * topKページとその近傍ページを抽出
 *
 * @param pageScores ページスコア配列
 * @param topK 上位K件
 * @param neighbor 近傍ページ数（前後）
 * @param summaryPageCount サマリーページ数（先頭N件は常に含める）
 * @returns 抽出対象のページ番号配列（昇順）
 */
export function selectTopPages(
  pageScores: PageScore[],
  topK: number,
  neighbor: number,
  summaryPageCount: number
): number[] {
  const selectedPages = new Set<number>();

  // サマリーページを追加（先頭N件）
  for (let i = 1; i <= summaryPageCount; i++) {
    selectedPages.add(i);
  }

  // topKページとその近傍を追加
  const topPages = pageScores.slice(0, topK);
  for (const { pageNumber } of topPages) {
    // 中心ページ
    selectedPages.add(pageNumber);

    // 近傍ページ
    for (let i = 1; i <= neighbor; i++) {
      selectedPages.add(pageNumber - i);
      selectedPages.add(pageNumber + i);
    }
  }

  // 0以下のページ番号を除外し、昇順でソート
  return Array.from(selectedPages)
    .filter((page) => page > 0)
    .sort((a, b) => a - b);
}

/**
 * 品質ゲート: 抽出されたテキストが必要な情報を含んでいるかチェック
 *
 * 同義語セットを使用し、各セットの少なくとも1つがマッチすればOK
 *
 * @param extractedText 抽出されたテキスト
 * @param documentType 文書タイプ
 * @returns 品質チェック結果
 */
export function checkExtractionQuality(
  extractedText: string,
  documentType: DocumentType
): QualityCheckResult {
  const keywordSets = QUALITY_GATE_KEYWORD_SETS[documentType];

  if (keywordSets.length === 0) {
    // キーワードセットが定義されていない場合は常にOK
    return {
      passed: true,
      matchedKeywords: [],
      missingKeywords: [],
      matchRate: 1.0,
    };
  }

  const matchedKeywords: string[] = [];
  const missingKeywords: string[] = [];

  // 各同義語セットをチェック
  for (const keywordSet of keywordSets) {
    let matched = false;
    for (const keyword of keywordSet) {
      if (extractedText.includes(keyword)) {
        matchedKeywords.push(keyword);
        matched = true;
        break; // セット内の1つがマッチすればOK
      }
    }

    if (!matched) {
      // セット内のすべてのキーワードを不足として記録（代表として最初のキーワード）
      missingKeywords.push(keywordSet[0]);
    }
  }

  const matchRate = matchedKeywords.length / keywordSets.length;
  const passed = matchRate >= QUALITY_GATE_THRESHOLD;

  return {
    passed,
    matchedKeywords,
    missingKeywords,
    matchRate,
  };
}

/**
 * 抽出パラメータを取得（品質ゲート未達時の増分適用用）
 *
 * @param documentType 文書タイプ
 * @param retryCount リトライ回数（0始まり）
 * @returns 抽出パラメータ
 */
export function getExtractionParams(
  documentType: DocumentType,
  retryCount: number
): { summaryPages: number; topK: number; neighbor: number } {
  const baseParams = EXTRACTION_PARAMS[documentType];

  // リトライ時はtopKを増やす（最大2回、1回につき+5）
  const topKIncrement = Math.min(retryCount, 2) * 5;

  return {
    summaryPages: baseParams.summaryPages,
    topK: baseParams.topK + topKIncrement,
    neighbor: baseParams.neighbor,
  };
}
