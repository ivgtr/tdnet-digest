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
import type { AdditionalAnalysis } from '@/lib/additional-analysis';
import { SUMMARY_TRACE_KEY, type SummaryTrace } from '@/lib/summary-trace';
import SummaryButton from '../SummaryButton';
import { useSummarize } from './useSummarize';

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
const keyFor = (mode: 'smart' | 'full', url = pdfUrl) =>
  'summaryCacheV2:' +
  buildSummaryCacheKey(
    url,
    buildAnalysisFingerprint({ provider: 'openai', model: 'fixture', extractionMode: mode })
  );
async function responseFor(mode: 'smart' | 'full' = 'full') {
  const analysisFingerprint = buildAnalysisFingerprint({
    provider: 'openai',
    model: 'fixture',
    extractionMode: mode,
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
let container: HTMLDivElement;
let settings: Record<string, unknown>;
let stored: Record<string, unknown>;
const sendMessage = vi.fn();
const save = vi.fn();
const remove = vi.fn();
const listeners = new Set<(changes: Record<string, unknown>, area: string) => void>();

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
  return { row, cell, button: cell.querySelector('button')! };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
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
const additionalAnalysis: AdditionalAnalysis = {
  version: 2,
  interpretation: {
    text: '営業利益の増加を確認できます',
    factIds: facts.facts.map((fact) => fact.id),
  },
  shortTerm: { text: '判断不能', factIds: [] },
  mediumTerm: { text: '判断不能', factIds: [] },
  longTerm: { text: '判断不能', factIds: [] },
  watchPoints: [],
};
function traceFor(runId: string, resultId: string | null): SummaryTrace {
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
    fingerprint: buildAnalysisFingerprint({
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
  await act(async () => listeners.forEach((listener) => listener(update, 'sync')));
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
      sync: { get: (_keys: string[], callback: (value: unknown) => void) => callback(settings) },
      local: {
        get: async (keys: string | string[], callback?: (data: unknown) => void) => {
          const data = Object.fromEntries(
            [keys]
              .flat()
              .filter((key) => key in stored)
              .map((key) => [key, structuredClone(stored[key])])
          );
          callback?.(data);
          return data;
        },
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
    runtime: { sendMessage },
  });
});
afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  expect(listeners.size).toBe(0);
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

  it('smart→全文→通常へ切り替え、保存後は通信せず復元する', async () => {
    settings.extractionMode = 'smart';
    sendMessage
      .mockResolvedValueOnce(await responseFor('full'))
      .mockResolvedValueOnce(await responseFor('smart'));
    const hook = await mount();
    await act(async () => hook().summarize('full'));
    expect(hook().result).toMatchObject({ error: null, diagnosticRunId: 'full-run' });
    expect(stored[keyFor('full')]).toBeDefined();
    const displayed = hook().result;
    await changeSettings({ experimentalScoring: false });
    expect(hook().result).toBe(displayed);
    await act(async () => hook().summarize());
    expect(hook().result).toMatchObject({ error: null, diagnosticRunId: 'smart-run' });
    expect(stored[keyFor('smart')]).toBeDefined();
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
    stored[keyFor('full')] = response;
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
    stored[keyFor('full', url)] = response;
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
      additionalAnalysis.interpretation.text
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
          interpretation: { ...additionalAnalysis.interpretation, text: '閉じた後の遅い分析結果' },
        },
      })
    );
    expect(row.nextElementSibling).toBeNull();
    expect(stored[`analysisCacheV2:${response.resultId}`]).toEqual(additionalAnalysis);
    await click(button);
    const reopened = await summaryRowFor(row);
    expect(cell.textContent).toBe('閉じる');
    expect(reopened.querySelector('#analysis-result')?.textContent).toContain(
      additionalAnalysis.interpretation.text
    );
    expect(reopened.textContent).not.toContain('閉じた後の遅い分析結果');
    expect(sendMessage).toHaveBeenCalledTimes(4);
    expect(
      sendMessage.mock.calls.filter(([request]) => request.action === 'summarize')
    ).toHaveLength(1);
  });

  it('診断ポータルの手動コピーと状態を後続処理で保ち、別実行と閉じる前の遅い完了を表示しない', async () => {
    const response = await responseFor();
    const trace = traceFor(response.diagnosticRunId, response.resultId);
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
    const trace = traceFor('failed-run', null);
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
