import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildScoreHtml } from '../content/utils/summaryHtmlBuilder';

const { generateText } = vi.hoisted(() => ({ generateText: vi.fn() }));
vi.mock('@/lib/llm-client', () => ({ generateText }));

const url = 'https://www.release.tdnet.info/inbs/test.pdf';
const pdfText =
  '[PDF_PAGE:1]\n2026年7月14日\nテスト社 日本基準 連結\n2026年通期 営業利益予想 1000百万円 前回\n2026年通期 営業利益予想 1150百万円 今回';
const source = (value: number, kind: 'forecastBefore' | 'forecastAfter') => ({
  value,
  unit: '百万円',
  source: {
    url,
    page: 1,
    quote: `2026年通期 営業利益予想 ${value}百万円 ${kind === 'forecastBefore' ? '前回' : '今回'}`,
    period: '2026年通期',
    fiscalYear: 2026,
    periodKind: 'fullYear',
    valueKind: kind,
    metric: '営業利益予想',
    basis: '日本基準',
    scope: '連結',
  },
});
const scoreInput = JSON.stringify({
  claims: [
    {
      category: 'coreForecast',
      label: '本業予想の改善',
      current: source(1150, 'forecastAfter'),
      previous: source(1000, 'forecastBefore'),
      earlier: null,
      relatedValue: null,
      companyExplanation: null,
    },
  ],
  unverified: [],
});
const scoreInference = JSON.stringify({
  value: 68,
  factors: [{ index: 0, impact: 'positive', strength: 'large' }],
});

async function runSummary(twoPass = true) {
  let listener:
    | ((request: unknown, sender: unknown, reply: (value: unknown) => void) => boolean)
    | undefined;
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
        text: pdfText,
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
        get: (_keys: unknown, cb: (value: unknown) => void) =>
          cb({
            provider: 'openai',
            apiKey: 'test',
            model: 'test',
            twoPassMode: twoPass,
            experimentalScoring: true,
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
  return await new Promise<{
    summary: string;
    metadata: { score: import('../lib/scoring').ExperimentalScore };
  }>((resolve) =>
    listener!(
      {
        action: 'summarize',
        pdfUrl: 'test.pdf',
        title: '通期業績予想の修正',
        code: '1234',
        companyName: 'テスト社',
      },
      null,
      (value) =>
        resolve(
          value as {
            summary: string;
            metadata: { score: import('../lib/scoring').ExperimentalScore };
          }
        )
    )
  );
}

describe('要約応答から一覧・詳細へのスコア接続', () => {
  beforeEach(() => {
    generateText.mockReset();
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it('2パス要約で根拠付きの推論点数を返す', async () => {
    generateText
      .mockResolvedValueOnce(
        JSON.stringify({
          summary: '予想修正',
          revisionItems: [],
          reason: null,
          dividendRevision: null,
          investmentView: {
            shortTerm: { stance: 'unknown', rationale: [] },
            mediumTerm: { stance: 'unknown', rationale: [] },
            longTerm: { stance: 'unknown', rationale: [] },
            positives: [],
            risks: [],
            watchPoints: [],
            rationale: '不明',
          },
          topics: [],
        })
      )
      .mockResolvedValueOnce('予想を修正。')
      .mockResolvedValueOnce(scoreInput)
      .mockResolvedValueOnce(scoreInference);
    const response = await runSummary();
    const { readPublishedDate } = await import('./index');
    expect(readPublishedDate('[PDF_PAGE:1]\n2026 年７月 14 日\n各位')).toBe('2026-07-14');
    expect(response.metadata.score.value, JSON.stringify(response.metadata.score)).toBe(68);
    expect(response.metadata.score.positives[0]).toContain('本業予想の改善');
    expect(buildScoreHtml(response.metadata.score)).toContain('#page=1');
  });

  it('2パスのJSON修復失敗後も1パス要約と点数を返す', async () => {
    generateText
      .mockResolvedValueOnce('不正なJSON')
      .mockResolvedValueOnce('修復できないJSON')
      .mockResolvedValueOnce('1パス要約')
      .mockResolvedValueOnce(scoreInput)
      .mockResolvedValueOnce(scoreInference);
    const response = await runSummary();
    expect(response.summary).toBe('1パス要約');
    expect(response.metadata.score.value, JSON.stringify(response.metadata.score)).toBe(68);
  });
});
