import { candidateResponse } from './fixtures/candidate-test-source';
import type { VerifiedFact } from './fact-contract';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';
import { generateText, type LLMConfig } from './llm-client';
import { generateVerifiedFacts as generateVerifiedFactSummary, renderFacts } from './fact-summary';
import { extractPageLayout } from './pdf-layout';
import corpus from './fixtures/ir-semantic-corpus.json';
import expectations from './fixtures/ir-semantic-expectations.json';

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
const pages = corpus[0].pages.map((page) =>
  extractPageLayout(page.items as TextItem[], page.pageNumber)
);
const raw = (facts: unknown[]) => candidateResponse(facts as VerifiedFact[], pages, 'earnings');

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

  it('大きな事実v4を初回・不足分修復とも拡張予算で原文照合して表示する', async () => {
    const facts = expectations[0].facts;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(raw(facts.slice(0, 6))))
      .mockResolvedValueOnce(response(raw(facts.slice(6))));
    vi.stubGlobal('fetch', fetchMock);
    const result = await generateVerifiedFactSummary(
      config,
      'earnings',
      pages.map((page) => page.text).join('\n'),
      pages
    );
    expect(result.repairAttempted).toBe(true);
    expect(result.facts.facts).toHaveLength(facts.length);
    expect(result.facts.unverified).toEqual([]);
    expect(renderFacts(result.facts)).toContain('-400百万円');
    expect(renderFacts(result.facts)).toContain('1.4%');
    expect(renderFacts(result.facts)).toContain('翌連結会計年度');
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
    const fetchMock = vi.fn().mockResolvedValue(response(raw(expectations[0].facts)));
    vi.stubGlobal('fetch', fetchMock);
    await generateVerifiedFactSummary(
      { ...config, model, maxOutputTokens: limit },
      'earnings',
      pages.map((page) => page.text).join('\n'),
      pages
    );
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).max_tokens).toBe(expected);
  });

  it('原文に正しい事実があっても打ち切り応答の部分採用や同じ上限での修復をしない', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(raw(expectations[0].facts), 'max_tokens'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      generateVerifiedFactSummary(config, 'earnings', pages[0].text, pages)
    ).rejects.toThrow('上限');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// Transport semantics belong here; narrative policy is checked by its existing owner.
describe('OpenRouterの任意推論', () => {
  it('推論無効を明示し、強度との競合は送信前に拒否する', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
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
    await generateText(router, messages);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).reasoning).toEqual({ enabled: false });
    await expect(generateText({ ...router, reasoningEffort: 'low' }, messages)).rejects.toThrow(
      '同時に指定'
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
