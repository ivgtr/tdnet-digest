import React, { useEffect, useState } from 'react';
import type { ExtractionMode, CachedSummary, SummaryCacheStore } from '@/types/summaryMetadata';
import { LLM_PROVIDERS, getProvider } from '@/lib/llm-providers';

const CACHE_KEY = 'summaryCache';

const Options: React.FC = () => {
  const [provider, setProvider] = useState('openai');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('gpt-4o');
  const [customUrl, setCustomUrl] = useState('');
  const [useCustomModel, setUseCustomModel] = useState(false);
  const [extractionMode, setExtractionMode] = useState<ExtractionMode>('full');
  const [saved, setSaved] = useState(false);
  const [autoSwitchedToCustom, setAutoSwitchedToCustom] = useState(false);
  const [hasAutoSwitched, setHasAutoSwitched] = useState(false);
  const [cacheEntries, setCacheEntries] = useState<[string, CachedSummary][]>([]);

  const loadCacheEntries = () => {
    chrome.storage.local.get(CACHE_KEY, (data) => {
      const store: SummaryCacheStore = data[CACHE_KEY] || {};
      const entries = Object.entries(store).sort(([, a], [, b]) => b.cachedAt - a.cachedAt);
      setCacheEntries(entries);
    });
  };

  const deleteCacheEntry = (key: string) => {
    chrome.storage.local.get(CACHE_KEY, (data) => {
      const store: SummaryCacheStore = data[CACHE_KEY] || {};
      delete store[key];
      chrome.storage.local.set({ [CACHE_KEY]: store }, loadCacheEntries);
    });
  };

  const clearAllCache = () => {
    chrome.storage.local.set({ [CACHE_KEY]: {} }, loadCacheEntries);
  };

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
    loadCacheEntries();
  }, []);

  // 保存済みモデルがリストにない場合、自動的にカスタムモデルに切り替え（初回のみ）
  useEffect(() => {
    // 既に自動切り替えを行った場合はスキップ
    if (hasAutoSwitched) return;

    const providerInfo = getProvider(provider);
    if (!providerInfo || providerInfo.requiresCustomUrl) return;

    const modelExists = providerInfo.models.some((m) => m.id === model);

    // リストにないモデル & カスタムモードでない場合
    if (!modelExists && model && !useCustomModel) {
      console.log(
        `[TDnet Digest] モデル "${model}" はリストにないため、カスタムモデルモードに自動切り替えしました`
      );
      setUseCustomModel(true);
      setAutoSwitchedToCustom(true);
      setHasAutoSwitched(true);
    }
  }, [provider, model, useCustomModel, hasAutoSwitched]);

  // モデルが変更されたら通知を消す
  useEffect(() => {
    if (autoSwitchedToCustom) {
      // モデル変更を検知するための遅延
      const timer = setTimeout(() => {
        const providerInfo = getProvider(provider);
        if (!providerInfo || providerInfo.requiresCustomUrl) return;

        const modelExists = providerInfo.models.some((m) => m.id === model);
        // モデルがリストに存在する場合、または空の場合は通知を消す
        if (modelExists || !model) {
          setAutoSwitchedToCustom(false);
        }
      }, 100);

      return () => clearTimeout(timer);
    }
  }, [model, provider, autoSwitchedToCustom]);

  // プロバイダー変更時の処理
  const handleProviderChange = (newProvider: string) => {
    setProvider(newProvider);
    const providerInfo = getProvider(newProvider);
    if (providerInfo && !providerInfo.requiresCustomUrl) {
      setModel(providerInfo.defaultModel);
      setUseCustomModel(false); // プリセットプロバイダーに変更時はカスタムモデルをOFFに
    }
    setHasAutoSwitched(false); // プロバイダー変更時にフラグをリセット
    setAutoSwitchedToCustom(false); // 通知もリセット
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
            {autoSwitchedToCustom && useCustomModel && (
              <div className="mt-2 p-2 bg-yellow-50 border border-yellow-200 rounded text-xs text-yellow-800">
                ℹ️ 保存済みのモデル「{model}
                」がリストにないため、カスタムモデルモードに自動切り替えしました。
                <br />
                新しいモデルに変更するか、このままご利用ください。
              </div>
            )}
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
              <option value="full">全文抽出（推奨）</option>
              <option value="smart">要点抽出</option>
            </select>
            <div className="mt-2 p-3 bg-gray-50 rounded text-xs text-gray-700">
              {extractionMode === 'smart' ? (
                <div>
                  <strong>スマート抽出:</strong>
                  <ul className="mt-1 ml-4 list-disc space-y-1">
                    <li>重要なセクションやページのみを抽出</li>
                    <li>トークン使用量が少ない（全文抽出の約1/4）</li>
                  </ul>
                </div>
              ) : (
                <div>
                  <strong>全文抽出（推奨）:</strong>
                  <ul className="mt-1 ml-4 list-disc space-y-1">
                    <li>PDF全体を抽出して要約（より正確な結果）</li>
                    <li>Gemini 2.5 Flash Lite なら1回あたり約¥1以下（100回で約¥90）</li>
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

        {/* キャッシュ管理セクション */}
        <div className="mt-8 p-4 bg-gray-50 rounded-lg border border-gray-200">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-gray-800">
              要約キャッシュ管理
              <span className="ml-2 text-xs font-normal text-gray-500">
                {cacheEntries.length}件
              </span>
            </h2>
            {cacheEntries.length > 0 && (
              <button
                onClick={clearAllCache}
                className="px-3 py-1 text-xs bg-red-50 text-red-700 border border-red-300 rounded hover:bg-red-100 transition-colors"
              >
                すべて削除
              </button>
            )}
          </div>
          {cacheEntries.length === 0 ? (
            <p className="text-sm text-gray-500">キャッシュはありません</p>
          ) : (
            <div className="max-h-64 overflow-y-auto space-y-2">
              {cacheEntries.map(([key, entry]) => (
                <div
                  key={key}
                  className="flex items-start justify-between p-3 bg-white rounded border border-gray-200"
                >
                  <div className="min-w-0 flex-1 mr-3">
                    <div className="text-sm font-medium text-gray-800 truncate">
                      {entry.code} {entry.companyName}
                    </div>
                    <div className="text-xs text-gray-600 truncate">{entry.title}</div>
                    <div className="text-xs text-gray-400 mt-1">
                      {new Date(entry.cachedAt).toLocaleString('ja-JP', {
                        month: 'numeric',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </div>
                  </div>
                  <button
                    onClick={() => deleteCacheEntry(key)}
                    className="px-2 py-1 text-xs bg-gray-100 text-gray-600 border border-gray-300 rounded hover:bg-gray-200 transition-colors flex-shrink-0"
                  >
                    削除
                  </button>
                </div>
              ))}
            </div>
          )}
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
