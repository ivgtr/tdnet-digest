import { effectiveApiUrl } from './llm-endpoint';

/**
 * 統一LLMクライアント
 * 各プロバイダーのAPIフォーマットの違いを吸収し、統一されたインターフェースを提供
 */

export interface LLMConfig {
  provider: string;
  apiKey: string;
  model: string;
  baseUrl?: string; // カスタムプロバイダー用
  maxOutputTokens?: number;
  // Default callers reject limit termination. Opted-in callers must validate the
  // returned response themselves and expose its potentially incomplete status.
  outputLimitBehavior?: 'reject' | 'return-response';
  reasoningEffort?: 'low' | 'high';
  reasoningEnabled?: boolean;
  temperature?: number; // 生成温度（0-2、低いほど安定した出力）
  onUsage?: (usage: {
    inputTokens: number | null;
    outputTokens: number | null;
    elapsedMs: number;
    finishReason?: string | null;
    reasoningTokens?: number | null;
  }) => void;
  responseFormat?:
    | 'json_object'
    | {
        type: 'json_schema';
        json_schema: { name: string; strict: true; schema: Record<string, unknown> };
      };
  signal?: AbortSignal;
  onResponse?: (response: string) => void;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export function isOutputLimitFinishReason(reason: string | null | undefined): boolean {
  return ['length', 'max_tokens', 'model_context_window_exceeded'].includes(reason ?? '');
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
  if (
    config.maxOutputTokens !== undefined &&
    (!Number.isInteger(config.maxOutputTokens) || config.maxOutputTokens <= 0)
  )
    throw new Error('APIの出力上限は正の整数で指定してください');
  if (
    config.reasoningEnabled !== undefined &&
    (typeof config.reasoningEnabled !== 'boolean' || config.provider !== 'openrouter')
  )
    throw new Error('推論の有効指定はOpenRouterで真偽値を指定してください');
  if (config.reasoningEnabled !== undefined && config.reasoningEffort !== undefined)
    throw new Error('推論の有効指定と推論強度は同時に指定できません');
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
  // 明示したbaseUrlまたはプロバイダー既定のURLを指紋と同じ規則で正規化する
  const baseUrl = effectiveApiUrl(config);

  const started = performance.now();
  const response = await fetch(baseUrl, {
    method: 'POST',
    signal: config.signal,
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
      ...(config.maxOutputTokens !== undefined && { max_tokens: config.maxOutputTokens }),
      ...(config.provider === 'openrouter' &&
        (config.reasoningEnabled !== undefined
          ? { reasoning: { enabled: config.reasoningEnabled } }
          : config.reasoningEffort && {
              reasoning: { effort: config.reasoningEffort, exclude: true },
            })),
      ...(config.temperature !== undefined && { temperature: config.temperature }),
      ...(config.responseFormat && {
        response_format:
          config.responseFormat === 'json_object' ? { type: 'json_object' } : config.responseFormat,
        ...(config.provider === 'openrouter' && { provider: { require_parameters: true } }),
      }),
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    const apiError = buildApiError(
      response.status,
      response.statusText,
      errorText.split(config.apiKey).join('[redacted]')
    );
    if (apiError.isServerError) {
      console.error('[LLM Client] API呼び出しエラー:', response.status);
    }
    throw apiError;
  }

  const data = await response.json();
  config.onUsage?.({
    inputTokens: Number.isFinite(data.usage?.prompt_tokens) ? data.usage.prompt_tokens : null,
    outputTokens: Number.isFinite(data.usage?.completion_tokens)
      ? data.usage.completion_tokens
      : null,
    elapsedMs: Math.round(performance.now() - started),
    finishReason:
      typeof data.choices?.[0]?.finish_reason === 'string' ? data.choices[0].finish_reason : null,
    reasoningTokens: Number.isFinite(data.usage?.completion_tokens_details?.reasoning_tokens)
      ? data.usage.completion_tokens_details.reasoning_tokens
      : null,
  });

  if (typeof data.choices?.[0]?.message?.content === 'string')
    config.onResponse?.(data.choices[0].message.content);
  if (
    isOutputLimitFinishReason(data.choices?.[0]?.finish_reason) &&
    config.outputLimitBehavior !== 'return-response'
  )
    throw new Error('APIの推論・出力上限に達しました。応答は採用できません');
  if (
    typeof data.choices?.[0]?.message?.content !== 'string' ||
    !data.choices[0].message.content.trim()
  ) {
    console.error('[LLM Client] 不正なレスポンス形式');
    throw new Error('APIレスポンスの形式が不正です');
  }

  return data.choices[0].message.content;
}

/**
 * Anthropic APIを呼び出す
 * Anthropicは独自のAPIフォーマットを使用
 */
async function generateTextAnthropic(config: LLMConfig, messages: ChatMessage[]): Promise<string> {
  const baseUrl = effectiveApiUrl(config);

  // systemメッセージを分離
  const systemMessage = messages.find((msg) => msg.role === 'system');
  const conversationMessages = messages.filter((msg) => msg.role !== 'system');

  const started = performance.now();
  const response = await fetch(baseUrl, {
    method: 'POST',
    signal: config.signal,
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': config.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: config.maxOutputTokens === undefined ? 4096 : config.maxOutputTokens,
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
    const apiError = buildApiError(
      response.status,
      response.statusText,
      errorText.split(config.apiKey).join('[redacted]')
    );
    if (apiError.isServerError) {
      console.error('[LLM Client] Anthropic API呼び出しエラー:', response.status);
    }
    throw apiError;
  }

  const data = await response.json();

  config.onUsage?.({
    inputTokens: Number.isFinite(data.usage?.input_tokens) ? data.usage.input_tokens : null,
    outputTokens: Number.isFinite(data.usage?.output_tokens) ? data.usage.output_tokens : null,
    elapsedMs: Math.round(performance.now() - started),
    finishReason: typeof data.stop_reason === 'string' ? data.stop_reason : null,
  });
  if (typeof data.content?.[0]?.text === 'string') config.onResponse?.(data.content[0].text);
  if (
    isOutputLimitFinishReason(data.stop_reason) &&
    config.outputLimitBehavior !== 'return-response'
  )
    throw new Error('APIの推論・出力上限に達しました。応答は採用できません');
  if (typeof data.content?.[0]?.text !== 'string' || !data.content[0].text.trim()) {
    console.error('[LLM Client] 不正なレスポンス形式');
    throw new Error('APIレスポンスの形式が不正です');
  }
  return data.content[0].text;
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
