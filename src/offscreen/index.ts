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
import {
  cleanPageText,
  selectExtractedPages,
  serializePagesForAnalysis,
  serializePagesForDetection,
} from '@/lib/page-text';
import type {
  SummaryMetadata,
  ExtractionMode,
  ExtractedPage,
  PdfExtractionResult,
} from '@/types/summaryMetadata';

console.log('[Offscreen] Offscreen Documentが起動しました');

// メッセージハンドラー
chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request.action === 'extractPdfText') {
    // ArrayをUint8Arrayに変換
    const uint8Array = new Uint8Array(request.pdfData);

    const extractionMode = request.extractionMode || 'full';
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
 * smartモードでのテキスト抽出
 * セクション検出 → 重要セクションフィルタ → 失敗時はページスコアリング
 * 品質ゲートを常に実行し、リトライ判定を正しく処理
 */
async function extractSmartMode(
  allPages: ExtractedPage[],
  totalPages: number,
  documentType: DocumentType
): Promise<ExtractionResult> {
  const MAX_RETRIES = 2; // 最大リトライ回数
  let retryCount = 0;

  // リトライで上書きするため let を使用
  let qualityCheck: QualityCheckResult = {
    passed: false,
    matchedKeywords: [],
    missingKeywords: [],
    matchRate: 0,
  };
  const detectionText = serializePagesForDetection(allPages);
  let extractedPageData: ExtractedPage[] = [];
  let extractedPages: number[] = [];
  let sectionsUsed: string[] = [];

  // リトライループ
  while (retryCount <= MAX_RETRIES) {
    // 抽出パラメータを取得（リトライ回数に応じて増分）
    const params = getExtractionParams(documentType, retryCount);

    // セクション検出を試みる
    const allSections = detectSections(detectionText);
    console.log(`[Offscreen] セクション検出: ${allSections.length}個 (試行 ${retryCount + 1})`);

    if (allSections.length > 0) {
      // セクション検出成功
      const importantSections = filterImportantSections(allSections, documentType);
      console.log(`[Offscreen] 重要セクション: ${importantSections.length}個`);

      // 重要セクションが空の場合はページスコアリングに切り替え
      if (importantSections.length === 0) {
        console.log('[Offscreen] 重要セクション空 → ページスコアリングに切替');
        extractedPages = selectPagesByScoring(detectionText, documentType, params);
        sectionsUsed = [`topK=${params.topK} (スコアリング)`];
      } else {
        extractedPages = Array.from(new Set(importantSections.map((s) => s.pageNumber))).sort(
          (a, b) => a - b
        );
        sectionsUsed = importantSections.map((s) => s.heading || '（見出しなし）');
      }
    } else {
      // セクション検出失敗 → ページスコアリング
      console.log('[Offscreen] セクション検出失敗 → ページスコアリング');
      extractedPages = selectPagesByScoring(detectionText, documentType, params);
      sectionsUsed = [`topK=${params.topK} (スコアリング)`];
    }

    extractedPageData = selectExtractedPages(allPages, extractedPages);
    extractedPages = extractedPageData.map(({ pageNumber }) => pageNumber);
    const qualityText = extractedPageData.map(({ text }) => text).join('\n\n');

    // 品質ゲートを常に実行（セクション検出の成否に関わらず）
    qualityCheck = checkExtractionQuality(qualityText, documentType);
    console.log(
      `[Offscreen] 品質チェック: ${qualityCheck.passed ? '合格' : '不合格'} (マッチ率: ${(qualityCheck.matchRate * 100).toFixed(0)}%)`
    );

    // リトライループ内で qualityCheck を更新
    if (qualityCheck.passed) {
      // 品質基準を満たしている場合は終了
      break;
    }

    // リトライ
    retryCount++;
    if (retryCount <= MAX_RETRIES) {
      console.log(`[Offscreen] 品質未達 → リトライ ${retryCount}/${MAX_RETRIES} (topK増加)`);
    }
  }

  const analysisText = serializePagesForAnalysis(extractedPageData);
  console.log(
    `[Offscreen] PDF抽出完了 (smartモード, ${extractedPages.length}/${totalPages}ページ, ${analysisText.length}文字)`
  );

  // メタデータ作成
  const metadata: ExtractionMetadata = {
    totalPages,
    extractedPages,
    sectionsUsed,
    extractionMode: 'smart',
    documentType,
  };

  // 品質警告を追加（最終状態の qualityCheck を使用）
  if (!qualityCheck.passed) {
    metadata.qualityWarning = {
      message: '一部の重要情報が抽出できなかった可能性があります。全文抽出を推奨します。',
      missingKeywords: qualityCheck.missingKeywords,
      matchRate: qualityCheck.matchRate,
    };
  }

  return {
    text: analysisText,
    pages: extractedPageData,
    metadata,
  };
}

/**
 * ページスコアリングによる抽出
 */
function selectPagesByScoring(
  fullText: string,
  documentType: DocumentType,
  params: { summaryPages: number; topK: number; neighbor: number }
): number[] {
  // ページスコアリングを実行
  const pageScores = scorePages(fullText, documentType);
  console.log(`[Offscreen] ページスコアリング: トップ${params.topK}ページを選択`);

  // topKページとその近傍ページを選択
  return selectTopPages(pageScores, params.topK, params.neighbor, params.summaryPages);
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
 * メタデータ型定義
 */
type ExtractionMetadata = SummaryMetadata;

/**
 * 抽出結果型定義
 */
type ExtractionResult = PdfExtractionResult;

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

    const pages: ExtractedPage[] = [];

    // 全ページからテキストを抽出
    for (let pageNum = 1; pageNum <= numPages; pageNum++) {
      try {
        const page = await pdf.getPage(pageNum);
        const textContent = await page.getTextContent();

        // Y座標で行をグループ化して改行を復元
        const lines = groupTextItemsByY(textContent.items);

        pages.push({
          pageNumber: pageNum,
          text: cleanPageText(lines.join('\n'), pageNum),
        });

        // メモリ解放
        page.cleanup();
      } catch (pageError) {
        console.error(`[Offscreen] ページ ${pageNum} の抽出エラー:`, pageError);
        pages.push({
          pageNumber: pageNum,
          text: `[ページ ${pageNum} の抽出に失敗しました]`,
        });
      }
    }

    if (!pages.some(({ text }) => text.trim())) {
      throw new Error('PDFからテキストを抽出できませんでした。画像PDFの可能性があります。');
    }

    // 抽出モード分岐
    if (extractionMode === 'full') {
      // fullモード: 全文返却
      const analysisText = serializePagesForAnalysis(pages);
      console.log(`[Offscreen] PDF抽出完了 (fullモード, ${analysisText.length}文字)`);

      return {
        text: analysisText,
        pages,
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
      return await extractSmartMode(pages, numPages, documentType);
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
