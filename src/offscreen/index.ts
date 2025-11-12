/**
 * Offscreen Document for PDF Processing
 * Service WorkerではDOM APIが使えないため、ここでPDF.jsを使ってPDF処理を行う
 */

// Viteの?urlインポートでWorkerファイルのURLを取得
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

console.log('[Offscreen] Offscreen Documentが起動しました');

// メッセージハンドラー
chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request.action === 'extractPdfText') {
    // ArrayをUint8Arrayに変換
    const uint8Array = new Uint8Array(request.pdfData);

    extractTextFromPDF(uint8Array)
      .then((text) => {
        sendResponse({ success: true, text });
      })
      .catch((error) => {
        console.error('[Offscreen] PDF抽出エラー:', error);
        sendResponse({ success: false, error: error.message });
      });
    return true; // 非同期レスポンスを示す
  }
});

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

  // 6. ページ番号っぽいパターンを除去 (例: "- 1 -", "1/10", "ページ 1")
  cleaned = cleaned.replace(/^[-\s]*\d+[-\s]*$/gm, '');
  cleaned = cleaned.replace(/\d+\s*\/\s*\d+/g, '');
  cleaned = cleaned.replace(/ページ\s*\d+/g, '');

  // 7. 先頭と末尾の空白を除去
  cleaned = cleaned.trim();

  return cleaned;
}

/**
 * PDFからテキストを抽出
 */
async function extractTextFromPDF(pdfData: Uint8Array): Promise<string> {
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

        // テキストアイテムを結合
        const pageText = textContent.items
          .map((item) => {
            if ('str' in item) {
              return item.str;
            }
            return '';
          })
          .join(' ');

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

    // テキストクリーニング
    const cleanedText = cleanExtractedText(fullText);
    console.log(`[Offscreen] PDF抽出完了 (${cleanedText.length}文字)`);

    return cleanedText;
  } catch (error) {
    console.error('[Offscreen] PDF抽出エラー:', error);
    if (error instanceof Error) {
      throw new Error(`PDF抽出エラー: ${error.message}`);
    }
    throw new Error('PDFからテキストを抽出できませんでした。');
  }
}

export {};
