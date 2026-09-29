/**
 * 要約処理とAPI通信を管理するカスタムフック
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { buildAnalysisFingerprint, buildSummaryCacheKey } from '@/lib/analysis-version';
import type {
  SummaryMetadata,
  ExtractionMode,
  CachedSummary,
  SummaryCacheStore,
} from '../types/summaryMetadata';
import type { ExperimentalScore } from '@/lib/scoring';

interface UseSummarizeOptions {
  pdfUrl: string;
  title: string;
  code: string;
  companyName: string;
}

interface SummarizeResult {
  summary: string | null;
  error: string | null;
  metadata: SummaryMetadata | null;
}

const CACHE_KEY = 'summaryCache';

export function useSummarize({ pdfUrl, title, code, companyName }: UseSummarizeOptions) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<SummarizeResult | null>(null);
  const [hasCached, setHasCached] = useState(false);
  const [cachedScore, setCachedScore] = useState<ExperimentalScore | null>(null);
  const [cacheKey, setCacheKey] = useState<string | null>(null);
  const cacheKeyRef = useRef<string | null>(null);

  useEffect(() => {
    let active = true;
    const keys = ['provider', 'model', 'extractionMode', 'twoPassMode', 'experimentalScoring'];
    const refresh = () =>
      chrome.storage.sync.get(keys, (settings) => {
        if (!active) return;
        const fingerprint = buildAnalysisFingerprint({
          provider: settings.provider || 'openai',
          model: settings.model || 'gpt-4o',
          extractionMode: settings.extractionMode || 'full',
          twoPassMode: settings.twoPassMode !== undefined ? settings.twoPassMode : true,
          experimentalScoring: settings.experimentalScoring === true,
        });
        const next = buildSummaryCacheKey(pdfUrl, fingerprint);
        if (next !== cacheKeyRef.current) {
          cacheKeyRef.current = next;
          setResult(null);
          setHasCached(false);
          setCachedScore(null);
          setCacheKey(next);
        }
      });
    refresh();
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'sync' && keys.some((key) => key in changes)) refresh();
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => {
      active = false;
      chrome.storage.onChanged.removeListener(onChanged);
    };
  }, [pdfUrl]);

  // マウント時にキャッシュの存在チェック
  useEffect(() => {
    if (!cacheKey) return;
    chrome.storage.local.get(CACHE_KEY, (data) => {
      if (cacheKey !== cacheKeyRef.current) return;
      const store: SummaryCacheStore = data[CACHE_KEY] || {};
      setHasCached(cacheKey in store);
      setCachedScore(store[cacheKey]?.metadata.score ?? null);
    });
  }, [cacheKey]);

  /**
   * キャッシュに保存
   */
  const saveToCache = useCallback(
    (summary: string, metadata: SummaryMetadata) => {
      const entryKey = metadata.analysisFingerprint
        ? buildSummaryCacheKey(pdfUrl, metadata.analysisFingerprint)
        : cacheKeyRef.current;
      if (!entryKey) return;

      chrome.storage.local.get(CACHE_KEY, (data) => {
        const store: SummaryCacheStore = data[CACHE_KEY] || {};
        const entry: CachedSummary = {
          summary,
          metadata,
          companyName,
          title,
          code,
          cachedAt: Date.now(),
        };
        store[entryKey] = entry;
        chrome.storage.local.set({ [CACHE_KEY]: store }, () => {
          if (entryKey === cacheKeyRef.current) {
            setHasCached(true);
            setCachedScore(metadata.score ?? null);
          }
        });
      });
    },
    [companyName, title, code, pdfUrl]
  );

  /**
   * キャッシュから読み込んで result にセット
   */
  const showCached = useCallback(() => {
    if (!cacheKey) return;
    chrome.storage.local.get(CACHE_KEY, (data) => {
      if (cacheKey !== cacheKeyRef.current) return;
      const store: SummaryCacheStore = data[CACHE_KEY] || {};
      const cached = store[cacheKey];
      if (cached) {
        setResult({
          summary: cached.summary,
          error: null,
          metadata: cached.metadata,
        });
      }
    });
  }, [cacheKey]);

  /**
   * 要約を実行
   * @param forceExtractionMode 強制抽出モード（全文再要約ボタン用）
   */
  const summarize = useCallback(
    async (forceExtractionMode?: ExtractionMode) => {
      setLoading(true);
      setResult(null);

      try {
        const cleanPdfUrl = String(pdfUrl);
        const cleanTitle = String(title);

        const response = await chrome.runtime.sendMessage({
          action: 'summarize' as const,
          pdfUrl: cleanPdfUrl,
          title: cleanTitle,
          code,
          companyName,
          ...(forceExtractionMode && { forceExtractionMode }),
        });

        if (response.error) {
          console.error('[Content] 要約エラー:', response.error);
          setResult({ summary: null, error: response.error, metadata: null });
        } else {
          const responseKey = response.metadata?.analysisFingerprint
            ? buildSummaryCacheKey(pdfUrl, response.metadata.analysisFingerprint)
            : null;
          if (responseKey === cacheKeyRef.current)
            setResult({ summary: response.summary, error: null, metadata: response.metadata });
          saveToCache(response.summary, response.metadata);
        }
      } catch (err) {
        console.error('[Content] 例外が発生:', err);
        const errorMessage = err instanceof Error ? err.message : '要約に失敗しました';
        setResult({ summary: null, error: errorMessage, metadata: null });
      } finally {
        setLoading(false);
      }
    },
    [pdfUrl, title, code, companyName, saveToCache]
  );

  /**
   * 結果をリセット
   */
  const reset = useCallback(() => {
    setResult(null);
  }, []);

  return { loading, result, hasCached, cachedScore, cacheKey, summarize, showCached, reset };
}
