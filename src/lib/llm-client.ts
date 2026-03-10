/**
 * 統一LLMクライアント
 * 各プロバイダーのAPIフォーマットの違いを吸収し、統一されたインターフェースを提供
 */

export interface LLMConfig {
  provider: string;
  apiKey: string;
  model: string;
  baseUrl?: string; // カスタムプロバイダー用
  temperature?: number; // 生成温度（0-2、低いほど安定した出力）
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export class ApiError extends Error {
  status: number;
  statusText: string;
  isServerError: boolean;

  constructor(message: string, status: number, statusText: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.statusText = statusText;
    this.isServerError = status >= 500;
  }
}

/**
 * LLM APIを呼び出して応答を取得
 */
export async function generateText(config: LLMConfig, messages: ChatMessage[]): Promise<string> {
  // プロバイダーに応じて適切なAPIを呼び出す
  switch (config.provider) {
    case 'anthropic':
      return generateTextAnthropic(config, messages);
    case 'openai':
    case 'google':
    case 'openrouter':
    case 'custom':
      return generateTextOpenAI(config, messages);
    default:
      throw new Error(`サポートされていないプロバイダー: ${config.provider}`);
  }
}

/**
 * OpenAI互換APIを呼び出す
 * OpenAI、Google (OpenAI互換モード)、OpenRouter、カスタムプロバイダーに対応
 */
async function generateTextOpenAI(config: LLMConfig, messages: ChatMessage[]): Promise<string> {
  // カスタムプロバイダーの場合はbaseUrlを使用、それ以外は既定のbaseUrlを使用
  const baseUrl = config.baseUrl || getDefaultBaseUrl(config.provider);

  const response = await fetch(baseUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages: messages.map((msg) => ({
        role: msg.role,
        content: msg.content,
      })),
      ...(config.temperature !== undefined && { temperature: config.temperature }),
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    const apiError = buildApiError(response.status, response.statusText, errorText);
    if (apiError.isServerError) {
      console.error('[LLM Client] API呼び出しエラー:', response.status, errorText);
    }
    throw apiError;
  }

  const data = await response.json();

  if (!data.choices?.[0]?.message?.content) {
    console.error('[LLM Client] 不正なレスポンス形式:', data);
    throw new Error('APIレスポンスの形式が不正です');
  }

  return data.choices[0].message.content;
}

/**
 * Anthropic APIを呼び出す
 * Anthropicは独自のAPIフォーマットを使用
 */
async function generateTextAnthropic(config: LLMConfig, messages: ChatMessage[]): Promise<string> {
  const baseUrl = config.baseUrl || 'https://api.anthropic.com/v1/messages';

  // systemメッセージを分離
  const systemMessage = messages.find((msg) => msg.role === 'system');
  const conversationMessages = messages.filter((msg) => msg.role !== 'system');

  const response = await fetch(baseUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': config.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: 4096,
      system: systemMessage?.content,
      messages: conversationMessages.map((msg) => ({
        role: msg.role === 'assistant' ? 'assistant' : 'user',
        content: msg.content,
      })),
      ...(config.temperature !== undefined && { temperature: config.temperature }),
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    const apiError = buildApiError(response.status, response.statusText, errorText);
    if (apiError.isServerError) {
      console.error('[LLM Client] Anthropic API呼び出しエラー:', response.status, errorText);
    }
    throw apiError;
  }

  const data = await response.json();

  if (!data.content?.[0]?.text) {
    console.error('[LLM Client] 不正なレスポンス形式:', data);
    throw new Error('APIレスポンスの形式が不正です');
  }

  return data.content[0].text;
}

/**
 * プロバイダーのデフォルトbaseURLを取得
 */
function getDefaultBaseUrl(provider: string): string {
  switch (provider) {
    case 'openai':
      return 'https://api.openai.com/v1/chat/completions';
    case 'google':
      return 'https://generativelanguage.googleapis.com/v1beta/chat/completions';
    case 'openrouter':
      return 'https://openrouter.ai/api/v1/chat/completions';
    case 'anthropic':
      return 'https://api.anthropic.com/v1/messages';
    default:
      throw new Error(`プロバイダー ${provider} のデフォルトURLが見つかりません`);
  }
}

function buildApiError(status: number, statusText: string, errorText: string): ApiError {
  const detail = extractApiErrorMessage(errorText);
  const text = detail || statusText;
  const message = `API呼び出しに失敗しました: ${status} ${text}`.trim();
  return new ApiError(message, status, statusText);
}

function extractApiErrorMessage(errorText: string): string | null {
  const trimmed = errorText.trim();
  if (!trimmed) return null;

  const parsed = safeJsonParse(trimmed);
  if (!parsed) {
    return trimmed;
  }

  const outerMessage = findErrorMessage(parsed);
  const rawDetail = extractRawDetail(parsed);
  const innerMessage = rawDetail ? extractRawMessage(rawDetail) : null;

  return combineErrorMessages(outerMessage, innerMessage) || trimmed;
}

function findErrorMessage(data: unknown): string | null {
  if (typeof data === 'string') return data;
  if (!data) return null;

  if (Array.isArray(data)) {
    for (const item of data) {
      const message = findErrorMessage(item);
      if (message) return message;
    }
    return null;
  }

  if (typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    if (typeof obj.message === 'string') return obj.message;
    if (typeof obj.error === 'string') return obj.error;
    if (typeof obj.detail === 'string') return obj.detail;

    if (obj.error) {
      const message = findErrorMessage(obj.error);
      if (message) return message;
    }

    if (obj.errors) {
      const message = findErrorMessage(obj.errors);
      if (message) return message;
    }
  }

  return null;
}

function safeJsonParse(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractRawDetail(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const obj = data as Record<string, unknown>;
  const error = obj.error;
  if (!error || typeof error !== 'object') return null;
  const err = error as Record<string, unknown>;
  const metadata = err.metadata;
  if (!metadata || typeof metadata !== 'object') return null;
  const raw = (metadata as Record<string, unknown>).raw;
  return typeof raw === 'string' ? raw : null;
}

function extractRawMessage(raw: string): string | null {
  const parsedRaw = safeJsonParse(raw);
  if (parsedRaw) {
    return findErrorMessage(parsedRaw) || raw;
  }
  return raw;
}

function combineErrorMessages(primary: string | null, secondary: string | null): string | null {
  if (primary && secondary) {
    if (primary === secondary) return primary;
    return `${primary}（詳細: ${secondary}）`;
  }
  return primary || secondary;
}
