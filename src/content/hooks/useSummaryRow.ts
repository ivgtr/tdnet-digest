/**
 * 要約行のDOM操作を管理するカスタムフック
 */

import { useCallback } from 'react';
import {
  buildAnalysisStageHtml,
  buildErrorHtml,
  buildScoreStageHtml,
  buildSummaryHtml,
} from '../utils/summaryHtmlBuilder';
import type { SummaryMetadata } from '../types/summaryMetadata';
import type { Stage } from './useSummarize';
import type { ExperimentalScore } from '@/lib/scoring';
import type { AdditionalAnalysis } from '@/lib/additional-analysis';

interface UseSummaryRowOptions {
  row: HTMLTableRowElement;
  iframeDoc: Document;
  rowData: {
    companyName: string;
    title: string;
  };
}

export function useSummaryRow({ row, iframeDoc, rowData }: UseSummaryRowOptions) {
  /**
   * 既存の要約行を削除
   */
  const removeSummaryRow = useCallback(() => {
    const existingSummaryRow = row.nextElementSibling;
    if (existingSummaryRow?.classList.contains('tdnet-digest-summary-row')) {
      existingSummaryRow.remove();
    }
  }, [row]);

  /**
   * 要約行が表示中かどうかを判定
   */
  const isSummaryRowVisible = useCallback((): boolean => {
    const next = row.nextElementSibling;
    return next?.classList.contains('tdnet-digest-summary-row') ?? false;
  }, [row]);

  /**
   * 要約行を挿入
   * @param summaryText 要約テキスト
   * @param errorText エラーテキスト
   * @param metadata メタデータ
   * @param onRetry 全文再要約ボタンのコールバック
   * @param onResummarize 再要約ボタンのコールバック
   */
  const insertSummaryRow = useCallback(
    (
      summaryText: string | null,
      errorText: string | null,
      metadata: SummaryMetadata | null,
      onRetry?: () => void,
      onResummarize?: () => void,
      onAnalyze?: () => void,
      score?: Stage<ExperimentalScore>,
      analysis?: Stage<AdditionalAnalysis>
    ) => {
      // 要約行を作成
      const summaryRow = iframeDoc.createElement('tr');
      summaryRow.className = 'tdnet-digest-summary-row';

      const summaryCell = iframeDoc.createElement('td');
      summaryCell.setAttribute('colspan', '8');
      summaryCell.style.padding = '12px';
      summaryCell.style.backgroundColor = '#f9fafb';
      summaryCell.style.borderTop = '2px solid #e5e7eb';
      summaryCell.style.borderBottom = '2px solid #e5e7eb';

      // HTML生成
      if (errorText) {
        summaryCell.innerHTML = buildErrorHtml(errorText);
      } else if (summaryText) {
        summaryCell.innerHTML = buildSummaryHtml(summaryText, metadata, rowData, score, analysis);

        // 全文再要約ボタンのイベントリスナー（存在する場合のみ）
        if (metadata?.extractionMode === 'smart' && onRetry) {
          const fullRetryBtn = summaryCell.querySelector('#full-retry-btn');
          fullRetryBtn?.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            summaryRow.remove();
            onRetry();
          });
        }

        // 再要約ボタンのイベントリスナー
        if (onResummarize) {
          const resummarizeBtn = summaryCell.querySelector('#resummarize-btn');
          resummarizeBtn?.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            summaryRow.remove();
            onResummarize();
          });
        }
        summaryCell.querySelector('#analyze-btn')?.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          onAnalyze?.();
        });
      }

      summaryRow.appendChild(summaryCell);

      // DOM挿入
      if (row.nextSibling) {
        row.parentNode?.insertBefore(summaryRow, row.nextSibling);
      } else {
        row.parentNode?.appendChild(summaryRow);
      }
    },
    [row, iframeDoc, rowData]
  );

  const updateStages = useCallback(
    (score?: Stage<ExperimentalScore>, analysis?: Stage<AdditionalAnalysis>) => {
      const summaryRow = row.nextElementSibling;
      if (!summaryRow?.classList.contains('tdnet-digest-summary-row')) return;
      const scoreCell = summaryRow.querySelector('#score-result');
      const analysisCell = summaryRow.querySelector('#analysis-result');
      if (scoreCell) scoreCell.innerHTML = buildScoreStageHtml(score);
      if (analysisCell) analysisCell.innerHTML = buildAnalysisStageHtml(analysis);
    },
    [row]
  );

  return { removeSummaryRow, insertSummaryRow, updateStages, isSummaryRowVisible };
}
