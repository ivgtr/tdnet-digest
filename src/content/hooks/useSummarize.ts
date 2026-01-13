/**
 * 要約処理とAPI通信を管理するカスタムフック
 */

import { useState } from 'react';
import type { SummaryMetadata, ExtractionMode } from '../types/summaryMetadata';

interface UseSummarizeOptions {
  pdfUrl: string;
  title: string;
}

interface SummarizeResult {
  summary: string | null;
  error: string | null;
  metadata: SummaryMetadata | null;
}

export function useSummarize({ pdfUrl, title }: UseSummarizeOptions) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<SummarizeResult | null>(null);

  /**
   * 要約を実行
   * @param forceExtractionMode 強制抽出モード（全文再要約ボタン用）
   */
  const summarize = async (forceExtractionMode?: ExtractionMode) => {
    setLoading(true);
    setResult(null);

    try {
      // 循環参照を避けるため、明示的に文字列化
      const cleanPdfUrl = String(pdfUrl);
      const cleanTitle = String(title);

      const response = await chrome.runtime.sendMessage({
        action: 'summarize' as const,
        pdfUrl: cleanPdfUrl,
        title: cleanTitle,
        ...(forceExtractionMode && { forceExtractionMode }),
      });

      if (response.error) {
        console.error('[Content] 要約エラー:', response.error);
        setResult({ summary: null, error: response.error, metadata: null });
      } else {
        setResult({ summary: response.summary, error: null, metadata: response.metadata });
      }
    } catch (err) {
      console.error('[Content] 例外が発生:', err);
      const errorMessage = err instanceof Error ? err.message : '要約に失敗しました';
      setResult({ summary: null, error: errorMessage, metadata: null });
    } finally {
      setLoading(false);
    }
  };

  /**
   * 結果をリセット
   */
  const reset = () => {
    setResult(null);
  };

  return { loading, result, summarize, reset };
}
