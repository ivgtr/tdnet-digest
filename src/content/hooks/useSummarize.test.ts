// @vitest-environment jsdom
/// <reference types="node" />
import { webcrypto } from 'node:crypto';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ANALYSIS_SCHEMA_VERSION,
  buildAnalysisFingerprint,
  buildSummaryCacheKey,
} from '@/lib/analysis-version';
import { textPage, numberCandidate } from '@/lib/fixtures/v4-test-source';
import { parseFactSummary, renderFacts } from '@/lib/fact-summary';
import { buildPresentation } from '@/lib/fixtures/summary-narrative-source';
import { summaryResultId } from '@/lib/summary-result-id';
import { toValue } from '@/lib/score-extraction';
import type { ExperimentalScore } from '@/lib/scoring';
import { parseAnalysisResponse } from '@/lib/additional-analysis';
import { buildAnalysisInput } from '@/lib/analysis-input';
import { SUMMARY_TRACE_KEY, type SummaryTrace } from '@/lib/summary-trace';
import SummaryButton from '../SummaryButton';
import { useSummarize } from './useSummarize';
import { startContentScript } from '../contentLifecycle';

const pdfUrl = 'https://www.release.tdnet.info/inbs/example.pdf';
const options = { pdfUrl, title: '開示', code: '1234', companyName: '株式会社テスト' };
const pages = [
  textPage(
    '会社名 株式会社テスト | 会計基準 日本基準 | 範囲 連結\n2026年3月期 連結経営成績\n営業利益は100百万円です。'
  ),
  textPage(
    '会社名 株式会社テスト | 会計基準 日本基準 | 範囲 連結\n2025年3月期 連結経営成績\n営業利益は80百万円です。',
    2
  ),
];
const facts = parseFactSummary(
  JSON.stringify({
    version: 6,
    documentType: 'other',
    facts: [
      numberCandidate(pages[0]),
      { ...numberCandidate(pages[1], '営業利益', 80, '2025年3月期'), id: 'f2' },
    ],
    unverified: [],
  }),
  'other',
  pages
);
const presentation = buildPresentation(facts, pages);
const documentHash = 'c'.repeat(64);
const keyFor = async (mode: 'smart' | 'full', url = pdfUrl) =>
  'summaryCacheV2:' +
  buildSummaryCacheKey(
    url,
    await buildAnalysisFingerprint({ provider: 'openai', model: 'fixture', extractionMode: mode })
  );
async function responseFor(
  mode: 'smart' | 'full' = 'full',
  endpoint: { provider: string; customUrl: string } | undefined = undefined
) {
  const analysisFingerprint = await buildAnalysisFingerprint({
    provider: 'openai',
    model: 'fixture',
    extractionMode: mode,
    ...endpoint,
    baseUrl: endpoint?.customUrl,
  });
  return {
    error: null,
    facts,
    presentation,
    summary: renderFacts(facts, presentation),
    resultId: await summaryResultId(pdfUrl, analysisFingerprint, facts, documentHash, presentation),
    diagnosticRunId: `${mode}-run`,
    metadata: { analysisFingerprint, analysisSchemaVersion: 6, documentHash },
  };
}

let root: Root;
let stopContentScript: (() => void) | undefined;
let container: HTMLDivElement;
let settings: Record<string, unknown>;
let stored: Record<string, unknown>;
const sendMessage = vi.fn();
const save = vi.fn();
const remove = vi.fn();
const listeners = new Set<(changes: Record<string, unknown>, area: string) => void>();
const messages = new Set<(request: { action: string; enabled: boolean }) => void>();

// Only the Chrome transport/storage boundary is replaced. React owns state, effects and rerenders.
async function mount(url = pdfUrl) {
  let current: ReturnType<typeof useSummarize>;
  function Probe() {
    current = useSummarize({ ...options, pdfUrl: url });
    return null;
  }
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(createElement(Probe)));
  if (!vi.isMockFunction(chrome.storage.sync.get))
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(current.cacheKey).not.toBeNull();
    });
  return () => current;
}
async function mountButton() {
  container = document.createElement('div');
  document.body.append(container);
  const table = document.createElement('table');
  container.append(table);
  const row = table.insertRow();
  row.innerHTML = `<td>15:00</td><td>1234</td><td>株式会社テスト</td><td><a href="${pdfUrl}">開示</a></td>`;
  const cell = row.insertCell();
  root = createRoot(cell);
  await act(async () =>
    root.render(
      createElement(SummaryButton, {
        rowData: { ...options, time: '15:00' },
        row,
        iframeDoc: document,
      })
    )
  );
  await vi.waitFor(async () => {
    await act(async () => {});
    expect(chrome.storage.local.get).toHaveBeenCalled();
  });
  return { row, cell, button: cell.querySelector('button')! };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
async function click(button: HTMLElement) {
  await act(async () => button.click());
}
async function summaryRowFor(row: HTMLTableRowElement) {
  await vi.waitFor(async () => {
    await act(async () => {});
    expect(row.nextElementSibling?.className).toBe('tdnet-digest-summary-row');
  });
  return row.nextElementSibling as HTMLTableRowElement;
}
const additionalAnalysis = parseAnalysisResponse(
  JSON.stringify({
    version: 3,
    issues: [
      {
        title: '増益の継続条件',
        conclusion: '増益だけで持続的な成長とは判断できません',
        evidenceIds: facts.facts.map((fact) => `fact:${fact.id}`),
        reading: '前年との差を確認し、増益要因の継続性を点検する必要があります',
        caveat: '今回の確認済み入力では事業別の増減要因は未確認です',
        nextCheck: '次の開示で本業の増益要因と一時要因の内訳を確認する',
      },
    ],
  }),
  buildAnalysisInput(facts, presentation)
);

async function traceFor(runId: string, resultId: string | null): Promise<SummaryTrace> {
  return {
    version: 1,
    runId,
    resultId,
    pdfUrl,
    startedAt: '2026-10-06T00:00:00.000Z',
    documentType: 'other',
    provider: 'openai',
    model: 'fixture',
    extractionMode: 'full',
    fingerprint: await buildAnalysisFingerprint({
      provider: 'openai',
      model: 'fixture',
      extractionMode: 'full',
    }),
    buildDigest: 'fixture',
    documentHash,
    inputHash: null,
    selectedPages: [1, 2],
    attempts: [],
    usage: [],
    elapsedMs: 1,
    outcome: resultId ? 'firstSuccess' : 'failure',
    error: resultId ? null : '一部抽出で要約できませんでした',
  };
}
async function changeSettings(update: Record<string, unknown>) {
  Object.assign(settings, update);
  const changes = Object.fromEntries(
    Object.entries(update).map(([key, newValue]) => [key, { newValue }])
  );
  await act(async () => listeners.forEach((listener) => listener(changes, 'sync')));
}

beforeEach(() => {
  settings = {
    provider: 'openai',
    model: 'fixture',
    extractionMode: 'full',
    experimentalScoring: true,
  };
  stored = {};
  listeners.clear();
  messages.clear();
  sendMessage.mockReset();
  save
    .mockReset()
    .mockImplementation(async (entries) =>
      Object.assign(stored, JSON.parse(JSON.stringify(entries)))
    );
  remove.mockReset().mockImplementation(async (key: string) => {
    delete stored[key];
  });
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('chrome', {
    storage: {
      sync: {
        get: (keys: string[], callback: (value: unknown) => void) =>
          callback(
            Object.fromEntries(
              keys.filter((key) => key in settings).map((key) => [key, settings[key]])
            )
          ),
      },
      local: {
        get: vi.fn(async (keys: string | string[], callback?: (data: unknown) => void) => {
          const data = Object.fromEntries(
            [keys]
              .flat()
              .filter((key) => key in stored)
              .map((key) => [key, structuredClone(stored[key])])
          );
          callback?.(data);
          return data;
        }),
        set: save,
        remove,
      },
      onChanged: {
        addListener: (listener: (changes: Record<string, unknown>, area: string) => void) =>
          listeners.add(listener),
        removeListener: (listener: (changes: Record<string, unknown>, area: string) => void) =>
          listeners.delete(listener),
      },
    },
    runtime: {
      sendMessage,
      onMessage: {
        addListener: (listener: (request: { action: string; enabled: boolean }) => void) =>
          messages.add(listener),
        removeListener: (listener: (request: { action: string; enabled: boolean }) => void) =>
          messages.delete(listener),
      },
    },
  });
});
afterEach(async () => {
  await act(async () => root?.unmount());
  await act(async () => stopContentScript?.());
  stopContentScript = undefined;
  container?.remove();
  expect(listeners.size).toBe(0);
  expect(messages.size).toBe(0);
  vi.unstubAllGlobals();
});

describe('実Reactでの要約・保存・後続処理の境界', () => {
  it.each([1, ANALYSIS_SCHEMA_VERSION - 1])(
    '旧v%sキャッシュを読み出して再表示しない',
    async (version) => {
      stored[`summaryCacheV2:v${version}:openai:fixture:full:${pdfUrl}`] = { summary: '旧要約' };
      const hook = await mount();
      await act(async () => hook().showCached());
      expect(hook().hasCached).toBe(false);
      expect(hook().result).toBeNull();
      expect(sendMessage).not.toHaveBeenCalled();
    }
  );

  it('同じ保存結果を開き直しても閉じる前の遅い分析が新しい分析を上書きしない', async () => {
    const response = await responseFor();
    const first = deferred<unknown>(),
      second = deferred<unknown>();
    sendMessage
      .mockResolvedValueOnce(response)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const hook = await mount();
    await act(async () => hook().summarize());
    await act(async () => hook().analyze());
    await act(async () => hook().reset());
    await act(async () => hook().showCached());
    await act(async () => hook().analyze());
    const old = structuredClone(additionalAnalysis),
      fresh = structuredClone(additionalAnalysis);
    old.issues[0].title = '閉じる前の論点';
    fresh.issues[0].title = '開き直した後の論点';
    await act(async () => second.resolve({ analysis: fresh }));
    await act(async () => first.resolve({ analysis: old }));
    expect(hook().analysis.data).toEqual(fresh);
    expect(stored[`analysisCacheV3:${response.resultId}`]).toEqual(fresh);
  });

  it('遅い保存読込が開始済みの追加分析を解除・置換しない', async () => {
    const response = await responseFor();
    const read = deferred<Record<string, unknown>>(),
      analysis = deferred<unknown>();
    sendMessage.mockResolvedValueOnce(response).mockReturnValueOnce(analysis.promise);
    const hook = await mount();
    await act(async () => hook().summarize());
    await act(async () => hook().reset());
    const originalGet = chrome.storage.local.get;
    chrome.storage.local.get = ((keys: string | string[], callback?: (data: unknown) => void) =>
      Array.isArray(keys)
        ? read.promise
        : originalGet(keys, callback!)) as typeof chrome.storage.local.get;
    let restoring: Promise<boolean>;
    await act(async () => {
      restoring = hook().showCached();
    });
    // Source/result-ID verification must finish before analysis can be started;
    // only the independent stage-cache read is deliberately left pending.
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(hook().result?.resultId).toBe(response.resultId);
    });
    await act(async () => hook().analyze());
    expect(hook().analysis.loading).toBe(true);
    await act(async () => {
      read.resolve({});
      await restoring;
    });
    expect(hook().analysis.loading).toBe(true);
    await act(async () => analysis.resolve({ analysis: additionalAnalysis }));
    expect(hook().analysis.data).toEqual(additionalAnalysis);
  });

  it('smart→全文→通常へ切り替え、保存後は通信せず復元する', async () => {
    settings.extractionMode = 'smart';
    sendMessage
      .mockResolvedValueOnce(await responseFor('full'))
      .mockResolvedValueOnce(await responseFor('smart'));
    const hook = await mount();
    await act(async () => hook().summarize('full'));
    expect(hook().result).toMatchObject({ error: null, diagnosticRunId: 'full-run' });
    expect(stored[await keyFor('full')]).toBeDefined();
    const displayed = hook().result;
    await changeSettings({ experimentalScoring: false });
    expect(hook().result).toBe(displayed);
    await act(async () => hook().summarize());
    expect(hook().result).toMatchObject({ error: null, diagnosticRunId: 'smart-run' });
    expect(stored[await keyFor('smart')]).toBeDefined();
    await act(async () => hook().reset());
    await act(async () => hook().showCached());
    expect(hook().result).toMatchObject({
      summary: displayed!.summary,
      error: null,
      diagnosticRunId: null,
    });
    expect(hook().loading).toBe(false);
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it.each(['background', 'transport', 'local'])(
    '%sの失敗を別実行の診断へ結び付けず保存しない',
    async (stage) => {
      if (stage === 'background')
        sendMessage.mockResolvedValue({ error: 'PDF取得失敗', diagnosticRunId: 'failed-run' });
      if (stage === 'transport') sendMessage.mockRejectedValue(new Error('通信失敗'));
      if (stage === 'local') chrome.storage.sync.get = vi.fn();
      const hook = await mount();
      await act(async () => hook().summarize());
      expect(hook().result).toMatchObject({
        summary: null,
        resultId: null,
        diagnosticRunId: stage === 'background' ? 'failed-run' : null,
        error: expect.any(String),
      });
      expect(hook().loading).toBe(false);
      expect(sendMessage).toHaveBeenCalledTimes(stage === 'local' ? 0 : 1);
      expect(save).not.toHaveBeenCalled();
    }
  );

  it('応答待ちの設定変更で操作可能へ戻り、遅い旧応答を表示・保存しない', async () => {
    let resolve!: (response: unknown) => void;
    sendMessage.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        })
    );
    const hook = await mount();
    let run!: Promise<void>;
    await act(async () => {
      run = hook().summarize();
    });
    expect(hook().loading).toBe(true);
    await changeSettings({ model: 'after' });
    expect(hook().loading).toBe(false);
    await act(async () => {
      resolve(await responseFor());
      await run;
    });
    expect(hook().result).toBeNull();
    expect(save).not.toHaveBeenCalled();
  });

  it('customUrlだけの変更で保存要約・分析を外し、遅い旧分析を保存しない', async () => {
    const endpoint = { provider: 'custom', customUrl: 'https://api.example.com/v1/chat?route=a' };
    Object.assign(settings, endpoint);
    const response = await responseFor('full', endpoint);
    const oldKey =
      'summaryCacheV2:' + buildSummaryCacheKey(pdfUrl, response.metadata.analysisFingerprint);
    stored[oldKey] = response;
    stored[`analysisCacheV3:${response.resultId}`] = additionalAnalysis;
    const hook = await mount();
    await act(async () => hook().showCached());
    expect(hook().result?.resultId).toBe(response.resultId);
    expect(hook().analysis.data).toEqual(additionalAnalysis);
    // The event is enough even when a follow-up storage read would remain pending.
    const pendingSettingsRead = vi.fn();
    chrome.storage.sync.get = pendingSettingsRead;
    await changeSettings({ customUrl: 'HTTPS://API.EXAMPLE.COM:443/x/../v1/chat?route=a#ignored' });
    expect(hook().result?.resultId).toBe(response.resultId);
    expect(hook().analysis.data).toEqual(additionalAnalysis);
    const oldAnalysis = deferred<unknown>();
    sendMessage.mockReturnValueOnce(oldAnalysis.promise);
    await act(async () => hook().analyze());
    expect(hook().analysis.loading).toBe(true);
    await changeSettings({ customUrl: 'https://api.example.com/v1/chat?route=b' });
    expect(hook().result).toBeNull();
    expect(hook().analysis).toEqual({ loading: false, data: null, error: null });
    expect(hook().hasCached).toBe(false);
    await act(async () =>
      oldAnalysis.resolve({
        analysis: {
          ...additionalAnalysis,
          issues: [{ ...additionalAnalysis.issues[0], title: '旧APIの遅い分析' }],
        },
      })
    );
    expect(save).not.toHaveBeenCalled();
    expect(hook().analysis.data).toBeNull();
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(hook().cacheKey).not.toBeNull();
    });
    expect('summaryCacheV2:' + hook().cacheKey).not.toBe(oldKey);
    await act(async () => hook().showCached());
    expect(hook().result).toBeNull();
    expect(hook().hasCached).toBe(false);
    const fresh = await responseFor('full', {
      ...endpoint,
      customUrl: settings.customUrl as string,
    });
    expect(fresh.resultId).not.toBe(response.resultId);
    sendMessage.mockResolvedValueOnce(fresh);
    await act(async () => hook().summarize());
    expect(hook().result?.resultId).toBe(fresh.resultId);
    expect(hook().analysis.data).toBeNull();
    expect(stored[`analysisCacheV3:${response.resultId}`]).toEqual(additionalAnalysis);
    expect(pendingSettingsRead).not.toHaveBeenCalled();
  });

  it('算出不能スコアを保存せず、要約を保ち、明示再試行を許す', async () => {
    sendMessage
      .mockResolvedValueOnce(await responseFor())
      .mockResolvedValue({ score: { value: null, unverified: ['採点根拠を確認できません'] } });
    const hook = await mount();
    await act(async () => hook().summarize());
    const summary = hook().result;
    save.mockClear();
    await act(async () => hook().startScore());
    expect(hook().score).toEqual({ loading: false, data: null, error: '採点根拠を確認できません' });
    expect(hook().result).toBe(summary);
    expect(save).not.toHaveBeenCalled();
    await act(async () => hook().startScore());
    expect(sendMessage).toHaveBeenCalledTimes(2);
    await act(async () => hook().retryScore());
    expect(sendMessage).toHaveBeenCalledTimes(3);
  });

  it('保存済み算出不能スコアを削除し、再採点可能な要約を復元する', async () => {
    const response = await responseFor();
    stored[await keyFor('full')] = response;
    stored[`scoreCacheV4:${response.resultId}`] = { value: null, unverified: ['過去の失敗'] };
    const hook = await mount();
    await act(async () => hook().showCached());
    expect(remove).toHaveBeenCalledWith(`scoreCacheV4:${response.resultId}`);
    expect(hook().score).toEqual({ loading: false, data: null, error: null });
    expect(hook().result?.error).toBeNull();
    sendMessage.mockResolvedValue({ error: '再試行した採点' });
    await act(async () => hook().startScore());
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ action: 'score' }));
  });

  it.each([
    ['example.pdf', pdfUrl, true],
    ['./example.pdf', pdfUrl, true],
    ['/inbs/example.pdf', pdfUrl, true],
    ['example.pdf', 'https://www.release.tdnet.info/inbs/another.pdf', false],
  ])('リンク %s の保存採点をPDF %sへ対応させる', async (url, storedUrl, valid) => {
    const response = await responseFor();
    const document = {
      url: storedUrl,
      documentHash,
      pages,
      text: pages.map((p) => p.text).join('\n'),
      issuer: options.companyName,
      code: options.code,
      publishedDate: null,
    };
    const score: ExperimentalScore = {
      value: 70,
      verdict: '好材料',
      positives: [],
      negatives: [],
      unverified: [],
      searchStatus: '固定回帰',
      breakdown: [
        {
          category: 'operatingProfit',
          label: '営業利益',
          current: toValue(facts.facts[0], document),
          previous: toValue(facts.facts[1], document),
          earlier: null,
          relatedValue: null,
          companyExplanation: null,
          impact: 'positive',
          strength: 'small',
          comparison: '前年比 25.0%（加速・鈍化は未確認）',
        },
      ],
    };
    stored[await keyFor('full', url)] = response;
    stored[`scoreCacheV4:${response.resultId}`] = score;
    const hook = await mount(url);
    await act(async () => hook().showCached());
    expect(hook().result).toMatchObject({ summary: response.summary, error: null });
    expect(hook().score).toEqual(
      valid
        ? { loading: false, data: score, error: null }
        : { loading: false, data: null, error: '保存された採点の形式・確定事実との対応が不正です' }
    );
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

// 管理外の表行とReactポータルの接続を担当する。事実・診断照合の組合せは各契約テストへ置く。
describe('実Reactの要約行アクション配置', () => {
  it('一覧は要約・表示・閉じるだけにし、追加分析の連打・失敗・再試行でも本文と操作のフォーカスを保つ', async () => {
    settings.extractionMode = 'smart';
    settings.experimentalScoring = false;
    const response = await responseFor('smart');
    const summary = deferred<unknown>();
    const analysis = deferred<unknown>();
    const retry = deferred<unknown>();
    const rerun = deferred<unknown>();
    sendMessage
      .mockReturnValueOnce(summary.promise)
      .mockReturnValueOnce(analysis.promise)
      .mockReturnValueOnce(retry.promise)
      .mockReturnValueOnce(rerun.promise);
    const { row, cell, button } = await mountButton();
    const disclosure = row.cells[3];
    const disclosureHtml = disclosure.innerHTML;
    expect(cell.textContent).toBe('要約');
    expect(cell.querySelectorAll('button')).toHaveLength(1);
    await act(async () => {
      button.click();
      button.click();
    });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(button.textContent).toBe('要約中');
    expect(button.disabled).toBe(true);
    await act(async () =>
      summary.resolve({
        ...response,
        metadata: {
          ...response.metadata,
          extractionMode: 'smart',
          totalPages: 2,
          extractedPages: [1],
        },
      })
    );
    const summaryRow = await summaryRowFor(row);
    expect(cell.textContent).toBe('閉じる');
    expect(cell.querySelectorAll('button')).toHaveLength(1);
    const section = summaryRow.querySelector('[data-additional-analysis]')!;
    expect(section.querySelector('h5')?.textContent).toBe('追加分析');
    const analyze = section.querySelector<HTMLButtonElement>('#analyze-btn')!;
    expect(analyze.textContent).toBe('追加分析する');
    const diagnostics = summaryRow.querySelector<HTMLDetailsElement>('[data-generation-info]')!;
    expect(diagnostics.open).toBe(false);
    expect(diagnostics.querySelector('summary')?.textContent).toBe('生成情報・診断');
    expect(diagnostics.querySelector('#full-retry-btn')).not.toBeNull();
    expect(diagnostics.querySelector('[data-diagnostic-root] button')?.textContent).toBe(
      '診断JSONをコピー'
    );
    expect(section.contains(diagnostics)).toBe(false);
    // CSSの契約を確認する。jsdomは実画面での折り返しを検証しない。
    const heading = summaryRow.querySelector('h4')!;
    expect(heading.parentElement!.style.flexWrap).toBe('wrap');
    expect(heading.style.minWidth).toBe('0');
    expect(heading.parentElement!.parentElement!.style.overflowWrap).toBe('anywhere');
    expect(button.style.whiteSpace).toBe('nowrap');
    for (const action of summaryRow.querySelectorAll('button')) {
      expect(action.style.whiteSpace).toBe('nowrap');
      expect(action.style.minHeight).toBe('32px');
      expect(action.style.fontSize).toBe('12px');
    }
    const body = summaryRow.querySelector('#score-result')!.previousElementSibling!;
    const bodyHtml = body.innerHTML;
    analyze.focus();
    expect(analyze.style.outline).not.toBe('');
    await act(async () => {
      analyze.click();
      analyze.click();
    });
    expect(sendMessage.mock.calls.filter(([request]) => request.action === 'analyze')).toHaveLength(
      1
    );
    expect(analyze.textContent).toBe('分析中…');
    expect(analyze.disabled).toBe(true);
    expect(section.querySelector('#analysis-result')?.getAttribute('aria-busy')).toBe('true');
    expect(section.querySelector('[role="status"]')?.textContent).toContain('追加分析を作成');
    expect(document.activeElement).toBe(analyze);
    await act(async () => analysis.resolve({ error: '固定応答の分析失敗' }));
    expect(analyze.textContent).toBe('再試行');
    expect(analyze.disabled).toBe(false);
    expect(section.querySelector('[role="alert"]')?.textContent).toContain('固定応答の分析失敗');
    expect(document.activeElement).toBe(analyze);
    await click(analyze);
    expect(analyze.textContent).toBe('分析中…');
    await act(async () => retry.resolve({ analysis: additionalAnalysis }));
    expect(section.querySelector('#analyze-btn')).toBe(analyze);
    expect(analyze.textContent).toBe('分析し直す');
    expect(analyze.disabled).toBe(false);
    expect(document.activeElement).toBe(analyze);
    expect(section.querySelector('#analysis-result')?.getAttribute('aria-busy')).toBe('false');
    expect(section.querySelector('#analysis-result')?.textContent).toContain(
      additionalAnalysis.issues[0].conclusion
    );
    expect(section.querySelector('#analysis-result a')?.getAttribute('href')).toBe(
      `${pdfUrl}#page=1`
    );
    expect(summaryRow.querySelector('#score-result')!.previousElementSibling).toBe(body);
    expect(body.innerHTML).toBe(bodyHtml);
    expect(row.cells[3]).toBe(disclosure);
    expect(disclosure.innerHTML).toBe(disclosureHtml);
    expect(diagnostics.open).toBe(false);
    await click(analyze);
    expect(analyze.textContent).toBe('分析中…');
    await click(button);
    expect(row.nextElementSibling).toBeNull();
    expect(cell.textContent).toBe('表示');
    await act(async () =>
      rerun.resolve({
        analysis: {
          ...additionalAnalysis,
          issues: [{ ...additionalAnalysis.issues[0], conclusion: '閉じた後の遅い分析結果' }],
        },
      })
    );
    expect(row.nextElementSibling).toBeNull();
    expect(stored[`analysisCacheV3:${response.resultId}`]).toEqual(additionalAnalysis);
    await click(button);
    const reopened = await summaryRowFor(row);
    expect(cell.textContent).toBe('閉じる');
    expect(reopened.querySelector('#analysis-result')?.textContent).toContain(
      additionalAnalysis.issues[0].conclusion
    );
    expect(reopened.textContent).not.toContain('閉じた後の遅い分析結果');
    expect(sendMessage).toHaveBeenCalledTimes(4);
    expect(
      sendMessage.mock.calls.filter(([request]) => request.action === 'summarize')
    ).toHaveLength(1);
  });

  it('診断ポータルの手動コピーと状態を後続処理で保ち、別実行と閉じる前の遅い完了を表示しない', async () => {
    const response = await responseFor();
    const trace = await traceFor(response.diagnosticRunId, response.resultId);
    stored[SUMMARY_TRACE_KEY] = trace;
    const score = deferred<unknown>();
    const analysis = deferred<unknown>();
    sendMessage.mockImplementation(({ action }) =>
      action === 'summarize'
        ? Promise.resolve(response)
        : action === 'score'
          ? score.promise
          : analysis.promise
    );
    const writeText = vi
      .fn()
      .mockRejectedValueOnce(new Error('Clipboard denied'))
      .mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const { row, cell, button } = await mountButton();
    await click(button);
    const summaryRow = await summaryRowFor(row);
    const diagnostics = summaryRow.querySelector<HTMLDetailsElement>('[data-generation-info]')!;
    const host = diagnostics.querySelector<HTMLElement>('[data-diagnostic-root]')!;
    const copy = host.querySelector('button')!;
    await click(diagnostics.querySelector('summary')!);
    expect(diagnostics.open).toBe(true);
    copy.focus();
    await click(copy);
    expect(writeText).toHaveBeenCalledWith(JSON.stringify(trace, null, 2));
    const textarea = host.querySelector('textarea')!;
    expect(textarea.value).toBe(JSON.stringify(trace, null, 2));
    expect(textarea.readOnly).toBe(true);
    expect(textarea.style.width).toBe('100%');
    expect(textarea.style.maxWidth).toBe('100%');
    expect(textarea.style.boxSizing).toBe('border-box');
    expect(textarea.closest('details')?.open).toBe(true);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('選択してコピー');
    expect(document.activeElement).toBe(copy);
    await act(async () => score.resolve({ error: '固定応答の採点失敗' }));
    expect(summaryRow.querySelector('#score-result')?.textContent).toContain('固定応答の採点失敗');
    expect(summaryRow.querySelector('[data-diagnostic-root]')).toBe(host);
    expect(diagnostics.open).toBe(true);
    expect(host.querySelector('textarea')).toBe(textarea);
    expect(textarea.closest('details')?.open).toBe(true);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('選択してコピー');
    expect(document.activeElement).toBe(copy);
    await click(copy);
    expect(host.querySelector('[role="status"]')?.textContent).toBe('コピーしました');
    await click(summaryRow.querySelector<HTMLButtonElement>('#analyze-btn')!);
    await act(async () => analysis.resolve({ analysis: additionalAnalysis }));
    expect(summaryRow.querySelector('[data-diagnostic-root]')).toBe(host);
    expect(diagnostics.open).toBe(true);
    expect(host.querySelector('[role="status"]')?.textContent).toBe('コピーしました');
    stored[SUMMARY_TRACE_KEY] = { ...trace, runId: 'another-run' };
    await click(copy);
    expect(writeText).toHaveBeenCalledTimes(2);
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(
      'この要約結果に対応する診断がありません'
    );
    expect(host.querySelector('textarea')).toBeNull();
    stored[SUMMARY_TRACE_KEY] = trace;
    const pendingCopy = deferred<void>();
    writeText.mockReturnValueOnce(pendingCopy.promise);
    await click(copy);
    expect(writeText).toHaveBeenCalledTimes(3);
    await click(button);
    expect(cell.textContent).toBe('表示');
    expect(row.nextElementSibling).toBeNull();
    await click(button);
    const reopened = await summaryRowFor(row);
    const reopenedHost = reopened.querySelector('[data-diagnostic-root]')!;
    expect(reopenedHost).not.toBe(host);
    await act(async () => pendingCopy.resolve());
    expect(reopened.querySelector('textarea')).toBeNull();
    expect(reopenedHost.querySelector('[role="status"]')?.textContent).toBe('');
    expect(reopenedHost.querySelector('[role="alert"]')).toBeNull();
    expect(reopened.querySelector<HTMLDetailsElement>('[data-generation-info]')?.open).toBe(false);
    expect(writeText).toHaveBeenCalledTimes(3);
  });

  it('エラー行でも閉じると診断を用意し、エラーの隣の全文再要約で回復する', async () => {
    settings.extractionMode = 'smart';
    settings.experimentalScoring = false;
    const trace = await traceFor('failed-run', null);
    stored[SUMMARY_TRACE_KEY] = trace;
    const response = await responseFor('full');
    const retry = deferred<unknown>();
    sendMessage
      .mockResolvedValueOnce({
        error: trace.error,
        diagnosticRunId: trace.runId,
        retryExtractionMode: 'full',
      })
      .mockReturnValueOnce(retry.promise);
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const { row, cell, button } = await mountButton();
    await click(button);
    const errorRow = await summaryRowFor(row);
    expect(cell.textContent).toBe('閉じる');
    expect(button.disabled).toBe(false);
    expect(cell.querySelectorAll('button')).toHaveLength(1);
    expect(errorRow.querySelector('[data-additional-analysis]')).toBeNull();
    expect(errorRow.querySelector('#resummarize-btn')?.textContent).toBe('再要約');
    const error = errorRow.querySelector('[role="alert"]')!;
    expect(error.textContent).toContain(trace.error);
    const fullRetry = error.querySelector<HTMLButtonElement>('#full-retry-btn')!;
    expect(fullRetry.textContent).toBe('全文で再要約');
    expect(fullRetry.closest('details')).toBeNull();
    const diagnostics = errorRow.querySelector<HTMLDetailsElement>('[data-generation-info]')!;
    expect(diagnostics.open).toBe(false);
    await click(diagnostics.querySelector('summary')!);
    await click(diagnostics.querySelector<HTMLButtonElement>('[data-diagnostic-root] button')!);
    expect(writeText).toHaveBeenCalledWith(JSON.stringify(trace, null, 2));
    expect(diagnostics.querySelector('[role="status"]')?.textContent).toBe('コピーしました');
    fullRetry.focus();
    await click(fullRetry);
    expect(row.nextElementSibling).toBeNull();
    expect(button.textContent).toBe('要約中');
    expect(document.activeElement).toBe(button);
    expect(sendMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: 'summarize', forceExtractionMode: 'full' })
    );
    await act(async () => retry.resolve(response));
    const success = await summaryRowFor(row);
    expect(success.querySelector('[data-additional-analysis]')).not.toBeNull();
    expect(success.querySelector('[role="alert"]')).toBeNull();
    expect(success.querySelector('textarea')).toBeNull();
    expect(cell.textContent).toBe('閉じる');
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });
});

// Storage failures and lifecycle races belong here: real state/effects/DOM,
// with only Chrome messaging and storage substituted at the boundary.
describe('保存失敗と一覧ライフサイクルの回復', () => {
  it('保存失敗を生成失敗にせず、要約・追加分析を表示して保存警告を分ける', async () => {
    settings.experimentalScoring = false;
    const response = await responseFor();
    const saveSummary = deferred<void>();
    save.mockReturnValueOnce(saveSummary.promise).mockRejectedValue(new Error('QUOTA_BYTES'));
    sendMessage
      .mockResolvedValueOnce({
        ...response,
        metadata: { ...response.metadata, persistenceWarning: '診断を保存できませんでした' },
      })
      .mockResolvedValueOnce({ analysis: additionalAnalysis });
    const { row, button } = await mountButton();
    await click(button);
    const summaryRow = await summaryRowFor(row);
    const body = summaryRow.querySelector('#score-result')!.previousElementSibling!;
    const analysisButton = summaryRow.querySelector<HTMLButtonElement>('#analyze-btn')!;
    // A completed result is usable before its independent cache write finishes.
    await click(analysisButton);
    expect(summaryRow.querySelector('#analysis-result')?.textContent).toContain(
      additionalAnalysis.issues[0].conclusion
    );
    expect(summaryRow.querySelector('#analysis-result')?.textContent).toContain(
      '追加分析を保存できませんでした'
    );
    expect(summaryRow.querySelector('[role="alert"]')).toBeNull();
    // The late cache rejection must not replace the completed body or analysis.
    await act(async () => saveSummary.reject(new Error('QUOTA_BYTES')));
    expect(summaryRow.querySelector('[data-persistence-warning]')?.textContent).toContain(
      '診断を保存できませんでした'
    );
    expect(summaryRow.querySelector('[data-persistence-warning]')?.textContent).toContain(
      '要約を保存できませんでした'
    );
    expect(summaryRow.querySelector('#score-result')!.previousElementSibling).toBe(body);
    expect(button.textContent).toBe('閉じる');
    await click(button);
    expect(button.textContent).toBe('要約');
    expect(remove).not.toHaveBeenCalled();
  });

  it('削除通知で表示を要約へ戻し、通知前のキャッシュミスも一度のクリックで回復する', async () => {
    settings.experimentalScoring = false;
    const response = await responseFor();
    const key = await keyFor('full');
    stored[key] = response;
    sendMessage.mockResolvedValue(response);
    const { row, button } = await mountButton();
    await vi.waitFor(() => expect(button.textContent).toBe('表示'));
    delete stored[key];
    await act(async () =>
      listeners.forEach((listener) => listener({ [key]: { oldValue: response } }, 'local'))
    );
    expect(button.textContent).toBe('要約');
    stored[key] = response;
    await act(async () =>
      listeners.forEach((listener) => listener({ [key]: { newValue: response } }, 'local'))
    );
    await vi.waitFor(() => expect(button.textContent).toBe('表示'));
    delete stored[key];
    await act(async () => {
      button.click();
      button.click();
    });
    await summaryRowFor(row);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(button.textContent).toBe('閉じる');
    await click(button);
    const get = chrome.storage.local.get;
    chrome.storage.local.get = vi
      .fn()
      .mockRejectedValueOnce(new Error('storage read failed'))
      .mockImplementation(get);
    await click(button);
    await summaryRowFor(row);
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(button.textContent).toBe('閉じる');
  });

  it('削除前に開始した遅いキャッシュ読込を表示にも存在判定にも戻さない', async () => {
    const response = await responseFor();
    const key = await keyFor('full');
    stored[key] = response;
    const availability = deferred<Record<string, unknown>>();
    const first = deferred<Record<string, unknown>>();
    const originalGet = chrome.storage.local.get;
    chrome.storage.local.get = vi
      .fn()
      .mockReturnValueOnce(availability.promise)
      .mockReturnValueOnce(first.promise)
      .mockImplementation(originalGet);
    const hook = await mount();
    let showing!: Promise<boolean>;
    await act(async () => {
      showing = hook().showCached();
    });
    delete stored[key];
    await act(async () =>
      listeners.forEach((listener) => listener({ [key]: { oldValue: response } }, 'local'))
    );
    await act(async () => {
      first.resolve({ [key]: response });
      availability.resolve({ [key]: response });
      await showing;
    });
    expect(await showing).toBe(false);
    expect(hook().hasCached).toBe(false);
    expect(hook().result).toBeNull();
    expect(sendMessage).not.toHaveBeenCalled();

    // Commit notification, deletion, then write completion: deletion wins.
    const write = deferred<void>();
    save.mockImplementation((entries) => {
      Object.assign(stored, entries);
      listeners.forEach((listener) => listener({ [key]: { newValue: entries[key] } }, 'local'));
      return write.promise;
    });
    sendMessage.mockResolvedValue(response);
    let generating!: Promise<void>;
    await act(async () => {
      generating = hook().summarize();
    });
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(save).toHaveBeenCalledOnce();
    });
    delete stored[key];
    await act(async () =>
      listeners.forEach((listener) => listener({ [key]: { oldValue: response } }, 'local'))
    );
    await act(async () => {
      write.resolve();
      await generating;
    });
    expect(hook().hasCached).toBe(false);
    expect(hook().result?.error).toBeNull();
  });

  function frameFixture() {
    const frame = document.createElement('iframe');
    frame.id = 'main_list';
    container.append(frame);
    const doc = frame.contentDocument!;
    doc.body.innerHTML = `<table id="list-head"><tbody><tr><td class="header-R" style="border-radius:4px">表題</td></tr></tbody></table>
      <table id="main-list-table"><tbody><tr><td class="oddnew-L kjTime">15:00</td><td class="oddnew-M kjCode">1234</td><td class="oddnew-M kjName">株式会社テスト</td><td class="oddnew-R kjTitle"><a href="${pdfUrl}">開示</a></td></tr></tbody></table>`;
    return { frame, doc, row: doc.querySelector<HTMLTableRowElement>('#main-list-table tr')! };
  }
  async function toggle(enabled: boolean) {
    await act(async () =>
      messages.forEach((listener) => listener({ action: 'toggleExtension', enabled }))
    );
  }
  async function mountLifecycle() {
    container = document.createElement('div');
    document.body.append(container);
    const fixture = frameFixture();
    await act(async () => {
      stopContentScript = startContentScript();
    });
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(chrome.storage.local.get).toHaveBeenCalled();
    });
    return fixture;
  }

  it('OFFでReactと購読を破棄し、遅い応答を保存・再表示せず、ONで一組だけ作り直す', async () => {
    settings.experimentalScoring = false;
    const pending = deferred<unknown>();
    sendMessage.mockReturnValueOnce(pending.promise).mockResolvedValue(await responseFor());
    const { frame, doc, row } = await mountLifecycle();
    const subscriptions = listeners.size;
    await act(async () => {
      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    });
    expect(listeners.size).toBe(subscriptions);
    expect(messages.size).toBe(1);
    await click(row.querySelector('button')!);
    await toggle(false);
    expect(
      doc.querySelectorAll(
        '.tdnet-digest-button-cell, .tdnet-digest-summary-row, .tdnet-digest-header'
      )
    ).toHaveLength(0);
    expect(listeners.size).toBe(1); // Only the lifecycle's enable/disable control remains.
    expect(row.lastElementChild?.className).toBe('oddnew-R kjTitle');
    expect(doc.querySelector('#list-head td')?.className).toBe('header-R');
    await act(async () => pending.resolve(await responseFor()));
    await act(async () => frame.dispatchEvent(new Event('load')));
    expect(doc.querySelector('.tdnet-digest-summary-row')).toBeNull();
    expect(save).not.toHaveBeenCalled();
    await toggle(true);
    await toggle(true);
    expect(doc.querySelectorAll('.tdnet-digest-button-cell')).toHaveLength(1);
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(listeners.size).toBe(subscriptions);
    });
    await click(row.querySelector('button')!);
    await summaryRowFor(row);
    await toggle(false);
    await toggle(true);
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(listeners.size).toBe(subscriptions);
    });
    expect(doc.querySelector('.tdnet-digest-summary-row')).toBeNull();
  });

  it('同じ行のPDF変更・行削除・iframe再読込と置換で旧rootを残さない', async () => {
    settings.experimentalScoring = false;
    const stale = deferred<unknown>();
    sendMessage.mockReturnValueOnce(stale.promise);
    const { frame, doc, row } = await mountLifecycle();
    const subscriptions = listeners.size;
    const oldButton = row.querySelector('button')!;
    await click(oldButton);
    await act(async () => row.querySelector('a')!.setAttribute('href', 'replacement.pdf'));
    expect(row.querySelector('button')).not.toBe(oldButton);
    expect(row.querySelector('button')?.textContent).toBe('要約');
    await act(async () => stale.resolve(await responseFor()));
    expect(row.nextElementSibling).toBeNull();
    expect(save).not.toHaveBeenCalled();
    const reloadButton = row.querySelector('button');
    await act(async () => frame.dispatchEvent(new Event('load')));
    expect(row.querySelector('button')).not.toBe(reloadButton);
    expect(listeners.size).toBe(subscriptions);
    await act(async () => row.querySelector('a')!.setAttribute('href', pdfUrl));
    sendMessage.mockResolvedValue(await responseFor());
    await click(row.querySelector('button')!);
    const displayed = await summaryRowFor(row);
    await act(async () => row.remove());
    expect(displayed.isConnected).toBe(false);
    expect(doc.querySelector('.tdnet-digest-summary-row')).toBeNull();
    expect(listeners.size).toBe(1);
    expect(row.querySelector('.tdnet-digest-button-cell')).toBeNull();
    let replacement!: ReturnType<typeof frameFixture>;
    await act(async () => {
      frame.remove();
      replacement = frameFixture();
    });
    expect(doc.querySelector('.tdnet-digest-header')).toBeNull();
    expect(replacement.doc.querySelectorAll('.tdnet-digest-button-cell')).toHaveLength(1);
    expect(listeners.size).toBe(subscriptions);
    await act(async () => frame.dispatchEvent(new Event('load')));
    expect(doc.querySelector('.tdnet-digest-header')).toBeNull();
    expect(replacement.doc.querySelectorAll('.tdnet-digest-button-cell')).toHaveLength(1);
  });
});
