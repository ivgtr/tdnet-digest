import {
  decodeSummaryStorage,
  encodeSummaryStorage,
  summaryStorageWarning,
} from '@/lib/summary-storage';
import { useState, useEffect, useCallback, useRef } from 'react';
import type { DiagnosticPersistence } from '@/lib/summary-trace';
import {
  ANALYSIS_CACHE_DIAGNOSTIC_PREFIX,
  ANALYSIS_DIAGNOSTICS_KEY,
  readLastAnalysisAttempt,
  type AnalysisLastAttempt,
  readAnalysisDiagnosticReference,
} from '@/lib/analysis-trace';
import { buildAnalysisInput } from '@/lib/analysis-input';
import { summaryResultId } from '@/lib/summary-result-id';
import { normalizeTdnetPdfUrl } from '@/lib/tdnet-url';
import {
  buildAnalysisFingerprint,
  buildSummaryCacheKey,
  type AnalysisFingerprintSettings,
} from '@/lib/analysis-version';
import { configuredApiUrl } from '@/lib/llm-endpoint';
import { FACT_SCHEMA_VERSION, renderFacts } from '@/lib/fact-summary';
import { validateSavedFacts, validateSavedScore } from '@/lib/fact-cache';
import type { FactSummary } from '@/lib/fact-summary';
import { validatePresentation, type SummaryPresentation } from '@/lib/summary-presentation';
import {
  ANALYSIS_CACHE_PREFIX,
  parseAnalysis,
  type AdditionalAnalysis,
} from '@/lib/additional-analysis';
import type { ExperimentalScore } from '@/lib/scoring';
import type { SummaryMetadata, ExtractionMode, CachedSummary } from '@/types/summaryMetadata';

interface Options {
  pdfUrl: string;
  title: string;
  code: string;
  companyName: string;
}
export interface SummaryResult {
  summary: string | null;
  error: string | null;
  metadata: SummaryMetadata | null;
  facts: FactSummary | null;
  presentation: SummaryPresentation | null;
  resultId: string | null;
  diagnosticRunId: string | null;
  diagnosticPersistence?: DiagnosticPersistence;
  retryExtractionMode?: 'full';
}
export interface Stage<T> {
  lastAttempt?: AnalysisLastAttempt;
  diagnosticRunId?: string;
  diagnosticInputHash?: string;
  diagnosticPersistence?: DiagnosticPersistence;
  loading: boolean;
  data: T | null;
  error: string | null;
  persistenceWarning?: string;
}
const emptyStage = <T>(): Stage<T> => ({ loading: false, data: null, error: null });
const SUMMARY_PREFIX = 'summaryCacheV2:';
const SCORE_PREFIX = 'scoreCacheV4:';
const ANALYSIS_PREFIX = ANALYSIS_CACHE_PREFIX;
function isCachedSummary(value: unknown, key: string, pdfUrl: string): value is CachedSummary {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<CachedSummary>;
  try {
    validateSavedFacts(item.facts);
    validatePresentation(item.presentation, item.facts);
    return (
      typeof item.summary === 'string' &&
      (item.diagnosticRunId === undefined ||
        (typeof item.diagnosticRunId === 'string' && item.diagnosticRunId.length > 0)) &&
      (item.diagnosticPersistence === undefined ||
        ['saved', 'failed'].includes(item.diagnosticPersistence)) &&
      typeof item.resultId === 'string' &&
      /^[a-f0-9]{64}$/.test(item.resultId) &&
      item.facts?.version === FACT_SCHEMA_VERSION &&
      item.metadata?.analysisSchemaVersion === FACT_SCHEMA_VERSION &&
      typeof item.metadata.documentHash === 'string' &&
      /^[a-f0-9]{64}$/.test(item.metadata.documentHash) &&
      item.metadata?.analysisFingerprint !== undefined &&
      buildSummaryCacheKey(pdfUrl, item.metadata.analysisFingerprint) === key &&
      renderFacts(item.facts, item.presentation) === item.summary
    );
  } catch {
    return false;
  }
}

async function validatedCachedSummary(
  value: unknown,
  key: string,
  pdfUrl: string
): Promise<CachedSummary | null> {
  try {
    const entry = await decodeSummaryStorage(value);
    if (!isCachedSummary(entry, key, pdfUrl)) return null;
    return (await summaryResultId(
      pdfUrl,
      entry.metadata.analysisFingerprint!,
      entry.facts,
      entry.metadata.documentHash!,
      entry.presentation
    )) === entry.resultId
      ? entry
      : null;
  } catch {
    return null;
  }
}

export function useSummarize({ pdfUrl, title, code, companyName }: Options) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<SummaryResult | null>(null);
  const [score, setScore] = useState<Stage<ExperimentalScore>>(emptyStage());
  const [analysis, setAnalysis] = useState<Stage<AdditionalAnalysis>>(emptyStage());
  const [scoringEnabled, setScoringEnabled] = useState(false);
  const [hasCached, setHasCached] = useState(false);
  const [persistenceWarning, setPersistenceWarning] = useState<string | null>(null);
  const [stagesReady, setStagesReady] = useState(false);
  const [cacheKey, setCacheKey] = useState<string | null>(null);
  const keyRef = useRef<string | null>(null);
  const configuredKeyRef = useRef<string | null>(null);
  const settingsRef = useRef<
    | (AnalysisFingerprintSettings & {
        fingerprints: Record<ExtractionMode, string>;
      })
    | null
  >(null);
  const idRef = useRef<string | null>(null);
  const scoreStarted = useRef<string | null>(null);
  const runRef = useRef(0);
  const stageRequestRef = useRef({ score: 0, analyze: 0 });
  const mountedRef = useRef(false);
  const cacheRevisionRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    let active = true;
    let settingsRequest = 0;
    let configuredSignature: string | null = null;
    let storedSettings: Record<string, unknown> | null = null;
    const keys = ['provider', 'model', 'customUrl', 'extractionMode', 'experimentalScoring'];
    const invalidate = () => {
      configuredKeyRef.current = null;
      keyRef.current = null;
      settingsRef.current = null;
      idRef.current = null;
      scoreStarted.current = null;
      runRef.current++;
      setLoading(false);
      setResult(null);
      setScore(emptyStage());
      setAnalysis(emptyStage());
      setHasCached(false);
      setPersistenceWarning(null);
      setStagesReady(false);
      setCacheKey(null);
    };
    const applySettings = async (settings: Record<string, unknown>, request: number) => {
      if (!active || request !== settingsRequest) return;
      storedSettings = { ...settings };
      try {
        const provider = settings.provider ?? 'openai';
        const model = settings.model ?? 'gpt-4o';
        const customUrl = settings.customUrl ?? '';
        const extractionMode = settings.extractionMode ?? 'full';
        if (
          typeof provider !== 'string' ||
          typeof model !== 'string' ||
          typeof customUrl !== 'string' ||
          (extractionMode !== 'full' && extractionMode !== 'smart')
        )
          throw new Error('設定値が不正です');
        const currentSettings: AnalysisFingerprintSettings = {
          provider,
          model,
          baseUrl: configuredApiUrl({ provider, customUrl }),
          extractionMode,
        };
        const signature = JSON.stringify([
          currentSettings.provider,
          currentSettings.model,
          currentSettings.extractionMode,
          currentSettings.baseUrl,
        ]);
        if (signature !== configuredSignature) {
          // Invalidate before hashing so old responses cannot win the async digest race.
          configuredSignature = signature;
          invalidate();
        }
        setScoringEnabled(settings.experimentalScoring === true);
        const [full, smart] = await Promise.all(
          (['full', 'smart'] as const).map((extractionMode) =>
            buildAnalysisFingerprint({ ...currentSettings, extractionMode })
          )
        );
        const fingerprints = { full, smart };
        const next = buildSummaryCacheKey(pdfUrl, fingerprints[currentSettings.extractionMode]);
        if (!active || request !== settingsRequest) return;
        settingsRef.current = { ...currentSettings, fingerprints };
        if (next !== configuredKeyRef.current) {
          configuredKeyRef.current = next;
          keyRef.current = next;
          setCacheKey(next);
        }
      } catch {
        if (!active || request !== settingsRequest) return;
        configuredSignature = null;
        invalidate();
      }
    };
    const refresh = () => {
      const request = ++settingsRequest;
      chrome.storage.sync.get(keys, (settings) => void applySettings(settings, request));
    };
    refresh();
    const changed = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== 'sync' || !keys.some((key) => key in changes)) return;
      if (!storedSettings) return refresh();
      // StorageChange carries complete values. Apply them immediately so a delayed
      // sync.get cannot let an old summary or follow-up response be persisted.
      const next = { ...storedSettings };
      for (const key of keys) if (key in changes) next[key] = changes[key].newValue;
      void applySettings(next, ++settingsRequest);
    };
    chrome.storage.onChanged.addListener(changed);
    const pendingRun = runRef;
    return () => {
      active = false;
      mountedRef.current = false;
      pendingRun.current++;
      keyRef.current = null;
      configuredKeyRef.current = null;
      settingsRef.current = null;
      chrome.storage.onChanged.removeListener(changed);
    };
  }, [pdfUrl]);

  useEffect(() => {
    if (!cacheKey) return;
    let active = true;
    let request = 0;
    const storageKey = SUMMARY_PREFIX + cacheKey;
    const refresh = async () => {
      const read = ++request;
      const revision = cacheRevisionRef.current;
      const current = () =>
        active &&
        read === request &&
        revision === cacheRevisionRef.current &&
        cacheKey === keyRef.current;
      try {
        const data = await chrome.storage.local.get(storageKey);
        const entry = await validatedCachedSummary(data[storageKey], cacheKey, pdfUrl);
        if (current()) setHasCached(entry !== null);
      } catch {
        if (current()) setHasCached(false);
      }
    };
    const changed = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== 'local' || !(storageKey in changes)) return;
      cacheRevisionRef.current++;
      // A deleted entry must not remain clickable while an older read is in flight.
      setHasCached(false);
      void refresh();
    };
    chrome.storage.onChanged.addListener(changed);
    void refresh();
    return () => {
      active = false;
      chrome.storage.onChanged.removeListener(changed);
    };
  }, [cacheKey, pdfUrl]);

  const restoreStages = useCallback(
    async (
      id: string,
      facts: FactSummary,
      documentHash: string,
      presentation: SummaryPresentation
    ) => {
      const epoch = runRef.current;
      const requests = { ...stageRequestRef.current };
      const current = () => idRef.current === id && runRef.current === epoch;
      const canRestore = (stage: 'score' | 'analyze') =>
        current() && stageRequestRef.current[stage] === requests[stage];
      let data: Record<string, unknown>;
      try {
        data = await chrome.storage.local.get([
          SCORE_PREFIX + id,
          ANALYSIS_PREFIX + id,
          ANALYSIS_CACHE_DIAGNOSTIC_PREFIX + id,
          ANALYSIS_DIAGNOSTICS_KEY,
        ]);
      } catch {
        if (!current()) return;
        setPersistenceWarning((warning) =>
          [warning, '保存された採点・追加分析を読み込めませんでした。再実行できます']
            .filter(Boolean)
            .join(' / ')
        );
        // An unread cache is not a cache miss. Require an explicit retry, and
        // do not replace a follow-up the user started while this read was pending.
        if (canRestore('score'))
          setScore({
            loading: false,
            data: null,
            error: '保存された採点を読み込めませんでした',
          });
        if (canRestore('analyze'))
          setAnalysis({
            loading: false,
            data: null,
            error: '保存された追加分析を読み込めませんでした',
          });
        setStagesReady(true);
        return;
      }
      if (!current()) return;
      const cachedScore = data[SCORE_PREFIX + id] as ExperimentalScore | undefined;
      if (cachedScore?.value === null && canRestore('score')) {
        // Failure to clean up a legacy failed score must not hide a valid summary.
        await chrome.storage.local.remove(SCORE_PREFIX + id).catch(() => {});
        if (!current()) return;
      }
      if (canRestore('score')) {
        try {
          if (cachedScore && cachedScore.value !== null) {
            validateSavedScore(cachedScore, facts, normalizeTdnetPdfUrl(pdfUrl), documentHash);
            setScore({ loading: false, data: cachedScore, error: null });
          } else setScore(emptyStage());
        } catch {
          setScore({
            loading: false,
            data: null,
            error: '保存された採点の形式・確定事実との対応が不正です',
          });
        }
      }
      if (canRestore('analyze')) {
        let lastAttempt: AnalysisLastAttempt | null = null;
        let diagnosticWarning: string | undefined;
        try {
          lastAttempt = readLastAnalysisAttempt(
            data[ANALYSIS_DIAGNOSTICS_KEY],
            pdfUrl,
            id,
            buildAnalysisInput(facts, presentation).inputHash
          );
        } catch {
          diagnosticWarning = '直近の追加分析診断を読み込めませんでした';
        }
        const diagnosticHistory = {
          ...(lastAttempt ? { lastAttempt } : {}),
          ...(diagnosticWarning ? { persistenceWarning: diagnosticWarning } : {}),
        };
        try {
          const entry = data[ANALYSIS_PREFIX + id];
          if (entry) {
            const analysis = parseAnalysis(JSON.stringify(entry), facts, presentation);
            const diagnostic = readAnalysisDiagnosticReference(
              data[ANALYSIS_CACHE_DIAGNOSTIC_PREFIX + id],
              id,
              analysis.inputHash
            );
            setAnalysis({
              loading: false,
              data: analysis,
              error: null,
              ...diagnosticHistory,
              ...(diagnostic
                ? {
                    diagnosticRunId: diagnostic.runId,
                    diagnosticInputHash: diagnostic.inputHash,
                    diagnosticPersistence: diagnostic.persistence,
                  }
                : {}),
            });
          } else
            setAnalysis({
              ...emptyStage<AdditionalAnalysis>(),
              ...diagnosticHistory,
              error:
                lastAttempt?.outcome === 'failure'
                  ? `前回の追加分析: ${lastAttempt.error?.message ?? '生成に失敗しました'}`
                  : lastAttempt?.outcome === 'running'
                    ? '前回の追加分析の完了記録を確認できません。途中の診断を確認できます'
                    : null,
            });
        } catch {
          setAnalysis({
            loading: false,
            data: null,
            error: '保存された追加分析の形式・根拠が不正です',
            ...diagnosticHistory,
          });
        }
      }
      setStagesReady(true);
    },
    [pdfUrl]
  );

  const showCached = useCallback(async () => {
    if (!mountedRef.current) return true;
    const run = ++runRef.current;
    const key = keyRef.current;
    if (!key) return true;
    const revision = cacheRevisionRef.current;
    setStagesReady(false);
    const invalidate = () => {
      setHasCached(false);
      idRef.current = null;
      scoreStarted.current = null;
      setResult(null);
      setScore(emptyStage());
      setAnalysis(emptyStage());
      setPersistenceWarning(null);
    };
    let data: Record<string, unknown>;
    try {
      data = await chrome.storage.local.get(SUMMARY_PREFIX + key);
    } catch {
      if (
        !mountedRef.current ||
        key !== keyRef.current ||
        run !== runRef.current ||
        revision !== cacheRevisionRef.current
      )
        return true;
      // A failed read is not an absent entry and must never authorize a paid retry.
      setResult({
        summary: null,
        metadata: null,
        facts: null,
        presentation: null,
        resultId: null,
        diagnosticRunId: null,
        error:
          '保存された要約を読み込めませんでした。時間をおいて再度表示してください。再要約は新たな生成を行います。',
      });
      return true;
    }
    if (!mountedRef.current || key !== keyRef.current || run !== runRef.current) return true;
    const value = data[SUMMARY_PREFIX + key];
    const entry = await validatedCachedSummary(value, key, pdfUrl);
    if (!mountedRef.current || key !== keyRef.current || run !== runRef.current) return true;
    // A newer storage event owns availability. Do not clear its state or convert
    // an interrupted lookup into permission to generate a new paid summary.
    if (revision !== cacheRevisionRef.current) return true;
    if (!entry) {
      invalidate();
      if (value === undefined) return false;
      setResult({
        summary: null,
        metadata: null,
        facts: null,
        presentation: null,
        resultId: null,
        diagnosticRunId: null,
        error: '保存された現行要約の形式・原数量・設定が不正です。再要約してください。',
      });
      return true;
    }
    setHasCached(true);
    idRef.current = entry.resultId;
    setPersistenceWarning(entry.metadata.persistenceWarning ?? null);
    setResult({
      summary: entry.summary,
      metadata: entry.metadata,
      facts: entry.facts,
      presentation: entry.presentation,
      resultId: entry.resultId,
      diagnosticRunId: entry.diagnosticRunId ?? null,
      diagnosticPersistence: entry.diagnosticPersistence,
      error: null,
    });
    await restoreStages(
      entry.resultId,
      entry.facts,
      entry.metadata.documentHash!,
      entry.presentation
    );
    return true;
  }, [restoreStages, pdfUrl]);

  const summarize = useCallback(
    async (forceExtractionMode?: ExtractionMode) => {
      if (!mountedRef.current) return;
      const run = ++runRef.current;
      setLoading(true);
      setResult(null);
      setScore(emptyStage());
      setAnalysis(emptyStage());
      setStagesReady(false);
      setPersistenceWarning(null);
      scoreStarted.current = null;
      idRef.current = null;
      let diagnosticRunId: string | null = null;
      let diagnosticPersistence: DiagnosticPersistence | undefined;
      let retryExtractionMode: 'full' | undefined;
      try {
        const settings = settingsRef.current;
        if (!settings) throw new Error('設定の読み込みが完了していません');
        const expectedKey = buildSummaryCacheKey(
          pdfUrl,
          settings.fingerprints[forceExtractionMode ?? settings.extractionMode]
        );
        const response = await chrome.runtime.sendMessage({
          action: 'summarize',
          pdfUrl,
          title,
          code,
          companyName,
          ...(forceExtractionMode ? { forceExtractionMode } : {}),
        });
        if (run !== runRef.current) return;
        if (typeof response.diagnosticRunId !== 'string' || !response.diagnosticRunId)
          throw new Error('要約結果の実行IDが不正です');
        diagnosticRunId = response.diagnosticRunId;
        diagnosticPersistence =
          response.diagnosticPersistence === 'saved' || response.diagnosticPersistence === 'failed'
            ? response.diagnosticPersistence
            : undefined;
        if (response.persistenceWarning) setPersistenceWarning(response.persistenceWarning);
        if (response.retryExtractionMode !== undefined) {
          if (response.retryExtractionMode !== 'full')
            throw new Error('再要約の抽出方式が不正です');
          retryExtractionMode = response.retryExtractionMode;
        }
        if (response.error) throw new Error(response.error);
        validateSavedFacts(response.facts);
        validatePresentation(response.presentation, response.facts);
        if (response.summary !== renderFacts(response.facts, response.presentation))
          throw new Error('要約本文と表示構成が一致しません');
        if (
          (await summaryResultId(
            pdfUrl,
            response.metadata.analysisFingerprint,
            response.facts,
            response.metadata.documentHash,
            response.presentation
          )) !== response.resultId
        )
          throw new Error('要約結果の識別子が一致しません');
        if (run !== runRef.current) return;
        const key = buildSummaryCacheKey(pdfUrl, response.metadata.analysisFingerprint);
        if (key !== expectedKey) throw new Error('要約結果の設定が一致しません');
        keyRef.current = key;
        setCacheKey(key);
        idRef.current = response.resultId;
        setResult({
          summary: response.summary,
          metadata: response.metadata,
          facts: response.facts,
          presentation: response.presentation,
          resultId: response.resultId,
          diagnosticRunId,
          diagnosticPersistence,
          error: null,
        });
        setStagesReady(true);
        const diagnosticWarning = response.metadata.persistenceWarning ?? null;
        setPersistenceWarning(diagnosticWarning);
        const entry: CachedSummary = {
          summary: response.summary,
          facts: response.facts,
          presentation: response.presentation,
          resultId: response.resultId,
          diagnosticRunId: diagnosticRunId!,
          diagnosticPersistence,
          metadata: response.metadata,
          companyName,
          title,
          code,
          cachedAt: Date.now(),
        };
        const cacheRevision = cacheRevisionRef.current;
        try {
          const storedEntry = await encodeSummaryStorage(entry);
          if (
            !mountedRef.current ||
            run !== runRef.current ||
            key !== keyRef.current ||
            cacheRevision !== cacheRevisionRef.current
          )
            return;
          await chrome.storage.local.set({ [SUMMARY_PREFIX + key]: storedEntry });
          if (
            run === runRef.current &&
            key === keyRef.current &&
            cacheRevision === cacheRevisionRef.current
          ) {
            // A newer storage event owns availability. A late write completion
            // must not undo a deletion or let a pre-write read replace this state.
            cacheRevisionRef.current++;
            setHasCached(true);
          }
        } catch (error) {
          if (run === runRef.current && key === keyRef.current) {
            const warning = [diagnosticWarning, summaryStorageWarning(error)]
              .filter(Boolean)
              .join(' / ');
            setPersistenceWarning(warning);
            // Replacement failure says nothing about the previous entry. Re-read
            // and validate it without replacing the fresh visible result.
            if (cacheRevision === cacheRevisionRef.current) {
              try {
                const saved = await chrome.storage.local.get(SUMMARY_PREFIX + key);
                const prior = await validatedCachedSummary(
                  saved[SUMMARY_PREFIX + key],
                  key,
                  pdfUrl
                );
                if (
                  mountedRef.current &&
                  run === runRef.current &&
                  key === keyRef.current &&
                  cacheRevision === cacheRevisionRef.current
                ) {
                  setHasCached(prior !== null);
                  if (prior)
                    setPersistenceWarning(`${warning}。以前の保存済み要約は引き続き表示できます`);
                }
              } catch {
                // Unknown availability is not a cache miss. Keep prior knowledge;
                // reopening always performs a fresh read before any generation.
              }
            }
          }
        }
      } catch (error) {
        if (run === runRef.current)
          setResult({
            summary: null,
            metadata: null,
            facts: null,
            presentation: null,
            resultId: null,
            diagnosticRunId,
            diagnosticPersistence,
            retryExtractionMode,
            error: error instanceof Error ? error.message : String(error),
          });
      } finally {
        if (run === runRef.current) setLoading(false);
      }
    },
    [pdfUrl, title, code, companyName]
  );

  const requestStage = useCallback(
    async (action: 'score' | 'analyze', current: SummaryResult) => {
      if (
        !mountedRef.current ||
        !current.facts ||
        !current.resultId ||
        !current.metadata?.analysisFingerprint
      )
        return;
      const id = current.resultId;
      const epoch = runRef.current;
      const requestNumber = ++stageRequestRef.current[action];
      const isCurrent = () =>
        mountedRef.current &&
        idRef.current === id &&
        runRef.current === epoch &&
        stageRequestRef.current[action] === requestNumber;
      const set = action === 'score' ? setScore : setAnalysis;
      const cache = (action === 'score' ? SCORE_PREFIX : ANALYSIS_PREFIX) + id;
      set({ loading: true, data: null, error: null });
      let diagnosticRunId: string | undefined;
      let diagnosticInputHash: string | undefined;
      let diagnosticPersistence: DiagnosticPersistence | undefined;
      let diagnosticWarning: string | undefined;
      const diagnosticState = () =>
        action === 'analyze'
          ? {
              diagnosticRunId,
              diagnosticInputHash,
              diagnosticPersistence,
              ...(diagnosticWarning ? { persistenceWarning: diagnosticWarning } : {}),
            }
          : {};
      try {
        const response = await chrome.runtime.sendMessage({
          action,
          pdfUrl,
          title,
          code,
          companyName,
          facts: current.facts,
          presentation: current.presentation,
          resultId: id,
          fingerprint: current.metadata.analysisFingerprint,
        });
        if (!isCurrent()) return;
        if (action === 'analyze') {
          diagnosticRunId =
            typeof response.diagnosticRunId === 'string' && response.diagnosticRunId
              ? response.diagnosticRunId
              : undefined;
          diagnosticInputHash =
            typeof response.diagnosticInputHash === 'string'
              ? response.diagnosticInputHash
              : undefined;
          diagnosticPersistence = ['saved', 'failed'].includes(response.diagnosticPersistence)
            ? response.diagnosticPersistence
            : undefined;
          diagnosticWarning =
            typeof response.persistenceWarning === 'string'
              ? response.persistenceWarning
              : undefined;
        }
        if (response.error) throw new Error(response.error);
        const data =
          action === 'score'
            ? response.score
            : parseAnalysis(
                JSON.stringify(response.analysis),
                current.facts,
                current.presentation!
              );
        if (!data) throw new Error(`${action} の結果がありません`);
        if (action === 'score' && data.value === null)
          throw new Error(data.unverified?.join(' / ') || '採点の根拠を確認できません');
        set({ loading: false, data, error: null, ...diagnosticState() });
        try {
          await chrome.storage.local.set({
            [cache]: data,
            ...(action === 'analyze'
              ? {
                  [ANALYSIS_CACHE_DIAGNOSTIC_PREFIX + id]: diagnosticRunId
                    ? {
                        runId: diagnosticRunId,
                        summaryResultId: id,
                        inputHash: (data as AdditionalAnalysis).inputHash,
                        persistence: diagnosticPersistence ?? 'failed',
                      }
                    : null,
                }
              : {}),
          });
        } catch (error) {
          if (isCurrent())
            set({
              loading: false,
              data,
              error: null,
              ...diagnosticState(),
              persistenceWarning: [
                diagnosticWarning,
                summaryStorageWarning(error, action === 'score' ? '採点' : '追加分析'),
              ]
                .filter(Boolean)
                .join(' / '),
            });
        }
      } catch (error) {
        if (isCurrent())
          set({
            loading: false,
            data: null,
            error: error instanceof Error ? error.message : String(error),
            ...diagnosticState(),
          });
      }
    },
    [pdfUrl, title, code, companyName]
  );

  const startScore = useCallback(() => {
    if (
      !scoringEnabled ||
      !stagesReady ||
      !result?.resultId ||
      score.loading ||
      score.data ||
      score.error ||
      scoreStarted.current === result.resultId
    )
      return;
    scoreStarted.current = result.resultId;
    void requestStage('score', result);
  }, [scoringEnabled, stagesReady, result, score, requestStage]);
  const retryScore = useCallback(() => {
    if (!scoringEnabled || !result?.resultId || score.loading || !score.error) return;
    scoreStarted.current = result.resultId;
    void requestStage('score', result);
  }, [scoringEnabled, result, score.loading, score.error, requestStage]);
  const analyze = useCallback(() => {
    if (result && !analysis.loading) void requestStage('analyze', result);
  }, [result, analysis.loading, requestStage]);
  const reset = useCallback(() => {
    runRef.current++;
    idRef.current = null;
    scoreStarted.current = null;
    setResult(null);
    setLoading(false);
    setPersistenceWarning(null);
    setScore(emptyStage());
    setAnalysis(emptyStage());
    setStagesReady(false);
  }, []);
  return {
    loading,
    result,
    score,
    analysis,
    scoringEnabled,
    hasCached,
    persistenceWarning,
    cacheKey,
    summarize,
    showCached,
    startScore,
    retryScore,
    analyze,
    reset,
  };
}
