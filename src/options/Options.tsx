import React, { useEffect, useState } from 'react';

const Options: React.FC = () => {
  const [apiUrl, setApiUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('gpt-4o');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    chrome.storage.sync.get(['apiUrl', 'apiKey', 'model'], (result) => {
      if (result.apiUrl) setApiUrl(result.apiUrl);
      if (result.apiKey) setApiKey(result.apiKey);
      if (result.model) setModel(result.model);
    });
  }, []);

  const handleSave = () => {
    chrome.storage.sync.set(
      {
        apiUrl,
        apiKey,
        model,
      },
      () => {
        setSaved(true);
        setTimeout(() => setSaved(false), 3000);
      }
    );
  };

  return (
    <div className="min-h-screen bg-gray-50 py-8">
      <div className="max-w-2xl mx-auto bg-white rounded-lg shadow p-6">
        <h1 className="text-2xl font-bold mb-6 text-gray-800">TDnet Digest 設定</h1>

        <div className="space-y-6">
          <div>
            <label htmlFor="apiUrl" className="block text-sm font-medium text-gray-700 mb-2">
              API URL
            </label>
            <input
              id="apiUrl"
              type="url"
              value={apiUrl}
              onChange={(e) => setApiUrl(e.target.value)}
              placeholder="https://api.openai.com/v1/chat/completions"
              className="w-full px-3 py-2 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <p className="mt-1 text-xs text-gray-500">
              OpenAI互換のチャットAPI エンドポイントを指定してください
            </p>
          </div>

          <div>
            <label htmlFor="apiKey" className="block text-sm font-medium text-gray-700 mb-2">
              API Key
            </label>
            <input
              id="apiKey"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="sk-..."
              className="w-full px-3 py-2 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <p className="mt-1 text-xs text-gray-500">APIキーは安全に保存されます</p>
          </div>

          <div>
            <label htmlFor="model" className="block text-sm font-medium text-gray-700 mb-2">
              モデル
            </label>
            <input
              id="model"
              type="text"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="gpt-4o"
              className="w-full px-3 py-2 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <p className="mt-1 text-xs text-gray-500">
              使用するモデル名を指定してください (例: gpt-4o, claude-3-opus-20240229)
            </p>
          </div>

          <div className="flex items-center gap-4">
            <button
              onClick={handleSave}
              className="px-6 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 transition-colors"
            >
              保存
            </button>
            {saved && <span className="text-sm text-green-600 font-medium">✓ 保存しました</span>}
          </div>
        </div>

        <div className="mt-8 p-4 bg-blue-50 rounded">
          <h2 className="text-sm font-semibold text-blue-900 mb-2">使い方</h2>
          <ol className="text-sm text-blue-800 space-y-1 list-decimal list-inside">
            <li>上記のフォームにAPI設定を入力して保存</li>
            <li>
              TDnetの開示ページ (https://disclosure2.tdnet.info/...) を開く
            </li>
            <li>ページ上に表示される「要約」ボタンをクリック</li>
            <li>PDFの内容がLLMで要約されて表示されます</li>
          </ol>
        </div>
      </div>
    </div>
  );
};

export default Options;
