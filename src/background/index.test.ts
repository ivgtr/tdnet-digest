import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FactSummary } from '../lib/fact-summary';

const mocked = vi.hoisted(() => ({
  generateText: vi.fn(),
  extractScoreInput: vi.fn(),
  inferExperimentalScore: vi.fn(),
  searchDisclosureCandidates: vi.fn(),
}));
interface TestResponse {
  error?: string;
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
vi.mock('@/lib/disclosure-search', () => ({
  searchDisclosureCandidates: mocked.searchDisclosureCandidates,
  fetchCandidatePdf: vi.fn(),
}));

const page = '2026年通期 営業利益 1150百万円';
const facts: FactSummary = {
  version: 3,
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
      evidence: null,
      quote: page,
    },
  ],
};

async function setup(scoring: boolean, allowPastPdf = true, withDate = false, legacy = false) {
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
        text: `[PDF_PAGE:1]\n${withDate ? '2026年8月13日\n' : ''}${page}`,
        pages: [{ pageNumber: 1, text: page, spans: [] }],
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
          ...(legacy ? { twoPassMode: true } : {}),
        }),
        remove: vi.fn(async () => {}),
      },
    },
    offscreen: { createDocument: vi.fn() },
    permissions: { contains: vi.fn(async () => allowPastPdf) },
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
    mocked.searchDisclosureCandidates.mockReset();
    mocked.searchDisclosureCandidates.mockResolvedValue({
      urls: [],
      status: '比較用PDF候補なし',
      error: null,
      requests: 1,
      apiRequests: 1,
      costStatus: '料金不明',
    });
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

  it('更新前から残る二段階要約設定を削除し、要約を続行する', async () => {
    mocked.generateText.mockResolvedValue(JSON.stringify(facts));
    const request = await setup(false, true, false, true);
    const result = await request({ action: 'summarize' });
    expect(result.summary).toContain('1150百万円');
    expect(chrome.storage.sync.remove).toHaveBeenCalledWith('twoPassMode');
  });

  it('TDnet以外のPDF URLを取得しない', async () => {
    const request = await setup(false);
    const result = await request({ action: 'summarize', pdfUrl: 'https://example.com/report.pdf' });
    expect(result.error).toContain('TDnetのPDF URLではありません');
    expect(fetch).not.toHaveBeenCalled();
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

  it('過去資料の任意権限がない場合は別サイトを取得しない', async () => {
    mocked.generateText.mockResolvedValue(JSON.stringify(facts));
    mocked.extractScoreInput.mockResolvedValue({
      claims: [{ category: 'revenue' }],
      unverified: [],
      searchStatus: '元PDF内',
    });
    mocked.inferExperimentalScore.mockResolvedValue({
      value: null,
      verdict: '算出不能',
      positives: [],
      negatives: [],
      breakdown: [],
      unverified: ['採点の根拠を検証できません'],
      searchStatus: '',
    });
    const request = await setup(true, false, true);
    const summary = await request({ action: 'summarize' });
    const score = await request({
      action: 'score',
      facts: summary.facts,
      resultId: summary.resultId,
      fingerprint: summary.metadata.analysisFingerprint,
    });
    expect(score.error).toContain('採点の根拠を検証できません');
    expect(mocked.inferExperimentalScore.mock.calls[0][2].searchStatus).toContain(
      '過去資料へのアクセス権がありません'
    );
    expect(chrome.permissions.contains).toHaveBeenCalledWith({
      origins: [
        'https://www2.jpx.co.jp/*',
        'https://ssl4.eir-parts.net/*',
        'https://pdf.irpocket.com/*',
      ],
    });
    expect(mocked.generateText).toHaveBeenCalledTimes(1);
  });

  it('検索API失敗は採点エラーとして返し、表示済み要約を保持する', async () => {
    mocked.generateText.mockResolvedValue(JSON.stringify(facts));
    mocked.extractScoreInput.mockResolvedValue({ claims: [], unverified: [], searchStatus: '' });
    mocked.searchDisclosureCandidates.mockResolvedValue({
      urls: [],
      status: 'Web検索失敗: HTTP 429',
      error: 'HTTP 429',
      requests: null,
      apiRequests: 1,
      costStatus: '料金不明',
    });
    const request = await setup(true, true, true);
    const summary = await request({ action: 'summarize' });
    const score = await request({
      action: 'score',
      facts: summary.facts,
      resultId: summary.resultId,
      fingerprint: summary.metadata.analysisFingerprint,
    });
    expect(summary.summary).toContain('1150百万円');
    expect(score.error).toContain('HTTP 429');
    expect(mocked.inferExperimentalScore).not.toHaveBeenCalled();
  });

  it('検索後も比較値を検証できなければ採点結果を作らない', async () => {
    mocked.generateText.mockResolvedValue(JSON.stringify(facts));
    mocked.extractScoreInput.mockResolvedValue({
      claims: [],
      unverified: ['引用を確認できません'],
      searchStatus: '',
    });
    const request = await setup(true, true, true);
    const summary = await request({ action: 'summarize' });
    const score = await request({
      action: 'score',
      facts: summary.facts,
      resultId: summary.resultId,
      fingerprint: summary.metadata.analysisFingerprint,
    });
    expect(summary.summary).toContain('1150百万円');
    expect(score.error).toContain('比較値を原文で確認できません');
    expect(mocked.inferExperimentalScore).not.toHaveBeenCalled();
  });
});
