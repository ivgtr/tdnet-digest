/**
 * 統一LLMクライアント
 * 各プロバイダーのAPIフォーマットの違いを吸収し、統一されたインターフェースを提供
 */

export interface LLMConfig {
  provider: string;
  apiKey: string;
  model: string;
  baseUrl?: string; // カスタムプロバイダー用
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
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
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('[LLM Client] API呼び出しエラー:', response.status, errorText);
    throw new Error(`API呼び出しに失敗しました: ${response.status} ${response.statusText}`);
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
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('[LLM Client] Anthropic API呼び出しエラー:', response.status, errorText);
    throw new Error(`API呼び出しに失敗しました: ${response.status} ${response.statusText}`);
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
