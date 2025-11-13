interface SummarizeRequest {
  action: 'summarize';
  pdfUrl: string;
}

interface Settings {
  apiUrl: string;
  apiKey: string;
  model: string;
}

// 拡張機能のインストール・更新時
chrome.runtime.onInstalled.addListener((details) => {
  console.log('[Background] 拡張機能がインストールされました:', details.reason);
});

// Service Workerの起動時
console.log('[Background] Service Workerが起動しました');

/**
 * Offscreen Documentをセットアップ（既に存在する場合は何もしない）
 */
async function setupOffscreenDocument(): Promise<void> {
  try {
    // 既存のOffscreen Documentをチェック
    const existingContexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT' as chrome.runtime.ContextType],
    });

    if (existingContexts.length > 0) {
      return;
    }

    // Offscreen Documentを作成
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['DOM_PARSER' as chrome.offscreen.Reason],
      justification: 'PDF.jsを使用してPDFからテキストを抽出するためにDOM APIが必要です',
    });
  } catch (error) {
    console.error('[Background] Offscreen Document作成エラー:', error);
    throw error;
  }
}

// メッセージリスナー
chrome.runtime.onMessage.addListener((request: SummarizeRequest, _sender, sendResponse) => {
  if (request.action === 'summarize') {
    handleSummarize(request.pdfUrl)
      .then((summary) => {
        sendResponse({ summary });
      })
      .catch((error) => {
        console.error('[Background] エラー:', error);
        sendResponse({ error: error.message });
      });
    return true; // 非同期レスポンスを示す
  }
});

async function handleSummarize(pdfUrl: string): Promise<string> {
  try {
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
  } catch (error) {
    console.error('[Background] 要約処理エラー:', error);
    throw error;
  }
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
  try {
    const response = await fetch('https://www.release.tdnet.info/inbs/' + url);

    if (!response.ok) {
      throw new Error(`PDF取得に失敗しました: ${response.status} ${response.statusText}`);
    }

    return await response.arrayBuffer();
  } catch (error) {
    console.error('[Background] PDF取得エラー:', error);
    throw error;
  }
}

async function summarizeWithLLM(pdfData: ArrayBuffer, settings: Settings): Promise<string> {
  try {
    // Offscreen Documentをセットアップ
    await setupOffscreenDocument();

    // PDFのテキスト抽出（Offscreen Documentで処理）
    const pdfText = await extractTextFromPDF(pdfData);

    // LLM API呼び出し
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
      const errorText = await response.text();
      console.error('[Background] LLM APIエラー:', response.status, errorText);
      throw new Error(`API呼び出しに失敗しました: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();

    if (!data.choices?.[0]?.message?.content) {
      console.error('[Background] 不正なレスポンス形式:', data);
      throw new Error('APIレスポンスの形式が不正です');
    }

    return data.choices[0].message.content;
  } catch (error) {
    console.error('[Background] LLM要約エラー:', error);
    throw error;
  }
}

/**
 * Offscreen DocumentでPDFからテキストを抽出
 */
async function extractTextFromPDF(pdfData: ArrayBuffer): Promise<string> {
  try {
    // ArrayBufferをUint8Arrayに変換（chrome.runtime.sendMessageでのシリアライゼーション対応）
    const uint8Array = new Uint8Array(pdfData);

    // Offscreen Documentにメッセージを送信
    const response = await chrome.runtime.sendMessage({
      action: 'extractPdfText',
      pdfData: Array.from(uint8Array), // Arrayに変換して送信
    });

    if (!response.success) {
      throw new Error(response.error || 'PDF抽出に失敗しました');
    }

    return response.text;
  } catch (error) {
    console.error('[Background] PDF抽出エラー:', error);
    if (error instanceof Error) {
      throw new Error(`PDF抽出エラー: ${error.message}`);
    }
    throw new Error('PDFからテキストを抽出できませんでした。');
  }
}

export {};
