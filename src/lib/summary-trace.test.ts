import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  loadSummaryTrace,
  matchingSummaryTrace,
  saveSummaryTrace,
  SUMMARY_DIAGNOSTICS_KEY,
  SUMMARY_DIAGNOSTICS_LIMITS,
  SUMMARY_TRACE_KEY,
  type SummaryTrace,
} from './summary-trace';

const pdfUrl = 'https://www.release.tdnet.info/inbs/test.pdf';
function trace(runId: string): SummaryTrace {
  return {
    version: 1,
    runId,
    resultId: 'a'.repeat(64),
    startedAt: '2026-10-08T00:00:00.000Z',
    pdfUrl,
    documentType: 'other',
    provider: 'openai',
    model: 'fixture',
    extractionMode: 'full',
    fingerprint: 'fixture',
    buildDigest: 'build',
    documentHash: 'd'.repeat(64),
    inputHash: 'e'.repeat(64),
    selectedPages: [1],
    attempts: [{ phase: 'first', response: 'fixture response', error: null }],
    usage: [{ inputTokens: 12, outputTokens: 8, elapsedMs: 1 }],
    elapsedMs: 2,
    outcome: 'firstSuccess',
    error: null,
  };
}
let stored: Record<string, unknown>;
const traces = () => (stored[SUMMARY_DIAGNOSTICS_KEY] as { traces: SummaryTrace[] }).traces;
const size = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
beforeEach(() => {
  stored = {};
  vi.stubGlobal('chrome', {
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
        remove: vi.fn(async (key: string) => {
          delete stored[key];
        }),
      },
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('結果と実行を結ぶ上限付き診断', () => {
  it.each(['count', 'bytes'] as const)(
    '上限%sで古い実行から削除し、同一runの更新は増殖しない',
    async (boundary) => {
      const count =
        boundary === 'count'
          ? SUMMARY_DIAGNOSTICS_LIMITS.records + 1
          : SUMMARY_DIAGNOSTICS_LIMITS.records;
      for (let i = 0; i < count; i++) {
        const item = trace(String(i));
        if (boundary === 'bytes') item.attempts[0].response = 'あ'.repeat(60_000);
        await saveSummaryTrace(item);
      }
      expect(traces().length).toBe(boundary === 'count' ? 12 : 11);
      expect(size(stored[SUMMARY_DIAGNOSTICS_KEY])).toBeLessThanOrEqual(
        SUMMARY_DIAGNOSTICS_LIMITS.bytes
      );
      expect(traces().every((item) => size(item) <= SUMMARY_DIAGNOSTICS_LIMITS.recordBytes)).toBe(
        true
      );
      await expect(loadSummaryTrace(pdfUrl, '0', trace('0').resultId)).rejects.toThrow('保存上限');
      const last = traces().at(-1)!;
      const retainedCount = traces().length;
      await saveSummaryTrace({ ...last, elapsedMs: 10 });
      expect(traces()).toHaveLength(retainedCount);
      expect(await loadSummaryTrace(pdfUrl, last.runId, last.resultId)).toMatchObject({
        elapsedMs: 10,
      });
    }
  );

  it('巨大な1件は数量上限とは別に明示的に縮小し、識別情報と通常の診断を変えない', async () => {
    const ordinary = trace('ordinary');
    await saveSummaryTrace(ordinary);
    expect(await loadSummaryTrace(pdfUrl, ordinary.runId, ordinary.resultId)).toEqual(ordinary);
    const oversized = trace('oversized');
    oversized.attempts = Array.from({ length: 10 }, () => ({
      phase: 'first',
      response: '応答'.repeat(10_000),
      error: null,
      diagnostics: Array.from({ length: 10 }, () => ({
        candidateId: 'c',
        sourceKey: 's',
        check: 'fixture',
        status: 'invalid',
        message: '診断'.repeat(1000),
      })),
      confirmedIds: Array.from({ length: 1000 }, (_, i) => String(i)),
    }));
    await saveSummaryTrace(oversized);
    const saved = await loadSummaryTrace(pdfUrl, oversized.runId, oversized.resultId);
    expect(saved).toMatchObject({
      runId: oversized.runId,
      resultId: oversized.resultId,
      documentHash: oversized.documentHash,
      inputHash: oversized.inputHash,
      outcome: oversized.outcome,
      compaction: { reason: 'storage-limit' },
    });
    expect(saved.compaction!.originalBytes).toBeGreaterThan(SUMMARY_DIAGNOSTICS_LIMITS.recordBytes);
    expect(size(saved)).toBeLessThanOrEqual(SUMMARY_DIAGNOSTICS_LIMITS.recordBytes);
    expect(saved.attempts[0].response).toContain('[省略]');
    expect(traces()).toHaveLength(2);
  });

  it('キューで並列更新を結合し、上限整理を含む書込み失敗後も元履歴を残し次の保存を続ける', async () => {
    await Promise.all(Array.from({ length: 12 }, (_, i) => saveSummaryTrace(trace(String(i)))));
    expect(traces().map((item) => item.runId)).toEqual(
      Array.from({ length: 12 }, (_, i) => String(i))
    );
    const previous = structuredClone(stored);
    vi.mocked(chrome.storage.local.set).mockRejectedValueOnce(new Error('quota exceeded'));
    await expect(saveSummaryTrace(trace('failed'))).rejects.toThrow('quota exceeded');
    expect(stored).toEqual(previous);
    await expect(
      loadSummaryTrace(pdfUrl, 'failed', trace('failed').resultId, 'failed')
    ).rejects.toThrow('診断を保存できませんでした');
    await saveSummaryTrace(trace('recovered'));
    expect(traces().map((item) => item.runId)).toEqual([
      ...Array.from({ length: 11 }, (_, i) => String(i + 1)),
      'recovered',
    ]);
  });

  it('別PDF・結果・実行・不正形式を拒み、旧単一診断は一致する場合だけ利用する', async () => {
    const original = trace('legacy');
    stored[SUMMARY_TRACE_KEY] = original;
    expect(await loadSummaryTrace(pdfUrl, null, original.resultId)).toEqual(original);
    expect(await loadSummaryTrace(pdfUrl, original.runId, original.resultId)).toEqual(original);
    for (const [url, runId, resultId] of [
      [pdfUrl, 'other-run', original.resultId],
      [pdfUrl, original.runId, 'b'.repeat(64)],
      ['other.pdf', original.runId, original.resultId],
    ])
      await expect(loadSummaryTrace(url!, runId!, resultId!)).rejects.toThrow(
        '対応する診断がありません'
      );
    expect(() =>
      matchingSummaryTrace(
        { ...original, attempts: null },
        pdfUrl,
        original.runId,
        original.resultId
      )
    ).toThrow();
    await saveSummaryTrace({ ...trace('incomplete'), resultId: null, outcome: 'running' });
    await expect(loadSummaryTrace(pdfUrl, 'incomplete', null, 'failed')).rejects.toThrow(
      '保存できませんでした'
    );
    stored[SUMMARY_DIAGNOSTICS_KEY] = { version: 99, traces: [] };
    await expect(loadSummaryTrace(pdfUrl, original.runId, original.resultId)).rejects.toThrow(
      '形式が不正'
    );
  });

  it('旧単一診断を上限内に移行してから削除し、整理失敗は新結果を残して次の保存で回復する', async () => {
    const legacy = trace('legacy');
    legacy.attempts[0].response = '旧診断'.repeat(100_000);
    stored[SUMMARY_TRACE_KEY] = legacy;
    const failed = trace('write-failed');
    vi.mocked(chrome.storage.local.set).mockRejectedValueOnce(new Error('quota'));
    await expect(saveSummaryTrace(failed)).rejects.toThrow('quota');
    expect(stored[SUMMARY_TRACE_KEY]).toEqual(legacy);
    expect(chrome.storage.local.remove).not.toHaveBeenCalled();
    vi.mocked(chrome.storage.local.remove).mockRejectedValueOnce(new Error('cleanup failed'));
    const current = trace('current');
    expect(await saveSummaryTrace(current)).toEqual({
      cleanupWarning: '以前の診断を整理できませんでした。今回の診断は保存済みです',
    });
    expect(await loadSummaryTrace(pdfUrl, current.runId, current.resultId)).toEqual(current);
    expect(traces().find((item) => item.runId === 'legacy')?.compaction).toMatchObject({
      reason: 'storage-limit',
    });
    expect(stored[SUMMARY_TRACE_KEY]).toEqual(legacy);
    expect(await saveSummaryTrace(current)).toEqual({});
    expect(stored[SUMMARY_TRACE_KEY]).toBeUndefined();
    expect(traces()).toHaveLength(2);
    expect(size(stored[SUMMARY_DIAGNOSTICS_KEY])).toBeLessThanOrEqual(
      SUMMARY_DIAGNOSTICS_LIMITS.bytes
    );
  });

  it('完了済み履歴を先に削除し、全件実行中でも上限と今回の診断を守る', async () => {
    const running = (id: string): SummaryTrace => ({
      ...trace(id),
      outcome: 'running',
      resultId: null,
    });
    await saveSummaryTrace(running('active'));
    await saveSummaryTrace(trace('completed'));
    for (let i = 0; i < 11; i++) await saveSummaryTrace(running(`pending-${i}`));
    expect(traces().some((item) => item.runId === 'active')).toBe(true);
    expect(traces().some((item) => item.runId === 'completed')).toBe(false);
    await saveSummaryTrace(trace('new-success'));
    expect(traces()).toHaveLength(12);
    expect(traces().some((item) => item.runId === 'active')).toBe(false);
    expect(
      await loadSummaryTrace(pdfUrl, 'new-success', trace('new-success').resultId)
    ).toMatchObject({ runId: 'new-success' });
  });

  it('診断用の許可フィールドだけを保存し設定・APIキー・ヘッダーを取り込まない', async () => {
    const item = {
      ...trace('safe'),
      apiKey: 'secret-key',
      config: { baseUrl: 'secret-url' },
      headers: { Authorization: 'secret-auth' },
      attempts: [{ ...trace('safe').attempts[0], apiKey: 'attempt-secret' }],
      usage: [{ ...trace('safe').usage[0], headers: 'usage-secret' }],
    };
    await saveSummaryTrace(item);
    const saved = JSON.stringify(stored);
    expect(saved).not.toMatch(/apiKey|config|headers|Authorization|secret/);
    expect(await loadSummaryTrace(pdfUrl, item.runId, item.resultId)).toMatchObject({
      runId: 'safe',
    });
  });
});
