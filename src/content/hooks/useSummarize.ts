import { useState, useEffect, useCallback, useRef } from 'react';
import { summaryResultId } from '@/lib/summary-result-id';
import { normalizeTdnetPdfUrl } from '@/lib/tdnet-url';
import { buildAnalysisFingerprint, buildSummaryCacheKey } from '@/lib/analysis-version';
import { FACT_SCHEMA_VERSION, renderFacts } from '@/lib/fact-summary';
import { validateSavedFacts, validateSavedScore } from '@/lib/fact-cache';
import type { FactSummary } from '@/lib/fact-summary';
import { validatePresentation, type SummaryPresentation } from '@/lib/summary-presentation';
import { parseAnalysis, type AdditionalAnalysis } from '@/lib/additional-analysis';
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
}
const emptyStage = <T>(): Stage<T> => ({ loading: false, data: null, error: null });
const SUMMARY_PREFIX = 'summaryCacheV2:';
const SCORE_PREFIX = 'scoreCacheV4:';
const ANALYSIS_PREFIX = 'analysisCacheV2:';
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
  const [stagesReady, setStagesReady] = useState(false);
  const [cacheKey, setCacheKey] = useState<string | null>(null);
  const keyRef = useRef<string | null>(null);
  const configuredKeyRef = useRef<string | null>(null);
  const settingsRef = useRef<{
    provider: string;
    model: string;
    extractionMode: ExtractionMode;
  } | null>(null);
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
        const currentSettings = {
          provider: settings.provider ?? 'openai',
          model: settings.model ?? 'gpt-4o',
          extractionMode: mode as ExtractionMode,
        };
        const next = buildSummaryCacheKey(pdfUrl, buildAnalysisFingerprint(currentSettings));
        settingsRef.current = currentSettings;
        if (next !== configuredKeyRef.current) {
          configuredKeyRef.current = next;
          keyRef.current = next;
          idRef.current = null;
          scoreStarted.current = null;
          runRef.current++;
          setLoading(false);
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
    chrome.storage.local.get(SUMMARY_PREFIX + cacheKey, async (data) => {
      if (cacheKey !== keyRef.current) return;
      const entry = data[SUMMARY_PREFIX + cacheKey] as CachedSummary | undefined;
      const valid =
        isCachedSummary(entry, cacheKey, pdfUrl) &&
        (await summaryResultId(
          pdfUrl,
          entry.metadata.analysisFingerprint!,
          entry.facts,
          entry.metadata.documentHash!,
          entry.presentation
        )) === entry.resultId;
      if (cacheKey === keyRef.current) setHasCached(valid);
    });
  }, [cacheKey, pdfUrl]);

  const restoreStages = useCallback(
    async (id: string, facts: FactSummary, documentHash: string) => {
      const data = await chrome.storage.local.get([SCORE_PREFIX + id, ANALYSIS_PREFIX + id]);
      if (idRef.current !== id) return;
      const cachedScore = data[SCORE_PREFIX + id] as ExperimentalScore | undefined;
      if (cachedScore?.value === null) {
        await chrome.storage.local.remove(SCORE_PREFIX + id);
        if (idRef.current !== id) return;
      }
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
      try {
        const entry = data[ANALYSIS_PREFIX + id];
        setAnalysis(
          entry
            ? { loading: false, data: parseAnalysis(JSON.stringify(entry), facts), error: null }
            : emptyStage()
        );
      } catch {
        setAnalysis({
          loading: false,
          data: null,
          error: '保存された追加分析の形式・根拠が不正です',
        });
      }
      setStagesReady(true);
    },
    [pdfUrl]
  );

  const showCached = useCallback(async () => {
    const key = keyRef.current;
    if (!key) return;
    setStagesReady(false);
    const data = await chrome.storage.local.get(SUMMARY_PREFIX + key);
    if (key !== keyRef.current) return;
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
    if (key !== keyRef.current) return;
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
      return;
    }
    if (key !== keyRef.current) return;
    if (!entry) return;
    idRef.current = entry.resultId;
    setResult({
      summary: entry.summary,
      metadata: entry.metadata,
      facts: entry.facts,
      presentation: entry.presentation,
      resultId: entry.resultId,
      diagnosticRunId: null,
      error: null,
    });
    await restoreStages(entry.resultId, entry.facts, entry.metadata.documentHash!);
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
      let diagnosticRunId: string | null = null;
      let retryExtractionMode: 'full' | undefined;
      try {
        const settings = settingsRef.current;
        if (!settings) throw new Error('設定の読み込みが完了していません');
        const expectedKey = buildSummaryCacheKey(
          pdfUrl,
          buildAnalysisFingerprint({
            ...settings,
            extractionMode: forceExtractionMode ?? settings.extractionMode,
          })
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
        await chrome.storage.local.set({ [SUMMARY_PREFIX + key]: entry });
        if (key === keyRef.current) setHasCached(true);
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
          presentation: current.presentation,
          resultId: id,
          fingerprint: current.metadata.analysisFingerprint,
        });
        if (idRef.current !== id) return;
        if (response.error) throw new Error(response.error);
        const data = action === 'score' ? response.score : response.analysis;
        if (!data) throw new Error(`${action} の結果がありません`);
        if (action === 'score' && data.value === null)
          throw new Error(data.unverified?.join(' / ') || '採点の根拠を確認できません');
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
