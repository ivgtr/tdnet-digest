import type { RowData } from './utils/rowDataExtractor';
import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useSummarize } from './hooks/useSummarize';
import { useSummaryRow } from './hooks/useSummaryRow';
import { loadSummaryTrace } from '@/lib/summary-trace';
import { requestAnalysisTrace } from '@/lib/analysis-trace';
import { ACTION_BUTTON_STYLE, BUTTON_STYLES, FOCUS_STYLE } from './constants/styles';

interface SummaryButtonProps {
  rowData: RowData;
  row: HTMLTableRowElement;
  iframeDoc: Document;
}

const SummaryButton: React.FC<SummaryButtonProps> = ({ rowData, row, iframeDoc }) => {
  const {
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
  } = useSummarize({
    pdfUrl: rowData.pdfUrl,
    nativeCompanion: rowData.nativeCompanion,
    title: rowData.title,
    code: rowData.code,
    companyName: rowData.companyName,
  });

  const summaryRowData = useMemo(
    () => ({
      companyName: rowData.companyName,
      title: rowData.title,
      pdfUrl: rowData.pdfUrl,
    }),
    [rowData.companyName, rowData.title, rowData.pdfUrl]
  );

  const { removeSummaryRow, insertSummaryRow, updateStages, isSummaryRowVisible } = useSummaryRow({
    row,
    iframeDoc,
    rowData: summaryRowData,
  });

  const [diagnosticHost, setDiagnosticHost] = useState<HTMLElement | null>(null);
  const listButton = useRef<HTMLButtonElement>(null);
  const summaryPending = useRef<Promise<void> | null>(null);

  // 行挿入・削除後にisVisibleを再評価するための再レンダリングトリガー
  const [, setForceUpdate] = useState(0);
  const triggerUpdate = useCallback(() => setForceUpdate((v) => v + 1), []);
  const priorCacheKey = useRef<string | null>(null);
  const analyzeRef = useRef(analyze);
  analyzeRef.current = analyze;
  const retryScoreRef = useRef(retryScore);
  retryScoreRef.current = retryScore;

  useEffect(() => {
    if (priorCacheKey.current && priorCacheKey.current !== cacheKey) {
      summaryPending.current = null;
      removeSummaryRow();
      setDiagnosticHost(null);
      triggerUpdate();
    }
    priorCacheKey.current = cacheKey;
  }, [cacheKey, removeSummaryRow, triggerUpdate]);

  const isVisible = isSummaryRowVisible();

  // 要約結果が更新されたら行を挿入
  useEffect(() => {
    if (result) {
      removeSummaryRow();
      const host = insertSummaryRow(
        result.summary,
        result.error,
        result.metadata,
        () => {
          setDiagnosticHost(null);
          listButton.current?.focus();
          reset();
          summarize('full');
        },
        () => {
          setDiagnosticHost(null);
          listButton.current?.focus();
          reset();
          summarize();
        },
        () => analyzeRef.current(),
        () => retryScoreRef.current(),
        undefined,
        undefined,
        result.retryExtractionMode === 'full',
        result.facts?.facts
      );
      setDiagnosticHost(host);
      triggerUpdate();
    } else {
      setDiagnosticHost(null);
    }
    return removeSummaryRow;
  }, [result, removeSummaryRow, insertSummaryRow, reset, summarize, triggerUpdate]);

  useEffect(() => {
    updateStages(
      scoringEnabled ? score : undefined,
      analysis,
      result?.facts?.facts,
      persistenceWarning
    );
    if (result?.summary && scoringEnabled) startScore();
  }, [score, analysis, scoringEnabled, result, persistenceWarning, updateStages, startScore]);

  const [diagnosticError, setDiagnosticError] = useState<string | null>(null);
  const [diagnosticText, setDiagnosticText] = useState<string | null>(null);
  const [diagnosticCopied, setDiagnosticCopied] = useState(false);
  const [diagnosticKind, setDiagnosticKind] = useState<'summary' | 'analysis' | 'lastAnalysis'>(
    'summary'
  );
  const diagnosticRequest = useRef(0);
  useEffect(() => {
    diagnosticRequest.current++;
    setDiagnosticError(null);
    setDiagnosticText(null);
    setDiagnosticCopied(false);
    const pendingRequest = diagnosticRequest;
    return () => {
      pendingRequest.current++;
    };
  }, [result, analysis.diagnosticRunId, analysis.lastAttempt?.runId]);
  const lastAnalysisRunId =
    analysis.lastAttempt?.runId ?? (!analysis.data ? analysis.diagnosticRunId : undefined);
  const copyDiagnostic = async (kind: 'summary' | 'analysis' | 'lastAnalysis' = 'summary') => {
    setDiagnosticKind(kind);
    const request = ++diagnosticRequest.current;
    setDiagnosticError(null);
    setDiagnosticText(null);
    setDiagnosticCopied(false);
    try {
      const trace =
        kind !== 'summary'
          ? await requestAnalysisTrace(
              rowData.pdfUrl,
              kind === 'analysis' ? analysis.diagnosticRunId! : lastAnalysisRunId!,
              result!.resultId!,
              kind === 'lastAnalysis' && analysis.lastAttempt
                ? analysis.lastAttempt.persistence
                : analysis.diagnosticPersistence,
              kind === 'analysis'
                ? analysis.data?.inputHash
                : (analysis.lastAttempt?.inputHash ?? analysis.diagnosticInputHash)
            )
          : await loadSummaryTrace(
              rowData.pdfUrl,
              result?.diagnosticRunId ?? null,
              result?.resultId ?? null,
              result?.diagnosticPersistence
            );
      if (request !== diagnosticRequest.current) return;
      const text = JSON.stringify(trace, null, 2);
      setDiagnosticText(text);
      try {
        await navigator.clipboard.writeText(text);
        if (request !== diagnosticRequest.current) return;
        setDiagnosticCopied(true);
      } catch {
        if (request !== diagnosticRequest.current) return;
        setDiagnosticError('コピーできませんでした。診断JSONの欄を選択してコピーしてください。');
      }
    } catch (e) {
      if (request !== diagnosticRequest.current) return;
      const message = e instanceof Error ? e.message : String(e);
      setDiagnosticError(
        /extension context invalidated/i.test(message)
          ? '拡張機能との接続が切れています。TDnetのページを再読み込みしてから、診断JSONのコピーをやり直してください。'
          : message
      );
    }
  };
  const handleClick = () => {
    if (loading) return;

    if (isVisible) {
      removeSummaryRow();
      setDiagnosticHost(null);
      reset();
      triggerUpdate();
      return;
    }

    // 同一描画内の連打でも要約要求は一度だけ送る。
    if (summaryPending.current) return;
    const requestedGeneration = !hasCached;
    const request = (async () => {
      // Always read first: availability can be unknown after a storage error.
      // A click on 表示 must never silently turn into a paid generation.
      if (!(await showCached()) && requestedGeneration) await summarize();
    })();
    summaryPending.current = request;
    const clearPending = () => {
      if (summaryPending.current === request) summaryPending.current = null;
    };
    void request.then(clearPending, clearPending);
  };

  // ボタンテキスト
  const buttonText = loading ? '要約中' : isVisible ? '閉じる' : hasCached ? '表示' : '要約';

  // スタイル: キャッシュ済みかどうかで分岐
  const containerStyle =
    (hasCached || isVisible) && !loading
      ? BUTTON_STYLES.containerCached(isVisible)
      : BUTTON_STYLES.container(loading);
  const buttonStyle =
    (hasCached || isVisible) && !loading
      ? BUTTON_STYLES.buttonCached(isVisible)
      : BUTTON_STYLES.button(loading);

  const hoverBackground =
    (hasCached || isVisible) && !loading
      ? isVisible
        ? BUTTON_STYLES.buttonCachedHover
        : BUTTON_STYLES.buttonCachedShowHover
      : BUTTON_STYLES.buttonHover;
  const normalBackground =
    (hasCached || isVisible) && !loading
      ? isVisible
        ? BUTTON_STYLES.buttonCached(true).background
        : BUTTON_STYLES.buttonCached(false).background
      : BUTTON_STYLES.buttonNormal;

  return (
    <div>
      <div style={containerStyle}>
        <button
          ref={listButton}
          type="button"
          onClick={handleClick}
          onFocus={(e) => Object.assign(e.currentTarget.style, FOCUS_STYLE)}
          onBlur={(e) => {
            e.currentTarget.style.removeProperty('outline');
            e.currentTarget.style.removeProperty('outline-offset');
          }}
          disabled={loading}
          style={buttonStyle}
          onMouseEnter={(e) => {
            if (!loading) {
              e.currentTarget.style.background = hoverBackground;
            }
          }}
          onMouseLeave={(e) => {
            if (!loading) {
              e.currentTarget.style.background = normalBackground;
            }
          }}
        >
          {buttonText}
        </button>
      </div>
      {result &&
        diagnosticHost &&
        createPortal(
          <div style={{ marginTop: 12, fontSize: 12, lineHeight: 1.6 }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
              <button
                type="button"
                onClick={() => void copyDiagnostic()}
                style={ACTION_BUTTON_STYLE}
              >
                要約の診断JSONをコピー
              </button>
              {analysis.data && analysis.diagnosticRunId && result.resultId && (
                <button
                  type="button"
                  onClick={() => void copyDiagnostic('analysis')}
                  style={ACTION_BUTTON_STYLE}
                >
                  表示中の追加分析の診断JSONをコピー
                </button>
              )}
              {lastAnalysisRunId &&
                result.resultId &&
                (!analysis.data || lastAnalysisRunId !== analysis.diagnosticRunId) && (
                  <button
                    type="button"
                    onClick={() => void copyDiagnostic('lastAnalysis')}
                    style={ACTION_BUTTON_STYLE}
                  >
                    直近の追加分析の診断JSONをコピー
                  </button>
                )}
              <span role="status" aria-live="polite" style={{ color: '#6b7280' }}>
                {diagnosticCopied ? 'コピーしました' : ''}
              </span>
            </div>
            {analysis.lastAttempt &&
              analysis.data &&
              analysis.lastAttempt.runId !== analysis.diagnosticRunId && (
                <p role="status" style={{ color: '#92400e', margin: '8px 0' }}>
                  {analysis.lastAttempt.outcome === 'failure'
                    ? `直近の追加分析は失敗しました: ${analysis.lastAttempt.error?.message ?? '生成失敗'}。以前の保存済み分析を表示しています。`
                    : analysis.lastAttempt.outcome === 'running'
                      ? '直近の追加分析の完了記録を確認できません。以前の保存済み分析を表示しています。'
                      : '直近の追加分析と、表示中の保存済み分析は別の実行です。'}
                </p>
              )}
            {diagnosticText !== null && (
              <details open={diagnosticError !== null} style={{ marginTop: 8 }}>
                <summary style={{ cursor: 'pointer', padding: '4px 0' }}>
                  {diagnosticKind === 'analysis'
                    ? '表示中の追加分析の診断JSONを表示'
                    : diagnosticKind === 'lastAnalysis'
                      ? '直近の追加分析の診断JSONを表示'
                      : '要約の診断JSONを表示'}
                </summary>
                <textarea
                  aria-label={
                    diagnosticKind === 'analysis'
                      ? '表示中の追加分析の診断JSON'
                      : diagnosticKind === 'lastAnalysis'
                        ? '直近の追加分析の診断JSON'
                        : '要約の診断JSON'
                  }
                  readOnly
                  value={diagnosticText}
                  rows={6}
                  onFocus={(e) => e.currentTarget.select()}
                  style={{
                    display: 'block',
                    width: '100%',
                    maxWidth: '100%',
                    minWidth: 0,
                    boxSizing: 'border-box',
                    resize: 'vertical',
                    marginTop: 8,
                    padding: 8,
                    fontFamily: 'monospace',
                    fontSize: 12,
                    lineHeight: 1.5,
                    border: '1px solid #cbd5e1',
                    borderRadius: 4,
                    background: '#ffffff',
                    color: '#374151',
                  }}
                />
              </details>
            )}
            {diagnosticError && (
              <p
                role="alert"
                style={{ margin: '8px 0 0', color: '#991b1b', overflowWrap: 'anywhere' }}
              >
                {diagnosticError}
              </p>
            )}
          </div>,
          diagnosticHost
        )}
    </div>
  );
};

export default SummaryButton;
