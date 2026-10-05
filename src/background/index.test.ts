import type { SummaryTrace } from '../lib/summary-trace';
import { matchingSummaryTrace } from '../lib/summary-trace';
import type { LLMConfig } from '../lib/llm-client';
import { candidateResponse } from '../lib/fixtures/candidate-test-source';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { textPage, numberCandidate } from '../lib/fixtures/v4-test-source';
import { parseFactSummary } from '../lib/fact-summary';
import type { FactSummary } from '../lib/fact-summary';
import type { ExtractedPage, ExtractionMode } from '../types/summaryMetadata';
import { serializePagesForAnalysis } from '../lib/page-text';
import {
  fixedNarrativeContent,
  fixedNarrativeReview,
} from '../lib/fixtures/summary-narrative-source';
import type { SummaryAttempt } from '../lib/summary-trace';

const mocked = vi.hoisted(() => ({
  generateText: vi.fn(),
  extractScoreInput: vi.fn(),
  inferExperimentalScore: vi.fn(),
  searchDisclosureCandidates: vi.fn(),
}));
interface TestResponse {
  retryExtractionMode?: 'full';
  error?: string;
  diagnosticRunId: string;
  summary: string;
  metadata: { analysisFingerprint: string; score?: unknown };
  facts: FactSummary;
  presentation: import('../lib/summary-presentation').SummaryPresentation;
  resultId: string;
  analysis: { longTerm: { text: string } };
  score: { value: number };
}
vi.mock('@/lib/llm-client', () => ({ generateText: mocked.generateText }));
// Candidate transport/diagnostic races belong here; synthesis semantics are owned
// by summary-narrative.test. Keep its current storage contract at this boundary.
vi.mock('@/lib/summary-narrative', async (original) => ({
  ...(await original<typeof import('../lib/summary-narrative')>()),
  generateSummaryNarrative: async (
    _config: LLMConfig,
    facts: FactSummary,
    values: import('../lib/summary-narrative').NarrativeValue[],
    excerpts: import('../lib/summary-source-inventory').SourceExcerpt[],
    onAttempt?: (attempt: SummaryAttempt) => void | Promise<void>
  ) => {
    const content = fixedNarrativeContent(facts, { excerpts, sections: [] });
    const review = fixedNarrativeReview(content, facts, { values, excerpts });
    await onAttempt?.({ phase: 'summary', response: JSON.stringify(content), error: null });
    await onAttempt?.({ phase: 'summaryReview', response: JSON.stringify(review), error: null });
    return { narrative: { content, review }, repaired: false };
  },
}));
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
  '会社名 株式会社テスト | 会計基準 日本基準 | 範囲 連結\n2026年3月期 業績予想\n営業利益は1150百万円です。\n売上高は10000百万円です。\n当期純利益は800百万円です。'
);
const page = nativePage.text;
const candidate = numberCandidate(nativePage, '営業利益', 1150);
candidate.valueKind = 'forecast';
candidate.semantics.state = 'forecast';
const forecastFacts = [
  candidate,
  ...[
    ['売上高', 10000],
    ['当期純利益', 800],
  ].map(([label, value], i) => {
    const f = numberCandidate(nativePage, String(label), Number(value));
    f.id = `f${i + 2}`;
    f.valueKind = f.semantics.state = 'forecast';
    return f;
  }),
];
const facts: FactSummary = parseFactSummary(
  JSON.stringify({
    version: 6,
    documentType: 'earningsRevision',
    facts: forecastFacts,
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
      local: { set: vi.fn(async () => {}) },
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

  it('修復APIが失敗しても初回診断を先に保存し、未完と失敗を区別する', async () => {
    const request = await setup(false);
    const writes: SummaryTrace[] = [];
    vi.mocked(chrome.storage.local.set).mockImplementation(
      async (items: Record<string, unknown>) => {
        writes.push(structuredClone(items.summaryLastRunV1) as SummaryTrace);
      }
    );
    mocked.generateText
      .mockImplementationOnce(async (config: LLMConfig) => {
        expect(config.signal).toBeInstanceOf(AbortSignal);
        expect(writes[writes.length - 1]).toMatchObject({ outcome: 'running', attempts: [] });
        return 'malformed';
      })
      .mockImplementationOnce(async () => {
        expect(writes[writes.length - 1].attempts).toEqual([
          expect.objectContaining({ phase: 'first', response: 'malformed' }),
        ]);
        throw new Error('fixture API failure');
      });
    const result = await request({ action: 'summarize' });
    expect(result.error).toContain('fixture API failure');
    expect(writes[writes.length - 1]).toMatchObject({
      outcome: 'failure',
      error: 'fixture API failure',
    });
    expect(writes[writes.length - 1].attempts.map((a) => a.phase)).toEqual(['first', 'repair']);
    expect(
      matchingSummaryTrace(writes[writes.length - 1], 'test.pdf', result.diagnosticRunId, null)
    ).toEqual(writes[writes.length - 1]);
    expect(JSON.stringify(writes)).not.toMatch(/apiKey|headers|authorization/);
  });
  it('根拠照合・説明生成・点検を完了し、採点を待たずに返す', async () => {
    mocked.generateText.mockResolvedValue(
      candidateResponse(facts.facts, [nativePage], facts.documentType)
    );
    const request = await setup(true);
    const result = await request({ action: 'summarize' });
    expect(result.summary).toContain('1150百万円');
    expect(result.metadata.score).toBeUndefined();
    expect(result.metadata).toMatchObject({ summaryMode: 'sourced-summary', generationCalls: 3 });
    expect(mocked.generateText).toHaveBeenCalledTimes(1);
    expect(mocked.extractScoreInput).not.toHaveBeenCalled();
  });
  it.each(['settings', 'download', 'extraction'])(
    '同じPDFの次の実行が%sで失敗しても以前の診断を現在の結果として出力しない',
    async (stage) => {
      mocked.generateText.mockResolvedValue(
        candidateResponse(facts.facts, [nativePage], facts.documentType)
      );
      const request = await setup(false);
      let saved: SummaryTrace | undefined;
      vi.mocked(chrome.storage.local.set).mockImplementation(
        async (items: Record<string, unknown>) => {
          saved = structuredClone(items.summaryLastRunV1) as SummaryTrace;
        }
      );
      const success = await request({ action: 'summarize' });
      expect(saved?.runId).toBe(success.diagnosticRunId);
      expect(
        matchingSummaryTrace(saved, 'test.pdf', success.diagnosticRunId, success.resultId)
      ).toEqual(saved);
      expect(matchingSummaryTrace(saved, 'test.pdf', null, success.resultId)).toEqual(saved);
      if (stage === 'settings')
        chrome.storage.sync.get = vi.fn(async () => ({
          provider: 'invalid',
        })) as typeof chrome.storage.sync.get;
      if (stage === 'download')
        vi.mocked(fetch).mockRejectedValueOnce(new Error('download failed'));
      if (stage === 'extraction')
        vi.mocked(chrome.runtime.sendMessage).mockRejectedValueOnce(new Error('extraction failed'));
      const failure = await request({ action: 'summarize' });
      expect(failure.error).toBeTruthy();
      expect(failure.diagnosticRunId).not.toBe(success.diagnosticRunId);
      expect(matchingSummaryTrace(saved, 'test.pdf', failure.diagnosticRunId, null)).toEqual(saved);
      expect(saved).toMatchObject({
        outcome: 'failure',
        resultId: null,
        attempts: [],
        usage: [],
        documentHash: null,
        inputHash: null,
      });
      expect(saved?.error).toBe(failure.error);
      expect(saved?.provider).toBe(stage === 'settings' ? null : 'openai');
      expect(() =>
        matchingSummaryTrace(saved, 'test.pdf', success.diagnosticRunId, null)
      ).toThrow();
      // Local failures before sendMessage and another same-PDF result also refuse it.
      expect(() => matchingSummaryTrace(saved, 'test.pdf', null, null)).toThrow();
      expect(() => matchingSummaryTrace(saved, 'test.pdf', null, 'different-result')).toThrow();
      expect(() =>
        matchingSummaryTrace({ ...saved, runId: undefined }, 'test.pdf', null, success.resultId)
      ).toThrow();
      expect(mocked.generateText).toHaveBeenCalledTimes(1);
    }
  );

  it.each(['success', 'failure', 'earlyFailure', 'lateExtraction'] as const)(
    '古い完了%sは新しい要求の診断を上書きしない',
    async (stage) => {
      const request = await setup(false);
      let saved: SummaryTrace | undefined;
      vi.mocked(chrome.storage.local.set).mockImplementation(
        async (items: Record<string, unknown>) => {
          saved = structuredClone(items.summaryLastRunV1) as SummaryTrace;
        }
      );
      let release!: (value: string) => void;
      let entered!: () => void;
      const waiting = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const first = new Promise<string>((resolve) => {
        release = resolve;
      });
      const raw = candidateResponse(facts.facts, [nativePage], facts.documentType);
      mocked.generateText
        .mockImplementationOnce(() => {
          entered();
          return first;
        })
        .mockResolvedValue(raw);
      let releaseExtraction!: () => void;
      if (stage === 'lateExtraction') {
        const extract = chrome.runtime.sendMessage;
        vi.mocked(chrome.runtime.sendMessage).mockImplementationOnce(async (body) => {
          entered();
          await new Promise<void>((resolve) => {
            releaseExtraction = resolve;
          });
          return extract(body);
        });
        mocked.generateText.mockReset().mockResolvedValue(raw);
      }
      const older = request({ action: 'summarize' });
      await waiting;
      chrome.storage.sync.get = vi.fn(async () => ({
        provider: 'openai',
        model: 'changed',
        apiKey: 'test',
        extractionMode: 'full',
      })) as typeof chrome.storage.sync.get;
      if (stage === 'failure')
        mocked.generateText.mockRejectedValueOnce(new Error('newer API failed'));
      if (stage === 'earlyFailure')
        vi.mocked(fetch).mockRejectedValueOnce(new Error('newer PDF failed'));
      const newer = await request({ action: 'summarize' });
      expect(saved?.runId).toBe(newer.diagnosticRunId);
      const newerTrace = structuredClone(saved);
      if (stage === 'lateExtraction') releaseExtraction();
      else release(raw);
      expect((await older).error).toBeUndefined();
      expect(saved).toEqual(newerTrace);
      expect(
        matchingSummaryTrace(saved, 'test.pdf', newer.diagnosticRunId, newer.resultId ?? null)
      ).toEqual(saved);
    }
  );

  it('更新前から残る二段階要約設定を削除し、要約を続行する', async () => {
    mocked.generateText.mockResolvedValue(
      candidateResponse(facts.facts, [nativePage], facts.documentType)
    );
    const request = await setup(false, true, false, true);
    const result = await request({ action: 'summarize' });
    expect(result.summary).toContain('1150百万円');
    expect(chrome.storage.sync.remove).toHaveBeenCalledWith('twoPassMode');
  });

  it.each([
    'https://example.com/report.pdf',
    'http://[',
    'https://www.release.tdnet.info/inbs/list.html',
  ])('拒否URL %sは取得せず、同じ失敗要求の診断だけを出力する', async (pdfUrl) => {
    const request = await setup(false);
    const result = await request({ action: 'summarize', pdfUrl });
    expect(result.error).toBeTruthy();
    if (pdfUrl !== 'http://[') expect(result.error).toContain('TDnetのPDF URLではありません');
    expect(fetch).not.toHaveBeenCalled();
    expect(mocked.generateText).not.toHaveBeenCalled();
    const calls = vi.mocked(chrome.storage.local.set).mock.calls;
    const trace = (calls[calls.length - 1][0] as Record<string, SummaryTrace>).summaryLastRunV1;
    expect(trace).toMatchObject({
      runId: result.diagnosticRunId,
      pdfUrl,
      outcome: 'failure',
      resultId: null,
    });
    expect(matchingSummaryTrace(trace, pdfUrl, result.diagnosticRunId, null)).toEqual(trace);
    expect(() => matchingSummaryTrace(trace, pdfUrl, 'other-run', null)).toThrow();
    expect(() =>
      matchingSummaryTrace(trace, 'another.pdf', result.diagnosticRunId, null)
    ).toThrow();
    expect(() => matchingSummaryTrace(trace, pdfUrl, null, 'cached-result')).toThrow();
    expect(() =>
      matchingSummaryTrace(
        { ...trace, outcome: 'firstSuccess', resultId: 'cached-result' },
        pdfUrl,
        result.diagnosticRunId,
        'cached-result'
      )
    ).toThrow();
  });

  it('スコアOFFでも追加分析を明示操作で実行できる', async () => {
    mocked.generateText
      .mockResolvedValueOnce(candidateResponse(facts.facts, [nativePage], facts.documentType))
      .mockResolvedValueOnce(
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
      presentation: summary.presentation,
      resultId: summary.resultId,
      fingerprint: summary.metadata.analysisFingerprint,
    });
    expect(analysis.analysis.longTerm.text).toBe('判断不能');
    expect(mocked.extractScoreInput).not.toHaveBeenCalled();
  });

  it('スコアONの採点は別要求で事実を起点にする', async () => {
    mocked.generateText.mockResolvedValue(
      candidateResponse(facts.facts, [nativePage], facts.documentType)
    );
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
      presentation: summary.presentation,
      resultId: summary.resultId,
      fingerprint: summary.metadata.analysisFingerprint,
    });
    expect(score.score.value).toBe(70);
    expect(mocked.extractScoreInput.mock.calls[0][4]).toEqual(summary.facts);
  });

  it('smartで本文が選択外なら生成前に全文再要約を促す', async () => {
    const pages = [
      nativePage,
      {
        ...textPage('会社名 株式会社テスト\n取得は承認を条件とします。', 2),
        selection: 'omitted' as const,
      },
    ];
    const request = await setup(false, false, false, false, { pages, mode: 'smart' });
    const summary = await request({ action: 'summarize' });
    expect(summary.error).toContain('全文で再要約');
    expect(summary.retryExtractionMode).toBe('full');
    expect(mocked.generateText).not.toHaveBeenCalled();
  });

  it('過去資料の任意権限がない場合は別サイトを取得しない', async () => {
    mocked.generateText.mockResolvedValue(
      candidateResponse(facts.facts, [nativePage], facts.documentType)
    );
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
      presentation: summary.presentation,
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
    mocked.generateText.mockResolvedValue(
      candidateResponse(facts.facts, [nativePage], facts.documentType)
    );
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
      presentation: summary.presentation,
      resultId: summary.resultId,
      fingerprint: summary.metadata.analysisFingerprint,
    });
    expect(summary.summary).toContain('1150百万円');
    expect(score.error).toContain('HTTP 429');
    expect(mocked.inferExperimentalScore).not.toHaveBeenCalled();
  });

  it('検索後も比較値を検証できなければ採点結果を作らない', async () => {
    mocked.generateText.mockResolvedValue(
      candidateResponse(facts.facts, [nativePage], facts.documentType)
    );
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
      presentation: summary.presentation,
      resultId: summary.resultId,
      fingerprint: summary.metadata.analysisFingerprint,
    });
    expect(summary.summary).toContain('1150百万円');
    expect(score.error).toContain('比較値を原文で確認できません');
    expect(mocked.inferExperimentalScore).not.toHaveBeenCalled();
  });
});
