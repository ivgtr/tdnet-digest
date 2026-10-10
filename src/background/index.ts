import {
  NATIVE_LIMITS,
  validateNativeCompanionRef,
  type NativeCompanionRef,
  type NativeDisclosure,
} from '@/lib/native-disclosure-contract';
import { validateNativeDisclosure } from '@/lib/native-disclosure';
import { summaryStorageWarning } from '@/lib/summary-storage';
import {
  saveSummaryTrace,
  summaryBuildDigest,
  type SummaryTrace,
  type DiagnosticPersistence,
} from '@/lib/summary-trace';
import {
  PdfExtractionError,
  pdfExtractionError,
  readPdfExtractionError,
  type PdfExtractionStage,
} from '@/lib/pdf-extraction-error';
import {
  saveAnalysisTrace,
  loadAnalysisTrace,
  nextAnalysisIntentAt,
  type AnalysisTrace,
  type AnalysisGenerationDiagnostic,
} from '@/lib/analysis-trace';
import { buildAnalysisInput } from '@/lib/analysis-input';
import { generateSourceSummary } from '@/lib/source-summary';
import { validateSavedFacts } from '@/lib/fact-cache';
import type { LLMConfig } from '@/lib/llm-client';
import { configuredApiUrl } from '@/lib/llm-endpoint';
import { detectDocumentType, type DocumentType } from '@/lib/document-type';
import {
  FACT_SCHEMA_VERSION,
  parseFactSummary,
  renderFacts,
  type FactSummary,
} from '@/lib/fact-summary';
import {
  analyzeFacts,
  analysisModelInput,
  type AdditionalAnalysis,
} from '@/lib/additional-analysis';
import { serializePagesForAnalysis } from '@/lib/page-text';
import { summaryResultId as resultId } from '@/lib/summary-result-id';
import {
  revalidatePresentation,
  SummarySourceSelectionError,
  validatePresentation,
  type SummaryPresentation,
} from '@/lib/summary-presentation';
import { validatePages } from '@/lib/fact-validation';
import { buildAnalysisFingerprint } from '@/lib/analysis-version';
import { normalizeTdnetPdfUrl as fullUrl } from '@/lib/tdnet-url';
import { assessClaim, inferExperimentalScore, type ExperimentalScore } from '@/lib/scoring';
import { extractScoreInput, type ScoreDocument } from '@/lib/score-extraction';
import { fetchCandidatePdf, searchDisclosureCandidates } from '@/lib/disclosure-search';
import { getProvider } from '@/lib/llm-providers';
import { customApiPermission, SCORING_PDF_PERMISSIONS } from '@/lib/host-permissions';
import type {
  SummaryMetadata,
  ExtractionMode,
  PdfExtractionResult,
  ExtractedPage,
} from '@/types/summaryMetadata';

interface BaseRequest {
  nativeCompanion?: NativeCompanionRef;
  pdfUrl: string;
  title: string;
  code: string;
  companyName: string;
}
interface SummarizeRequest extends BaseRequest {
  action: 'summarize';
  forceExtractionMode?: ExtractionMode;
}
interface FollowupRequest extends BaseRequest {
  action: 'score' | 'analyze';
  facts: FactSummary;
  presentation: SummaryPresentation;
  resultId: string;
  fingerprint: string;
}
type Request = SummarizeRequest | FollowupRequest;
interface Settings {
  provider: string;
  apiKey: string;
  model: string;
  customUrl: string;
  extractionMode: ExtractionMode;
  experimentalScoring: boolean;
}
class RetryableScoringError extends Error {}

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason !== 'update') return;
  void chrome.permissions
    .getAll()
    .then(async ({ origins }) => {
      if (origins?.includes('https://*/*')) {
        const removed = await chrome.permissions.remove({ origins: ['https://*/*'] });
        if (!removed) throw new Error('旧HTTPS全域権限を削除できませんでした');
      }
    })
    .catch((error) => console.error('旧ホスト権限の削除に失敗:', error));
});
interface AnalysisDiagnosticRequest {
  action: 'getAnalysisDiagnostic';
  pdfUrl: string;
  runId: string;
  summaryResultId: string;
  inputHash: string;
}
chrome.runtime.onMessage.addListener(
  (request: Request | AnalysisDiagnosticRequest, _sender, sendResponse) => {
    if (request.action === 'getAnalysisDiagnostic') {
      if (
        ![request.pdfUrl, request.runId, request.summaryResultId, request.inputHash].every(
          (value) => typeof value === 'string' && value.length > 0
        )
      ) {
        sendResponse({ error: '追加分析診断の識別情報が不正です' });
        return;
      }
      void loadAnalysisTrace(
        request.pdfUrl,
        request.runId,
        request.summaryResultId,
        'failed',
        request.inputHash
      )
        .then((trace) => sendResponse({ trace }))
        .catch((error) =>
          sendResponse({ error: error instanceof Error ? error.message : String(error) })
        );
      return true;
    }
    if (!['summarize', 'score', 'analyze'].includes(request.action)) return;
    const diagnosticRunId = request.action !== 'score' ? crypto.randomUUID() : null;
    const task =
      request.action === 'summarize'
        ? handleSummarize(request, diagnosticRunId!)
        : request.action === 'analyze'
          ? handleAnalyze(request, diagnosticRunId!)
          : handleFollowup(request);
    task
      .then((response) =>
        sendResponse({ ...response, ...(diagnosticRunId ? { diagnosticRunId } : {}) })
      )
      .catch((error) =>
        sendResponse({
          error: error instanceof Error ? error.message : String(error),
          ...(error instanceof SummarySourceSelectionError ? { retryExtractionMode: 'full' } : {}),
          ...(diagnosticRunId ? { diagnosticRunId } : {}),
        })
      );
    return true;
  }
);

// Concurrent summary/follow-up requests share only the in-flight initialization.
// Recheck contexts after completion so a subsequently closed document is recreated.
let offscreenSetup: Promise<void> | null = null;
function setupOffscreenDocument(): Promise<void> {
  if (!offscreenSetup) {
    offscreenSetup = (async () => {
      const existing = await chrome.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT' as chrome.runtime.ContextType],
      });
      if (!existing.length)
        await chrome.offscreen.createDocument({
          url: 'offscreen.html',
          reasons: ['DOM_PARSER' as chrome.offscreen.Reason],
          justification: 'PDF.jsによる文字抽出',
        });
    })().finally(() => {
      offscreenSetup = null;
    });
  }
  return offscreenSetup;
}

async function getSettings(): Promise<Settings> {
  const result = await chrome.storage.sync.get([
    'provider',
    'apiKey',
    'model',
    'customUrl',
    'extractionMode',
    'experimentalScoring',
    'twoPassMode',
  ]);
  if (result.twoPassMode !== undefined) {
    await chrome.storage.sync.remove('twoPassMode');
    console.info('廃止された twoPassMode 設定を削除しました');
  }
  const provider = result.provider ?? 'openai';
  const model = result.model ?? 'gpt-4o';
  const extractionMode = result.extractionMode ?? 'full';
  if (
    typeof provider !== 'string' ||
    !getProvider(provider) ||
    typeof model !== 'string' ||
    !model.trim() ||
    !['full', 'smart'].includes(extractionMode) ||
    (result.experimentalScoring !== undefined && typeof result.experimentalScoring !== 'boolean')
  )
    throw new Error('設定値が不正です。設定画面で確認してください');
  if (typeof result.apiKey !== 'string' || !result.apiKey)
    throw new Error('APIキーが設定されていません');
  const customUrl = result.customUrl ?? '';
  if (typeof customUrl !== 'string' || (provider === 'custom' && !customUrl))
    throw new Error('API URLが不正です');
  if (provider === 'custom') {
    const origin = customApiPermission(customUrl);
    if (!(await chrome.permissions.contains({ origins: [origin] })))
      throw new Error('カスタムAPIホストへのアクセス権がありません。設定画面で保存してください');
  }
  return {
    provider,
    apiKey: result.apiKey,
    model,
    customUrl,
    extractionMode,
    experimentalScoring: result.experimentalScoring === true,
  };
}
function configOf(settings: Settings): LLMConfig {
  return {
    provider: settings.provider,
    apiKey: settings.apiKey,
    model: settings.model,
    baseUrl: configuredApiUrl(settings),
  };
}
async function fetchPDF(url: string): Promise<ArrayBuffer> {
  const response = await fetch(fullUrl(url));
  if (!response.ok)
    throw new Error(`PDF取得に失敗しました: ${response.status} ${response.statusText}`);
  return response.arrayBuffer();
}
async function hashPdf(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function acquireNativeSource(
  ref: NativeCompanionRef | undefined,
  pdfUrl: string,
  pdfText: string
): Promise<{ native?: NativeDisclosure; warnings: string[] }> {
  if (!ref) return { warnings: [] };
  try {
    const source = validateNativeCompanionRef(ref, pdfUrl);
    const response = await fetch(source.zipUrl, {
      signal: AbortSignal.timeout(15_000),
      redirect: 'error',
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (Number(response.headers.get('content-length')) > NATIVE_LIMITS.archiveBytes)
      throw new Error('ZIPのサイズが取得上限を超えています');
    if (!response.body) throw new Error('ZIPの応答本文がありません');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > NATIVE_LIMITS.archiveBytes)
          throw new Error('ZIPのサイズが取得上限を超えています');
        chunks.push(next.value);
      }
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const parsed = await chrome.runtime.sendMessage({
      action: 'parseNativeDisclosure',
      archiveData: Array.from(bytes),
      ref: source,
      pdfText,
    });
    if (!parsed?.success) throw new Error(parsed?.error ?? 'XBRL/HTMLの読取りに失敗しました');
    const native = validateNativeDisclosure(parsed.native);
    return {
      native,
      warnings:
        native.status === 'eligible'
          ? native.warnings
          : [
              '同じ開示のXBRL/HTMLを利用できないためPDF全文へ切り替えました。' +
                native.reasons.join(' / '),
            ],
    };
  } catch (error) {
    return {
      warnings: [
        `XBRL/HTMLを利用できないためPDF全文へ切り替えました（${error instanceof Error ? error.message : String(error)}）`,
      ],
    };
  }
}

async function handleSummarize(request: SummarizeRequest, runId: string) {
  const started = performance.now();
  const trace: SummaryTrace = {
    version: 1,
    runId,
    resultId: null,
    startedAt: new Date().toISOString(),
    pdfUrl: request.pdfUrl,
    documentType: detectDocumentType(request.title),
    provider: null,
    model: null,
    extractionMode: null,
    fingerprint: null,
    buildDigest: summaryBuildDigest(),
    documentHash: null,
    inputHash: null,
    selectedPages: [],
    attempts: [],
    usage: [],
    elapsedMs: 0,
    outcome: 'running',
    error: null,
  };
  let diagnosticPersistence: DiagnosticPersistence = 'failed';
  let diagnosticWarning: string | undefined;
  const saveTrace = async () => {
    trace.elapsedMs = Math.round(performance.now() - started);
    try {
      const saved = await saveSummaryTrace(structuredClone(trace));
      diagnosticPersistence = 'saved';
      diagnosticWarning = saved.cleanupWarning;
    } catch {
      diagnosticPersistence = 'failed';
      diagnosticWarning = '診断を保存できませんでした';
    }
  };

  try {
    trace.pdfUrl = fullUrl(request.pdfUrl);
    await saveTrace();
    const settings = await getSettings();
    const documentType = detectDocumentType(request.title);
    const mode = request.forceExtractionMode ?? settings.extractionMode;
    if (!['full', 'smart'].includes(mode)) throw new Error('抽出モードが不正です');
    Object.assign(trace, {
      provider: settings.provider,
      model: settings.model,
      extractionMode: 'full',
      requestedExtractionMode: mode,
    });
    const data = await fetchPDF(request.pdfUrl);
    await setupOffscreenDocument();
    // Source-first generation always reads all pages. The selected setting still
    // participates in cache identity; it never silently removes source evidence.
    const extraction = await extractTextFromPDF(data, documentType, 'full');
    const config = configOf(settings);
    const fingerprint = await buildAnalysisFingerprint({
      ...config,
      extractionMode: mode,
    });
    const documentHash = await hashPdf(data);
    Object.assign(trace, {
      fingerprint,
      documentHash,
      selectedPages: extraction.pages
        .filter((p) => p.selection === 'selected')
        .map((p) => p.pageNumber),
    });
    await saveTrace();
    const nativeSource = await acquireNativeSource(
      request.nativeCompanion,
      request.pdfUrl,
      extraction.text
    );
    const generated = await generateSourceSummary(
      { ...config, signal: AbortSignal.timeout(60_000), onUsage: (u) => trace.usage.push(u) },
      documentType,
      extraction.pages,
      async (snapshot) => {
        trace.inputHash = snapshot.input.inputHash;
        trace.sourceFirst = {
          version: 1,
          modelInput: analysisModelInput(snapshot.input),
          contract: snapshot.contract,
          notices: snapshot.notices ?? [],
        };
        if (snapshot.response !== null)
          trace.attempts = [
            {
              phase: 'summary',
              response: snapshot.response,
              error: snapshot.error?.message ?? null,
            },
          ];
        await saveTrace();
      },
      nativeSource
    );
    const facts = generated.facts;
    const id = await resultId(
      request.pdfUrl,
      fingerprint,
      facts,
      documentHash,
      generated.presentation
    );
    trace.resultId = id;
    trace.outcome = generated.presentation.sourceFirst!.summary!.notices.length
      ? 'partialSuccess'
      : 'firstSuccess';

    await saveTrace();
    const metadata: SummaryMetadata = {
      ...extraction.metadata,
      documentHash,
      analysisSchemaVersion: FACT_SCHEMA_VERSION,
      provider: settings.provider,
      model: settings.model,
      summaryMode: 'source-first',
      extractionMode: 'full',
      generationCalls: trace.attempts.length,
      analysisFingerprint: fingerprint,
      ...(diagnosticWarning
        ? {
            persistenceWarning:
              diagnosticPersistence === 'failed'
                ? `${diagnosticWarning}。表示結果は利用できます`
                : diagnosticWarning,
          }
        : {}),
    };
    return {
      summary: renderFacts(facts, generated.presentation),
      facts,
      presentation: generated.presentation,
      resultId: id,
      diagnosticPersistence,
      metadata,
    };
  } catch (error) {
    trace.outcome = 'failure';
    trace.error = error instanceof Error ? error.message : String(error);
    if (error instanceof PdfExtractionError) trace.pdfExtractionError = error.details;
    await saveTrace();
    return {
      error: trace.error,
      diagnosticPersistence,
      ...(diagnosticWarning ? { persistenceWarning: diagnosticWarning } : {}),
      ...(error instanceof SummarySourceSelectionError ? { retryExtractionMode: 'full' } : {}),
    };
  }
}

async function handleAnalyze(request: FollowupRequest, runId: string) {
  const started = performance.now();
  const trace: AnalysisTrace = {
    version: 1,
    stage: 'analysis',
    intentAt: nextAnalysisIntentAt(),
    runId,
    summaryResultId: request.resultId,
    startedAt: new Date().toISOString(),
    pdfUrl: request.pdfUrl,
    provider: null,
    model: null,
    buildDigest: summaryBuildDigest(),
    fingerprint: request.fingerprint,
    inputHash: null,
    input: null,
    contract: null,
    response: null,
    usage: null,
    outcome: 'running',
    error: null,
    elapsedMs: 0,
  };
  let diagnosticPersistence: DiagnosticPersistence = 'failed';
  let diagnosticWarning: string | undefined;
  const saveTrace = async () => {
    trace.elapsedMs = Math.round(performance.now() - started);
    try {
      await saveAnalysisTrace(trace);
      diagnosticPersistence = 'saved';
      diagnosticWarning = undefined;
    } catch (error) {
      diagnosticPersistence = 'failed';
      diagnosticWarning = summaryStorageWarning(error, '追加分析の診断');
    }
  };
  let terminalObserved = false;
  const metadata = () => ({
    diagnosticPersistence,
    diagnosticInputHash: trace.inputHash,
    ...(diagnosticPersistence === 'failed' ? { persistenceWarning: diagnosticWarning } : {}),
  });
  try {
    trace.pdfUrl = fullUrl(request.pdfUrl);
    validatePresentation(request.presentation, request.facts);
    trace.inputHash = buildAnalysisInput(request.facts, request.presentation).inputHash;
    await saveTrace();
    const result = await handleFollowup(request, async (snapshot, identity) => {
      if (identity) {
        trace.provider = identity.provider;
        trace.model = identity.model;
      }
      if (snapshot) {
        trace.input = request.presentation.sourceFirst ? null : snapshot.input;
        if (request.presentation.sourceFirst) trace.modelInput = analysisModelInput(snapshot.input);
        trace.contract = snapshot.contract;
        trace.inputHash = snapshot.input.inputHash;
        trace.response = snapshot.response;
        trace.usage = snapshot.usage;
        trace.outcome = snapshot.outcome;
        trace.notices = snapshot.notices;
        terminalObserved = snapshot.outcome !== 'running';
        trace.error = snapshot.error;
      }
      await saveTrace();
    });
    if (!terminalObserved) {
      trace.outcome = result.analysis?.notices.length ? 'partialSuccess' : 'success';
      trace.notices = result.analysis?.notices;
      await saveTrace();
    }
    return { ...result, ...metadata() };
  } catch (error) {
    trace.outcome = 'failure';
    trace.error ??= {
      code: 'analysis-preflight-failed',
      path: '$',
      message: error instanceof Error ? error.message : String(error),
    };
    if (!terminalObserved) await saveTrace();
    return { error: error instanceof Error ? error.message : String(error), ...metadata() };
  }
}

async function handleFollowup(
  request: FollowupRequest,
  diagnostic?: (
    snapshot: AnalysisGenerationDiagnostic | null,
    identity?: { provider: string; model: string }
  ) => Promise<void>
): Promise<{ score?: ExperimentalScore; analysis?: AdditionalAnalysis }> {
  validatePresentation(request.presentation, request.facts);
  const settings = await getSettings();
  const config = configOf(settings);
  await diagnostic?.(null, { provider: settings.provider, model: settings.model });
  const fingerprints = await Promise.all(
    (['full', 'smart'] as const).map((extractionMode) =>
      buildAnalysisFingerprint({ ...config, extractionMode })
    )
  );
  if (!fingerprints.includes(request.fingerprint))
    throw new Error('設定が変更されています。要約をやり直してください');
  const documentType = detectDocumentType(request.title);
  if (request.action === 'score' && request.presentation.sourceFirst)
    throw new Error(
      '原資料要約では実験的スコアを利用できません。追加分析をご利用ください（採点用APIは呼び出していません）'
    );
  const data = await fetchPDF(request.pdfUrl);
  await setupOffscreenDocument();
  const extraction = await extractTextFromPDF(data, documentType, 'full');
  // 必須判定は初回の選択範囲で実施済み。全文再取得では元事実の意味を再照合する。
  // 再照合で事実が変われば、PDFハッシュを含むresultIdの一致検査で拒否する。
  validateSavedFacts(request.facts);
  const facts = request.presentation.sourceFirst
    ? request.facts
    : parseFactSummary(JSON.stringify(request.facts), documentType, extraction.pages, false);
  if (facts.documentType !== documentType) throw new Error('原資料の文書種別が一致しません');
  const presentation = revalidatePresentation(request.presentation, facts, extraction.pages);
  if (presentation.sourceFirst?.nativeMode === 'included') {
    const prior = presentation.sourceFirst.native!;
    const current = await acquireNativeSource(prior.source, request.pdfUrl, extraction.text);
    if (
      !current.native ||
      current.native.status !== 'eligible' ||
      current.native.hash !== prior.hash ||
      current.native.checksum !== prior.checksum
    )
      throw new Error(
        'XBRL/HTMLの原資料が取得時から変更されたか再確認できません。PDF全文で要約をやり直してください'
      );
  }
  if (
    (await resultId(
      request.pdfUrl,
      request.fingerprint,
      facts,
      await hashPdf(data),
      presentation
    )) !== request.resultId
  )
    throw new Error('要約結果の識別子が一致しません');
  if (request.action === 'analyze')
    return {
      analysis: await analyzeFacts(config, facts, presentation, diagnostic, extraction.pages),
    };
  if (!settings.experimentalScoring) throw new Error('実験的スコアがOFFです');
  const score = await attachScore(
    config,
    documentType,
    request.title,
    fullUrl(request.pdfUrl),
    request.code,
    request.companyName,
    data,
    'full',
    extraction,
    facts
  );
  if (score.value === null)
    throw new RetryableScoringError(score.unverified.join(' / ') || '採点の根拠を確認できません');
  return { score };
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
  extractionResult: PdfExtractionResult,
  facts: FactSummary
): Promise<ExperimentalScore> {
  let searchStatus = '元PDF内を確認';
  try {
    const scoringExtraction =
      extractionMode === 'smart'
        ? await extractTextFromPDF(pdfData, documentType, 'full')
        : extractionResult;
    const scoringText = scoringExtraction.text;
    const original: ScoreDocument = {
      url: pdfUrl,
      documentHash: await hashPdf(pdfData),
      text: scoringText,
      pages: scoringExtraction.pages,
      issuer: companyName,
      code,
      publishedDate: readPublishedDate(scoringText),
    };
    const documents = [original];
    let input = await extractScoreInput(config, documentType, documents, searchStatus, facts);
    const needsPast =
      !input.claims.some((claim) => assessClaim(claim) !== null) ||
      (input.claims.some((claim) => claim.category === 'oneOff') &&
        !input.claims.some((claim) =>
          ['operatingProfit', 'revenue', 'margin', 'kpi', 'coreForecast'].includes(claim.category)
        )) ||
      input.claims.some(
        (claim) => ['operatingProfit', 'revenue', 'kpi'].includes(claim.category) && !claim.earlier
      );
    if (needsPast && !(await chrome.permissions.contains({ origins: SCORING_PDF_PERMISSIONS }))) {
      searchStatus = '過去資料へのアクセス権がありません。設定画面で実験的スコアを保存してください';
    } else if (needsPast && companyName && code && original.publishedDate) {
      const search = await searchDisclosureCandidates(
        config,
        companyName,
        code,
        title,
        original.publishedDate
      );
      if (search.error) throw new RetryableScoringError(`過去資料の検索に失敗: ${search.error}`);
      searchStatus = `${search.status}（API要求${search.apiRequests}回、実検索${search.requests === null ? '不明' : search.requests + '回'}、候補${search.urls.length}件）。${search.costStatus}`;
      for (const url of search.urls) {
        try {
          const data = await fetchCandidatePdf(url, code);
          const result = await extractTextFromPDF(data, documentType, 'full');
          const candidate: ScoreDocument = {
            url,
            documentHash: await hashPdf(data),
            text: result.text,
            pages: result.pages,
            issuer: companyName,
            code,
            publishedDate: readPublishedDate(result.text),
          };
          if (
            !original.publishedDate ||
            !candidate.publishedDate ||
            candidate.publishedDate >= original.publishedDate
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
            searchStatus,
            facts
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
    if (needsPast && (!companyName || !code || !original.publishedDate))
      searchStatus = '会社名、証券コード、または元PDFの開示日を確認できず過去資料を検索できません';
    if (!input.claims.some((claim) => assessClaim(claim) !== null))
      throw new RetryableScoringError(
        `採点に必要な比較値を原文で確認できませんでした。${searchStatus}`
      );
    input.searchStatus = searchStatus;
    return await inferExperimentalScore(config, documentType, input);
  } catch (error) {
    if (error instanceof RetryableScoringError) throw error;
    return {
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
): Promise<PdfExtractionResult> {
  let stage: PdfExtractionStage = 'transport';
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
      throw (
        readPdfExtractionError(response.pdfExtractionError) ??
        new Error(response.error || 'PDF抽出に失敗しました')
      );
    }

    stage = 'validation';
    validatePages(response.pages);
    if (
      typeof response.text !== 'string' ||
      !response.metadata ||
      response.metadata.extractionMode !== extractionMode ||
      response.metadata.totalPages !== response.pages.length ||
      response.pages.some((p: ExtractedPage, i: number) => p.pageNumber !== i + 1) ||
      JSON.stringify(response.metadata.extractedPages) !==
        JSON.stringify(
          response.pages
            .filter((p: ExtractedPage) => p.selection === 'selected')
            .map((p: ExtractedPage) => p.pageNumber)
        ) ||
      response.text !==
        serializePagesForAnalysis(
          response.pages.filter((p: ExtractedPage) => p.selection === 'selected')
        )
    )
      throw new Error('PDF抽出応答の形式が不正です');
    return {
      text: response.text,
      pages: response.pages,
      metadata: response.metadata,
    };
  } catch (error) {
    console.error('[Background] PDF抽出エラー:', error);
    throw pdfExtractionError(error, stage);
  }
}
