import { beforeEach, describe, expect, it, vi } from 'vitest';
import { textPage, numberCandidate } from '../lib/fixtures/v4-test-source';
import { parseFactSummary } from '../lib/fact-summary';
import type { FactSummary } from '../lib/fact-summary';
import type { ExtractedPage, ExtractionMode } from '../types/summaryMetadata';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';
import { extractPageLayout } from '../lib/pdf-layout';
import { serializePagesForAnalysis } from '../lib/page-text';
import corpus from '../lib/fixtures/ir-semantic-corpus.json';
import expectations from '../lib/fixtures/ir-semantic-expectations.json';

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

const nativePage = textPage(
  '会社名 株式会社テスト | 会計基準 日本基準 | 範囲 連結\n2026年3月期 今回予想\n営業利益は1150百万円です。'
);
const page = nativePage.text;
const candidate = numberCandidate(nativePage, '営業利益', 1150);
candidate.valueKind = 'forecastAfter';
candidate.semantics.state = 'forecastAfter';
const facts: FactSummary = parseFactSummary(
  JSON.stringify({
    version: 4,
    documentType: 'earningsRevision',
    facts: [candidate],
    unverified: [],
  }),
  'earningsRevision',
  [nativePage]
);

async function setup(
  scoring: boolean,
  allowPastPdf = true,
  withDate = false,
  legacy = false,
  source?: { pages: ExtractedPage[]; mode: ExtractionMode }
) {
  const extractionPage = withDate ? textPage(page + '\n2026年8月13日') : nativePage;
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
      sendMessage: vi.fn(async (request) => {
        const pages = (source?.pages ?? [extractionPage]).map((page) => ({
          ...page,
          selection: request.extractionMode === 'full' ? ('selected' as const) : page.selection,
        }));
        const selected = pages.filter((page) => page.selection === 'selected');
        return {
          success: true,
          text: serializePagesForAnalysis(selected),
          pages,
          metadata: {
            totalPages: pages.length,
            extractedPages: selected.map((page) => page.pageNumber),
            extractionMode: request.extractionMode,
            documentType: request.documentType,
          },
        };
      }),
    },
    storage: {
      sync: {
        get: async () => ({
          provider: 'openai',
          model: 'test',
          apiKey: 'test',
          extractionMode: source?.mode ?? 'full',
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
        version: 2,
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

  it.each(['analyze', 'score'])(
    'smart要約から%sへ進んでも未選択の損失予定を要求しない',
    async (action) => {
      const selectedPages = corpus[0].pages.map((page) =>
        extractPageLayout(page.items as TextItem[], page.pageNumber)
      );
      const pages = Array.from({ length: 18 }, (_, index) => {
        const pageNumber = index + 1;
        const page =
          selectedPages.find((p) => p.pageNumber === pageNumber) ?? textPage('', pageNumber);
        return {
          ...page,
          selection:
            pageNumber === 1 || pageNumber === 5 ? ('selected' as const) : ('omitted' as const),
        };
      });
      const smartFacts = parseFactSummary(
        JSON.stringify({
          version: 4,
          documentType: 'earnings',
          facts: expectations[0].facts.filter((f) => f.page !== 18),
          unverified: [],
        }),
        'earnings',
        pages
      );
      mocked.generateText.mockResolvedValueOnce(JSON.stringify(smartFacts)).mockResolvedValueOnce(
        JSON.stringify({
          version: 2,
          interpretation: { text: '判断不能', factIds: [] },
          shortTerm: { text: '判断不能', factIds: [] },
          mediumTerm: { text: '判断不能', factIds: [] },
          longTerm: { text: '判断不能', factIds: [] },
          watchPoints: [],
        })
      );
      mocked.extractScoreInput.mockResolvedValue({
        claims: [{ category: 'coreForecast' }],
        unverified: [],
        searchStatus: '元PDF内',
      });
      mocked.inferExperimentalScore.mockResolvedValue({ value: 70 });
      const request = await setup(true, false, false, false, { pages, mode: 'smart' });
      const base = { title: '2026年3月期 決算短信' };
      const summary = await request({ ...base, action: 'summarize' });
      expect(summary.error).toBeUndefined();
      expect(summary.summary).not.toContain('翌連結会計年度');
      const followup = {
        ...base,
        action,
        facts: summary.facts,
        resultId: summary.resultId,
        fingerprint: summary.metadata.analysisFingerprint,
      };
      const result = await request(followup);
      expect(result.error).toBeUndefined();
      if (action === 'analyze') expect(result.analysis.longTerm.text).toBe('判断不能');
      else {
        expect(result.score.value).toBe(70);
        expect(mocked.extractScoreInput.mock.calls[0][4]).toEqual(summary.facts);
      }
      expect(chrome.runtime.sendMessage).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ extractionMode: 'smart' })
      );
      expect(chrome.runtime.sendMessage).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ extractionMode: 'full' })
      );

      const changed = structuredClone(summary.facts);
      changed.facts[0].value = 1;
      expect((await request({ ...followup, facts: changed })).error).toContain('識別子');
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(5),
      } as Response);
      expect((await request(followup)).error).toContain('識別子');
      pages[17].status = 'failed';
      expect((await request(followup)).error).toContain('抽出失敗');
    }
  );

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
