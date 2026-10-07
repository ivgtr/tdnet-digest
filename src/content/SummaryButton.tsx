import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useSummarize } from './hooks/useSummarize';
import { useSummaryRow } from './hooks/useSummaryRow';
import { SUMMARY_TRACE_KEY, matchingSummaryTrace } from '@/lib/summary-trace';
import { ACTION_BUTTON_STYLE, BUTTON_STYLES, FOCUS_STYLE } from './constants/styles';

interface RowData {
  time: string;
  code: string;
  companyName: string;
  title: string;
  pdfUrl: string;
}

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
  }, [result]);
  const copyDiagnostic = async () => {
    const request = ++diagnosticRequest.current;
    setDiagnosticError(null);
    setDiagnosticText(null);
    setDiagnosticCopied(false);
    try {
      const saved = await chrome.storage.local.get(SUMMARY_TRACE_KEY);
      if (request !== diagnosticRequest.current) return;
      const trace = matchingSummaryTrace(
        saved[SUMMARY_TRACE_KEY],
        rowData.pdfUrl,
        result?.diagnosticRunId ?? null,
        result?.resultId ?? null
      );
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
      setDiagnosticError(e instanceof Error ? e.message : String(e));
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
    const request = (async () => {
      if (!hasCached || !(await showCached())) await summarize();
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
                診断JSONをコピー
              </button>
              <span role="status" aria-live="polite" style={{ color: '#6b7280' }}>
                {diagnosticCopied ? 'コピーしました' : ''}
              </span>
            </div>
            {diagnosticText !== null && (
              <details open={diagnosticError !== null} style={{ marginTop: 8 }}>
                <summary style={{ cursor: 'pointer', padding: '4px 0' }}>診断JSONを表示</summary>
                <textarea
                  aria-label="診断JSON"
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
