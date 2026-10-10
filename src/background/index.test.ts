import {
  loadAnalysisTrace,
  readLastAnalysisAttempt,
  ANALYSIS_DIAGNOSTICS_KEY,
} from '../lib/analysis-trace';
import type { SummaryTrace } from '../lib/summary-trace';
import {
  matchingSummaryTrace,
  loadSummaryTrace,
  SUMMARY_DIAGNOSTICS_KEY,
} from '../lib/summary-trace';
import type { LLMConfig } from '../lib/llm-client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { textPage, numberCandidate } from '../lib/fixtures/v4-test-source';
import { parseFactSummary } from '../lib/fact-summary';
import type { FactSummary } from '../lib/fact-summary';
import type { ExtractedPage, ExtractionMode } from '../types/summaryMetadata';
import { serializePagesForAnalysis } from '../lib/page-text';
import { buildPresentation as legacyPresentation } from '../lib/fixtures/summary-narrative-source';
import { summaryResultId } from '../lib/summary-result-id';
import { nativeFixtureRef } from '../lib/fixtures/native-disclosure-source';
import type { PdfExtractionErrorDetails } from '../lib/pdf-extraction-error';

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
  diagnosticInputHash?: string;
  trace?: import('../lib/analysis-trace').AnalysisDiagnosticExport;
  diagnosticPersistence?: 'saved' | 'failed';
  persistenceWarning?: string;
  summary: string;
  metadata: {
    analysisFingerprint: string;
    documentHash: string;
    score?: unknown;
    persistenceWarning?: string;
  };
  facts: FactSummary;
  presentation: import('../lib/summary-presentation').SummaryPresentation;
  resultId: string;
  analysis: import('../lib/additional-analysis').AdditionalAnalysis;
  score: { value: number };
}
vi.mock('@/lib/llm-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/llm-client')>()),
  generateText: mocked.generateText,
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

// Public source-first response: the original PDF row supports a generated
// summary, without fabricating verified facts or invoking the legacy pipeline.
const sourceEvidenceId = `raw:${nativePage.blocks[2].id}`;
const sourceSummaryResponse = JSON.stringify({
  version: 4,
  overallSummary: {
    text: '会社は2026年3月期の業績予想を公表しました。営業利益予想は1150百万円です。',
    evidenceIds: [sourceEvidenceId],
  },
  issues: [
    {
      title: '営業利益予想',
      conclusion: '営業利益予想は1150百万円です。',
      evidenceIds: [sourceEvidenceId],
      reading: '会社が通期の業績予想として公表しています。',
      caveat: '予想であり実績ではありません。',
      nextCheck: '',
    },
  ],
});

// The score API still accepts independently verified legacy results. Construct
// one explicitly; a new source-first summary must never extract facts to score.
async function legacyScorePayload(summary: TestResponse, withDate = false) {
  const pages = [withDate ? textPage(page + '\n2026年8月13日') : nativePage];
  const presentation = legacyPresentation(facts, pages);
  const fingerprint = summary.metadata.analysisFingerprint;
  return {
    facts,
    presentation,
    fingerprint,
    resultId: await summaryResultId(
      'test.pdf',
      fingerprint,
      facts,
      summary.metadata.documentHash,
      presentation
    ),
  };
}

let stored: Record<string, unknown>;
function latestTrace(items: Record<string, unknown>): SummaryTrace {
  return (items[SUMMARY_DIAGNOSTICS_KEY] as { traces: SummaryTrace[] }).traces.at(-1)!;
}
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
  stored = {};
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
      local: {
        get: vi.fn(async (keys: string | string[]) =>
          Object.fromEntries(
            [keys]
              .flat()
              .filter((key) => key in stored)
              .map((key) => [key, structuredClone(stored[key])])
          )
        ),
        set: vi.fn(async (items: Record<string, unknown>) => {
          Object.assign(stored, structuredClone(items));
        }),
      },
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

  it('不正JSONは元応答・使用量と終端診断を保存し、修復APIを呼ばない', async () => {
    const request = await setup(false);
    const writes: SummaryTrace[] = [];
    vi.mocked(chrome.storage.local.set).mockImplementation(
      async (items: Record<string, unknown>) => {
        Object.assign(stored, structuredClone(items));
        writes.push(structuredClone(latestTrace(items)));
      }
    );
    mocked.generateText.mockImplementationOnce(async (config: LLMConfig) => {
      expect(config.signal).toBeInstanceOf(AbortSignal);
      expect(writes.at(-1)).toMatchObject({ outcome: 'running', attempts: [] });
      config.onUsage?.({ inputTokens: 12, outputTokens: 8, elapsedMs: 2, finishReason: 'stop' });
      return '{malformed';
    });
    const result = await request({ action: 'summarize' });
    expect(result.error).toContain('invalid_json');
    expect(result.summary).toBeUndefined();
    expect(writes.at(-1)).toMatchObject({
      outcome: 'failure',
      resultId: null,
      error: result.error,
      attempts: [
        expect.objectContaining({
          phase: 'summary',
          response: '{malformed',
          error: expect.any(String),
        }),
      ],
      usage: [expect.objectContaining({ outputTokens: 8 })],
      sourceFirst: { contract: { version: 4, generation: { purpose: 'summary' } } },
    });
    expect(matchingSummaryTrace(writes.at(-1), 'test.pdf', result.diagnosticRunId, null)).toEqual(
      writes.at(-1)
    );
    expect(JSON.stringify(writes)).not.toMatch(/apiKey|headers|authorization/);
    expect(mocked.generateText).toHaveBeenCalledTimes(1);
  });
  it('原資料から全体要約と論点を一度に生成し、採点を待たずに返す', async () => {
    mocked.generateText.mockResolvedValue(sourceSummaryResponse);
    const request = await setup(true);
    const result = await request({ action: 'summarize' });
    expect(result.summary).toContain('1150百万円');
    expect(result.metadata.score).toBeUndefined();
    expect(result.facts.facts).toEqual([]);
    expect(result.presentation.sourceFirst!.summary).toMatchObject({
      overallSummary: { text: expect.stringContaining('会社は2026年3月期') },
      issues: [expect.objectContaining({ title: '営業利益予想' })],
    });
    expect(result.summary.indexOf('会社は2026年3月期')).toBeLessThan(
      result.summary.indexOf('### 営業利益予想')
    );
    expect(mocked.generateText.mock.calls[0][1][1].content).toContain('今回の要求は事実要約');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(1);
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'parseNativeDisclosure' })
    );
    expect(result.metadata).toMatchObject({ summaryMode: 'source-first', generationCalls: 1 });
    expect(mocked.generateText).toHaveBeenCalledTimes(1);
    expect(mocked.extractScoreInput).not.toHaveBeenCalled();
  });
  it('要約の不正な参照だけを隔離し、全体要約・有効論点と部分成功の診断を保存する', async () => {
    const raw = JSON.parse(sourceSummaryResponse);
    raw.issues.push({ ...raw.issues[0], title: '参照切れ', evidenceIds: ['raw:missing'] });
    mocked.generateText.mockResolvedValueOnce(JSON.stringify(raw));
    const request = await setup(false);
    const result = await request({ action: 'summarize' });
    expect(result.error).toBeUndefined();
    expect(result.presentation.sourceFirst!.summary).toMatchObject({
      overallSummary: { text: raw.overallSummary.text },
      issues: [expect.objectContaining({ title: '営業利益予想' })],
      candidates: expect.any(Array),
      notices: [
        expect.objectContaining({
          issueIndex: 1,
          code: 'evidence_unknown',
          severity: 'quarantined',
        }),
      ],
    });
    expect(result.presentation.sourceFirst!.summary!.candidates).toHaveLength(2);
    const trace = await loadSummaryTrace('test.pdf', result.diagnosticRunId, result.resultId);
    expect(trace).toMatchObject({
      outcome: 'partialSuccess',
      resultId: result.resultId,
      attempts: [expect.objectContaining({ phase: 'summary', response: JSON.stringify(raw) })],
      sourceFirst: {
        contract: { generation: { purpose: 'summary' } },
        notices: [expect.objectContaining({ issueIndex: 1, code: 'evidence_unknown' })],
      },
    });
    expect(mocked.generateText).toHaveBeenCalledTimes(1);
  });

  it.each(['download', 'parse'] as const)(
    '同じ開示行のZIPの%s失敗を表示し、PDF全文から一回だけ生成する',
    async (stage) => {
      const request = await setup(false);
      const ref = nativeFixtureRef();
      vi.mocked(fetch).mockResolvedValueOnce(new Response(new Uint8Array(4)));
      if (stage === 'download')
        vi.mocked(fetch).mockRejectedValueOnce(new Error('ZIP download failed'));
      else {
        vi.mocked(fetch).mockResolvedValueOnce(new Response(new Uint8Array([80, 75, 3, 4])));
        vi.mocked(chrome.runtime.sendMessage)
          .mockResolvedValueOnce({
            success: true,
            text: serializePagesForAnalysis([nativePage]),
            pages: [nativePage],
            metadata: {
              totalPages: 1,
              extractedPages: [1],
              extractionMode: 'full',
              documentType: 'earningsRevision',
            },
          })
          .mockResolvedValueOnce({ success: false, error: 'ZIP parse failed' });
      }
      mocked.generateText.mockResolvedValueOnce(sourceSummaryResponse);
      const result = await request({
        action: 'summarize',
        pdfUrl: ref.pdfUrl,
        nativeCompanion: ref,
      });
      expect(result.error).toBeUndefined();
      expect(result.summary).toContain('1150百万円');
      expect(result.summary).toContain('PDF全文へ切り替えました');
      expect(result.presentation.sourceFirst).toMatchObject({
        warnings: [expect.stringContaining(`ZIP ${stage} failed`)],
      });
      expect(result.presentation.sourceFirst!.native).toBeUndefined();
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(fetch).toHaveBeenLastCalledWith(
        ref.zipUrl,
        expect.objectContaining({ redirect: 'error' })
      );
      if (stage === 'parse')
        expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
          action: 'parseNativeDisclosure',
          archiveData: [80, 75, 3, 4],
          ref,
          pdfText: serializePagesForAnalysis([nativePage]),
        });
      else expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(1);
      expect(mocked.generateText).toHaveBeenCalledTimes(1);
      expect(mocked.generateText.mock.calls[0][1][1].content).toContain('営業利益は1150百万円です');
      expect(mocked.generateText.mock.calls[0][1][1].content).not.toContain('"nativeDocument":');
      expect(mocked.extractScoreInput).not.toHaveBeenCalled();
    }
  );

  it.each(['settings', 'download', 'extraction'])(
    '同じPDFの次の実行が%sで失敗しても以前の診断を現在の結果として出力しない',
    async (stage) => {
      mocked.generateText.mockResolvedValue(sourceSummaryResponse);
      const request = await setup(false);
      let saved: SummaryTrace | undefined;
      vi.mocked(chrome.storage.local.set).mockImplementation(
        async (items: Record<string, unknown>) => {
          Object.assign(stored, structuredClone(items));
          saved = structuredClone(latestTrace(items));
        }
      );
      const success = await request({ action: 'summarize' });
      expect(saved?.runId).toBe(success.diagnosticRunId);
      expect(
        matchingSummaryTrace(saved, 'test.pdf', success.diagnosticRunId, success.resultId)
      ).toEqual(saved);
      expect(matchingSummaryTrace(saved, 'test.pdf', null, success.resultId)).toEqual(saved);
      const successTrace = structuredClone(saved);
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
      expect(await loadSummaryTrace('test.pdf', success.diagnosticRunId, success.resultId)).toEqual(
        successTrace
      );
      expect(await loadSummaryTrace('test.pdf', failure.diagnosticRunId, null)).toEqual(saved);
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

  it('Offscreenの元例外を診断JSONへ保持し、失敗ページから生成しない', async () => {
    const request = await setup(false);
    const details: PdfExtractionErrorDetails = {
      pageNumber: 2,
      stage: 'page-layout',
      name: 'Error',
      code: 'SOURCE_DRAWING',
      message: 'SOURCE_DRAWING:表のセル解析の処理上限',
    };
    const response = JSON.parse(
      JSON.stringify({
        success: false,
        error: `PDF抽出エラー: PDF p.2: ${details.message}`,
        pdfExtractionError: details,
      })
    );
    vi.mocked(chrome.runtime.sendMessage).mockResolvedValueOnce(response);
    const result = await request({ action: 'summarize' });
    const writes = vi.mocked(chrome.storage.local.set).mock.calls;
    const lastWrite = writes[writes.length - 1][0] as Record<string, unknown>;
    const trace = JSON.parse(JSON.stringify(latestTrace(lastWrite)));
    expect(result.error).toBe(response.error);
    expect(trace).toMatchObject({
      runId: result.diagnosticRunId,
      outcome: 'failure',
      error: response.error,
      pdfExtractionError: details,
      attempts: [],
      usage: [],
      resultId: null,
    });
    expect(matchingSummaryTrace(trace, 'test.pdf', result.diagnosticRunId, null)).toEqual(trace);
    expect(mocked.generateText).not.toHaveBeenCalled();
  });

  it.each([undefined, { pageNumber: 0, stage: 'page-layout', message: 'invalid details' }])(
    '旧形式または不正な抽出エラー詳細%sでも元メッセージを失わず接頭辞を重複させない',
    async (details) => {
      const request = await setup(false);
      vi.mocked(chrome.runtime.sendMessage).mockResolvedValueOnce({
        success: false,
        error: 'PDF抽出エラー: PDF抽出エラー: SOURCE:PDF p.1の抽出失敗',
        pdfExtractionError: details,
      });
      const result = await request({ action: 'summarize' });
      expect(result.error).toBe('PDF抽出エラー: SOURCE:PDF p.1の抽出失敗');
      expect(mocked.generateText).not.toHaveBeenCalled();
    }
  );

  it.each(['success', 'failure', 'earlyFailure', 'lateExtraction'] as const)(
    '並列要求%sは逆順に完了しても両方の実行診断を残す',
    async (stage) => {
      const request = await setup(false);
      let saved: SummaryTrace | undefined;
      vi.mocked(chrome.storage.local.set).mockImplementation(
        async (items: Record<string, unknown>) => {
          Object.assign(stored, structuredClone(items));
          saved = structuredClone(latestTrace(items));
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
      const raw = sourceSummaryResponse;
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
      const olderResult = await older;
      expect(olderResult.error).toBeUndefined();
      expect(
        await loadSummaryTrace('test.pdf', newer.diagnosticRunId, newer.resultId ?? null)
      ).toEqual(newerTrace);
      expect(
        await loadSummaryTrace('test.pdf', olderResult.diagnosticRunId, olderResult.resultId)
      ).toMatchObject({
        runId: olderResult.diagnosticRunId,
        resultId: olderResult.resultId,
        outcome: 'firstSuccess',
      });
    }
  );

  it('A成功後にBを開始してもAの診断を保持し、同じresultIdの別runも分ける', async () => {
    const request = await setup(false);
    const raw = sourceSummaryResponse;
    mocked.generateText.mockResolvedValueOnce(raw);
    const a = await request({ action: 'summarize' });
    const traceA = await loadSummaryTrace('test.pdf', a.diagnosticRunId, a.resultId);
    let finish!: (value: string) => void;
    mocked.generateText.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        })
    );
    const pendingB = request({ action: 'summarize' });
    await vi.waitFor(() => expect(mocked.generateText).toHaveBeenCalledTimes(2));
    expect(await loadSummaryTrace('test.pdf', a.diagnosticRunId, a.resultId)).toEqual(traceA);
    finish(raw);
    const b = await pendingB;
    expect(b.resultId).toBe(a.resultId);
    expect(b.diagnosticRunId).not.toBe(a.diagnosticRunId);
    expect(await loadSummaryTrace('test.pdf', a.diagnosticRunId, a.resultId)).toEqual(traceA);
    expect(await loadSummaryTrace('test.pdf', b.diagnosticRunId, b.resultId)).toMatchObject({
      runId: b.diagnosticRunId,
      resultId: b.resultId,
      documentHash: traceA.documentHash,
    });
  });

  it.each(['read', 'write'] as const)(
    '診断保存の%s失敗は完成結果と生成元のエラーを覆わず、後続の保存も妨げない',
    async (stage) => {
      const request = await setup(false);
      mocked.generateText.mockResolvedValue(sourceSummaryResponse);
      const get = vi.mocked(chrome.storage.local.get).getMockImplementation()!;
      const set = vi.mocked(chrome.storage.local.set).getMockImplementation()!;
      if (stage === 'read')
        vi.mocked(chrome.storage.local.get).mockRejectedValue(new Error('storage read failed'));
      else
        vi.mocked(chrome.storage.local.set).mockRejectedValue(new Error('storage quota exceeded'));
      const success = await request({ action: 'summarize' });
      expect(success.error).toBeUndefined();
      expect(success.summary).toContain('1150百万円');
      expect(success.diagnosticPersistence).toBe('failed');
      expect(success.metadata.persistenceWarning).toContain('診断を保存できませんでした');
      mocked.generateText.mockRejectedValueOnce(new Error('generation failed'));
      const failure = await request({ action: 'summarize' });
      expect(failure.error).toContain('generation failed');
      expect(failure.diagnosticPersistence).toBe('failed');
      expect(failure.persistenceWarning).toContain('診断を保存できませんでした');
      vi.mocked(chrome.storage.local.get).mockImplementation(get);
      vi.mocked(chrome.storage.local.set).mockImplementation(set);
      const next = await request({ action: 'summarize' });
      expect(next.error).toBeUndefined();
      expect(next.diagnosticPersistence).toBe('saved');
      expect(next.metadata.persistenceWarning).toBeUndefined();
      expect(await loadSummaryTrace('test.pdf', next.diagnosticRunId, next.resultId)).toMatchObject(
        {
          runId: next.diagnosticRunId,
          outcome: 'firstSuccess',
        }
      );
    }
  );

  it.each([false, true])(
    '同時初回要求はOffscreen初期化を共有し、失敗=%sの後も再確認する',
    async (fails) => {
      const request = await setup(false);
      mocked.generateText.mockResolvedValue(sourceSummaryResponse);
      chrome.runtime.getContexts = vi.fn(async () => []);
      let finish!: () => void;
      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      vi.mocked(chrome.offscreen.createDocument)
        .mockImplementationOnce(async () => {
          entered();
          await new Promise<void>((resolve) => {
            finish = resolve;
          });
          if (fails) throw new Error('offscreen creation failed');
        })
        .mockResolvedValue(undefined);
      const first = request({ action: 'summarize', pdfUrl: 'first.pdf' });
      await started;
      const second = request({ action: 'summarize', pdfUrl: 'second.pdf' });
      // Both requests have downloaded before the shared initialization completes.
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
      expect(chrome.offscreen.createDocument).toHaveBeenCalledTimes(1);
      finish();
      const results = await Promise.all([first, second]);
      for (const result of results) {
        if (fails) expect(result.error).toBe('offscreen creation failed');
        else expect(result.summary).toContain('1150百万円');
      }
      expect(chrome.runtime.getContexts).toHaveBeenCalledTimes(1);
      const next = await request({ action: 'summarize' });
      expect(next.error).toBeUndefined();
      expect(chrome.runtime.getContexts).toHaveBeenCalledTimes(2);
      expect(chrome.offscreen.createDocument).toHaveBeenCalledTimes(2);
    }
  );

  it('更新前から残る二段階要約設定を削除し、要約を続行する', async () => {
    mocked.generateText.mockResolvedValue(sourceSummaryResponse);
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
    const trace = latestTrace(calls[calls.length - 1][0]);
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

  it('smart設定でも全文を読み、空の確定事実から追加分析へ進み、採点は通信前に停止する', async () => {
    const blank = { ...textPage('', 2), selection: 'omitted' as const };
    mocked.generateText
      .mockResolvedValueOnce(sourceSummaryResponse)
      .mockResolvedValueOnce(JSON.stringify({ version: 4, overallSummary: null, issues: [] }));
    const request = await setup(true, true, false, false, {
      pages: [nativePage, blank],
      mode: 'smart',
    });
    const summary = await request({ action: 'summarize' });
    expect(summary.error).toBeUndefined();
    expect(summary.facts.facts).toEqual([]);
    expect(summary.presentation.sourceFirst!.summary!.issues).toHaveLength(1);
    expect(summary.presentation.sourceLedger!.pages[1].selection).toBe('selected');
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ extractionMode: 'full' })
    );
    const payload = {
      facts: summary.facts,
      presentation: summary.presentation,
      resultId: summary.resultId,
      fingerprint: summary.metadata.analysisFingerprint,
    };
    const analysis = await request({ action: 'analyze', ...payload });
    expect(analysis.error).toBeUndefined();
    expect(analysis.analysis.issues).toEqual([]);
    expect(mocked.generateText).toHaveBeenCalledTimes(2);
    const fetches = vi.mocked(fetch).mock.calls.length;
    const extractionCalls = vi.mocked(chrome.runtime.sendMessage).mock.calls.length;
    const score = await request({ action: 'score', ...payload });
    expect(score.error).toContain('原資料要約では実験的スコアを利用できません');
    expect(fetch).toHaveBeenCalledTimes(fetches);
    expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(extractionCalls);
    expect(mocked.generateText).toHaveBeenCalledTimes(2);
    expect(mocked.extractScoreInput).not.toHaveBeenCalled();
    expect(mocked.inferExperimentalScore).not.toHaveBeenCalled();
    expect(mocked.searchDisclosureCandidates).not.toHaveBeenCalled();
  });

  it('スコアOFFでも追加分析を明示操作で実行できる', async () => {
    mocked.generateText.mockResolvedValueOnce(sourceSummaryResponse).mockResolvedValueOnce(
      JSON.stringify({
        version: 4,
        overallSummary: null,
        issues: [
          {
            title: '計画の実現条件',
            conclusion: '会社計画の実現性は前提条件と実績の確認が必要です',
            evidenceIds: [sourceEvidenceId],
            reading: '予想の水準だけから達成確度を決めることはできません',
            caveat: '今回の確認済み入力では予想に対応する実績は未確認です',
            nextCheck: '次の決算で同じ対象期間の実績と予想の前提を確認する',
          },
        ],
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
    expect(analysis.analysis.issues).toHaveLength(1);
    expect(analysis.diagnosticRunId).not.toBe(summary.diagnosticRunId);
    expect(analysis.diagnosticPersistence).toBe('saved');
    expect(
      vi.mocked(chrome.storage.local.set).mock.calls.filter(([items]) => {
        const store = (items as Record<string, unknown>)[ANALYSIS_DIAGNOSTICS_KEY] as
          | { traces?: { runId: string; outcome: string }[] }
          | undefined;
        return store?.traces?.some(
          (trace) => trace.runId === analysis.diagnosticRunId && trace.outcome === 'success'
        );
      })
    ).toHaveLength(1);
    expect(
      await loadAnalysisTrace('test.pdf', analysis.diagnosticRunId, summary.resultId)
    ).toMatchObject({
      stage: 'analysis',
      outcome: 'success',
      summaryResultId: summary.resultId,
      inputHash: analysis.analysis.inputHash,
      input: null,
      modelInput: {
        evidence: [],
        allowedEvidenceIds: expect.arrayContaining([sourceEvidenceId]),
        sourceDocument: { pages: expect.any(Array) },
      },
      response: expect.stringContaining('計画の実現条件'),
    });
    expect(
      await loadSummaryTrace('test.pdf', summary.diagnosticRunId, summary.resultId)
    ).toMatchObject({ outcome: 'firstSuccess' });
    const sent = mocked.generateText.mock.calls.at(-1)!;
    expect(sent[1][1].content).toContain(sourceEvidenceId);
    expect(sent[1][1].content).toContain('営業利益は1150百万円です');
    expect(sent[1][1].content).toContain('今回の要求は追加分析');
    expect(sent[0].maxOutputTokens).toBe(8192);
    expect(sent[0].signal).toBeInstanceOf(AbortSignal);
    expect(mocked.extractScoreInput).not.toHaveBeenCalled();
  });

  it('一部の論点を隔離しても有効な論点を返し、部分成功の診断を同じ実行に保存する', async () => {
    mocked.generateText.mockResolvedValueOnce(sourceSummaryResponse);
    const request = await setup(false);
    const summary = await request({ action: 'summarize' });
    const issue = {
      title: '計画の実現条件',
      conclusion: '条件確認が必要です',
      evidenceIds: [sourceEvidenceId],
      reading: '足元の実績と計画の整合を点検します',
      caveat: '継続性は未確認です',
      nextCheck: '実績と前提を確認する',
    };
    const raw = JSON.stringify({
      version: 4,
      overallSummary: null,
      issues: [issue, { ...issue, evidenceIds: ['raw:missing'] }],
    });
    mocked.generateText.mockResolvedValueOnce(raw);
    const result = await request({
      action: 'analyze',
      facts: summary.facts,
      presentation: summary.presentation,
      resultId: summary.resultId,
      fingerprint: summary.metadata.analysisFingerprint,
    });
    expect(result.error).toBeUndefined();
    expect(result.analysis.issues).toHaveLength(1);
    expect(result.analysis.candidates).toHaveLength(2);
    expect(result.analysis.notices).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          issueIndex: 1,
          code: 'evidence_unknown',
          severity: 'quarantined',
        }),
      ])
    );
    expect(result.diagnosticPersistence).toBe('saved');
    expect(
      await loadAnalysisTrace(
        'test.pdf',
        result.diagnosticRunId,
        summary.resultId,
        'saved',
        result.analysis.inputHash
      )
    ).toMatchObject({
      outcome: 'partialSuccess',
      error: null,
      notices: result.analysis.notices,
      response: raw,
      contract: { version: 4 },
    });
    expect(
      readLastAnalysisAttempt(
        stored[ANALYSIS_DIAGNOSTICS_KEY],
        'test.pdf',
        summary.resultId,
        result.analysis.inputHash
      )
    ).toMatchObject({
      runId: result.diagnosticRunId,
      outcome: 'partialSuccess',
    });
    expect(
      await loadSummaryTrace('test.pdf', summary.diagnosticRunId, summary.resultId)
    ).toMatchObject({ outcome: 'firstSuccess' });
    expect(mocked.generateText).toHaveBeenCalledTimes(2);
  });

  it.each([['malformed', '{broken', 'invalid_json', '$']])(
    '追加分析%sの生応答・使用量・拒否位置を残し、成功要約と前の分析を汚さない',
    async (_case, raw, code, path) => {
      mocked.generateText.mockResolvedValueOnce(sourceSummaryResponse);
      const request = await setup(false);
      const summary = await request({ action: 'summarize' });
      const followup = {
        action: 'analyze',
        facts: summary.facts,
        presentation: summary.presentation,
        resultId: summary.resultId,
        fingerprint: summary.metadata.analysisFingerprint,
      };
      mocked.generateText.mockResolvedValueOnce('{"version":4,"overallSummary":null,"issues":[]}');
      const success = await request(followup);
      const summaryTrace = structuredClone(stored[SUMMARY_DIAGNOSTICS_KEY]);
      mocked.generateText.mockImplementationOnce(async (config: LLMConfig) => {
        config.onUsage?.({ inputTokens: 12, outputTokens: 8, elapsedMs: 2, finishReason: 'stop' });
        return raw;
      });
      const failed = await request(followup);
      expect(failed.analysis).toBeUndefined();
      expect(failed.error).toContain(code);
      expect(failed.diagnosticRunId).not.toBe(success.diagnosticRunId);
      expect(
        await loadAnalysisTrace('test.pdf', failed.diagnosticRunId, summary.resultId)
      ).toMatchObject({
        outcome: 'failure',
        response: raw,
        error: { code, path },
        usage: { outputTokens: 8 },
        inputHash: success.analysis.inputHash,
      });
      expect(
        await loadAnalysisTrace('test.pdf', success.diagnosticRunId, summary.resultId)
      ).toMatchObject({ outcome: 'success' });
      expect(stored[SUMMARY_DIAGNOSTICS_KEY]).toEqual(summaryTrace);
      expect(mocked.generateText).toHaveBeenCalledTimes(3);
    }
  );

  it('同じ要約の追加分析が逆順に完了しても最新の操作と各実行の診断を分けて保持する', async () => {
    const request = await setup(false);
    mocked.generateText.mockResolvedValueOnce(sourceSummaryResponse);
    const summary = await request({ action: 'summarize' });
    const followup = {
      action: 'analyze',
      facts: summary.facts,
      presentation: summary.presentation,
      resultId: summary.resultId,
      fingerprint: summary.metadata.analysisFingerprint,
    };
    let finishOlder!: (response: string) => void;
    mocked.generateText.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          finishOlder = resolve;
        })
    );
    const olderRequest = request(followup);
    await vi.waitFor(() => expect(mocked.generateText).toHaveBeenCalledTimes(2));
    mocked.generateText.mockResolvedValueOnce(sourceSummaryResponse);
    const newer = await request(followup);
    finishOlder(sourceSummaryResponse);
    const older = await olderRequest;
    expect(newer.error).toBeUndefined();
    expect(older.error).toBeUndefined();
    expect(older.diagnosticRunId).not.toBe(newer.diagnosticRunId);
    expect(
      readLastAnalysisAttempt(
        stored[ANALYSIS_DIAGNOSTICS_KEY],
        'test.pdf',
        summary.resultId,
        newer.analysis.inputHash
      )
    ).toMatchObject({
      runId: newer.diagnosticRunId,
      outcome: 'success',
    });
    for (const result of [newer, older])
      expect(
        await loadAnalysisTrace('test.pdf', result.diagnosticRunId, summary.resultId)
      ).toMatchObject({
        runId: result.diagnosticRunId,
        outcome: 'success',
        inputHash: result.analysis.inputHash,
      });
    expect(mocked.generateText).toHaveBeenCalledTimes(3);
  });

  it('追加分析の制限時間中断では完了していない応答を成功にせず、課金再試行しない', async () => {
    mocked.generateText.mockResolvedValueOnce(sourceSummaryResponse);
    const request = await setup(false);
    const summary = await request({ action: 'summarize' });
    vi.useFakeTimers();
    try {
      mocked.generateText.mockImplementationOnce(
        (config: LLMConfig) =>
          new Promise((_resolve, reject) => {
            config.onResponse?.('{"version":4,"issues":[');
            config.onUsage?.({ inputTokens: 12, outputTokens: 8, elapsedMs: 60_000 });
            config.signal!.addEventListener('abort', () => reject(new Error('aborted')), {
              once: true,
            });
          })
      );
      const pending = request({
        action: 'analyze',
        facts: summary.facts,
        presentation: summary.presentation,
        resultId: summary.resultId,
        fingerprint: summary.metadata.analysisFingerprint,
      });
      await vi.waitFor(() => expect(mocked.generateText).toHaveBeenCalledTimes(2));
      await vi.advanceTimersByTimeAsync(60_001);
      const failed = await pending;
      expect(failed.error).toContain('interrupted');
      expect(
        await loadAnalysisTrace('test.pdf', failed.diagnosticRunId, summary.resultId)
      ).toMatchObject({
        outcome: 'failure',
        response: '{"version":4,"issues":[',
        error: { code: 'interrupted', path: '$' },
      });
      expect(mocked.generateText).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('追加分析診断の保存失敗を通知して有効結果を返し、次の明示要求で回復する', async () => {
    mocked.generateText.mockResolvedValueOnce(sourceSummaryResponse);
    const request = await setup(false);
    const summary = await request({ action: 'summarize' });
    const write = async (items: Record<string, unknown>) => {
      Object.assign(stored, structuredClone(items));
    };
    vi.mocked(chrome.storage.local.set).mockImplementation(
      async (items: Record<string, unknown>) => {
        if (ANALYSIS_DIAGNOSTICS_KEY in items) throw new Error('quota');
        return write(items);
      }
    );
    const followup = {
      action: 'analyze',
      facts: summary.facts,
      presentation: summary.presentation,
      resultId: summary.resultId,
      fingerprint: summary.metadata.analysisFingerprint,
    };
    mocked.generateText.mockResolvedValue('{"version":4,"overallSummary":null,"issues":[]}');
    const result = await request(followup);
    expect(result.analysis).toMatchObject({ issues: [] });
    expect(result.diagnosticPersistence).toBe('failed');
    expect(result.persistenceWarning).toContain('保存できません');
    expect(result.persistenceWarning).toContain('保存容量が不足');
    expect(mocked.generateText).toHaveBeenCalledTimes(2);
    const exported = await request({
      action: 'getAnalysisDiagnostic',
      runId: result.diagnosticRunId,
      summaryResultId: summary.resultId,
      inputHash: result.diagnosticInputHash,
    });
    expect(exported.trace).toMatchObject({
      runId: result.diagnosticRunId,
      outcome: 'success',
      volatile: true,
      persistenceWarning: expect.stringContaining('未保存'),
      persistenceFailure: { code: 'quota', stage: 'write' },
    });
    const wrong = await request({
      action: 'getAnalysisDiagnostic',
      runId: result.diagnosticRunId,
      summaryResultId: summary.resultId,
      inputHash: 'other',
    });
    expect(wrong.error).toContain('未保存の最終診断');
    expect(mocked.generateText).toHaveBeenCalledTimes(2);
    vi.mocked(chrome.storage.local.set).mockImplementation(write);
    const next = await request(followup);
    expect(next.diagnosticPersistence).toBe('saved');
    expect(next.diagnosticRunId).not.toBe(result.diagnosticRunId);
  });

  it('customUrlだけの変更で旧要約の追加分析・採点を通信前に拒否する', async () => {
    mocked.generateText.mockResolvedValue(sourceSummaryResponse);
    const request = await setup(true);
    const settings = {
      provider: 'custom',
      model: 'test',
      apiKey: 'private-api-key',
      customUrl: 'HTTPS://API.EXAMPLE.COM:443/v1/chat?deployment=a&token=private-token#ignored',
      extractionMode: 'full',
      experimentalScoring: true,
    };
    chrome.storage.sync.get = vi.fn(async () => settings) as typeof chrome.storage.sync.get;
    const summary = await request({ action: 'summarize' });
    expect(summary.error).toBeUndefined();
    expect(mocked.generateText.mock.calls[0][0].baseUrl).toBe(
      'https://api.example.com/v1/chat?deployment=a&token=private-token'
    );
    const persisted = JSON.stringify(vi.mocked(chrome.storage.local.set).mock.calls);
    expect(persisted).not.toContain('private-api-key');
    expect(persisted).not.toContain('private-token');
    expect(summary.metadata.analysisFingerprint).not.toContain('api.example.com');
    const fetches = vi.mocked(fetch).mock.calls.length;
    settings.customUrl = settings.customUrl.replace('deployment=a', 'deployment=b');
    for (const action of ['analyze', 'score']) {
      const stale = await request({
        action,
        facts: summary.facts,
        presentation: summary.presentation,
        resultId: summary.resultId,
        fingerprint: summary.metadata.analysisFingerprint,
      });
      expect(stale.error).toContain('設定が変更されています');
    }
    expect(fetch).toHaveBeenCalledTimes(fetches);
    expect(mocked.generateText).toHaveBeenCalledTimes(1);
    expect(mocked.extractScoreInput).not.toHaveBeenCalled();
  });

  it.each(['resultId', 'pdfBytes', 'sourceRows'] as const)(
    '追加分析の%s不一致では確定事実が空でも課金せず、元の要約を保持する',
    async (changed) => {
      const request = await setup(false);
      mocked.generateText.mockResolvedValueOnce(sourceSummaryResponse);
      const summary = await request({ action: 'summarize' });
      const original = structuredClone(summary);
      const followup = {
        action: 'analyze',
        facts: summary.facts,
        presentation: summary.presentation,
        resultId: summary.resultId,
        fingerprint: summary.metadata.analysisFingerprint,
      };
      if (changed === 'resultId') followup.resultId = 'another-result';
      if (changed === 'pdfBytes')
        vi.mocked(fetch).mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3, 4])));
      if (changed === 'sourceRows') {
        const changedPage = textPage(page.replace('1150', '9999'));
        vi.mocked(chrome.runtime.sendMessage).mockResolvedValueOnce({
          success: true,
          text: serializePagesForAnalysis([changedPage]),
          pages: [changedPage],
          metadata: {
            totalPages: 1,
            extractedPages: [1],
            extractionMode: 'full',
            documentType: 'earningsRevision',
          },
        });
      }
      const failed = await request(followup);
      expect(failed.error).toBeTruthy();
      expect(failed.analysis).toBeUndefined();
      expect(mocked.generateText).toHaveBeenCalledTimes(1);
      expect(summary).toEqual(original);
      expect(
        await loadSummaryTrace('test.pdf', summary.diagnosticRunId, summary.resultId)
      ).toMatchObject({ outcome: 'firstSuccess' });
      expect(
        await loadAnalysisTrace('test.pdf', failed.diagnosticRunId, followup.resultId)
      ).toMatchObject({
        outcome: 'failure',
        error: { code: 'analysis-preflight-failed' },
        response: null,
      });
    }
  );

  it('保存済みの旧形式の採点は別要求で確認済み事実を起点にする', async () => {
    mocked.generateText.mockResolvedValue(sourceSummaryResponse);
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
      ...(await legacyScorePayload(summary)),
    });
    expect(score.score.value).toBe(70);
    expect(mocked.extractScoreInput.mock.calls[0][4]).toEqual(facts);
  });

  it('smartで以前は選択外だった本文も同じ一回の要約入力に残す', async () => {
    const pages = [
      nativePage,
      {
        ...textPage('会社名 株式会社テスト\n取得は承認を条件とします。', 2),
        selection: 'omitted' as const,
      },
    ];
    mocked.generateText.mockResolvedValueOnce(sourceSummaryResponse);
    const request = await setup(false, false, false, false, { pages, mode: 'smart' });
    const summary = await request({ action: 'summarize' });
    expect(summary.error).toBeUndefined();
    expect(summary.presentation.sourceLedger!.pages.map((page) => page.selection)).toEqual([
      'selected',
      'selected',
    ]);
    expect(mocked.generateText.mock.calls[0][1][1].content).toContain('取得は承認を条件とします。');
    expect(mocked.generateText).toHaveBeenCalledTimes(1);
  });

  it('過去資料の任意権限がない場合は別サイトを取得しない', async () => {
    mocked.generateText.mockResolvedValue(sourceSummaryResponse);
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
      ...(await legacyScorePayload(summary, true)),
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
    mocked.generateText.mockResolvedValue(sourceSummaryResponse);
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
      ...(await legacyScorePayload(summary, true)),
    });
    expect(summary.summary).toContain('1150百万円');
    expect(score.error).toContain('HTTP 429');
    expect(mocked.inferExperimentalScore).not.toHaveBeenCalled();
  });

  it('検索後も比較値を検証できなければ採点結果を作らない', async () => {
    mocked.generateText.mockResolvedValue(sourceSummaryResponse);
    mocked.extractScoreInput.mockResolvedValue({
      claims: [],
      unverified: ['引用を確認できません'],
      searchStatus: '',
    });
    const request = await setup(true, true, true);
    const summary = await request({ action: 'summarize' });
    const score = await request({
      action: 'score',
      ...(await legacyScorePayload(summary, true)),
    });
    expect(summary.summary).toContain('1150百万円');
    expect(score.error).toContain('比較値を原文で確認できません');
    expect(mocked.inferExperimentalScore).not.toHaveBeenCalled();
  });
});
