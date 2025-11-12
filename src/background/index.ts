interface SummarizeRequest {
  action: 'summarize';
  pdfUrl: string;
}

interface Settings {
  apiUrl: string;
  apiKey: string;
  model: string;
}

// メッセージリスナー
chrome.runtime.onMessage.addListener((request: SummarizeRequest, _sender, sendResponse) => {
  if (request.action === 'summarize') {
    handleSummarize(request.pdfUrl)
      .then((summary) => sendResponse({ summary }))
      .catch((error) => sendResponse({ error: error.message }));
    return true; // 非同期レスポンスを示す
  }
});

async function handleSummarize(pdfUrl: string): Promise<string> {
  // 設定を取得
  const settings = await getSettings();

  if (!settings.apiUrl || !settings.apiKey) {
    throw new Error('API設定が未完了です。拡張機能の設定ページで設定してください。');
  }

  // PDFを取得
  const pdfData = await fetchPDF(pdfUrl);

  // LLMで要約
  const summary = await summarizeWithLLM(pdfData, settings);

  return summary;
}

async function getSettings(): Promise<Settings> {
  return new Promise((resolve) => {
    chrome.storage.sync.get(['apiUrl', 'apiKey', 'model'], (result) => {
      resolve({
        apiUrl: result.apiUrl || '',
        apiKey: result.apiKey || '',
        model: result.model || 'gpt-4o',
      });
    });
  });
}

async function fetchPDF(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`PDF取得に失敗しました: ${response.status}`);
  }
  return response.arrayBuffer();
}

async function summarizeWithLLM(pdfData: ArrayBuffer, settings: Settings): Promise<string> {
  // PDFのテキスト抽出は実装が必要 (pdf.js等を使用)
  // ここでは簡易的な実装
  const pdfText = await extractTextFromPDF(pdfData);

  const response = await fetch(settings.apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${settings.apiKey}`,
    },
    body: JSON.stringify({
      model: settings.model,
      messages: [
        {
          role: 'system',
          content:
            'あなたは日本の適時開示情報を要約する専門家です。開示内容を簡潔に要約し、重要なポイントを箇条書きで示してください。',
        },
        {
          role: 'user',
          content: `以下のTDnet開示内容を要約してください:\n\n${pdfText}`,
        },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`API呼び出しに失敗しました: ${response.status}`);
  }

  const data = await response.json();
  return data.choices[0].message.content;
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
  cleaned = cleaned.replace(/　/g, ' ');

  // 5. 制御文字を除去（改行・タブは維持）
  cleaned = cleaned.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, '');

  // 6. ページ番号っぽいパターンを除去 (例: "- 1 -", "1/10", "ページ 1")
  cleaned = cleaned.replace(/^[-\s]*\d+[-\s]*$/gm, '');
  cleaned = cleaned.replace(/\d+\s*\/\s*\d+/g, '');
  cleaned = cleaned.replace(/ページ\s*\d+/g, '');

  // 7. 先頭と末尾の空白を除去
  cleaned = cleaned.trim();

  return cleaned;
}

async function extractTextFromPDF(pdfData: ArrayBuffer): Promise<string> {
  try {
    // pdf.jsを動的インポート
    const pdfjsLib = await import('pdfjs-dist');

    // Worker設定: Service Worker環境ではWorkerを無効化
    const loadingTask = pdfjsLib.getDocument({
      data: pdfData,
      useWorkerFetch: false,
      isEvalSupported: false,
      useSystemFonts: true,
    });

    const pdf = await loadingTask.promise;
    const numPages = pdf.numPages;
    console.log(`[PDF Extract] ページ数: ${numPages}`);

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
        console.log(`[PDF Extract] ページ ${pageNum}/${numPages} 完了`);

        // メモリ解放
        page.cleanup();
      } catch (pageError) {
        console.error(`[PDF Extract] ページ ${pageNum} の抽出エラー:`, pageError);
        textPages.push(`[ページ ${pageNum} の抽出に失敗しました]`);
      }
    }

    // 全ページのテキストを結合
    const fullText = textPages.join('\n\n');
    console.log(`[PDF Extract] 抽出完了（生データ）: ${fullText.length} 文字`);

    if (!fullText.trim()) {
      throw new Error('PDFからテキストを抽出できませんでした。画像PDFの可能性があります。');
    }

    // テキストクリーニング
    const cleanedText = cleanExtractedText(fullText);
    console.log(`[PDF Extract] クリーニング完了: ${cleanedText.length} 文字`);

    // デバッグ用: 最初の500文字をログ出力
    console.log('[PDF Extract] テキストプレビュー:', cleanedText.substring(0, 500));

    return cleanedText;
  } catch (error) {
    console.error('[PDF Extract] エラー:', error);
    if (error instanceof Error) {
      throw new Error(`PDF抽出エラー: ${error.message}`);
    }
    throw new Error('PDFからテキストを抽出できませんでした。');
  }
}

export {};
