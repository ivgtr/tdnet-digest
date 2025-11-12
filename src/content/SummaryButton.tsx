import React, { useState } from 'react';

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
  const [loading, setLoading] = useState(false);

  const handleSummarize = async () => {
    setLoading(true);

    // 既存の要約行を削除
    const existingSummaryRow = row.nextElementSibling;
    if (existingSummaryRow?.classList.contains('tdnet-digest-summary-row')) {
      existingSummaryRow.remove();
    }

    try {
      // Background scriptにメッセージを送信
      const response = await chrome.runtime.sendMessage({
        action: 'summarize',
        pdfUrl: rowData.pdfUrl,
        rowData,
      });

      if (response.error) {
        console.error('[Content] 要約エラー:', response.error);
        insertSummaryRow(null, response.error);
      } else {
        insertSummaryRow(response.summary, null);
      }
    } catch (err) {
      console.error('[Content] 例外が発生:', err);
      const errorMessage = err instanceof Error ? err.message : '要約に失敗しました';
      insertSummaryRow(null, errorMessage);
    } finally {
      setLoading(false);
    }
  };

  const insertSummaryRow = (summaryText: string | null, errorText: string | null) => {
    // 要約結果を表示する行を作成
    const summaryRow = iframeDoc.createElement('tr');
    summaryRow.className = 'tdnet-digest-summary-row';

    const summaryCell = iframeDoc.createElement('td');
    summaryCell.setAttribute('colspan', '8'); // 全列をカバー
    summaryCell.style.padding = '12px';
    summaryCell.style.backgroundColor = '#f9fafb';
    summaryCell.style.borderTop = '2px solid #e5e7eb';
    summaryCell.style.borderBottom = '2px solid #e5e7eb';

    if (errorText) {
      summaryCell.innerHTML = `
        <div style="padding: 12px; background-color: #fef2f2; border: 1px solid #fecaca; border-radius: 6px;">
          <p style="margin: 0; font-size: 13px; color: #991b1b;">${errorText}</p>
        </div>
      `;
    } else if (summaryText) {
      summaryCell.innerHTML = `
        <div style="padding: 12px; background-color: #ffffff; border: 1px solid #e5e7eb; border-radius: 6px;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
            <h4 style="margin: 0; font-size: 14px; font-weight: bold; color: #1f2937;">
              AI要約: ${rowData.companyName} - ${rowData.title}
            </h4>
            <button id="close-summary-btn" style="padding: 4px 8px; font-size: 12px; background-color: #f3f4f6; border: 1px solid #d1d5db; border-radius: 4px; cursor: pointer; color: #4b5563;">
              閉じる
            </button>
          </div>
          <div style="font-size: 13px; color: #374151; line-height: 1.6; white-space: pre-wrap;">${summaryText}</div>
        </div>
      `;

      // 閉じるボタンのイベントリスナーを追加
      const closeBtn = summaryCell.querySelector('#close-summary-btn');
      closeBtn?.addEventListener('click', () => {
        summaryRow.remove();
      });
    }

    summaryRow.appendChild(summaryCell);

    // 現在の行の次に挿入
    if (row.nextSibling) {
      row.parentNode?.insertBefore(summaryRow, row.nextSibling);
    } else {
      row.parentNode?.appendChild(summaryRow);
    }
  };

  return (
    <div
      style={{
        border: loading ? '1px solid #9ca3af' : '1px solid #4a84b9',
        borderRadius: '3px',
        height: '25px',
        width: '60px',
        margin: '0 auto',
        overflow: 'hidden',
        padding: '0',
        fontSize: '13px',
        fontWeight: 'bold',
      }}
    >
      <button
        onClick={handleSummarize}
        disabled={loading}
        style={{
          width: '100%',
          height: '100%',
          padding: '3px 0 0 0',
          border: 'none',
          cursor: loading ? 'not-allowed' : 'pointer',
          background: loading
            ? 'linear-gradient(to bottom, #d1d5db, #9ca3af)'
            : 'linear-gradient(to bottom, #75a8d0, #4a84b9)',
          fontWeight: 'bold',
          color: '#ffffff',
          textDecoration: 'none',
          outline: 'none',
          display: 'block',
        }}
        onMouseEnter={(e) => {
          if (!loading) {
            e.currentTarget.style.background = 'linear-gradient(to bottom, #577b98, #2c506f)';
          }
        }}
        onMouseLeave={(e) => {
          if (!loading) {
            e.currentTarget.style.background = 'linear-gradient(to bottom, #75a8d0, #4a84b9)';
          }
        }}
      >
        {loading ? '...' : '要約'}
      </button>
    </div>
  );
};

export default SummaryButton;
