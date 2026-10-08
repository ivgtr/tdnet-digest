import { useState, useEffect, useCallback, useRef } from 'react';
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
  retryExtractionMode?: 'full';
}
export interface Stage<T> {
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
        const entry = data[storageKey] as CachedSummary | undefined;
        const valid =
          isCachedSummary(entry, cacheKey, pdfUrl) &&
          (await summaryResultId(
            pdfUrl,
            entry.metadata.analysisFingerprint!,
            entry.facts,
            entry.metadata.documentHash!,
            entry.presentation
          )) === entry.resultId;
        if (current()) setHasCached(valid);
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
        data = await chrome.storage.local.get([SCORE_PREFIX + id, ANALYSIS_PREFIX + id]);
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
        try {
          const entry = data[ANALYSIS_PREFIX + id];
          setAnalysis(
            entry
              ? {
                  loading: false,
                  data: parseAnalysis(JSON.stringify(entry), facts, presentation),
                  error: null,
                }
              : emptyStage()
          );
        } catch {
          setAnalysis({
            loading: false,
            data: null,
            error: '保存された追加分析の形式・根拠が不正です',
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
      if (key !== keyRef.current || run !== runRef.current) return true;
      invalidate();
      return false;
    }
    if (key !== keyRef.current || run !== runRef.current) return true;
    const entry = data[SUMMARY_PREFIX + key] as CachedSummary | undefined;
    const valid =
      isCachedSummary(entry, key, pdfUrl) &&
      (await summaryResultId(
        pdfUrl,
        entry.metadata.analysisFingerprint!,
        entry.facts,
        entry.metadata.documentHash!,
        entry.presentation
      )) === entry.resultId;
    if (key !== keyRef.current || run !== runRef.current) return true;
    if (revision !== cacheRevisionRef.current || !valid) {
      invalidate();
      if (revision !== cacheRevisionRef.current || entry === undefined) return false;
    }
    if (!valid) {
      if (entry !== undefined)
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
    if (!entry) return false;
    idRef.current = entry.resultId;
    setPersistenceWarning(entry.metadata.persistenceWarning ?? null);
    setResult({
      summary: entry.summary,
      metadata: entry.metadata,
      facts: entry.facts,
      presentation: entry.presentation,
      resultId: entry.resultId,
      diagnosticRunId: null,
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
          metadata: response.metadata,
          companyName,
          title,
          code,
          cachedAt: Date.now(),
        };
        const cacheRevision = cacheRevisionRef.current;
        try {
          await chrome.storage.local.set({ [SUMMARY_PREFIX + key]: entry });
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
        } catch {
          if (run === runRef.current) {
            setPersistenceWarning(
              [diagnosticWarning, '要約を保存できませんでした。表示結果は利用できます']
                .filter(Boolean)
                .join(' / ')
            );
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
        set({ loading: false, data, error: null });
        try {
          await chrome.storage.local.set({ [cache]: data });
        } catch {
          if (isCurrent())
            set({
              loading: false,
              data,
              error: null,
              persistenceWarning: `${action === 'score' ? '採点' : '追加分析'}を保存できませんでした。表示結果は利用できます`,
            });
        }
      } catch (error) {
        if (isCurrent())
          set({
            loading: false,
            data: null,
            error: error instanceof Error ? error.message : String(error),
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
