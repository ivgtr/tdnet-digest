import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FactSummary } from '../lib/fact-summary';

const mocked = vi.hoisted(() => ({
  generateText: vi.fn(),
  extractScoreInput: vi.fn(),
  inferExperimentalScore: vi.fn(),
}));
interface TestResponse {
  summary: string;
  metadata: { analysisFingerprint: string; score?: unknown };
  facts: FactSummary;
  resultId: string;
  analysis: { longTerm: { text: string } };
  score: { value: number };
}
vi.mock('@/lib/llm-client', () => ({ generateText: mocked.generateText }));
vi.mock('@/lib/score-extraction', () => ({ extractScoreInput: mocked.extractScoreInput }));
vi.mock('@/lib/scoring', () => ({
  assessClaim: () => '確認済み',
  inferExperimentalScore: mocked.inferExperimentalScore,
}));

const page = '2026年通期 営業利益 1150百万円';
const facts: FactSummary = {
  version: 2,
  documentType: 'earningsRevision',
  unverified: [],
  facts: [
    {
      id: 'f1',
      importance: 'key',
      kind: 'number',
      label: '営業利益',
      value: 1150,
      unit: '百万円',
      period: '2026年通期',
      valueKind: 'forecastAfter',
      column: null,
      statement: null,
      page: 1,
      quote: page,
    },
  ],
};

async function setup(scoring: boolean) {
  let listener: (
    request: unknown,
    sender: unknown,
    reply: (value: TestResponse) => void
  ) => boolean = () => false;
  vi.stubGlobal('chrome', {
    runtime: {
      onInstalled: { addListener: vi.fn() },
      onMessage: {
        addListener: (fn: typeof listener) => {
          listener = fn;
        },
      },
      getContexts: async () => [{ contextType: 'OFFSCREEN_DOCUMENT' }],
      sendMessage: async () => ({
        success: true,
        text: `[PDF_PAGE:1]\n${page}`,
        pages: [{ pageNumber: 1, text: page }],
        metadata: {
          totalPages: 1,
          extractedPages: [1],
          extractionMode: 'full',
          documentType: 'earningsRevision',
        },
      }),
    },
    storage: {
      sync: {
        get: async () => ({
          provider: 'openai',
          model: 'test',
          apiKey: 'test',
          extractionMode: 'full',
          experimentalScoring: scoring,
        }),
      },
    },
    offscreen: { createDocument: vi.fn() },
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(4) }))
  );
  await import('./index');
  const request = async (body: Record<string, unknown>) =>
    new Promise<TestResponse>((resolve) =>
      listener(
        {
          pdfUrl: 'test.pdf',
          title: '通期業績予想の修正',
          code: '1234',
          companyName: 'テスト社',
          ...body,
        },
        null,
        resolve
      )
    );
  return request;
}

describe('要約・採点・追加分析の分離', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    mocked.generateText.mockReset();
    mocked.extractScoreInput.mockReset();
    mocked.inferExperimentalScore.mockReset();
  });

  it('要約は1回のLLM呼び出しで採点を待たずに返す', async () => {
    mocked.generateText.mockResolvedValue(JSON.stringify(facts));
    const request = await setup(true);
    const result = await request({ action: 'summarize' });
    expect(result.summary).toContain('1150百万円');
    expect(result.metadata.score).toBeUndefined();
    expect(mocked.generateText).toHaveBeenCalledTimes(1);
    expect(mocked.extractScoreInput).not.toHaveBeenCalled();
  });

  it('スコアOFFでも追加分析を明示操作で実行できる', async () => {
    mocked.generateText.mockResolvedValueOnce(JSON.stringify(facts)).mockResolvedValueOnce(
      JSON.stringify({
        version: 1,
        interpretation: { text: '判断不能', factIds: [] },
        shortTerm: { text: '判断不能', factIds: [] },
        mediumTerm: { text: '判断不能', factIds: [] },
        longTerm: { text: '判断不能', factIds: [] },
        watchPoints: [],
      })
    );
    const request = await setup(false);
    const summary = await request({ action: 'summarize' });
    const analysis = await request({
      action: 'analyze',
      facts: summary.facts,
      resultId: summary.resultId,
      fingerprint: summary.metadata.analysisFingerprint,
    });
    expect(analysis.analysis.longTerm.text).toBe('判断不能');
    expect(mocked.extractScoreInput).not.toHaveBeenCalled();
  });

  it('スコアONの採点は別要求で事実を起点にする', async () => {
    mocked.generateText.mockResolvedValue(JSON.stringify(facts));
    mocked.extractScoreInput.mockResolvedValue({
      claims: [{ category: 'revenue' }],
      unverified: [],
      searchStatus: '元PDF内',
    });
    mocked.inferExperimentalScore.mockResolvedValue({
      value: 70,
      verdict: '参考',
      positives: [],
      negatives: [],
      breakdown: [],
      unverified: [],
      searchStatus: '元PDF内',
    });
    const request = await setup(true);
    const summary = await request({ action: 'summarize' });
    const score = await request({
      action: 'score',
      facts: summary.facts,
      resultId: summary.resultId,
      fingerprint: summary.metadata.analysisFingerprint,
    });
    expect(score.score.value).toBe(70);
    expect(mocked.extractScoreInput.mock.calls[0][4]).toEqual(summary.facts);
  });
});
