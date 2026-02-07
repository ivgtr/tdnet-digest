import { generateText, type LLMConfig, type ChatMessage } from '@/lib/llm-client';
import { detectDocumentType, type DocumentType } from '@/lib/document-type';
import { getPromptForDocumentType } from '@/lib/prompts';
import type { SummaryMetadata, ExtractionMode } from '@/types/summaryMetadata';

interface SummarizeRequest {
  action: 'summarize';
  pdfUrl: string;
  title: string; // 文書タイプ判別用
  forceExtractionMode?: ExtractionMode; // 全文再要約ボタン用
}

interface Settings {
  provider: string;
  apiKey: string;
  model: string;
  customUrl?: string;
  extractionMode?: ExtractionMode;
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
  console.log('[Background DEBUG] Message received:', request.action);

  if (request.action === 'summarize') {
    console.log('[Background DEBUG] Summarize params:', {
      pdfUrl: request.pdfUrl,
      title: request.title,
      forceExtractionMode: request.forceExtractionMode,
    });

    handleSummarize(request.pdfUrl, request.title, request.forceExtractionMode)
      .then((result) => {
        console.log('[Background DEBUG] Summarize completed');
        sendResponse({ summary: result.summary, metadata: result.metadata });
      })
      .catch((error) => {
        console.error('[Background] エラー:', error);
        sendResponse({ error: error instanceof Error ? error.message : '不明なエラー' });
      });
    return true; // 非同期レスポンスを示す
  }
});

async function handleSummarize(
  pdfUrl: string,
  title: string,
  forceExtractionMode?: ExtractionMode
): Promise<{ summary: string; metadata: SummaryMetadata }> {
  try {
    // 設定を取得
    const settings = await getSettings();

    if (!settings.apiKey) {
      throw new Error('APIキーが設定されていません。拡張機能の設定ページで設定してください。');
    }

    if (settings.provider === 'custom' && !settings.customUrl) {
      throw new Error(
        'カスタムプロバイダーを使用する場合はAPI URLを設定してください。'
      );
    }

    // 文書タイプを判別
    const documentType = detectDocumentType(title);
    console.log(`[Background] 文書タイプ: ${documentType} (タイトル: ${title})`);

    // 強制抽出モードがあれば設定より優先
    const extractionMode = forceExtractionMode || settings.extractionMode || 'full';
    console.log(
      `[Background] 抽出モード: ${extractionMode}${forceExtractionMode ? ' (強制)' : ''}`
    );

    // PDFを取得
    const pdfData = await fetchPDF(pdfUrl);

    // LLMで要約
    const result = await summarizeWithLLM(pdfData, settings, documentType, extractionMode);

    return result;
  } catch (error) {
    console.error('[Background] 要約処理エラー:', error);
    throw error;
  }
}

async function getSettings(): Promise<Settings> {
  return new Promise((resolve) => {
    chrome.storage.sync.get(
      ['provider', 'apiKey', 'model', 'customUrl', 'extractionMode'],
      (result) => {
        resolve({
          provider: result.provider || 'openai',
          apiKey: result.apiKey || '',
          model: result.model || 'gpt-4o',
          customUrl: result.customUrl || '',
          extractionMode: result.extractionMode || 'full',
        });
      }
    );
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

async function summarizeWithLLM(
  pdfData: ArrayBuffer,
  settings: Settings,
  documentType: DocumentType,
  extractionMode: ExtractionMode
): Promise<{ summary: string; metadata: SummaryMetadata }> {
  try {
    // 設定の検証
    if (!settings.apiKey) {
      throw new Error('APIキーが設定されていません');
    }

    // カスタムプロバイダーの場合はURLも必須
    if (settings.provider === 'custom' && !settings.customUrl) {
      throw new Error('カスタムプロバイダーを使用する場合はAPI URLを設定してください');
    }

    // Offscreen Documentをセットアップ
    await setupOffscreenDocument();

    // PDFのテキスト抽出（Offscreen Documentで処理）
    const extractionResult = await extractTextFromPDF(pdfData, documentType, extractionMode);
    const pdfText = extractionResult.text;
    const metadata = extractionResult.metadata;

    // 抽出メタデータをログ出力
    console.log('[Background] 抽出メタデータ:', {
      documentType: metadata.documentType,
      extractionMode: metadata.extractionMode,
      totalPages: metadata.totalPages,
      extractedPages: `${metadata.extractedPages.length}ページ`,
      sectionsUsed: metadata.sectionsUsed,
      qualityWarning: metadata.qualityWarning?.message || 'なし',
    });

    // LLM設定を構築
    const llmConfig: LLMConfig = {
      provider: settings.provider,
      apiKey: settings.apiKey,
      model: settings.model,
      baseUrl: settings.customUrl || undefined,
    };

    // 文書タイプ別プロンプトを使用
    const promptText = getPromptForDocumentType(documentType, pdfText);

    // メッセージを構築
    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: promptText,
      },
    ];

    // 統一LLMクライアントを使用して要約を生成
    const summary = await generateText(llmConfig, messages);

    return { summary, metadata };
  } catch (error) {
    console.error('[Background] LLM要約エラー:', error);
    throw error;
  }
}

/**
 * Offscreen DocumentでPDFからテキストを抽出
 */
async function extractTextFromPDF(
  pdfData: ArrayBuffer,
  documentType: DocumentType,
  extractionMode: ExtractionMode
): Promise<{ text: string; metadata: SummaryMetadata }> {
  try {
    // ArrayBufferを配列に変換して送信
    const uint8Array = new Uint8Array(pdfData);

    // Offscreen Documentにメッセージを送信
    const response = await chrome.runtime.sendMessage({
      action: 'extractPdfText',
      pdfData: Array.from(uint8Array), // Arrayに変換して送信
      documentType, // 文書タイプを渡す
      extractionMode, // 抽出モードを渡す
    });

    if (!response.success) {
      throw new Error(response.error || 'PDF抽出に失敗しました');
    }

    return {
      text: response.text,
      metadata: response.metadata,
    };
  } catch (error) {
    console.error('[Background] PDF抽出エラー:', error);
    if (error instanceof Error) {
      throw new Error(`PDF抽出エラー: ${error.message}`);
    }
    throw new Error('PDFからテキストを抽出できませんでした。');
  }
}

export {};
