/**
 * Offscreen Document for PDF Processing
 * Service WorkerではDOM APIが使えないため、ここでPDF.jsを使ってPDF処理を行う
 */

// Viteの?urlインポートでWorkerファイルのURLを取得
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

// ライブラリをインポート
import type { DocumentType } from '@/lib/document-type';
import type { TextItem, TextMarkedContent } from 'pdfjs-dist/types/src/display/api';
import {
  detectSections,
  filterImportantSections,
  scorePages,
  selectTopPages,
  getExtractionParams,
  checkExtractionQuality,
  type QualityCheckResult,
} from '@/lib/section-detector';
import type { SummaryMetadata, ExtractionMode } from '@/types/summaryMetadata';

console.log('[Offscreen] Offscreen Documentが起動しました');

// メッセージハンドラー
chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request.action === 'extractPdfText') {
    // ArrayをUint8Arrayに変換
    const uint8Array = new Uint8Array(request.pdfData);

    const extractionMode = request.extractionMode || 'smart';
    const documentType: DocumentType = request.documentType || 'other';

    extractTextFromPDF(uint8Array, extractionMode, documentType)
      .then((result) => {
        sendResponse({ success: true, ...result });
      })
      .catch((error) => {
        console.error('[Offscreen] PDF抽出エラー:', error);
        sendResponse({ success: false, error: error.message });
      });
    return true; // 非同期レスポンスを示す
  }
});

/**
 * セクションベースでのテキスト抽出を試みる
 * 重要セクションが見つかればそれを使用、なければページスコアリングにフォールバック
 */
function extractWithSections(
  fullText: string,
  totalPages: number,
  documentType: DocumentType,
  params: { summaryPages: number; topK: number; neighbor: number }
): { text: string; extractedPages: number[]; sectionsUsed: string[] } {
  const allSections = detectSections(fullText);

  if (allSections.length === 0) {
    // セクション検出失敗 → ページスコアリング
    console.log('[Offscreen] セクション検出失敗 → ページスコアリング');
    return extractByPageScoring(fullText, totalPages, documentType, params);
  }

  console.log(`[Offscreen] セクション検出: ${allSections.length}個`);
  const importantSections = filterImportantSections(allSections, documentType);
  console.log(`[Offscreen] 重要セクション: ${importantSections.length}個`);

  if (importantSections.length === 0) {
    // 重要セクションが空 → ページスコアリング
    console.log('[Offscreen] 重要セクション空 → ページスコアリングに切替');
    return extractByPageScoring(fullText, totalPages, documentType, params);
  }

  // 重要セクションからテキストを抽出
  const text = importantSections.map((s) => s.text).join('\n\n');
  const extractedPages = Array.from(
    new Set(importantSections.map((s) => s.pageNumber))
  ).sort((a, b) => a - b);
  const sectionsUsed = importantSections.map((s) => s.heading || '（見出しなし）');

  return { text, extractedPages, sectionsUsed };
}

/**
 * 抽出結果に品質警告を追加する
 */
function addQualityWarning(
  metadata: ExtractionMetadata,
  qualityCheck: QualityCheckResult
): void {
  if (!qualityCheck.passed) {
    metadata.qualityWarning = {
      message: '一部の重要情報が抽出できなかった可能性があります。全文抽出を推奨します。',
      missingKeywords: qualityCheck.missingKeywords,
      matchRate: qualityCheck.matchRate,
    };
  }
}

/**
 * smartモードでのテキスト抽出
 * セクション検出 → 重要セクションフィルタ → 失敗時はページスコアリング
 * 品質ゲートで確認し、必要に応じてリトライ
 */
async function extractSmartMode(
  fullText: string,
  totalPages: number,
  documentType: DocumentType
): Promise<ExtractionResult> {
  const MAX_RETRIES = 2;
  let finalQualityCheck: QualityCheckResult | null = null;
  let extractionData: { text: string; extractedPages: number[]; sectionsUsed: string[] } | null =
    null;

  // リトライループ: 品質基準を満たすまで試行
  for (let retryCount = 0; retryCount <= MAX_RETRIES; retryCount++) {
    console.log(`[Offscreen] 抽出試行 ${retryCount + 1}/${MAX_RETRIES + 1}`);

    // リトライ回数に応じて抽出パラメータを調整
    const params = getExtractionParams(documentType, retryCount);

    // セクションベースで抽出を試みる
    extractionData = extractWithSections(fullText, totalPages, documentType, params);

    // 品質チェック
    finalQualityCheck = checkExtractionQuality(extractionData.text, documentType);
    console.log(
      `[Offscreen] 品質チェック: ${finalQualityCheck.passed ? '合格' : '不合格'} ` +
        `(マッチ率: ${(finalQualityCheck.matchRate * 100).toFixed(0)}%)`
    );

    // 品質基準を満たしていればループを抜ける
    if (finalQualityCheck.passed) {
      break;
    }

    // リトライ継続をログ出力
    if (retryCount < MAX_RETRIES) {
      console.log(`[Offscreen] 品質未達 → リトライ ${retryCount + 1}/${MAX_RETRIES} (topK増加)`);
    }
  }

  // 最終的な抽出データが必ず存在する（ループは最低1回実行される）
  if (!extractionData || !finalQualityCheck) {
    throw new Error('[Offscreen] 抽出処理が完了しませんでした');
  }

  // テキストクリーニング
  const cleanedText = cleanExtractedText(extractionData.text);
  console.log(
    `[Offscreen] PDF抽出完了 (smartモード, ${extractionData.extractedPages.length}/${totalPages}ページ, ${cleanedText.length}文字)`
  );

  // メタデータ作成
  const metadata: ExtractionMetadata = {
    totalPages,
    extractedPages: extractionData.extractedPages,
    sectionsUsed: extractionData.sectionsUsed,
    extractionMode: 'smart',
    documentType,
  };

  // 品質警告を追加
  addQualityWarning(metadata, finalQualityCheck);

  return {
    text: cleanedText,
    metadata,
  };
}

/**
 * ページスコアリングによる抽出
 */
function extractByPageScoring(
  fullText: string,
  totalPages: number,
  documentType: DocumentType,
  params: { summaryPages: number; topK: number; neighbor: number }
): { text: string; extractedPages: number[]; sectionsUsed: string[] } {
  // ページスコアリングを実行
  const pageScores = scorePages(fullText, documentType);
  console.log(`[Offscreen] ページスコアリング: トップ${params.topK}ページを選択`);

  // topKページとその近傍ページを選択
  const selectedPages = selectTopPages(
    pageScores,
    params.topK,
    params.neighbor,
    params.summaryPages
  );

  // 選択されたページのテキストを抽出
  const text = extractTextFromSelectedPages(fullText, selectedPages);

  console.log(
    `[Offscreen] ページスコアリング完了 (${selectedPages.length}/${totalPages}ページ, ${text.length}文字)`
  );

  return {
    text,
    extractedPages: selectedPages,
    sectionsUsed: [`topK=${params.topK} (スコアリング)`],
  };
}

/**
 * 選択されたページからテキストを抽出
 */
function extractTextFromSelectedPages(fullText: string, selectedPages: number[]): string {
  const lines = fullText.split('\n');
  const extractedLines: string[] = [];
  let currentPage = 0;

  for (const line of lines) {
    // ページ番号の検出（行が数字のみの場合）
    if (/^\d+$/.test(line.trim())) {
      const pageNum = parseInt(line.trim(), 10);
      if (pageNum > currentPage) {
        currentPage = pageNum;
      }
    }

    // 選択されたページの場合、行を追加
    if (selectedPages.includes(currentPage)) {
      extractedLines.push(line);
    }
  }

  return extractedLines.join('\n');
}

/**
 * テキストアイテムをY座標でグループ化して行に変換
 * チェーン効果を回避するため、許容誤差を固定値で使用
 */
function groupTextItemsByY(items: Array<TextItem | TextMarkedContent>): string[] {
  if (items.length === 0) {
    return [];
  }

  const Y_TOLERANCE = 2; // Y座標の許容誤差（ピクセル）
  const lines: Map<number, string[]> = new Map();

  for (const item of items) {
    if (!('str' in item) || !item.str) {
      continue;
    }

    // Y座標を取得（transform[5]がY座標）
    const y = item.transform?.[5] ?? 0;

    // 既存の行の中から、Y座標が近い行を探す
    let matchedY: number | null = null;
    for (const existingY of lines.keys()) {
      if (Math.abs(existingY - y) <= Y_TOLERANCE) {
        matchedY = existingY;
        break;
      }
    }

    if (matchedY !== null) {
      // 既存の行に追加
      lines.get(matchedY)!.push(item.str);
    } else {
      // 新しい行を作成
      lines.set(y, [item.str]);
    }
  }

  // Y座標でソート（上から下へ）して、各行のテキストを結合
  const sortedYs = Array.from(lines.keys()).sort((a, b) => b - a); // 降順（PDFは下が小さい値）
  return sortedYs.map((y) => lines.get(y)!.join(' '));
}

/**
 * 抽出したテキストをクリーニング
 */
function cleanExtractedText(text: string): string {
  let cleaned = text;

  // 1. 連続する空白を1つに
  cleaned = cleaned.replace(/[ \t]+/g, ' ');

  // 2. 連続する改行を最大2つに（段落区切りを維持）
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');

  // 3. 行末の空白を削除
  cleaned = cleaned.replace(/[ \t]+\n/g, '\n');

  // 4. 全角スペースを半角スペースに統一
  // eslint-disable-next-line no-irregular-whitespace
  cleaned = cleaned.replace(/　/g, ' ');

  // 5. 制御文字を除去（改行・タブは維持）
  // eslint-disable-next-line no-control-regex
  cleaned = cleaned.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, '');

  // 6. ページ番号を行限定で除去
  // 行全体が数字のみの場合のみ削除（本文中の数値は保持）
  cleaned = cleaned.replace(/^[-\s]*\d+[-\s]*$/gm, '');
  cleaned = cleaned.replace(/^\d+\s*\/\s*\d+$/gm, '');
  cleaned = cleaned.replace(/^ページ\s*\d+$/gm, '');

  // 7. 先頭と末尾の空白を除去
  cleaned = cleaned.trim();

  return cleaned;
}

/**
 * メタデータ型定義
 */
type ExtractionMetadata = SummaryMetadata;

/**
 * 抽出結果型定義
 */
interface ExtractionResult {
  text: string;
  metadata: ExtractionMetadata;
}

/**
 * PDFからテキストを抽出
 */
async function extractTextFromPDF(
  pdfData: Uint8Array,
  extractionMode: ExtractionMode,
  documentType: DocumentType
): Promise<ExtractionResult> {
  try {
    // pdf.jsを動的インポート
    const pdfjsLib = await import('pdfjs-dist');

    // GlobalWorkerOptions.workerSrcを設定（必須）
    if (pdfjsLib.GlobalWorkerOptions) {
      // Viteの?urlインポートで取得したWorker URLを使用
      // Chrome拡張機能の場合、相対パスなら絶対URLに変換
      const workerUrl = pdfWorkerUrl.startsWith('/')
        ? chrome.runtime.getURL(pdfWorkerUrl.slice(1))
        : pdfWorkerUrl;
      pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
    }

    const loadingTask = pdfjsLib.getDocument({
      data: pdfData,
      useWorkerFetch: false,
      isEvalSupported: false,
      useSystemFonts: true,
    });

    const pdf = await loadingTask.promise;
    const numPages = pdf.numPages;
    console.log(`[Offscreen] PDF抽出開始 (${numPages}ページ)`);

    const textPages: string[] = [];

    // 全ページからテキストを抽出
    for (let pageNum = 1; pageNum <= numPages; pageNum++) {
      try {
        const page = await pdf.getPage(pageNum);
        const textContent = await page.getTextContent();

        // Y座標で行をグループ化して改行を復元
        const lines = groupTextItemsByY(textContent.items);

        // ページ番号を先頭に追加（セクション検出・ページスコアリングで使用）
        const pageText = `${pageNum}\n${lines.join('\n')}`;

        textPages.push(pageText);

        // メモリ解放
        page.cleanup();
      } catch (pageError) {
        console.error(`[Offscreen] ページ ${pageNum} の抽出エラー:`, pageError);
        textPages.push(`[ページ ${pageNum} の抽出に失敗しました]`);
      }
    }

    // 全ページのテキストを結合
    const fullText = textPages.join('\n\n');

    if (!fullText.trim()) {
      throw new Error('PDFからテキストを抽出できませんでした。画像PDFの可能性があります。');
    }

    // 抽出モード分岐
    if (extractionMode === 'full') {
      // fullモード: 全文返却
      const cleanedText = cleanExtractedText(fullText);
      console.log(`[Offscreen] PDF抽出完了 (fullモード, ${cleanedText.length}文字)`);

      return {
        text: cleanedText,
        metadata: {
          totalPages: numPages,
          extractedPages: Array.from({ length: numPages }, (_, i) => i + 1),
          sectionsUsed: ['全ページ'],
          extractionMode: 'full',
          documentType,
        },
      };
    } else {
      // smartモード: セマンティック抽出
      return await extractSmartMode(fullText, numPages, documentType);
    }
  } catch (error) {
    console.error('[Offscreen] PDF抽出エラー:', error);
    if (error instanceof Error) {
      throw new Error(`PDF抽出エラー: ${error.message}`);
    }
    throw new Error('PDFからテキストを抽出できませんでした。');
  }
}

export {};
