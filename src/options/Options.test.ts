// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ANALYSIS_CACHE_DIAGNOSTIC_PREFIX, ANALYSIS_DIAGNOSTICS_KEY } from '@/lib/analysis-trace';
import { SUMMARY_DIAGNOSTICS_KEY } from '@/lib/summary-trace';
import Options from './Options';

let root: Root | undefined;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('追加分析キャッシュと診断参照の削除', () => {
  it.each(['削除', 'すべて削除'])(
    '%sで成功キャッシュの参照も消し、上限付き実行履歴は別に保つ',
    async (label) => {
      const stored: Record<string, unknown> = {
        'summaryCacheV2:fixture': {
          resultId: 'summary-result',
          facts: {},
          cachedAt: 0,
          title: 'fixture',
          companyName: 'テスト',
          code: '1234',
        },
        'analysisCacheV3:summary-result': { issues: [] },
        'analysisCacheV4:summary-result': { issues: [], candidates: [], notices: [] },
        [ANALYSIS_CACHE_DIAGNOSTIC_PREFIX + 'summary-result']: { runId: 'analysis-run' },
        [ANALYSIS_DIAGNOSTICS_KEY]: { version: 1, traces: [] },
        [SUMMARY_DIAGNOSTICS_KEY]: { version: 1, traces: [] },
      };
      vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
      vi.stubGlobal('chrome', {
        storage: {
          sync: { get: (_keys: string[], callback: (data: object) => void) => callback({}) },
          local: {
            get: (_keys: null, callback: (data: object) => void) => callback({ ...stored }),
            remove: (keys: string[], callback: () => void) => {
              for (const key of keys) delete stored[key];
              callback();
            },
          },
        },
      });
      const container = document.createElement('div');
      document.body.append(container);
      root = createRoot(container);
      await act(async () => root!.render(createElement(Options)));
      const button = Array.from(container.querySelectorAll('button')).find(
        (item) => item.textContent === label
      )!;
      await act(async () => button.click());
      expect(stored['summaryCacheV2:fixture']).toBeUndefined();
      expect(stored['analysisCacheV3:summary-result']).toBeUndefined();
      expect(stored['analysisCacheV4:summary-result']).toBeUndefined();
      expect(stored[ANALYSIS_CACHE_DIAGNOSTIC_PREFIX + 'summary-result']).toBeUndefined();
      expect(stored[ANALYSIS_DIAGNOSTICS_KEY]).toBeDefined();
      expect(stored[SUMMARY_DIAGNOSTICS_KEY]).toBeDefined();
    }
  );
});
