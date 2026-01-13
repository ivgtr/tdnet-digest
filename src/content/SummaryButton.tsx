import React, { useEffect } from 'react';
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
  const { loading, result, summarize, reset } = useSummarize({
    pdfUrl: rowData.pdfUrl,
    title: rowData.title,
  });

  const { removeSummaryRow, insertSummaryRow } = useSummaryRow({
    row,
    iframeDoc,
    rowData: { companyName: rowData.companyName, title: rowData.title },
  });

  // 要約結果が更新されたら行を挿入
  useEffect(() => {
    if (result) {
      removeSummaryRow();
      insertSummaryRow(result.summary, result.error, result.metadata, () => {
        reset();
        summarize('full');
      });
    }
  }, [result, removeSummaryRow, insertSummaryRow, reset, summarize]);

  const handleClick = () => {
    removeSummaryRow();
    summarize();
  };

  return (
    <div style={BUTTON_STYLES.container(loading)}>
      <button
        onClick={handleClick}
        disabled={loading}
        style={BUTTON_STYLES.button(loading)}
        onMouseEnter={(e) => {
          if (!loading) {
            e.currentTarget.style.background = BUTTON_STYLES.buttonHover;
          }
        }}
        onMouseLeave={(e) => {
          if (!loading) {
            e.currentTarget.style.background = BUTTON_STYLES.buttonNormal;
          }
        }}
      >
        {loading ? '...' : '要約'}
      </button>
    </div>
  );
};

export default SummaryButton;
