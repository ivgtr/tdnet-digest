import React, { useState } from 'react';

const SummaryButton: React.FC = () => {
  const [loading, setLoading] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleSummarize = async () => {
    setLoading(true);
    setError(null);
    setSummary(null);

    try {
      // PDFのURLを取得 (TDnetページから)
      const pdfUrl = window.location.href;

      // Background scriptにメッセージを送信
      const response = await chrome.runtime.sendMessage({
        action: 'summarize',
        pdfUrl,
      });

      if (response.error) {
        setError(response.error);
      } else {
        setSummary(response.summary);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '要約に失敗しました');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="bg-white rounded-lg shadow-lg p-4 max-w-md">
      <button
        onClick={handleSummarize}
        disabled={loading}
        className="w-full py-2 px-4 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors"
      >
        {loading ? '要約中...' : '📄 要約'}
      </button>

      {error && (
        <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded">
          <p className="text-sm text-red-800">{error}</p>
        </div>
      )}

      {summary && (
        <div className="mt-4 p-4 bg-gray-50 rounded max-h-96 overflow-y-auto">
          <h3 className="font-bold text-gray-800 mb-2">要約</h3>
          <div className="text-sm text-gray-700 whitespace-pre-wrap">{summary}</div>
        </div>
      )}
    </div>
  );
};

export default SummaryButton;
