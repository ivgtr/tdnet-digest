import type { LLMConfig } from './llm-client';

export interface SearchOutcome {
  urls: string[];
  status: string;
  requests: number | null;
  apiRequests: number;
  costStatus: string;
}

/** 候補発見専用。検索応答そのものは採点根拠にしない。 */
export async function searchDisclosureCandidates(
  config: LLMConfig,
  company: string,
  code: string,
  title: string
): Promise<SearchOutcome> {
  if (!['openai', 'anthropic', 'google', 'openrouter'].includes(config.provider)) {
    return {
      urls: [],
      status: '設定中のAPIではWeb検索を利用できません',
      requests: 0,
      apiRequests: 0,
      costStatus: '検索料金なし',
    };
  }
  const query = `${company} ${code} ${title} 比較対象 前期 会社 IR 公式 PDF`;
  const instruction = `次の会社の比較用となる過去の公式開示PDFを1回だけ検索してください。URLだけ返してください。検索語: ${query}`;
  let data: unknown;
  try {
    if (config.provider === 'openai') {
      data = await post(
        'https://api.openai.com/v1/responses',
        {
          model: config.model,
          input: instruction,
          tools: [{ type: 'web_search', search_context_size: 'low' }],
          tool_choice: 'required',
          max_output_tokens: 500,
        },
        { Authorization: `Bearer ${config.apiKey}` }
      );
    } else if (config.provider === 'anthropic') {
      data = await post(
        'https://api.anthropic.com/v1/messages',
        {
          model: config.model,
          max_tokens: 500,
          messages: [{ role: 'user', content: instruction }],
          tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 1 }],
        },
        { 'x-api-key': config.apiKey, 'anthropic-version': '2023-06-01' }
      );
    } else if (config.provider === 'google') {
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.model)}:generateContent`;
      data = await post(
        endpoint,
        {
          contents: [{ role: 'user', parts: [{ text: instruction }] }],
          tools: [{ google_search: {} }],
        },
        { 'x-goog-api-key': config.apiKey }
      );
    } else {
      data = await post(
        'https://openrouter.ai/api/v1/chat/completions',
        {
          model: config.model,
          messages: [{ role: 'user', content: instruction }],
          tools: [
            { type: 'openrouter:web_search', parameters: { max_results: 3, max_total_results: 3 } },
          ],
        },
        { Authorization: `Bearer ${config.apiKey}` }
      );
    }
  } catch (error) {
    return {
      urls: [],
      status: `Web検索失敗: ${error instanceof Error ? error.message : String(error)}`,
      requests: null,
      apiRequests: 1,
      costStatus: '検索APIの請求額は確認できません',
    };
  }
  const raw = JSON.stringify(data);
  const urls = [
    ...new Set(
      (raw.match(/https?:\\?\/\\?\/[^\s"'<>\\]+/g) ?? [])
        .map((item) => item.replace(/\\\//g, '/').replace(/[),.;]+$/, ''))
        .filter((item) => /^https:\/\//.test(item) && /\.pdf(?:\?|$)/i.test(item))
    ),
  ]
    .filter((item) => {
      try {
        return !new URL(item).hostname.endsWith('jpx.co.jp');
      } catch {
        return false;
      }
    })
    .slice(0, 3);
  const requests = readRequestCount(data);
  return {
    urls,
    status: urls.length ? '過去資料候補を取得' : '検索したが比較用PDF候補を確認できません',
    requests,
    apiRequests: 1,
    costStatus: '検索APIの請求額は応答から確認できません。利用中APIの料金表を参照',
  };
}

export async function fetchCandidatePdf(url: string): Promise<ArrayBuffer> {
  const parsed = new URL(url);
  if (
    parsed.protocol !== 'https:' ||
    !/\.pdf$/i.test(parsed.pathname) ||
    /^(localhost|0\.0\.0\.0|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[::1\])/.test(
      parsed.hostname
    ) ||
    parsed.hostname.endsWith('.local') ||
    parsed.hostname.endsWith('jpx.co.jp') ||
    parsed.hostname.endsWith('tdnet.info')
  ) {
    throw new Error('取得対象外のURLです');
  }
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(12_000) });
  if (!response.ok || !response.headers.get('content-type')?.toLowerCase().includes('pdf')) {
    throw new Error(`PDF本文に到達できません (${response.status})`);
  }
  const size = Number(response.headers.get('content-length') ?? 0);
  if (size > 15_000_000) throw new Error('PDFがサイズ上限を超えます');
  const data = await response.arrayBuffer();
  if (data.byteLength > 15_000_000 || new TextDecoder().decode(data.slice(0, 4)) !== '%PDF') {
    throw new Error('PDF形式またはサイズを確認できません');
  }
  return data;
}

async function post(url: string, body: unknown, headers: Record<string, string>): Promise<unknown> {
  const response = await fetch(url, {
    method: 'POST',
    signal: AbortSignal.timeout(15_000),
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function readRequestCount(data: unknown): number | null {
  if (!data || typeof data !== 'object') return null;
  const root = data as Record<string, unknown>;
  const usage = root.usage as Record<string, unknown> | undefined;
  const server = usage?.server_tool_use as Record<string, unknown> | undefined;
  if (typeof server?.web_search_requests === 'number') return server.web_search_requests;
  const output = root.output;
  if (Array.isArray(output))
    return output.filter((item) => item?.type === 'web_search_call').length;
  const candidates = root.candidates;
  if (Array.isArray(candidates)) {
    const grounding = candidates[0]?.groundingMetadata;
    if (Array.isArray(grounding?.webSearchQueries)) return grounding.webSearchQueries.length;
  }
  return null;
}
