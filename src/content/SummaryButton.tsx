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
  const [summary, setSummary] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleSummarize = async () => {
    setLoading(true);
    setError(null);

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
        setError(response.error);
        insertSummaryRow(null, response.error);
      } else {
        setSummary(response.summary);
        insertSummaryRow(response.summary, null);
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : '要約に失敗しました';
      setError(errorMessage);
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
        setSummary(null);
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
    <button
      onClick={handleSummarize}
      disabled={loading}
      style={{
        padding: '4px 12px',
        fontSize: '12px',
        fontWeight: '500',
        color: loading ? '#9ca3af' : '#ffffff',
        backgroundColor: loading ? '#e5e7eb' : '#2563eb',
        border: 'none',
        borderRadius: '4px',
        cursor: loading ? 'not-allowed' : 'pointer',
        transition: 'all 0.2s',
        whiteSpace: 'nowrap',
      }}
      onMouseEnter={(e) => {
        if (!loading) {
          e.currentTarget.style.backgroundColor = '#1d4ed8';
        }
      }}
      onMouseLeave={(e) => {
        if (!loading) {
          e.currentTarget.style.backgroundColor = '#2563eb';
        }
      }}
    >
      {loading ? '要約中...' : '要約'}
    </button>
  );
};

export default SummaryButton;
