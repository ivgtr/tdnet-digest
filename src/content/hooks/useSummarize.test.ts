import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildAnalysisFingerprint, buildSummaryCacheKey } from '@/lib/analysis-version';
import { useSummarize } from './useSummarize';

const stateSetters = vi.hoisted(() => [] as Array<ReturnType<typeof vi.fn>>);

vi.mock('react', () => ({
  useState: (initial: unknown) => {
    const setter = vi.fn();
    stateSetters.push(setter);
    return [initial, setter];
  },
  useRef: (initial: unknown) => ({ current: initial }),
  useEffect: (effect: () => void) => effect(),
  useCallback: (callback: unknown) => callback,
}));

describe('要約モード別の表示とキャッシュ', () => {
  beforeEach(() => {
    stateSetters.length = 0;
    vi.unstubAllGlobals();
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
      facts: { version: 2, documentType: 'other', facts: [], unverified: [] },
      resultId: (mode === 'full' ? 'a' : 'b').repeat(64),
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
      expect.objectContaining({ summary: 'fullの要約' })
    );
    expect(saved).toHaveBeenCalledWith(
      expect.objectContaining({ [`summaryCacheV2:${keyFor('full')}`]: expect.any(Object) })
    );
    const displayedResults = stateSetters[1].mock.calls.length;
    onChanged.mock.calls[0][0]({ experimentalScoring: {} }, 'sync');
    expect(stateSetters[1].mock.calls).toHaveLength(displayedResults);

    await hook.summarize();
    expect(stateSetters[1]).toHaveBeenLastCalledWith(
      expect.objectContaining({ summary: 'smartの要約' })
    );
    expect(saved).toHaveBeenCalledWith(
      expect.objectContaining({ [`summaryCacheV2:${keyFor('smart')}`]: expect.any(Object) })
    );
  });
});
