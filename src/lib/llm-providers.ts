/**
 * LLMプロバイダーの定義
 */

export interface LLMProvider {
  id: string;
  name: string;
  baseUrl: string;
  models: LLMModel[];
  defaultModel: string;
  requiresCustomUrl?: boolean;
}

export interface LLMModel {
  id: string;
  name: string;
}

/**
 * 主要なLLMプロバイダーの定義
 */
export const LLM_PROVIDERS: LLMProvider[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1/chat/completions',
    defaultModel: 'gpt-4o',
    models: [
      { id: 'gpt-4o', name: 'GPT-4o' },
      { id: 'gpt-4o-mini', name: 'GPT-4o Mini' },
      { id: 'gpt-4-turbo', name: 'GPT-4 Turbo' },
      { id: 'gpt-4', name: 'GPT-4' },
      { id: 'gpt-3.5-turbo', name: 'GPT-3.5 Turbo' },
    ],
  },
  {
    id: 'anthropic',
    name: 'Anthropic (Claude)',
    baseUrl: 'https://api.anthropic.com/v1/messages',
    defaultModel: 'claude-3-5-sonnet-20241022',
    models: [
      { id: 'claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet' },
      { id: 'claude-3-5-haiku-20241022', name: 'Claude 3.5 Haiku' },
      { id: 'claude-3-opus-20240229', name: 'Claude 3 Opus' },
      { id: 'claude-3-sonnet-20240229', name: 'Claude 3 Sonnet' },
      { id: 'claude-3-haiku-20240307', name: 'Claude 3 Haiku' },
    ],
  },
  {
    id: 'google',
    name: 'Google (Gemini)',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/chat/completions',
    defaultModel: 'gemini-2.0-flash-exp',
    models: [
      { id: 'gemini-2.0-flash-exp', name: 'Gemini 2.0 Flash (Experimental)' },
      { id: 'gemini-2.0-flash-thinking-exp-01-21', name: 'Gemini 2.0 Flash Thinking (Experimental)' },
      { id: 'gemini-exp-1206', name: 'Gemini Experimental 1206' },
      { id: 'gemini-exp-1121', name: 'Gemini Experimental 1121' },
      { id: 'gemini-1.5-pro-latest', name: 'Gemini 1.5 Pro (Latest)' },
      { id: 'gemini-1.5-pro', name: 'Gemini 1.5 Pro' },
      { id: 'gemini-1.5-flash-latest', name: 'Gemini 1.5 Flash (Latest)' },
      { id: 'gemini-1.5-flash', name: 'Gemini 1.5 Flash' },
      { id: 'gemini-1.5-flash-8b', name: 'Gemini 1.5 Flash 8B' },
    ],
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1/chat/completions',
    defaultModel: 'anthropic/claude-3.5-sonnet',
    models: [
      { id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet' },
      { id: 'openai/gpt-4o', name: 'GPT-4o' },
      { id: 'google/gemini-2.0-flash-exp', name: 'Gemini 2.0 Flash' },
      { id: 'meta-llama/llama-3.1-70b-instruct', name: 'Llama 3.1 70B' },
      { id: 'meta-llama/llama-3.1-8b-instruct', name: 'Llama 3.1 8B' },
    ],
  },
  {
    id: 'custom',
    name: 'カスタム',
    baseUrl: '',
    defaultModel: '',
    models: [],
    requiresCustomUrl: true,
  },
];

/**
 * プロバイダーIDからプロバイダー情報を取得
 */
export function getProvider(providerId: string): LLMProvider | undefined {
  return LLM_PROVIDERS.find((p) => p.id === providerId);
}

/**
 * プロバイダーIDとモデルIDからモデル情報を取得
 */
export function getModel(providerId: string, modelId: string): LLMModel | undefined {
  const provider = getProvider(providerId);
  if (!provider) return undefined;
  return provider.models.find((m) => m.id === modelId);
}
