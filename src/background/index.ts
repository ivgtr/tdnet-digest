import { generateText, type LLMConfig, type ChatMessage } from '@/lib/llm-client';
import { ANALYSIS_SCHEMA_VERSION, buildAnalysisFingerprint } from '@/lib/analysis-version';
import { detectDocumentType, detectEarningsContext, type DocumentType } from '@/lib/document-type';
import { getPromptForDocumentType, getExtractionPrompt } from '@/lib/prompts';
import { getFormatPrompt } from '@/lib/format-prompts';
import { getJsonSchema } from '@/lib/summary-schema';
import type { EarningsExtraction } from '@/lib/summary-schema';
import { refineEarningsExtraction } from '@/lib/earnings-refinement';
import { assessClaim, inferExperimentalScore } from '@/lib/scoring';
import { extractScoreInput, type ScoreDocument } from '@/lib/score-extraction';
import { fetchCandidatePdf, searchDisclosureCandidates } from '@/lib/disclosure-search';
import {
  buildJsonRepairMessages,
  getProviderCapabilities,
  parseAndValidateExtraction,
} from '@/lib/structured-output';
import type { SummaryMetadata, ExtractionMode } from '@/types/summaryMetadata';

interface SummarizeRequest {
  action: 'summarize';
  pdfUrl: string;
  title: string; // 文書タイプ判別用
  code: string;
  companyName: string;
  forceExtractionMode?: ExtractionMode; // 全文再要約ボタン用
}

interface Settings {
  provider: string;
  apiKey: string;
  model: string;
  customUrl?: string;
  extractionMode?: ExtractionMode;
  twoPassMode?: boolean;
  experimentalScoring?: boolean;
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

    handleSummarize(
      request.pdfUrl,
      request.title,
      request.code,
      request.companyName,
      request.forceExtractionMode
    )
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
  code: string,
  companyName: string,
  forceExtractionMode?: ExtractionMode
): Promise<{ summary: string; metadata: SummaryMetadata }> {
  try {
    // 設定を取得
    const settings = await getSettings();

    if (!settings.apiKey) {
      throw new Error('APIキーが設定されていません。拡張機能の設定ページで設定してください。');
    }

    if (settings.provider === 'custom' && !settings.customUrl) {
      throw new Error('カスタムプロバイダーを使用する場合はAPI URLを設定してください。');
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
    const result = await summarizeWithLLM(
      pdfData,
      settings,
      documentType,
      extractionMode,
      title,
      `https://www.release.tdnet.info/inbs/${pdfUrl}`,
      code,
      companyName
    );

    return result;
  } catch (error) {
    console.error('[Background] 要約処理エラー:', error);
    throw error;
  }
}

async function getSettings(): Promise<Settings> {
  return new Promise((resolve) => {
    chrome.storage.sync.get(
      [
        'provider',
        'apiKey',
        'model',
        'customUrl',
        'extractionMode',
        'twoPassMode',
        'experimentalScoring',
      ],
      (result) => {
        resolve({
          provider: result.provider || 'openai',
          apiKey: result.apiKey || '',
          model: result.model || 'gpt-4o',
          customUrl: result.customUrl || '',
          extractionMode: result.extractionMode || 'full',
          twoPassMode: result.twoPassMode !== undefined ? result.twoPassMode : true,
          experimentalScoring: result.experimentalScoring === true,
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
  extractionMode: ExtractionMode,
  title: string,
  pdfUrl: string,
  code: string,
  companyName: string
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

    // 文書タイプ別コンテキスト
    const earningsContext = documentType === 'earnings' ? detectEarningsContext(title) : undefined;

    // 2パスモード判定（デフォルトON）
    const useTwoPass = settings.twoPassMode !== false;
    metadata.analysisSchemaVersion = ANALYSIS_SCHEMA_VERSION;
    metadata.provider = settings.provider;
    metadata.model = settings.model;
    metadata.summaryMode = useTwoPass ? 'two-pass' : 'one-pass';
    metadata.experimentalScoring = settings.experimentalScoring === true;
    metadata.analysisFingerprint = buildAnalysisFingerprint({
      provider: settings.provider,
      model: settings.model,
      extractionMode,
      twoPassMode: useTwoPass,
      experimentalScoring: metadata.experimentalScoring,
    });

    let summaryResult;
    if (useTwoPass) {
      summaryResult = await summarizeTwoPass(
        llmConfig,
        documentType,
        pdfText,
        earningsContext,
        title,
        metadata
      );
    } else {
      summaryResult = await summarizeOnePass(
        llmConfig,
        documentType,
        pdfText,
        earningsContext,
        metadata
      );
    }
    if (settings.experimentalScoring === true) {
      await attachScore(
        llmConfig,
        documentType,
        title,
        pdfUrl,
        code,
        companyName,
        pdfData,
        extractionMode,
        extractionResult,
        metadata
      );
    }
    return summaryResult;
  } catch (error) {
    console.error('[Background] LLM要約エラー:', error);
    throw error;
  }
}

/**
 * 1パス要約（従来方式）
 */
async function summarizeOnePass(
  llmConfig: LLMConfig,
  documentType: DocumentType,
  pdfText: string,
  earningsContext: ReturnType<typeof detectEarningsContext> | undefined,
  metadata: SummaryMetadata
): Promise<{ summary: string; metadata: SummaryMetadata }> {
  const { system, user } = getPromptForDocumentType(documentType, pdfText, earningsContext);
  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
  const summary = await generateText(llmConfig, messages);
  return { summary, metadata };
}

/**
 * 2パス要約（情報抽出→フォーマット整形）
 */
async function summarizeTwoPass(
  llmConfig: LLMConfig,
  documentType: DocumentType,
  pdfText: string,
  earningsContext: ReturnType<typeof detectEarningsContext> | undefined,
  documentTitle: string,
  metadata: SummaryMetadata
): Promise<{ summary: string; metadata: SummaryMetadata }> {
  // パス1: 情報抽出（JSON）
  console.log('[Background] 2パス要約: パス1（情報抽出）開始');
  const { system: s1, user: u1 } = getExtractionPrompt(documentType, pdfText, earningsContext);
  const capabilities = getProviderCapabilities(llmConfig.provider);
  const extractionConfig: LLMConfig = {
    ...llmConfig,
    temperature: 0,
    ...(capabilities.jsonObject && { responseFormat: 'json_object' as const }),
  };
  const extractedText = await generateText(extractionConfig, [
    { role: 'system', content: s1 },
    { role: 'user', content: u1 },
  ]);

  let validation = parseAndValidateExtraction(extractedText, documentType, metadata.totalPages);
  if (!validation.success) {
    console.warn('[Background] 2パス要約: 検証失敗、JSON修復を1回実行', validation.errors);
    const repairMessages = buildJsonRepairMessages(
      extractedText,
      validation.errors,
      getJsonSchema(documentType, earningsContext)
    );
    const repairedText = await generateText(extractionConfig, repairMessages);
    validation = parseAndValidateExtraction(repairedText, documentType, metadata.totalPages);
  }

  if (!validation.success || !validation.data) {
    console.warn(
      '[Background] 2パス要約: JSON修復後も検証失敗、検証済み1パス要約へフォールバック',
      validation.errors
    );
    return summarizeOnePass(llmConfig, documentType, pdfText, earningsContext, metadata);
  }

  console.log('[Background] 2パス要約: パス1完了、パス2（フォーマット整形）開始');

  const extractionData =
    documentType === 'earnings' && earningsContext
      ? refineEarningsExtraction(
          validation.data as EarningsExtraction,
          earningsContext,
          documentTitle
        )
      : validation.data;

  // パス2: フォーマット整形（低temperature）
  const formatConfig: LLMConfig = { ...llmConfig, temperature: 0.3 };
  const { system: s2, user: u2 } = getFormatPrompt(documentType, extractionData, earningsContext);
  const formatted = await generateText(formatConfig, [
    { role: 'system', content: s2 },
    { role: 'user', content: u2 },
  ]);

  console.log('[Background] 2パス要約: パス2完了');
  return { summary: formatted, metadata };
}

async function attachScore(
  config: LLMConfig,
  documentType: DocumentType,
  title: string,
  pdfUrl: string,
  code: string,
  companyName: string,
  pdfData: ArrayBuffer,
  extractionMode: ExtractionMode,
  extractionResult: { text: string; metadata: SummaryMetadata },
  metadata: SummaryMetadata
): Promise<void> {
  let searchStatus = '元PDF内を確認';
  try {
    const scoringText =
      extractionMode === 'smart'
        ? (await extractTextFromPDF(pdfData, documentType, 'full')).text
        : extractionResult.text;
    const original: ScoreDocument = {
      url: pdfUrl,
      text: scoringText,
      issuer: companyName,
      code,
      publishedDate: readPublishedDate(scoringText),
    };
    const documents = [original];
    let input = await extractScoreInput(config, documentType, documents, searchStatus);
    const needsPast =
      !input.claims.some((claim) => assessClaim(claim) !== null) ||
      (input.claims.some((claim) => claim.category === 'oneOff') &&
        !input.claims.some((claim) =>
          ['operatingProfit', 'revenue', 'margin', 'kpi', 'coreForecast'].includes(claim.category)
        )) ||
      input.claims.some(
        (claim) => ['operatingProfit', 'revenue', 'kpi'].includes(claim.category) && !claim.earlier
      );
    if (needsPast && companyName && code) {
      const search = await searchDisclosureCandidates(config, companyName, code, title);
      searchStatus = `${search.status}（API要求${search.apiRequests}回、実検索${search.requests === null ? '不明' : search.requests + '回'}、候補${search.urls.length}件）。${search.costStatus}`;
      for (const url of search.urls) {
        try {
          const data = await fetchCandidatePdf(url);
          const result = await extractTextFromPDF(data, documentType, 'full');
          const candidate: ScoreDocument = {
            url,
            text: result.text,
            issuer: companyName,
            code,
            publishedDate: readPublishedDate(result.text),
          };
          if (
            !original.publishedDate ||
            !candidate.publishedDate ||
            candidate.publishedDate > original.publishedDate
          )
            throw new Error('開示日の前後を照合できません');
          if (
            !candidate.text
              .normalize('NFKC')
              .replace(/\s/g, '')
              .includes(companyName.normalize('NFKC').replace(/\s/g, '')) &&
            !candidate.text.includes(code.slice(0, 4))
          )
            throw new Error('発行会社を照合できません');
          const next = await extractScoreInput(
            config,
            documentType,
            [original, candidate],
            searchStatus
          );
          const candidateClaims = next.claims.filter(
            (claim) =>
              assessClaim(claim) !== null &&
              [claim.current, claim.previous, claim.earlier, claim.relatedValue].some(
                (value) => value?.source.url === candidate.url
              )
          );
          if (candidateClaims.length) {
            const key = (claim: (typeof input.claims)[number]) =>
              [
                claim.category,
                claim.current.source.metric,
                claim.current.source.period,
                claim.current.source.scope,
              ].join('|');
            const merged = new Map(input.claims.map((claim) => [key(claim), claim]));
            for (const claim of candidateClaims) {
              const existing = merged.get(key(claim));
              if (
                !existing ||
                assessClaim(existing) === null ||
                (!existing.earlier && claim.earlier)
              )
                merged.set(key(claim), claim);
            }
            input = {
              claims: [...merged.values()],
              unverified: [...new Set([...input.unverified, ...next.unverified])],
              searchStatus,
            };
            documents.push(candidate);
          } else {
            searchStatus += ' / 候補の比較条件が不一致';
          }
        } catch (error) {
          searchStatus += ` / 候補不採用: ${error instanceof Error ? error.message : String(error)}`;
        }
      }
    }
    if (needsPast && (!companyName || !code))
      searchStatus = '会社名または証券コードを確認できず過去資料を検索できません';
    input.searchStatus = searchStatus;
    metadata.score = await inferExperimentalScore(config, documentType, input);
  } catch (error) {
    metadata.score = {
      value: null,
      verdict: '算出不能',
      positives: [],
      negatives: [],
      breakdown: [],
      unverified: [
        `採点根拠を検証できません: ${error instanceof Error ? error.message : String(error)}`,
      ],
      searchStatus,
    };
  }
}

export function readPublishedDate(text: string): string | null {
  const firstPage = text.match(/\[PDF_PAGE:1\]([\s\S]*?)(?=\[PDF_PAGE:|$)/)?.[1];
  if (!firstPage) return null;
  for (const line of firstPage.normalize('NFKC').split('\n').slice(0, 12)) {
    const match = line.replace(/\s/g, '').match(/^(20\d{2})[年/.-](\d{1,2})[月/.-](\d{1,2})日?$/);
    if (!match) continue;
    const year = Number(match[1]),
      month = Number(match[2]),
      day = Number(match[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (
      date.getUTCFullYear() === year &&
      date.getUTCMonth() === month - 1 &&
      date.getUTCDate() === day
    )
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  return null;
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
