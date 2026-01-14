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
    defaultModel: 'gpt-5.2',
    models: [
      { id: 'gpt-5.2', name: 'GPT-5.2' },
      { id: 'gpt-5.1', name: 'GPT-5.1' },
      { id: 'gpt-5', name: 'GPT-5' },
      { id: 'gpt-4.1', name: 'GPT-4.1' },
      { id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini' },
      { id: 'gpt-4o', name: 'GPT-4o' },
      { id: 'gpt-4o-mini', name: 'GPT-4o Mini' },
    ],
  },
  {
    id: 'anthropic',
    name: 'Anthropic (Claude)',
    baseUrl: 'https://api.anthropic.com/v1/messages',
    defaultModel: 'claude-sonnet-4-5-20250929',
    models: [
      { id: 'claude-opus-4-5-20241124', name: 'Claude Opus 4.5' },
      { id: 'claude-sonnet-4-5-20250929', name: 'Claude Sonnet 4.5' },
      { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5' },
      { id: 'claude-sonnet-4-20250522', name: 'Claude Sonnet 4' },
      { id: 'claude-sonnet-3-7-20250224', name: 'Claude 3.7 Sonnet' },
      { id: 'claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet' },
    ],
  },
  {
    id: 'google',
    name: 'Google (Gemini)',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/chat/completions',
    defaultModel: 'gemini-2.5-flash',
    models: [
      { id: 'gemini-3-flash-preview', name: 'Gemini 3 Flash Preview' },
      { id: 'gemini-3-pro-preview', name: 'Gemini 3 Pro Preview' },
      { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
      { id: 'gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash Lite' },
      { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
    ],
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1/chat/completions',
    defaultModel: 'anthropic/claude-4.5-sonnet',
    models: [
      { id: 'anthropic/claude-4.5-sonnet', name: 'Claude 4.5 Sonnet' },
      { id: 'google/gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
      { id: 'x-ai/grok-code-fast-1', name: 'Grok Code Fast' },
      { id: 'xiaomi/mimo-v2-flash:free', name: 'Mimo V2 Flash Free' },
      { id: 'mistralai/devstral-2512:free', name: 'Devstral 2512 Free' },
      { id: 'tngtech/deepseek-r1t2-chimera:free', name: 'DeepSeek R1T2 Chimera Free' },
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
