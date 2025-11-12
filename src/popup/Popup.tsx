import React, { useEffect, useState } from 'react';

interface Settings {
  apiUrl: string;
  apiKey: string;
  model: string;
}

const Popup: React.FC = () => {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [status, setStatus] = useState<string>('Loading...');
  const [enabled, setEnabled] = useState<boolean>(true);

  useEffect(() => {
    chrome.storage.sync.get(['apiUrl', 'apiKey', 'model', 'extensionEnabled'], (result) => {
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

      // デフォルトはtrue
      setEnabled(result.extensionEnabled !== false);
    });
  }, []);

  const openOptions = () => {
    chrome.runtime.openOptionsPage();
  };

  const toggleEnabled = () => {
    const newEnabled = !enabled;
    setEnabled(newEnabled);
    chrome.storage.sync.set({ extensionEnabled: newEnabled }, () => {
      // Content scriptにメッセージを送信してボタンの表示/非表示を切り替え
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]?.id) {
          chrome.tabs.sendMessage(tabs[0].id, {
            action: 'toggleExtension',
            enabled: newEnabled,
          });
        }
      });
    });
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

      {/* オンオフトグルスイッチ */}
      <div className="mb-4 p-3 bg-gray-50 rounded">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-gray-800">要約ボタンを表示</p>
            <p className="text-xs text-gray-600 mt-1">
              開示情報一覧に要約ボタンを{enabled ? '表示' : '非表示'}
            </p>
          </div>
          <button
            onClick={toggleEnabled}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
              enabled ? 'bg-blue-600' : 'bg-gray-300'
            }`}
            aria-label="要約ボタン表示切替"
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                enabled ? 'translate-x-6' : 'translate-x-1'
              }`}
            />
          </button>
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
