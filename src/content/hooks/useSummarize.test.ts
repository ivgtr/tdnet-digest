import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildAnalysisFingerprint, buildSummaryCacheKey } from '@/lib/analysis-version';
import { textPage, numberCandidate } from '@/lib/fixtures/v4-test-source';
import { parseFactSummary, renderFacts } from '@/lib/fact-summary';
import { useSummarize } from './useSummarize';
import { toValue } from '@/lib/score-extraction';
import { assessClaim, scoreVerdict, type ExperimentalScore, type ScoreClaim } from '@/lib/scoring';

const stateSetters = vi.hoisted(() => [] as Array<ReturnType<typeof vi.fn>>);
const stateOverrides = vi.hoisted(() => new Map<number, unknown>());
const refOverrides = vi.hoisted(() => new Map<number, unknown>());
const refIndex = vi.hoisted(() => ({ current: 0 }));

vi.mock('react', () => ({
  useState: (initial: unknown) => {
    const setter = vi.fn();
    const index = stateSetters.length;
    stateSetters.push(setter);
    return [stateOverrides.has(index) ? stateOverrides.get(index) : initial, setter];
  },
  useRef: (initial: unknown) => {
    const index = refIndex.current++;
    return { current: refOverrides.has(index) ? refOverrides.get(index) : initial };
  },
  useEffect: (effect: () => void) => effect(),
  useCallback: (callback: unknown) => callback,
}));

describe('要約モード別の表示とキャッシュ', () => {
  beforeEach(() => {
    stateSetters.length = 0;
    stateOverrides.clear();
    refOverrides.clear();
    refIndex.current = 0;
    vi.unstubAllGlobals();
  });

  it.each([38, 39, 40, 41, 42, 43, 44, 45, 46])('誤受理が残るv%sキャッシュを読み出して再表示しない', async (version) => {
    const pdfUrl = 'https://www.release.tdnet.info/inbs/example.pdf';
    const oldKey = `summaryCacheV2:v${version}:openai:gpt-4o:full:${pdfUrl}`;
    const currentKey = `summaryCacheV2:${buildSummaryCacheKey(pdfUrl, buildAnalysisFingerprint({ provider: 'openai', model: 'gpt-4o', extractionMode: 'full' }))}`;
    const get = vi.fn(async () => ({ [oldKey]: { summary: '売上高: 100百万円（予想）' } }));
    const sendMessage = vi.fn();
    vi.stubGlobal('chrome', {
      storage: {
        sync: {
          get: (_keys: string[], callback: (settings: unknown) => void) =>
            callback({ provider: 'openai', model: 'gpt-4o', extractionMode: 'full' }),
        },
        local: { get },
        onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
      },
      runtime: { sendMessage },
    });
    const hook = useSummarize({
      pdfUrl,
      title: '開示',
      code: '1234',
      companyName: '株式会社テスト',
    });
    await hook.showCached();
    expect(currentKey).not.toBe(oldKey);
    expect(get).toHaveBeenCalledWith(currentKey);
    expect(stateSetters[1].mock.calls.every(([value]) => value === null)).toBe(true);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('smart設定から全文で再要約した結果を表示し、通常の再要約にも戻れる', async () => {
    const pdfUrl = 'https://www.release.tdnet.info/inbs/example.pdf';
    const keyFor = (mode: 'smart' | 'full') =>
      buildSummaryCacheKey(
        pdfUrl,
        buildAnalysisFingerprint({ provider: 'openai', model: 'gpt-4o', extractionMode: mode })
      );
    const responseFor = (mode: 'smart' | 'full') => ({
      error: null,
      summary: `${mode}の要約`,
      facts: { version: 4, documentType: 'other', facts: [], unverified: [] },
      resultId: (mode === 'full' ? 'a' : 'b').repeat(64),
      diagnosticRunId: `${mode}-run`,
      metadata: {
        analysisFingerprint: buildAnalysisFingerprint({
          provider: 'openai',
          model: 'gpt-4o',
          extractionMode: mode,
        }),
      },
    });
    const saved = vi.fn(async () => {});
    const onChanged = vi.fn();
    const sendMessage = vi
      .fn()
      .mockResolvedValueOnce(responseFor('full'))
      .mockResolvedValueOnce(responseFor('smart'));
    vi.stubGlobal('chrome', {
      storage: {
        sync: {
          get: (_keys: string[], callback: (settings: unknown) => void) =>
            callback({ provider: 'openai', model: 'gpt-4o', extractionMode: 'smart' }),
        },
        local: { set: saved },
        onChanged: { addListener: onChanged, removeListener: vi.fn() },
      },
      runtime: { sendMessage },
    });

    const hook = useSummarize({ pdfUrl, title: '開示', code: '1234', companyName: '会社' });
    await hook.summarize('full');
    expect(stateSetters[1]).toHaveBeenLastCalledWith(
      expect.objectContaining({ summary: 'fullの要約', diagnosticRunId: 'full-run' })
    );
    expect(saved).toHaveBeenCalledWith(
      expect.objectContaining({ [`summaryCacheV2:${keyFor('full')}`]: expect.any(Object) })
    );
    const displayedResults = stateSetters[1].mock.calls.length;
    onChanged.mock.calls[0][0]({ experimentalScoring: {} }, 'sync');
    expect(stateSetters[1].mock.calls).toHaveLength(displayedResults);

    await hook.summarize();
    expect(stateSetters[1]).toHaveBeenLastCalledWith(
      expect.objectContaining({ summary: 'smartの要約', diagnosticRunId: 'smart-run' })
    );
    expect(saved).toHaveBeenCalledWith(
      expect.objectContaining({ [`summaryCacheV2:${keyFor('smart')}`]: expect.any(Object) })
    );
  });

  it.each(['background', 'transport', 'local'])(
    '%sの失敗を別実行の診断へ結び付けない',
    async (stage) => {
      const sendMessage = vi.fn();
      if (stage === 'background')
        sendMessage.mockResolvedValue({ error: 'PDF取得失敗', diagnosticRunId: 'failed-run' });
      if (stage === 'transport') sendMessage.mockRejectedValue(new Error('通信失敗'));
      const saved = vi.fn();
      vi.stubGlobal('chrome', {
        storage: {
          sync: {
            get: (_keys: string[], callback: (settings: unknown) => void) => {
              if (stage !== 'local')
                callback({ provider: 'openai', model: 'fixture', extractionMode: 'full' });
            },
          },
          local: { set: saved },
          onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
        },
        runtime: { sendMessage },
      });
      const hook = useSummarize({
        pdfUrl: 'test.pdf',
        title: '開示',
        code: '1234',
        companyName: '会社',
      });
      await hook.summarize();
      expect(stateSetters[1]).toHaveBeenLastCalledWith(
        expect.objectContaining({
          summary: null,
          resultId: null,
          diagnosticRunId: stage === 'background' ? 'failed-run' : null,
          error: expect.any(String),
        })
      );
      expect(sendMessage).toHaveBeenCalledTimes(stage === 'local' ? 0 : 1);
      expect(saved).not.toHaveBeenCalled();
    }
  );

  it('要約の応答待ちにモデルを変更しても操作可能へ戻り、古い応答を表示・保存しない', async () => {
    let model = 'before';
    let resolveResponse: (response: unknown) => void = () => {};
    const pending = new Promise((resolve) => {
      resolveResponse = resolve;
    });
    const changed = vi.fn();
    const saved = vi.fn();
    vi.stubGlobal('chrome', {
      storage: {
        sync: {
          get: (_keys: string[], callback: (settings: unknown) => void) =>
            callback({ provider: 'openai', model, extractionMode: 'full' }),
        },
        local: { set: saved },
        onChanged: { addListener: changed, removeListener: vi.fn() },
      },
      runtime: { sendMessage: vi.fn(() => pending) },
    });
    const hook = useSummarize({
      pdfUrl: 'test.pdf',
      title: '開示',
      code: '1234',
      companyName: '会社',
    });
    const run = hook.summarize();
    expect(stateSetters[0]).toHaveBeenLastCalledWith(true);
    model = 'after';
    changed.mock.calls[0][0]({ model: { newValue: model } }, 'sync');
    expect(stateSetters[0]).toHaveBeenLastCalledWith(false);
    resolveResponse({ error: '古い応答', diagnosticRunId: 'before-run' });
    await run;
    expect(stateSetters[1]).toHaveBeenLastCalledWith(null);
    expect(saved).not.toHaveBeenCalled();
  });

  it('算出不能の採点応答は要約を保ったままエラーにし、保存しない', async () => {
    const pdfUrl = 'https://www.release.tdnet.info/inbs/example.pdf';
    const id = 'a'.repeat(64);
    const fingerprint = buildAnalysisFingerprint({
      provider: 'openai',
      model: 'gpt-4o',
      extractionMode: 'full',
    });
    const facts = { version: 4, documentType: 'other', facts: [], unverified: [] };
    stateOverrides.set(1, {
      summary: '検証済み要約',
      error: null,
      metadata: { analysisFingerprint: fingerprint },
      facts,
      resultId: id,
    });
    stateOverrides.set(4, true);
    stateOverrides.set(6, true);
    refOverrides.set(1, buildSummaryCacheKey(pdfUrl, fingerprint));
    refOverrides.set(3, id);
    const saved = vi.fn(async () => {});
    vi.stubGlobal('chrome', {
      storage: {
        sync: {
          get: (_keys: string[], callback: (settings: unknown) => void) =>
            callback({ provider: 'openai', model: 'gpt-4o', extractionMode: 'full' }),
        },
        local: { set: saved },
        onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
      },
      runtime: {
        sendMessage: vi.fn(async () => ({
          score: { value: null, unverified: ['採点根拠を確認できません'] },
        })),
      },
    });

    const hook = useSummarize({ pdfUrl, title: '開示', code: '1234', companyName: '会社' });
    hook.startScore();
    await vi.waitFor(() =>
      expect(stateSetters[2]).toHaveBeenLastCalledWith({
        loading: false,
        data: null,
        error: '採点根拠を確認できません',
      })
    );
    expect(saved).not.toHaveBeenCalled();
    expect(stateSetters[1]).not.toHaveBeenCalledWith(null);
  });

  it('過去に保存された算出不能スコアを削除して再採点できる状態にする', async () => {
    const pdfUrl = 'https://www.release.tdnet.info/inbs/example.pdf';
    const id = 'a'.repeat(64);
    const fingerprint = buildAnalysisFingerprint({
      provider: 'openai',
      model: 'gpt-4o',
      extractionMode: 'full',
    });
    const source = textPage(
      '会社名 株式会社テスト | 会計基準 日本基準 | 範囲 連結\n2026年3月期 連結経営成績\n営業利益は100百万円です。'
    );
    const facts = parseFactSummary(
      JSON.stringify({
        version: 4,
        documentType: 'other',
        facts: [numberCandidate(source)],
        unverified: [],
      }),
      'other',
      [source]
    );
    const summaryKey = `summaryCacheV2:${buildSummaryCacheKey(pdfUrl, fingerprint)}`;
    const remove = vi.fn(async () => {});
    vi.stubGlobal('chrome', {
      storage: {
        sync: {
          get: (_keys: string[], callback: (settings: unknown) => void) =>
            callback({ provider: 'openai', model: 'gpt-4o', extractionMode: 'full' }),
        },
        local: {
          get: vi.fn(async (key: string | string[]) =>
            typeof key === 'string'
              ? {
                  [summaryKey]: {
                    summary: renderFacts(facts),
                    facts,
                    resultId: id,
                    metadata: {
                      analysisFingerprint: fingerprint,
                      analysisSchemaVersion: 4,
                      documentHash: 'c'.repeat(64),
                    },
                  },
                }
              : { [`scoreCacheV4:${id}`]: { value: null, unverified: ['過去の失敗'] } }
          ),
          remove,
        },
        onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
      },
    });

    const hook = useSummarize({ pdfUrl, title: '開示', code: '1234', companyName: '会社' });
    await hook.showCached();
    expect(remove).toHaveBeenCalledWith(`scoreCacheV4:${id}`);
    expect(stateSetters[2]).toHaveBeenLastCalledWith({ loading: false, data: null, error: null });
    expect(stateSetters[6]).toHaveBeenLastCalledWith(true);
  });

  it.each([
    {
      pdfUrl: 'example.pdf',
      storedUrl: 'https://www.release.tdnet.info/inbs/example.pdf',
      valid: true,
    },
    {
      pdfUrl: './example.pdf',
      storedUrl: 'https://www.release.tdnet.info/inbs/example.pdf',
      valid: true,
    },
    {
      pdfUrl: '/inbs/example.pdf',
      storedUrl: 'https://www.release.tdnet.info/inbs/example.pdf',
      valid: true,
    },
    {
      pdfUrl: 'example.pdf',
      storedUrl: 'https://www.release.tdnet.info/inbs/another.pdf',
      valid: false,
    },
  ])(
    'リンク $pdfUrl の採点を保存URL $storedUrl と照合して復元する',
    async ({ pdfUrl, storedUrl, valid }) => {
      const current = textPage(
        '会社名 株式会社テスト | 会計基準 日本基準 | 範囲 連結\n2026年3月期 連結経営成績\n営業利益は100百万円です。'
      );
      const previous = textPage(
        '会社名 株式会社テスト | 会計基準 日本基準 | 範囲 連結\n2025年3月期 連結経営成績\n営業利益は80百万円です。',
        2
      );
      const facts = parseFactSummary(
        JSON.stringify({
          version: 4,
          documentType: 'other',
          facts: [
            numberCandidate(current),
            { ...numberCandidate(previous, '営業利益', 80, '2025年3月期'), id: 'f2' },
          ],
          unverified: [],
        }),
        'other',
        [current, previous]
      );
      const document = {
        url: storedUrl,
        pages: [current, previous],
        text: current.text + '\n' + previous.text,
        issuer: '株式会社テスト',
        code: '1234',
        publishedDate: null,
      };
      const claim: ScoreClaim = {
        category: 'operatingProfit',
        label: '営業利益',
        current: toValue(facts.facts[0], document),
        previous: toValue(facts.facts[1], document),
        earlier: null,
        relatedValue: null,
        companyExplanation: null,
      };
      const score: ExperimentalScore = {
        value: 70,
        verdict: scoreVerdict(70),
        positives: [],
        negatives: [],
        unverified: [],
        searchStatus: '固定回帰',
        breakdown: [
          { ...claim, impact: 'positive', strength: 'small', comparison: assessClaim(claim)! },
        ],
      };
      const fingerprint = buildAnalysisFingerprint({
        provider: 'openai',
        model: 'gpt-4o',
        extractionMode: 'full',
      });
      const summaryKey = `summaryCacheV2:${buildSummaryCacheKey(pdfUrl, fingerprint)}`;
      const id = 'a'.repeat(64);
      const sendMessage = vi.fn();
      vi.stubGlobal('chrome', {
        storage: {
          sync: {
            get: (_keys: string[], callback: (settings: unknown) => void) =>
              callback({ provider: 'openai', model: 'gpt-4o', extractionMode: 'full' }),
          },
          local: {
            get: vi.fn(async (key: string | string[]) =>
              typeof key === 'string'
                ? {
                    [summaryKey]: {
                      summary: renderFacts(facts),
                      facts,
                      resultId: id,
                      metadata: {
                        analysisFingerprint: fingerprint,
                        analysisSchemaVersion: 4,
                        documentHash: 'c'.repeat(64),
                      },
                    },
                  }
                : { [`scoreCacheV4:${id}`]: score }
            ),
          },
          onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
        },
        runtime: { sendMessage },
      });
      const hook = useSummarize({
        pdfUrl,
        title: '開示',
        code: '1234',
        companyName: '株式会社テスト',
      });
      await hook.showCached();
      expect(stateSetters[1]).toHaveBeenLastCalledWith(
        expect.objectContaining({ summary: renderFacts(facts), error: null })
      );
      expect(stateSetters[2]).toHaveBeenLastCalledWith(
        valid
          ? { loading: false, data: score, error: null }
          : {
              loading: false,
              data: null,
              error: '保存された採点の形式・確定事実との対応が不正です',
            }
      );
      expect(sendMessage).not.toHaveBeenCalled();
    }
  );
});
