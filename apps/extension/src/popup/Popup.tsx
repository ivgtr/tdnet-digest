import React, { useEffect, useState } from 'react';

interface Settings {
  apiUrl: string;
  apiKey: string;
  model: string;
}

const Popup: React.FC = () => {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [status, setStatus] = useState<string>('Loading...');

  useEffect(() => {
    chrome.storage.sync.get(['apiUrl', 'apiKey', 'model'], (result) => {
      if (result.apiUrl && result.apiKey) {
        setSettings({
          apiUrl: result.apiUrl,
          apiKey: result.apiKey,
          model: result.model || 'gpt-4o',
        });
        setStatus('設定済み');
      } else {
        setStatus('未設定');
      }
    });
  }, []);

  const openOptions = () => {
    chrome.runtime.openOptionsPage();
  };

  return (
    <div className="w-80 p-4 bg-white">
      <h1 className="text-xl font-bold mb-4 text-gray-800">TDnet Digest</h1>

      <div className="mb-4">
        <p className="text-sm text-gray-600 mb-2">
          TDnetの開示ページで「要約」ボタンを使用できます
        </p>
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">状態:</span>
          <span
            className={`text-sm font-semibold ${
              status === '設定済み' ? 'text-green-600' : 'text-orange-600'
            }`}
          >
            {status}
          </span>
        </div>
      </div>

      {settings && (
        <div className="mb-4 p-3 bg-gray-50 rounded">
          <p className="text-xs text-gray-600 mb-1">API URL</p>
          <p className="text-sm font-mono text-gray-800 truncate">{settings.apiUrl}</p>
          <p className="text-xs text-gray-600 mb-1 mt-2">モデル</p>
          <p className="text-sm font-mono text-gray-800">{settings.model}</p>
        </div>
      )}

      <button
        onClick={openOptions}
        className="w-full py-2 px-4 bg-blue-600 text-white rounded hover:bg-blue-700 transition-colors"
      >
        設定を開く
      </button>
    </div>
  );
};

export default Popup;
