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

async function extractTextFromPDF(_pdfData: ArrayBuffer): Promise<string> {
  // TODO: pdf.jsを使用してPDFからテキストを抽出
  // 現時点ではプレースホルダー
  return '[PDF内容の抽出は未実装です。pdf.jsライブラリの追加が必要です。]';
}

export {};
