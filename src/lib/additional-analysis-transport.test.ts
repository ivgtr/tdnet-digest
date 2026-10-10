import { afterEach, describe, expect, it, vi } from 'vitest';
import { numberCandidate, textPage } from './fixtures/v4-test-source';
import { buildPresentation } from './fixtures/summary-narrative-source';
import { parseFactSummary } from './fact-summary';
import { analyzeFacts, parseAnalysis } from './additional-analysis';
import { generateText } from './llm-client';
import type { AnalysisGenerationDiagnostic } from './analysis-trace';

// This boundary deliberately keeps the real transport: mocking generateText
// would miss transport rejection before the analysis parser sees valid JSON.
const page = textPage(
  '会社名 株式会社テスト | 会計基準 日本基準 | 範囲 連結\n2026年3月期 連結経営成績\n営業利益は100百万円です。'
);
const facts = parseFactSummary(
  JSON.stringify({
    version: 6,
    documentType: 'other',
    facts: [numberCandidate(page)],
    unverified: [],
  }),
  'other',
  [page]
);
const presentation = buildPresentation(facts, [page]);
const raw = JSON.stringify({
  version: 4,
  overallSummary: {
    text: '利益計上は確認できますが、持続性の評価には収益要因の裏付けが必要です。',
    evidenceIds: [`fact:${facts.facts[0].id}`],
  },
  issues: [
    {
      title: '利益の継続性',
      conclusion: '利益の継続性は要因の確認が必要です',
      evidenceIds: [`fact:${facts.facts[0].id}`],
      reading: '利益を支える条件が続けば維持される可能性があります',
      caveat: '将来の条件は変わる可能性があります',
      nextCheck: '次期の利益とその要因を確認する',
    },
  ],
});
const config = (provider: string) => ({ provider, apiKey: 'fixture', model: 'fixture' });
const limitedCases = [
  ['openai', 'length'],
  ['anthropic', 'max_tokens'],
  ['anthropic', 'model_context_window_exceeded'],
] as const;
const transportResponse = (provider: string, finishReason: string, content = raw) =>
  new Response(
    JSON.stringify(
      provider === 'anthropic'
        ? {
            content: [{ type: 'text', text: content }],
            stop_reason: finishReason,
            usage: { input_tokens: 100, output_tokens: 8192 },
          }
        : {
            choices: [{ message: { content }, finish_reason: finishReason }],
            usage: { prompt_tokens: 100, completion_tokens: 8192 },
          }
    ),
    { status: 200 }
  );
afterEach(() => vi.unstubAllGlobals());

describe('追加分析の通信から保存までの出力上限境界', () => {
  it.each(limitedCases)(
    '%s / %s の完全JSONを注意付きで保存・復元する',
    async (provider, reason) => {
      const fetch = vi.fn().mockResolvedValue(transportResponse(provider, reason));
      vi.stubGlobal('fetch', fetch);
      const snapshots: AnalysisGenerationDiagnostic[] = [];
      const result = await analyzeFacts(config(provider), facts, presentation, (value) => {
        snapshots.push(value);
      });
      expect(result.issues).toHaveLength(1);
      expect(result.overallSummary).toEqual(JSON.parse(raw).overallSummary);
      expect(result.notices).toContainEqual(
        expect.objectContaining({ code: 'output_limit', issueIndex: -1, severity: 'warning' })
      );
      expect(parseAnalysis(JSON.stringify(result), facts, presentation)).toEqual(result);
      expect(snapshots[snapshots.length - 1]).toMatchObject({
        outcome: 'partialSuccess',
        response: raw,
        usage: { finishReason: reason },
        error: null,
      });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(JSON.parse(fetch.mock.calls[0][1].body)).not.toHaveProperty('outputLimitBehavior');
    }
  );

  it.each(limitedCases)('%s / %s は通常の呼出しでは引き続き拒否する', async (provider, reason) => {
    const fetch = vi.fn().mockResolvedValue(transportResponse(provider, reason));
    vi.stubGlobal('fetch', fetch);
    await expect(
      generateText(config(provider), [{ role: 'user', content: 'fixture' }])
    ).rejects.toThrow('APIの推論・出力上限');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('上限終了の不完全JSONを補完せず、原応答付きの失敗にする', async () => {
    const incomplete = '{"version":4,"issues":[';
    const fetch = vi.fn().mockResolvedValue(transportResponse('openai', 'length', incomplete));
    vi.stubGlobal('fetch', fetch);
    const snapshots: AnalysisGenerationDiagnostic[] = [];
    await expect(
      analyzeFacts(config('openai'), facts, presentation, (value) => {
        snapshots.push(value);
      })
    ).rejects.toMatchObject({ code: 'output_limit' });
    expect(snapshots[snapshots.length - 1]).toMatchObject({
      outcome: 'failure',
      response: incomplete,
      error: { code: 'output_limit' },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('HTTP失敗を回復扱いせず再要求もしない', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response('{"error":{"message":"bad request"}}', { status: 400 }));
    vi.stubGlobal('fetch', fetch);
    const snapshots: AnalysisGenerationDiagnostic[] = [];
    await expect(
      analyzeFacts(config('openai'), facts, presentation, (value) => {
        snapshots.push(value);
      })
    ).rejects.toMatchObject({ code: 'request_failed' });
    expect(snapshots[snapshots.length - 1]).toMatchObject({ outcome: 'failure', response: null });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('受信後の明示中断を上限応答からの回復より優先する', async () => {
    const controller = new AbortController();
    const fetch = vi.fn().mockResolvedValue(transportResponse('openai', 'length'));
    vi.stubGlobal('fetch', fetch);
    const snapshots: AnalysisGenerationDiagnostic[] = [];
    await expect(
      analyzeFacts(
        { ...config('openai'), signal: controller.signal, onResponse: () => controller.abort() },
        facts,
        presentation,
        (value) => {
          snapshots.push(value);
        }
      )
    ).rejects.toMatchObject({ code: 'interrupted' });
    expect(snapshots[snapshots.length - 1]).toMatchObject({
      outcome: 'failure',
      response: raw,
      error: { code: 'interrupted' },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
