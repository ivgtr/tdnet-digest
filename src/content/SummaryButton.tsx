import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useSummarize } from './hooks/useSummarize';
import { useSummaryRow } from './hooks/useSummaryRow';
import { SUMMARY_TRACE_KEY, matchingSummaryTrace } from '@/lib/summary-trace';
import { BUTTON_STYLES } from './constants/styles';

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
      removeSummaryRow();
      triggerUpdate();
    }
    priorCacheKey.current = cacheKey;
  }, [cacheKey, removeSummaryRow, triggerUpdate]);

  const isVisible = isSummaryRowVisible();

  // 要約結果が更新されたら行を挿入
  useEffect(() => {
    if (result) {
      removeSummaryRow();
      insertSummaryRow(
        result.summary,
        result.error,
        result.metadata,
        () => {
          reset();
          summarize('full');
        },
        () => {
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
      triggerUpdate();
    }
  }, [result, removeSummaryRow, insertSummaryRow, reset, summarize, triggerUpdate]);

  useEffect(() => {
    updateStages(scoringEnabled ? score : undefined, analysis, result?.facts?.facts);
    if (result?.summary && scoringEnabled) startScore();
  }, [score, analysis, scoringEnabled, result, updateStages, startScore]);

  const [diagnosticError, setDiagnosticError] = useState<string | null>(null);
  const [diagnosticText, setDiagnosticText] = useState<string | null>(null);
  const [diagnosticCopied, setDiagnosticCopied] = useState(false);
  const diagnosticRequest = useRef(0);
  useEffect(() => {
    diagnosticRequest.current++;
    setDiagnosticError(null);
    setDiagnosticText(null);
    setDiagnosticCopied(false);
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
      reset();
      triggerUpdate();
      return;
    }

    if (hasCached) {
      showCached();
      return;
    }

    summarize();
  };

  // ボタンテキスト
  const buttonText = loading ? '...' : hasCached ? (isVisible ? '非表示' : '表示') : '要約';

  // スタイル: キャッシュ済みかどうかで分岐
  const containerStyle =
    hasCached && !loading
      ? BUTTON_STYLES.containerCached(isVisible)
      : BUTTON_STYLES.container(loading);
  const buttonStyle =
    hasCached && !loading ? BUTTON_STYLES.buttonCached(isVisible) : BUTTON_STYLES.button(loading);

  const hoverBackground =
    hasCached && !loading
      ? isVisible
        ? BUTTON_STYLES.buttonCachedHover
        : BUTTON_STYLES.buttonCachedShowHover
      : BUTTON_STYLES.buttonHover;
  const normalBackground =
    hasCached && !loading
      ? isVisible
        ? BUTTON_STYLES.buttonCached(true).background
        : BUTTON_STYLES.buttonCached(false).background
      : BUTTON_STYLES.buttonNormal;

  return (
    <div>
      <div style={containerStyle}>
        <button
          type="button"
          onClick={handleClick}
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
      {result && (
        <button type="button" onClick={() => void copyDiagnostic()} style={{ fontSize: 10 }}>
          診断をコピー
        </button>
      )}
      {diagnosticCopied && (
        <span role="status" style={{ fontSize: 10 }}>
          コピーしました
        </span>
      )}
      {diagnosticText !== null && (
        <details open={diagnosticError !== null} style={{ fontSize: 10 }}>
          <summary>診断JSONを表示</summary>
          <textarea
            aria-label="診断JSON"
            readOnly
            value={diagnosticText}
            rows={6}
            onFocus={(e) => e.currentTarget.select()}
            style={{ width: 320, maxWidth: '80vw', fontSize: 10 }}
          />
        </details>
      )}
      {diagnosticError && (
        <span role="alert" style={{ fontSize: 10 }}>
          {diagnosticError}
        </span>
      )}
    </div>
  );
};

export default SummaryButton;
