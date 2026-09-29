import { useState, useEffect, useCallback, useRef } from 'react';
import { buildAnalysisFingerprint, buildSummaryCacheKey } from '@/lib/analysis-version';
import { FACT_SCHEMA_VERSION, renderFacts } from '@/lib/fact-summary';
import type { FactSummary } from '@/lib/fact-summary';
import type { AdditionalAnalysis } from '@/lib/additional-analysis';
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
  resultId: string | null;
}
export interface Stage<T> {
  loading: boolean;
  data: T | null;
  error: string | null;
}
const emptyStage = <T>(): Stage<T> => ({ loading: false, data: null, error: null });
const SUMMARY_PREFIX = 'summaryCacheV2:';
const SCORE_PREFIX = 'scoreCacheV3:';
const ANALYSIS_PREFIX = 'analysisCacheV1:';
function isCachedSummary(value: unknown, key: string, pdfUrl: string): value is CachedSummary {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<CachedSummary>;
  try {
    return (
      typeof item.summary === 'string' &&
      typeof item.resultId === 'string' &&
      /^[a-f0-9]{64}$/.test(item.resultId) &&
      item.facts?.version === FACT_SCHEMA_VERSION &&
      item.metadata?.analysisSchemaVersion === FACT_SCHEMA_VERSION &&
      item.metadata?.analysisFingerprint !== undefined &&
      buildSummaryCacheKey(pdfUrl, item.metadata.analysisFingerprint) === key &&
      renderFacts(item.facts) === item.summary
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
  const [stagesReady, setStagesReady] = useState(false);
  const [cacheKey, setCacheKey] = useState<string | null>(null);
  const keyRef = useRef<string | null>(null);
  const idRef = useRef<string | null>(null);
  const scoreStarted = useRef<string | null>(null);
  const runRef = useRef(0);

  useEffect(() => {
    let active = true;
    const keys = ['provider', 'model', 'extractionMode', 'experimentalScoring'];
    const refresh = () =>
      chrome.storage.sync.get(keys, (settings) => {
        if (!active) return;
        const mode = settings.extractionMode ?? 'full';
        const next = buildSummaryCacheKey(
          pdfUrl,
          buildAnalysisFingerprint({
            provider: settings.provider ?? 'openai',
            model: settings.model ?? 'gpt-4o',
            extractionMode: mode,
          })
        );
        if (next !== keyRef.current) {
          keyRef.current = next;
          idRef.current = null;
          scoreStarted.current = null;
          runRef.current++;
          setResult(null);
          setScore(emptyStage());
          setAnalysis(emptyStage());
          setHasCached(false);
          setStagesReady(false);
          setCacheKey(next);
        }
        setScoringEnabled(settings.experimentalScoring === true);
      });
    refresh();
    const changed = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'sync' && keys.some((key) => key in changes)) refresh();
    };
    chrome.storage.onChanged.addListener(changed);
    return () => {
      active = false;
      chrome.storage.onChanged.removeListener(changed);
    };
  }, [pdfUrl]);

  useEffect(() => {
    if (!cacheKey) return;
    chrome.storage.local.get(SUMMARY_PREFIX + cacheKey, (data) => {
      if (cacheKey !== keyRef.current) return;
      const entry = data[SUMMARY_PREFIX + cacheKey] as CachedSummary | undefined;
      setHasCached(isCachedSummary(entry, cacheKey, pdfUrl));
    });
  }, [cacheKey, pdfUrl]);

  const restoreStages = useCallback(async (id: string) => {
    const data = await chrome.storage.local.get([SCORE_PREFIX + id, ANALYSIS_PREFIX + id]);
    if (idRef.current !== id) return;
    setScore(
      data[SCORE_PREFIX + id]
        ? { loading: false, data: data[SCORE_PREFIX + id], error: null }
        : emptyStage()
    );
    setAnalysis(
      data[ANALYSIS_PREFIX + id]
        ? { loading: false, data: data[ANALYSIS_PREFIX + id], error: null }
        : emptyStage()
    );
    setStagesReady(true);
  }, []);

  const showCached = useCallback(async () => {
    const key = keyRef.current;
    if (!key) return;
    setStagesReady(false);
    const data = await chrome.storage.local.get(SUMMARY_PREFIX + key);
    if (key !== keyRef.current) return;
    const entry = data[SUMMARY_PREFIX + key] as CachedSummary | undefined;
    if (!isCachedSummary(entry, key, pdfUrl)) return;
    idRef.current = entry.resultId;
    setResult({
      summary: entry.summary,
      metadata: entry.metadata,
      facts: entry.facts,
      resultId: entry.resultId,
      error: null,
    });
    await restoreStages(entry.resultId);
  }, [restoreStages, pdfUrl]);

  const summarize = useCallback(
    async (forceExtractionMode?: ExtractionMode) => {
      const run = ++runRef.current;
      setLoading(true);
      setResult(null);
      setScore(emptyStage());
      setAnalysis(emptyStage());
      setStagesReady(false);
      scoreStarted.current = null;
      idRef.current = null;
      try {
        const response = await chrome.runtime.sendMessage({
          action: 'summarize',
          pdfUrl,
          title,
          code,
          companyName,
          ...(forceExtractionMode ? { forceExtractionMode } : {}),
        });
        if (run !== runRef.current) return;
        if (response.error) throw new Error(response.error);
        const key = buildSummaryCacheKey(pdfUrl, response.metadata.analysisFingerprint);
        if (key !== keyRef.current) return;
        idRef.current = response.resultId;
        setResult({
          summary: response.summary,
          metadata: response.metadata,
          facts: response.facts,
          resultId: response.resultId,
          error: null,
        });
        setStagesReady(true);
        const entry: CachedSummary = {
          summary: response.summary,
          facts: response.facts,
          resultId: response.resultId,
          metadata: response.metadata,
          companyName,
          title,
          code,
          cachedAt: Date.now(),
        };
        await chrome.storage.local.set({ [SUMMARY_PREFIX + key]: entry });
        if (key === keyRef.current) setHasCached(true);
      } catch (error) {
        if (run === runRef.current)
          setResult({
            summary: null,
            metadata: null,
            facts: null,
            resultId: null,
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
      if (!current.facts || !current.resultId || !current.metadata?.analysisFingerprint) return;
      const id = current.resultId;
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
          resultId: id,
          fingerprint: current.metadata.analysisFingerprint,
        });
        if (idRef.current !== id) return;
        if (response.error) throw new Error(response.error);
        const data = action === 'score' ? response.score : response.analysis;
        if (!data) throw new Error(`${action} の結果がありません`);
        set({ loading: false, data, error: null });
        await chrome.storage.local.set({ [cache]: data });
      } catch (error) {
        if (idRef.current === id)
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
    idRef.current = null;
    scoreStarted.current = null;
    setResult(null);
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
    cacheKey,
    summarize,
    showCached,
    startScore,
    retryScore,
    analyze,
    reset,
  };
}
