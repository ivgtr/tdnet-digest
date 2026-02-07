import React, { useEffect, useState, useCallback } from 'react';
import { useSummarize } from './hooks/useSummarize';
import { useSummaryRow } from './hooks/useSummaryRow';
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
  const { loading, result, hasCached, summarize, showCached, reset } = useSummarize({
    pdfUrl: rowData.pdfUrl,
    title: rowData.title,
    code: rowData.code,
    companyName: rowData.companyName,
  });

  const { removeSummaryRow, insertSummaryRow, isSummaryRowVisible } = useSummaryRow({
    row,
    iframeDoc,
    rowData: { companyName: rowData.companyName, title: rowData.title },
  });

  // 閉じるボタンからの再レンダリング用
  const [, setForceUpdate] = useState(0);
  const triggerUpdate = useCallback(() => setForceUpdate((v) => v + 1), []);

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
        triggerUpdate
      );
    }
  }, [result, removeSummaryRow, insertSummaryRow, reset, summarize, triggerUpdate]);

  const handleClick = () => {
    if (loading) return;

    if (isVisible) {
      removeSummaryRow();
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
    hasCached && !loading ? BUTTON_STYLES.containerCached(isVisible) : BUTTON_STYLES.container(loading);
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
  );
};

export default SummaryButton;
