import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ANALYSIS_DIAGNOSTICS_KEY,
  ANALYSIS_DIAGNOSTICS_LIMITS,
  loadAnalysisTrace,
  requestAnalysisTrace,
  readLastAnalysisAttempt,
  saveAnalysisTrace,
  readAnalysisDiagnosticReference,
  type AnalysisTrace,
  isAnalysisModelInput,
} from './analysis-trace';
import { analysisModelInput } from './additional-analysis';
import { SUMMARY_DIAGNOSTICS_KEY } from './summary-trace';
import { buildSourceLedger, sourceLedgerModelInput } from './source-ledger';
import { textPage } from './fixtures/v4-test-source';

const pdfUrl = 'https://www.release.tdnet.info/inbs/test.pdf';
const size = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
const trace = (runId: string): AnalysisTrace => ({
  version: 1,
  stage: 'analysis',
  runId,
  summaryResultId: 'a'.repeat(64),
  startedAt: '2026-10-09T00:00:00Z',
  intentAt: 1,
  pdfUrl,
  provider: 'openai',
  model: 'fixture',
  buildDigest: 'build',
  fingerprint: 'fingerprint',
  inputHash: 'input-hash',
  input: {
    documentType: 'other',
    inputHash: 'input-hash',
    evidence: [
      {
        id: 'fact:f1',
        kind: 'fact',
        text: 'fixture',
        context: 'verified',
        sourceIds: ['f1'],
        pages: [1],
      },
    ],
    coverage: {
      facts: 1,
      explanations: 0,
      observations: 0,
      calculations: 0,
      pages: [1],
      organizationStatus: 'ready',
      unresolvedSources: 0,
      unverifiedFacts: 0,
      unverifiedItems: 0,
      unverifiedSourcePages: [],
      limitations: [],
    },
  },
  contract: {
    version: 3,
    allowedEvidenceIds: ['fact:f1'],
    limits: { issues: 4, references: 6, title: 80, text: 350 },
  },
  response: '{"version":3,"issues":[]}',
  usage: { inputTokens: 4, outputTokens: 3, elapsedMs: 10 },
  outcome: 'success',
  error: null,
  elapsedMs: 12,
});
let stored: Record<string, unknown>;
const traces = () => (stored[ANALYSIS_DIAGNOSTICS_KEY] as { traces: AnalysisTrace[] }).traces;
beforeEach(() => {
  stored = { [SUMMARY_DIAGNOSTICS_KEY]: { unchangedSummaryTrace: true } };
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({ [key]: structuredClone(stored[key]) })),
        set: vi.fn(async (items: Record<string, unknown>) => {
          Object.assign(stored, structuredClone(items));
        }),
      },
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('追加分析の実行別診断', () => {
  it('wire input validation ignores object key order but rejects changed identity and unknown fields', async () => {
    const t = trace('wire');
    const wire = analysisModelInput(t.input!);
    const reordered = Object.fromEntries(Object.entries(wire).reverse());
    expect(isAnalysisModelInput(reordered, t.inputHash)).toBe(true);
    expect(isAnalysisModelInput({ ...wire, inputHash: 'other' }, t.inputHash)).toBe(false);
    expect(isAnalysisModelInput({ ...wire, apiKey: 'not-source' }, t.inputHash)).toBe(false);
    t.modelInput = wire;
    t.input = null;
    await saveAnalysisTrace(t);
    expect(
      (await loadAnalysisTrace(pdfUrl, t.runId, t.summaryResultId, 'saved', t.inputHash!))
        .modelInput
    ).toEqual(wire);
  });

  it('keeps the full diagnostic when a large error would otherwise be duplicated into the latest-attempt pointer', async () => {
    const t = trace('long-error');
    t.input = null;
    t.outcome = 'failure';
    t.error = { code: 'api', path: '$', message: 'e'.repeat(600_000) };
    await saveAnalysisTrace(t);
    expect(traces()[0].error?.message).toHaveLength(600_000);
    const latest = readLastAnalysisAttempt(
      stored[ANALYSIS_DIAGNOSTICS_KEY],
      pdfUrl,
      t.summaryResultId,
      t.inputHash!
    );
    expect(latest?.error?.message).toContain('[診断の全文を参照]');
    expect(size(stored[ANALYSIS_DIAGNOSTICS_KEY])).toBeLessThan(ANALYSIS_DIAGNOSTICS_LIMITS.bytes);
  });

  it('原資料入力と抽出範囲を診断へ保持し、余分な秘密フィールドは保存しない', async () => {
    const t = trace('source-ledger');
    const ledger = buildSourceLedger([textPage('未知の利益段階 70百万円')]);
    const document = sourceLedgerModelInput(ledger);
    t.input!.sourceDocument = document;
    t.input!.coverage.sourceLedger = {
      sourceHash: ledger.sourceHash,
      pages: [1],
      failedPages: [],
      emptyPages: [],
      omittedPages: [],
      rows: ledger.rows.length,
      spans: ledger.pages[0].spans.length,
      status: 'extracted-source',
    };
    Object.assign(document, { apiKey: 'DO-NOT-STORE' });
    Object.assign(document.pages[0], { authorization: 'DO-NOT-STORE' });
    await saveAnalysisTrace(t);
    const restored = await loadAnalysisTrace(pdfUrl, t.runId, t.summaryResultId);
    expect(restored.input?.sourceDocument?.pages[0].rows[0][1]).toBe('未知の利益段階 70百万円');
    expect(restored.input?.coverage.sourceLedger).toEqual(t.input!.coverage.sourceLedger);
    expect(JSON.stringify(restored)).not.toContain('DO-NOT-STORE');
    expect(restored.compaction).toBeUndefined();
  });

  it('並行保存を直列化し、逆順完了や同じ要約の次の失敗でも元の成功と要約診断を保つ', async () => {
    const older = { ...trace('older'), outcome: 'running' as const };
    const newer = { ...trace('newer'), intentAt: 2 };
    await Promise.all([saveAnalysisTrace(older), saveAnalysisTrace(newer)]);
    older.outcome = 'running';
    await saveAnalysisTrace({
      ...older,
      outcome: 'failure',
      response: 'broken-json',
      error: { code: 'invalid-json', path: '$', message: '形式不正' },
    });
    expect(traces()).toHaveLength(2);
    expect(await loadAnalysisTrace(pdfUrl, newer.runId, newer.summaryResultId)).toEqual(newer);
    expect(await loadAnalysisTrace(pdfUrl, older.runId, older.summaryResultId)).toMatchObject({
      outcome: 'failure',
      response: 'broken-json',
    });
    await expect(loadAnalysisTrace(pdfUrl, newer.runId, 'different-summary')).rejects.toThrow(
      '対応する診断'
    );
    await expect(
      loadAnalysisTrace(pdfUrl, newer.runId, newer.summaryResultId, 'saved', 'different-input')
    ).rejects.toThrow('対応する診断');
    await expect(
      loadAnalysisTrace('other.pdf', newer.runId, newer.summaryResultId)
    ).rejects.toThrow('対応する診断');
    await expect(loadAnalysisTrace(pdfUrl, 'missing', newer.summaryResultId)).rejects.toThrow(
      '対応する診断'
    );
    expect(stored[SUMMARY_DIAGNOSTICS_KEY]).toEqual({ unchangedSummaryTrace: true });
  });

  it('v1の従来記録と部分成功を共存させ、最後の試行と診断を実行IDに結び付ける', async () => {
    const success = trace('legacy-success');
    await saveAnalysisTrace(success);
    const partial: AnalysisTrace = {
      ...trace('partial'),
      intentAt: 2,
      contract: { ...success.contract!, version: 4 },
      outcome: 'partialSuccess',
      response: '{"version":4,"issues":[{"evidenceIds":["fact:missing"]}]}',
    };
    await saveAnalysisTrace(partial);
    expect(
      await loadAnalysisTrace(
        pdfUrl,
        partial.runId,
        partial.summaryResultId,
        'saved',
        partial.inputHash!
      )
    ).toEqual(partial);
    expect(
      readLastAnalysisAttempt(
        stored[ANALYSIS_DIAGNOSTICS_KEY],
        pdfUrl,
        partial.summaryResultId,
        partial.inputHash!
      )
    ).toMatchObject({
      version: 1,
      runId: partial.runId,
      outcome: 'partialSuccess',
      error: null,
    });
    await expect(
      loadAnalysisTrace(pdfUrl, partial.runId, partial.summaryResultId, 'saved', 'wrong-input')
    ).rejects.toThrow('対応する診断');
    await saveAnalysisTrace({
      ...trace('later-failure'),
      intentAt: 3,
      outcome: 'failure',
      error: { code: 'invalid_json', path: '$', message: '形式不正' },
    });
    expect(await loadAnalysisTrace(pdfUrl, success.runId, success.summaryResultId)).toEqual(
      success
    );
    expect(await loadAnalysisTrace(pdfUrl, partial.runId, partial.summaryResultId)).toEqual(
      partial
    );
    expect(
      readLastAnalysisAttempt(
        stored[ANALYSIS_DIAGNOSTICS_KEY],
        pdfUrl,
        partial.summaryResultId,
        partial.inputHash!
      )
    ).toMatchObject({ runId: 'later-failure', outcome: 'failure' });
  });

  it('通知と実行制限を許可項目だけで保存し、後続の変更を混ぜない', async () => {
    const item: AnalysisTrace = {
      ...trace('notices'),
      outcome: 'partialSuccess',
      notices: [
        {
          issueIndex: 0,
          code: 'evidence_unknown',
          path: '$.issues[0].evidenceIds[0]',
          message: '参照不正',
          severity: 'quarantined',
        },
        {
          issueIndex: -1,
          code: 'output_limit',
          path: '$',
          message: '出力上限',
          severity: 'warning',
        },
      ],
    };
    item.contract!.resourceLimits = {
      responseBytes: 262144,
      savedBytes: 1048576,
      issues: 16,
      text: 4096,
      references: 32,
      depth: 32,
      nodes: 10000,
      savedNodes: 40000,
    };
    Object.assign(item.notices![0], { apiKey: 'secret' });
    Object.assign(item.contract!.resourceLimits, { headers: 'secret' });
    const pending = saveAnalysisTrace(item);
    item.notices![0].message = 'changed';
    await pending;
    const saved = await loadAnalysisTrace(pdfUrl, item.runId, item.summaryResultId);
    expect(saved.notices).toEqual([
      {
        issueIndex: 0,
        code: 'evidence_unknown',
        path: '$.issues[0].evidenceIds[0]',
        message: '参照不正',
        severity: 'quarantined',
      },
      { issueIndex: -1, code: 'output_limit', path: '$', message: '出力上限', severity: 'warning' },
    ]);
    expect(saved.contract!.resourceLimits).toMatchObject({ issues: 16, nodes: 10000 });
    expect(JSON.stringify(saved)).not.toMatch(/secret|apiKey|headers/);
  });

  it.each([
    { issueIndex: 16 },
    { issueIndex: -2 },
    { issueIndex: 0.5 },
    { code: '' },
    { path: 'x'.repeat(257) },
    { message: 'x'.repeat(1025) },
    { severity: 'success' },
    { config: 'secret' },
  ])('壊れた保存通知を受け入れない: %j', async (change) => {
    const item = {
      ...trace('bad-notice'),
      notices: [
        {
          issueIndex: 0,
          code: 'evidence_unknown',
          path: '$.issues[0]',
          message: '参照不正',
          severity: 'quarantined',
          ...change,
        },
      ],
    };
    stored[ANALYSIS_DIAGNOSTICS_KEY] = { version: 1, traces: [item], lastAttempts: [] };
    await expect(loadAnalysisTrace(pdfUrl, item.runId, item.summaryResultId)).rejects.toThrow(
      '形式が不正'
    );
  });

  it('通知の保存量を明示的に制限し、縮小後も読める通知と実行IDを保つ', async () => {
    const item: AnalysisTrace = {
      ...trace('many-notices'),
      outcome: 'partialSuccess',
      notices: Array.from({ length: 1024 }, () => ({
        issueIndex: 0,
        code: 'text_length',
        path: '$.issues[0].reading',
        message: '長'.repeat(1024),
        severity: 'warning' as const,
      })),
    };
    await saveAnalysisTrace(item);
    const saved = await loadAnalysisTrace(pdfUrl, item.runId, item.summaryResultId);
    expect(saved.compaction?.reason).toBe('storage-limit');
    expect(saved.notices).toHaveLength(128);
    expect(saved.notices![0]).toMatchObject({
      code: 'text_length',
      path: '$.issues[0].reading',
      severity: 'warning',
    });
    expect(size(saved)).toBeLessThanOrEqual(ANALYSIS_DIAGNOSTICS_LIMITS.recordBytes);
  });

  it.each(['count', 'bytes'] as const)(
    '上限%sで古い完了記録を除き、保存量を明示的に制限する',
    async (boundary) => {
      const count = boundary === 'count' ? 13 : 12;
      for (let i = 0; i < count; i++) {
        const item = { ...trace(String(i)), intentAt: i + 1 };
        if (boundary === 'bytes') item.response = 'あ'.repeat(40_000);
        await saveAnalysisTrace(item);
      }
      expect(traces().length).toBeLessThan(count);
      expect(size(stored[ANALYSIS_DIAGNOSTICS_KEY])).toBeLessThanOrEqual(
        ANALYSIS_DIAGNOSTICS_LIMITS.bytes
      );
      expect(traces().every((t) => size(t) <= ANALYSIS_DIAGNOSTICS_LIMITS.recordBytes)).toBe(true);
      await expect(loadAnalysisTrace(pdfUrl, '0', trace('0').summaryResultId)).rejects.toThrow(
        '保存上限'
      );
    }
  );

  it('巨大応答・入力を明示的に縮小し、識別子とエラー位置を保ち、設定を投影しない', async () => {
    const item = trace('large');
    item.response = '応答'.repeat(200_000);
    item.input!.evidence = Array.from({ length: 100 }, (_, i) => ({
      id: `fact:${i}`,
      kind: 'fact',
      text: '本文'.repeat(10_000),
      context: '文脈'.repeat(1_000),
      sourceIds: ['f1'],
      pages: [1],
    }));
    item.contract!.allowedEvidenceIds = item.input!.evidence.map((e) => e.id);
    item.error = {
      code: 'unknown-evidence-id',
      path: 'issues[0].evidenceIds[0]',
      message: '参照不正',
    };
    Object.assign(item, {
      apiKey: 'secret',
      config: { headers: 'secret' },
      endpoint: 'private-url',
    });
    Object.assign(item.input!, { secret: 'secret' });
    Object.assign(item.input!.coverage, { apiKey: 'secret' });
    Object.assign(item.input!.evidence[0], { apiKey: 'secret' });
    Object.assign(item.usage!, { headers: 'secret' });
    await saveAnalysisTrace(item);
    const saved = await loadAnalysisTrace(pdfUrl, item.runId, item.summaryResultId);
    expect(saved).toMatchObject({
      runId: item.runId,
      summaryResultId: item.summaryResultId,
      inputHash: item.inputHash,
      error: item.error,
      compaction: { reason: 'storage-limit' },
    });
    expect(saved.response).toContain('省略');
    expect(saved.contract!.allowedEvidenceIds).toEqual(item.contract!.allowedEvidenceIds);
    expect(saved.contract!.allowedEvidenceIds).toContain('fact:99');
    expect(size(saved)).toBeLessThanOrEqual(ANALYSIS_DIAGNOSTICS_LIMITS.recordBytes);
    expect(JSON.stringify(saved)).not.toMatch(/secret|private-url|apiKey|headers|endpoint/);
  });

  it('最終保存失敗を途中記録の成功に見せず、次の保存は回復する', async () => {
    const item = trace('interrupted');
    await saveAnalysisTrace({ ...item, outcome: 'running', response: null });
    vi.mocked(chrome.storage.local.set).mockRejectedValueOnce(new Error('quota'));
    await expect(saveAnalysisTrace(item)).rejects.toThrow('quota');
    await expect(
      loadAnalysisTrace(pdfUrl, item.runId, item.summaryResultId, 'failed')
    ).rejects.toThrow('未保存の最終診断');
    expect(
      await loadAnalysisTrace(pdfUrl, item.runId, item.summaryResultId, 'failed', item.inputHash!)
    ).toMatchObject({
      outcome: 'success',
      response: item.response,
      volatile: true,
      persistenceWarning: expect.stringContaining('未保存'),
    });
    expect(await loadAnalysisTrace(pdfUrl, item.runId, item.summaryResultId)).toMatchObject({
      outcome: 'running',
    });
    const next = trace('next');
    await saveAnalysisTrace(next);
    expect(await loadAnalysisTrace(pdfUrl, next.runId, next.summaryResultId)).toEqual(next);
  });

  // New boundaries: failed final save is exportable only in this worker and for
  // the exact requested identity; retention has the same count/byte limits as disk.
  it('未保存の最終記録は呼出時に固定し、別実行・結果・入力・PDFへ流用しない', async () => {
    const item = trace('volatile-identity');
    vi.mocked(chrome.storage.local.set).mockRejectedValue(new Error('quota'));
    const pending = saveAnalysisTrace(item);
    item.response = 'changed after save';
    await expect(pending).rejects.toThrow('quota');
    const load = (
      runId = item.runId,
      result = item.summaryResultId,
      input = item.inputHash!,
      pdf = pdfUrl
    ) => loadAnalysisTrace(pdf, runId, result, 'failed', input);
    const saved = await load();
    expect(saved.response).not.toBe(item.response);
    saved.input!.evidence[0].text = 'changed after export';
    expect((await load()).input!.evidence[0].text).toBe('fixture');
    for (const args of [
      ['other'],
      [item.runId, 'other'],
      [item.runId, item.summaryResultId, 'other'],
      [item.runId, item.summaryResultId, item.inputHash!, 'other.pdf'],
    ]) {
      await expect(load(...args)).rejects.toThrow('未保存の最終診断');
    }
    vi.resetModules();
    const restarted = await import('./analysis-trace');
    await expect(
      restarted.loadAnalysisTrace(
        pdfUrl,
        item.runId,
        item.summaryResultId,
        'failed',
        item.inputHash!
      )
    ).rejects.toThrow('再起動');
  });

  it.each(['count', 'bytes'] as const)(
    '未保存記録の%s上限では古い記録を復活させない',
    async (boundary) => {
      vi.mocked(chrome.storage.local.set).mockRejectedValue(new Error('quota'));
      const count = boundary === 'count' ? 13 : 12;
      const items = Array.from({ length: count }, (_, i) => ({
        ...trace(`volatile-${boundary}-${i}`),
        response: boundary === 'bytes' ? 'あ'.repeat(40_000) : '{}',
      }));
      for (const item of items) await expect(saveAnalysisTrace(item)).rejects.toThrow('quota');
      const load = (item: AnalysisTrace) =>
        loadAnalysisTrace(pdfUrl, item.runId, item.summaryResultId, 'failed', item.inputHash!);
      await expect(load(items[0])).rejects.toThrow('保持上限');
      expect(await load(items.at(-1)!)).toMatchObject({ volatile: true });
    }
  );

  it.each([
    { stage: 'write', code: 'quota', message: 'QUOTA_BYTES secret-api-key' },
    { stage: 'read', code: 'storage-error', message: 'read failed private-endpoint' },
  ] as const)(
    '未保存診断は生成結果と別に安全な保存理由を保持する: $stage/$code',
    async ({ stage, code, message }) => {
      const item = trace(`safe-storage-error-${stage}`);
      if (stage === 'write')
        vi.mocked(chrome.storage.local.set).mockRejectedValueOnce(new Error(message));
      else vi.mocked(chrome.storage.local.get).mockRejectedValueOnce(new Error(message));
      await expect(saveAnalysisTrace(item)).rejects.toThrow(message);
      const exported = await loadAnalysisTrace(
        pdfUrl,
        item.runId,
        item.summaryResultId,
        'failed',
        item.inputHash!
      );
      expect(exported).toMatchObject({
        outcome: 'success',
        error: null,
        persistenceFailure: { code, stage },
      });
      expect(JSON.stringify(exported)).not.toMatch(/secret-api-key|private-endpoint/);
    }
  );

  it('content側は未保存診断だけをworkerへ要求し、異なる応答や途中記録を拒否する', async () => {
    const item = {
      ...trace('bridge'),
      persistenceFailure: { code: 'quota' as const, stage: 'write' as const },
    };
    const sendMessage = vi.fn().mockResolvedValue({ trace: { ...item, volatile: true } });
    Object.assign(chrome, { runtime: { sendMessage } });
    const load = () =>
      requestAnalysisTrace(pdfUrl, item.runId, item.summaryResultId, 'failed', item.inputHash!);
    expect(await load()).toMatchObject({ runId: item.runId, volatile: true });
    expect(sendMessage).toHaveBeenCalledWith({
      action: 'getAnalysisDiagnostic',
      pdfUrl,
      runId: item.runId,
      summaryResultId: item.summaryResultId,
      inputHash: item.inputHash,
    });
    for (const change of [{ runId: 'other' }, { outcome: 'running' }, { volatile: undefined }]) {
      sendMessage.mockResolvedValueOnce({ trace: { ...item, volatile: true, ...change } });
      await expect(load()).rejects.toThrow('対応する診断');
    }
    sendMessage.mockResolvedValueOnce({ error: '再起動後は利用できません' });
    await expect(load()).rejects.toThrow('再起動後');
  });

  it('直近の試行は応答完了順でなく開始順に結び、別結果・別入力へ混ぜない', async () => {
    const older = { ...trace('older-intent'), intentAt: 1, outcome: 'running' as const };
    const newer = {
      ...trace('newer-intent'),
      intentAt: 2,
      outcome: 'failure' as const,
      error: { code: 'invalid_json', path: '$', message: '新しい試行の失敗' },
    };
    await saveAnalysisTrace(older);
    await saveAnalysisTrace(newer);
    await saveAnalysisTrace({ ...older, outcome: 'success' });
    const last = () =>
      readLastAnalysisAttempt(
        stored[ANALYSIS_DIAGNOSTICS_KEY],
        pdfUrl,
        newer.summaryResultId,
        newer.inputHash!
      );
    expect(last()).toMatchObject({ runId: newer.runId, outcome: 'failure' });
    const other = { ...trace('other-summary'), summaryResultId: 'b'.repeat(64), intentAt: 3 };
    await saveAnalysisTrace(other);
    expect(last()?.runId).toBe(newer.runId);
    expect(
      readLastAnalysisAttempt(
        stored[ANALYSIS_DIAGNOSTICS_KEY],
        pdfUrl,
        other.summaryResultId,
        other.inputHash!
      )?.runId
    ).toBe(other.runId);
    expect(
      readLastAnalysisAttempt(
        stored[ANALYSIS_DIAGNOSTICS_KEY],
        pdfUrl,
        newer.summaryResultId,
        'wrong-input'
      )
    ).toBeNull();
    expect(
      readLastAnalysisAttempt(
        stored[ANALYSIS_DIAGNOSTICS_KEY],
        'other.pdf',
        newer.summaryResultId,
        newer.inputHash!
      )
    ).toBeNull();
    const store = stored[ANALYSIS_DIAGNOSTICS_KEY] as { traces: AnalysisTrace[] };
    store.traces = store.traces.filter((item) => item.runId !== newer.runId);
    expect(last()?.runId).toBe(newer.runId);
    await expect(
      loadAnalysisTrace(pdfUrl, newer.runId, newer.summaryResultId, 'saved', newer.inputHash!)
    ).rejects.toThrow('保存上限');
  });

  it.each([
    { version: 2, traces: [], lastAttempts: [] },
    { version: 1, traces: [], lastAttempts: [{ version: 1, runId: 'partial' }] },
    { version: 1, traces: [], lastAttempts: [], config: { apiKey: 'secret' } },
  ])('診断履歴の未知版・壊れた参照・余分な設定を復元しない', (value) => {
    expect(() =>
      readLastAnalysisAttempt(value, pdfUrl, trace('x').summaryResultId, 'input-hash')
    ).toThrow('形式が不正');
  });

  it('成功キャッシュの診断参照を同じ結果・入力に限定する', () => {
    const ref = {
      runId: 'success',
      summaryResultId: 'summary',
      inputHash: 'input',
      persistence: 'saved',
    };
    expect(readAnalysisDiagnosticReference(ref, 'summary', 'input')).toEqual(ref);
    expect(readAnalysisDiagnosticReference(ref, 'other', 'input')).toBeNull();
    expect(readAnalysisDiagnosticReference(ref, 'summary', 'other')).toBeNull();
  });
});
