import { candidateResponse } from './fixtures/candidate-test-source';
import { numberCandidate, textPage } from './fixtures/v4-test-source';
import type { VerifiedFact } from './fact-contract';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateText, type LLMConfig } from './llm-client';
import { generateVerifiedFacts as generateVerifiedFactSummary } from './fact-summary';

const config = {
  provider: 'anthropic',
  model: 'claude-sonnet-4-5-20250929',
  apiKey: 'test',
};
const messages = [{ role: 'user' as const, content: 'JSONを返す' }];
const response = (text: unknown, stopReason = 'end_turn', outputTokens = 6000) =>
  new Response(
    JSON.stringify({
      content: [{ type: 'text', text }],
      stop_reason: stopReason,
      usage: { input_tokens: 100, output_tokens: outputTokens },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
// Transport tests only need one valid source fact; real PDF coverage belongs to the corpus tests.
const page = textPage(
  '会社名 株式会社テスト | 会計基準 日本基準 | 範囲 連結\n2026年3月期 連結経営成績\n営業利益は100百万円です。'
);
const pages = [page];
const fact = numberCandidate(page);
const raw = (facts: VerifiedFact[]) => candidateResponse(facts, pages);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Anthropicの出力予算と完了判定', () => {
  it('既定値と明示した出力予算をMessages APIへ渡す', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(response('{}')));
    vi.stubGlobal('fetch', fetchMock);
    await generateText(config, messages);
    await generateText({ ...config, maxOutputTokens: 32768 }, messages);
    expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body).max_tokens)).toEqual([
      4096, 32768,
    ]);
  });

  it.each(['max_tokens', 'model_context_window_exceeded'])(
    '打ち切り %s は有効なJSONでも採用せず、停止理由と利用量を残す',
    async (stopReason) => {
      const onUsage = vi.fn();
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response('{}', stopReason)));
      await expect(generateText({ ...config, onUsage }, messages)).rejects.toThrow('上限');
      expect(onUsage).toHaveBeenCalledWith(
        expect.objectContaining({
          finishReason: stopReason,
          inputTokens: 100,
          outputTokens: 6000,
        })
      );
    }
  );

  it.each(['', '  ', null, 123])('空または不正な本文 %j を拒否する', async (text) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(text)));
    await expect(generateText(config, messages)).rejects.toThrow('形式が不正');
  });

  it.each([0, -1, 1.5, NaN, null])('不正な出力予算 %j を送信前に拒否する', async (limit) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      generateText({ ...config, maxOutputTokens: limit } as LLMConfig, messages)
    ).rejects.toThrow('正の整数');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('初回と不足分修復の両方へ拡張予算と生成設定を渡す', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(raw([])))
      .mockResolvedValueOnce(response(raw([fact])));
    vi.stubGlobal('fetch', fetchMock);
    const result = await generateVerifiedFactSummary(config, 'other', page.text, pages);
    expect(result.repairAttempted).toBe(true);
    expect(result.facts.facts).toHaveLength(1);
    expect(result.facts.unverified).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [, init] of fetchMock.mock.calls) {
      const body = JSON.parse(init.body);
      expect(body.max_tokens).toBe(32768);
      expect(body.temperature).toBe(0);
      expect(body.response_format).toBeUndefined();
    }
  });

  it.each([
    ['claude-3-5-sonnet-20241022', undefined, 8192],
    [config.model, 16384, 16384],
  ])('モデル %s と明示予算 %s を初回生成へ反映する', async (model, limit, expected) => {
    const fetchMock = vi.fn().mockResolvedValue(response(raw([fact])));
    vi.stubGlobal('fetch', fetchMock);
    await generateVerifiedFactSummary(
      { ...config, model, maxOutputTokens: limit },
      'other',
      page.text,
      pages
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).max_tokens).toBe(expected);
  });

  it('原文に正しい事実があっても打ち切り応答の部分採用や同じ上限での修復をしない', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(raw([fact]), 'max_tokens'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(generateVerifiedFactSummary(config, 'other', page.text, pages)).rejects.toThrow(
      '上限'
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// Transport semantics belong here; narrative policy is checked by its existing owner.
describe('OpenRouterの任意推論', () => {
  it('推論無効を明示し、強度との競合は送信前に拒否する', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(
        async () =>
          new Response(
            JSON.stringify({ choices: [{ message: { content: '{}' }, finish_reason: 'stop' }] }),
            { status: 200 }
          )
      );
    vi.stubGlobal('fetch', fetchMock);
    const router = {
      provider: 'openrouter',
      model: 'deepseek/deepseek-v4.1-flash',
      apiKey: 'test',
      reasoningEnabled: false,
    };
    await generateText({ ...router, responseFormat: 'json_object' }, messages);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.reasoning).toEqual({ enabled: false });
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.provider).toEqual({ require_parameters: true });
    const schema = {
      type: 'json_schema' as const,
      json_schema: {
        name: 'current',
        strict: true as const,
        schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
      },
    };
    await generateText(
      {
        provider: router.provider,
        model: router.model,
        apiKey: router.apiKey,
        reasoningEffort: 'low',
        responseFormat: schema,
      },
      messages
    );
    const structuredBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(structuredBody.response_format).toEqual(schema);
    expect(structuredBody.reasoning).toEqual({ effort: 'low', exclude: true });
    expect(structuredBody.provider).toEqual({ require_parameters: true });
    await expect(generateText({ ...router, reasoningEffort: 'low' }, messages)).rejects.toThrow(
      '同時に指定'
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
