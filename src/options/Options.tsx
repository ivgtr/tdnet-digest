import React, { useEffect, useState } from 'react';
import type { ExtractionMode } from '@/types/summaryMetadata';
import { LLM_PROVIDERS, getProvider } from '@/lib/llm-providers';

const Options: React.FC = () => {
  const [provider, setProvider] = useState('openai');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('gpt-4o');
  const [customUrl, setCustomUrl] = useState('');
  const [useCustomModel, setUseCustomModel] = useState(false);
  const [extractionMode, setExtractionMode] = useState<ExtractionMode>('smart');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    chrome.storage.sync.get(
      ['provider', 'apiKey', 'model', 'customUrl', 'useCustomModel', 'extractionMode'],
      (result) => {
        if (result.provider) setProvider(result.provider);
        if (result.apiKey) setApiKey(result.apiKey);
        if (result.model) setModel(result.model);
        if (result.customUrl) setCustomUrl(result.customUrl);
        if (result.useCustomModel !== undefined) setUseCustomModel(result.useCustomModel);
        if (result.extractionMode) setExtractionMode(result.extractionMode);
      }
    );
  }, []);

  // プロバイダー変更時の処理
  const handleProviderChange = (newProvider: string) => {
    setProvider(newProvider);
    const providerInfo = getProvider(newProvider);
    if (providerInfo && !providerInfo.requiresCustomUrl) {
      setModel(providerInfo.defaultModel);
      setUseCustomModel(false); // プリセットプロバイダーに変更時はカスタムモデルをOFFに
    }
  };

  const handleSave = () => {
    chrome.storage.sync.set(
      {
        provider,
        apiKey,
        model,
        customUrl: provider === 'custom' ? customUrl : '',
        useCustomModel,
        extractionMode,
      },
      () => {
        setSaved(true);
        setTimeout(() => setSaved(false), 3000);
      }
    );
  };

  // 現在のプロバイダー情報を取得
  const currentProvider = getProvider(provider);
  const availableModels = currentProvider?.models || [];
  const isCustomProvider = provider === 'custom';

  return (
    <div className="min-h-screen bg-gray-50 py-8">
      <div className="max-w-2xl mx-auto bg-white rounded-lg shadow p-6">
        <h1 className="text-2xl font-bold mb-6 text-gray-800">TDnet Digest 設定</h1>

        <div className="space-y-6">
          {/* プロバイダー選択 */}
          <div>
            <label htmlFor="provider" className="block text-sm font-medium text-gray-700 mb-2">
              プロバイダー
            </label>
            <select
              id="provider"
              value={provider}
              onChange={(e) => handleProviderChange(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {LLM_PROVIDERS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-gray-500">
              使用するLLMプロバイダーを選択してください
            </p>
          </div>

          {/* カスタムURL入力（カスタムプロバイダーの場合のみ表示） */}
          {isCustomProvider && (
            <div>
              <label htmlFor="customUrl" className="block text-sm font-medium text-gray-700 mb-2">
                カスタム API URL
              </label>
              <input
                id="customUrl"
                type="url"
                value={customUrl}
                onChange={(e) => setCustomUrl(e.target.value)}
                placeholder="https://api.example.com/v1/chat/completions"
                className="w-full px-3 py-2 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <p className="mt-1 text-xs text-gray-500">
                OpenAI互換のチャットAPI エンドポイントを指定してください
              </p>
            </div>
          )}

          {/* APIキー入力 */}
          <div>
            <label htmlFor="apiKey" className="block text-sm font-medium text-gray-700 mb-2">
              API Key
            </label>
            <input
              id="apiKey"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={
                provider === 'openai'
                  ? 'sk-...'
                  : provider === 'anthropic'
                    ? 'sk-ant-...'
                    : provider === 'google'
                      ? 'AIza...'
                      : 'API Key'
              }
              className="w-full px-3 py-2 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <p className="mt-1 text-xs text-gray-500">APIキーは安全に保存されます</p>
          </div>

          {/* モデル選択 */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label htmlFor="model" className="block text-sm font-medium text-gray-700">
                モデル
              </label>
              {!isCustomProvider && (
                <label className="flex items-center text-xs text-gray-600 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={useCustomModel}
                    onChange={(e) => setUseCustomModel(e.target.checked)}
                    className="mr-1"
                  />
                  カスタムモデル名を使用
                </label>
              )}
            </div>
            {isCustomProvider || useCustomModel ? (
              <input
                id="model"
                type="text"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="model-name"
                className="w-full px-3 py-2 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            ) : (
              <select
                id="model"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                {availableModels.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            )}
            <p className="mt-1 text-xs text-gray-500">
              {isCustomProvider || useCustomModel
                ? 'モデル名を入力してください'
                : 'プリセットから選択するか、カスタムモデル名を入力できます'}
            </p>
          </div>

          <div>
            <label htmlFor="extractionMode" className="block text-sm font-medium text-gray-700 mb-2">
              抽出モード
            </label>
            <select
              id="extractionMode"
              value={extractionMode}
              onChange={(e) => setExtractionMode(e.target.value as ExtractionMode)}
              className="w-full px-3 py-2 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="smart">要点抽出</option>
              <option value="full">全文抽出</option>
            </select>
            <div className="mt-2 p-3 bg-gray-50 rounded text-xs text-gray-700">
              {extractionMode === 'smart' ? (
                <div>
                  <strong>スマート抽出:</strong>
                  <ul className="mt-1 ml-4 list-disc space-y-1">
                    <li>トークン使用量: 少ない</li>
                    <li>重要なセクションやページのみを抽出</li>
                  </ul>
                </div>
              ) : (
                <div>
                  <strong>全文抽出:</strong>
                  <ul className="mt-1 ml-4 list-disc space-y-1">
                    <li>トークン使用量: 多い</li>
                    <li>PDF全体を抽出して要約</li>
                  </ul>
                </div>
              )}
            </div>
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
            <li>上記のフォームでプロバイダーとAPIキーを設定して保存</li>
            <li>TDnetの開示ページ (https://www.release.tdnet.info/...) を開く</li>
            <li>ページ上に表示される「要約」ボタンをクリック</li>
            <li>PDFの内容がLLMで要約されて表示されます</li>
          </ol>
        </div>
      </div>
    </div>
  );
};

export default Options;
