import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { LLMConfig } from '../../src/lib/llm-client';
import type { CandidateFact } from '../../src/lib/fact-contract';
import { candidateResponse } from '../../src/lib/fixtures/candidate-test-source';
import { extractPageLayout } from '../../src/lib/pdf-layout';
import corpus from '../../src/lib/fixtures/ir-semantic-corpus.json';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';
import type { VerifiedFact } from '../../src/lib/fact-contract';
import expectations from '../../src/lib/fixtures/ir-semantic-expectations.json';
import { parseFactSummary } from '../../src/lib/fact-summary';
import { expectedErrors, type Case as BrowserCase } from './fact-summary-expectations';
async function builtDigest(): Promise<string> {
  const digest = createHash('sha256');
  for (const directory of ['dist', 'dist/assets', 'dist/.vite']) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (
        !entry.isFile() ||
        entry.name.startsWith('.env') ||
        !/\.(js|mjs|json|css|html|png)$/.test(entry.name)
      )
        continue;
      const file = path.join(directory, entry.name);
      digest.update(file).update(await readFile(file));
    }
  }
  return digest.digest('hex');
}
/** Called by the existing evaluator after its ordinary configuration load. No secrets are logged. */
export async function checkExtension(item: BrowserCase, config: LLMConfig, args: string[]) {
  if (!['bluememe-20260930', 'buyback-20260714', 'monthly-20260714'].includes(item.id))
    throw new Error('ブラウザー評価は重点3資料のIDを指定してください');
  const arg = (flag: string) => args[args.indexOf(flag) + 1];
  if (!args.includes('--browser-module') || !args.includes('--browser-executable'))
    throw new Error('既存PlaywrightモジュールとChromiumを指定してください');
  const { chromium } = await import(pathToFileURL(arg('--browser-module')).href);
  const withComparison = args.includes('--with-comparison');
  const fixedFailure = args.includes('--fixed-failure');
  if (fixedFailure && !args.includes('--fixed-api'))
    throw new Error('拒否表示試験は固定API専用です');
  const smartFull = args.includes('--smart-full');
  if (smartFull && item.id !== 'bluememe-20260930')
    throw new Error('smart/full比較はBlueMemeに限定します');
  if (withComparison && (!args.includes('--fixed-api') || item.id !== 'bluememe-20260930'))
    throw new Error('比較固定試験はBlueMemeの固定APIでのみ使用します');
  const fixed = args.includes('--fixed-api'),
    fixtureSource = args.includes('--fixture-source');
  const buildDigest = await builtDigest();
  const profile = await mkdtemp(path.join(tmpdir(), 'tdnet-ir-browser-'));
  let context: any;
  let apiCalls = 0,
    pdfHash: string | null = null,
    failScore = false;
  const started = performance.now();
  const evidence: any = {
    caseId: item.id,
    api: fixed ? 'fixed' : 'live',
    expectedOutcome: fixedFailure ? 'failure' : 'success',
    source: fixtureSource ? 'fixture' : 'TDnet',
    buildDigest,
    stages: [],
    success: false,
  };
  try {
    context = await chromium.launchPersistentContext(profile, {
      executablePath: arg('--browser-executable'),
      headless: true,
      ignoreDefaultArgs: ['--disable-extensions'],
      env: {
        XDG_CONFIG_HOME: profile,
        XDG_CACHE_HOME: profile,
        PATH: '/usr/local/bin:/usr/bin:/bin',
      },
      args: [
        `--disable-extensions-except=${path.resolve('dist')}`,
        `--load-extension=${path.resolve('dist')}`,
        '--no-sandbox',
      ],
      viewport: { width: 1200, height: 900 },
    });
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));

    const credentials = fixed
      ? { provider: 'openai', model: 'fixture', apiKey: 'fixture', baseUrl: undefined }
      : config;
    await worker.evaluate(
      async (settings: any) => {
        await chrome.storage.sync.set({
          ...settings,
          customUrl: settings.baseUrl ?? '',
          extensionEnabled: true,
          extractionMode: settings.extractionMode,
          experimentalScoring: false,
        });
      },
      {
        extractionMode: smartFull ? 'smart' : 'full',
        provider: credentials.provider,
        model: credentials.model,
        apiKey: credentials.apiKey,
        baseUrl: credentials.baseUrl,
      }
    );
    if (fixed) {
      const source = expectations.find((e) => e.id === item.id);
      if (!source) throw new Error('固定候補がありません');
      const fixedFacts = structuredClone(source.facts) as unknown as CandidateFact[];
      if (withComparison) {
        const previous = structuredClone(fixedFacts[0]);
        previous.id = 'f20';
        previous.value = 2365;
        previous.period = '2025年3月期';
        if (!('valueId' in previous.evidence)) throw new Error('table expected');
        previous.evidence.valueId = 'p1s80';
        previous.evidence.periodIds = ['p1s78', 'p1s79'];
        fixedFacts.push(previous);
      }
      const fixture = corpus.find((c) => c.id === item.id)!;
      const sourcePages = fixture.pages.map((p) =>
        extractPageLayout(p.items as TextItem[], p.pageNumber)
      );
      await context.route('https://api.openai.com/**', async (route: any) => {
        const prompt = route
          .request()
          .postDataJSON()
          .messages.map((m: any) => m.content)
          .join('\n');
        apiCalls++;
        let result: any;
        if (fixedFailure) {
          await route.fulfill({
            contentType: 'application/json',
            body: JSON.stringify({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      candidateVersion: 0,
                      documentType: item.documentType,
                      candidates: [],
                      unverified: [],
                    }),
                  },
                },
              ],
            }),
          });
          return;
        }
        if (prompt.includes('"claims"') && failScore) {
          await route.fulfill({ status: 429, body: 'fixed score failure' });
          return;
        }
        if (prompt.includes('capは各分類全体'))
          result = { value: 55, factors: [{ index: 0, impact: 'positive', strength: 'small' }] };
        else if (prompt.includes('"claims"') && withComparison) {
          const registry = JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1));
          const facts = registry[0].facts;
          const current = facts.find(
            (f: any) => f.label === '売上高' && f.period === '2026年3月期'
          );
          const previous = facts.find(
            (f: any) => f.label === '売上高' && f.period === '2025年3月期'
          );
          result = {
            version: 4,
            claims: [
              {
                category: 'revenue',
                label: '売上高',
                current: current.id,
                previous: previous.id,
                earlier: null,
                relatedValue: null,
                companyExplanation: null,
              },
            ],
            unverified: [],
          };
        } else if (prompt.includes('"claims"'))
          result = { version: 4, claims: [], unverified: ['固定試験:比較値なし'] };
        else if (prompt.includes('"interpretation"')) {
          const unknown = { text: '判断不能', factIds: [] };
          result = {
            version: 2,
            interpretation: unknown,
            shortTerm: unknown,
            mediumTerm: unknown,
            longTerm: unknown,
            watchPoints: [],
          };
        } else
          result = JSON.parse(
            candidateResponse(fixedFacts as VerifiedFact[], sourcePages, item.documentType)
          );
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }),
        });
      });
    } else {
      context.on('request', (request: any) => {
        if (request.method() === 'POST' && request.resourceType() === 'fetch') apiCalls++;
      });
    }
    const pdfUrl = fixtureSource
      ? `https://www.release.tdnet.info/inbs/fixture-${item.id}.pdf`
      : item.url;
    if (fixtureSource) {
      const pdf = await readFile(`evaluation/fixtures/real-pdfs/${item.id}.pdf`);
      pdfHash = createHash('sha256').update(pdf).digest('hex');
      await context.route(pdfUrl, (route: any) =>
        route.fulfill({ contentType: 'application/pdf', body: pdf })
      );
      await context.route('https://www.release.tdnet.info/inbs/fixture-main.html', (route: any) =>
        route.fulfill({
          contentType: 'text/html',
          body: '<html><meta charset="utf-8"><iframe id="main_list" src="fixture-list.html" style="width:100%;height:880px"></iframe></html>',
        })
      );
      await context.route('https://www.release.tdnet.info/inbs/fixture-list.html', (route: any) =>
        route.fulfill({
          contentType: 'text/html',
          body: `<html><meta charset="utf-8"><table id="list-head"><tr><td class="header-R">表題</td></tr></table><table id="main-list-table"><tbody><tr><td class="kjTime oddnew-L">15:00</td><td class="kjCode oddnew-M">${item.id.startsWith('bluememe') ? '4069' : item.id.startsWith('buyback') ? '9313' : '3979'}</td><td class="kjName oddnew-M">公開PDF検証</td><td class="kjTitle oddnew-M"><a href="${pdfUrl}">${item.title}</a></td><td class="oddnew-R"></td></tr></tbody></table></html>`,
        })
      );
    }
    const page = await context.newPage();
    await page.goto(
      fixtureSource
        ? 'https://www.release.tdnet.info/inbs/fixture-main.html'
        : 'https://www.release.tdnet.info/inbs/I_main_00.html'
    );
    const frame = page.frameLocator('#main_list');
    if (!fixtureSource) {
      // Navigate within the actual day's published list until the exact PDF is found.
      const frameHandle = page.frames().find((f: any) => /I_list_/.test(f.url()));
      if (!frameHandle) throw new Error('実一覧のiframeがありません');
      const date = item.id.match(/(20\d{6})$/)?.[1];
      if (date)
        await frameHandle.goto(`https://www.release.tdnet.info/inbs/I_list_001_${date}.html`);
      const links = await frameHandle
        .locator('a[href*="I_list_"]')
        .evaluateAll((links: any[]) => links.map((a) => a.href));
      const candidates = [...new Set([frameHandle.url(), ...links])] as string[];
      let found = false;
      for (const url of candidates) {
        await frameHandle.goto(url);
        if (await frameHandle.locator(`a[href$="${item.url.split('/').pop()}"]`).count()) {
          found = true;
          break;
        }
      }
      if (!found) throw new Error('当日の実一覧に対象PDFを見つけられません');
    }
    const row = frame
      .locator(`a[href$="${pdfUrl.split('/').pop()}"]`)
      .locator('xpath=ancestor::tr[1]');
    await row.getByRole('button', { name: '要約', exact: true }).click({ timeout: 20000 });
    const summary = frame.locator('.tdnet-digest-summary-row');
    // The product inserts its result row after generation, not while the API is pending.
    await page.waitForFunction(
      () => {
        const text =
          document
            .querySelector<HTMLIFrameElement>('#main_list')
            ?.contentDocument?.querySelector('.tdnet-digest-summary-row')?.textContent ?? '';
        return text.trim().length > 0;
      },
      {},
      { timeout: 330000 }
    );
    evidence.stages.push('button → PDF → offscreen → API → facts → HTML');
    if (fixedFailure) {
      evidence.rendered = await summary.innerText();
      assert.ok(evidence.rendered.includes('形式が不正'));
      const trace = await worker.evaluate(
        async () => (await chrome.storage.local.get('summaryLastRunV1')).summaryLastRunV1
      );
      evidence.trace = trace;
      assert.equal(trace.outcome, 'failure');
      assert.deepEqual(
        trace.attempts.map((a: any) => a.phase),
        ['first', 'repair']
      );
      const downloadEvent = page.waitForEvent('download', { timeout: 10000 });
      await row.getByRole('button', { name: '診断を保存', exact: true }).click();
      const download = await downloadEvent;
      assert.deepEqual(JSON.parse(await readFile(await download.path(), 'utf8')), trace);
      assert.equal(apiCalls, 2);
      evidence.stages.push('failed first/complete-repair → error HTML → raw diagnostic export');
      await context.close();
      context = null;
      evidence.success = true;
      return;
    }

    if (smartFull) {
      const before = await worker.evaluate(async () => {
        const entries = await chrome.storage.local.get();
        return Object.entries(entries).find(
          ([k, v]: [string, any]) =>
            k.startsWith('summaryCacheV2:') && v.metadata?.extractionMode === 'smart'
        )?.[1];
      });
      assert.ok(before?.facts?.facts.length, 'smart事実が確定しませんでした');
      evidence.smart = before;
      // Re-fetch through the built extension's offscreen route, then recheck exactly
      // the same confirmed facts without generation or addition of full-page facts.
      const fullExtraction = await worker.evaluate(async (url: string) => {
        const data = await (await fetch(url)).arrayBuffer();
        return chrome.runtime.sendMessage({
          action: 'extractPdfText',
          pdfData: Array.from(new Uint8Array(data)),
          extractionMode: 'full',
          documentType: 'earnings',
        });
      }, pdfUrl);
      assert.ok(fullExtraction.success);
      const checked = parseFactSummary(
        JSON.stringify(before.facts),
        'earnings',
        fullExtraction.pages,
        false
      );
      assert.deepEqual(
        checked.facts.map((f) => f.id),
        before.facts.facts.map((f: any) => f.id)
      );
      evidence.stages.push('smart facts retain IDs after extension full PDF retrieval');
      const priorCalls = apiCalls;
      await summary.getByRole('button', { name: '全文で再要約', exact: true }).click();
      await page.waitForFunction(
        () =>
          document
            .querySelector<HTMLIFrameElement>('#main_list')
            ?.contentDocument?.querySelector('.tdnet-digest-summary-row')
            ?.textContent?.includes('全文抽出'),
        {},
        { timeout: 330000 }
      );
      assert.ok(apiCalls > priorCalls);
      evidence.stages.push('smart → full regenerates with the same candidate contract');
    }
    const body = await summary.innerText();
    evidence.rendered = body;
    const expected = item.id.startsWith('bluememe')
      ? [
          '3298',
          '47',
          '24',
          '2600',
          '30',
          '-400',
          '1.4',
          '-119.53',
          '概算',
          '翌連結会計年度',
          '特別損失',
          '予定',
        ]
      : item.id.startsWith('buyback')
        ? ['200000', '206200000', '上限', '予定', '2026年7月15日', '可能性']
        : ['2026年6月', '338214', 'NJSS', '速報', '修正する可能性'];
    for (const term of expected) assert.ok(body.includes(term), `表示に必要な意味がない: ${term}`);
    const stored = await worker.evaluate(async () => {
      const data = await chrome.storage.local.get();
      const entry = Object.entries(data).find(
        ([key, value]: [string, any]) =>
          key.startsWith('summaryCacheV2:') && value.metadata?.extractionMode === 'full'
      );
      return entry ? { key: entry[0], value: entry[1] } : null;
    });
    assert.ok(stored?.value?.facts?.version === 4);
    assert.match(stored.value.metadata.documentHash, /^[a-f0-9]{64}$/);
    if (pdfHash) assert.equal(stored.value.metadata.documentHash, pdfHash);
    const trace = await worker.evaluate(
      async () => (await chrome.storage.local.get('summaryLastRunV1')).summaryLastRunV1
    );
    evidence.trace = trace;
    assert.ok(trace?.attempts.length);
    assert.equal(trace.documentHash, stored.value.metadata.documentHash);
    assert.equal(trace.error, null);
    const downloadEvent = page.waitForEvent('download', { timeout: 10000 });
    await row.getByRole('button', { name: '診断を保存', exact: true }).click();
    const download = await downloadEvent;
    const exported = JSON.parse(await readFile(await download.path(), 'utf8'));
    assert.deepEqual(exported, trace);
    evidence.stages.push('phase/raw/diagnostics/hash/usage trace exported from UI');
    evidence.sourceHash = stored.value.metadata.documentHash;
    evidence.facts = stored.value.facts;
    evidence.metadata = stored.value.metadata;
    evidence.rendered = body;
    assert.deepEqual(expectedErrors(item, stored.value.facts), []);
    await row.getByRole('button', { name: '非表示', exact: true }).click();
    const callsBefore = apiCalls;
    await row.getByRole('button', { name: '表示', exact: true }).click();
    await summary
      .getByRole('heading', { name: '確認できた事実', exact: true })
      .waitFor({ timeout: 10000 });
    assert.equal(apiCalls, callsBefore);
    evidence.stages.push('hide/show/cache without API');
    const listUrl = page
      .frames()
      .find((f: any) => /I_list_|fixture-list/.test(f.url()))!
      .url();
    await page.reload();
    await frame.locator('#main-list-table').waitFor({ timeout: 20000 });
    await page
      .frames()
      .find((f: any) => /I_list_|fixture-list/.test(f.url()))!
      .goto(listUrl);
    await row.getByRole('button', { name: '表示', exact: true }).click({ timeout: 20000 });
    await summary
      .getByRole('heading', { name: '確認できた事実', exact: true })
      .waitFor({ timeout: 10000 });
    assert.equal(apiCalls, callsBefore);
    evidence.stages.push('page reload restores exact current facts without API');

    if (!fixed && args.includes('--live-followups')) {
      await summary.getByRole('button', { name: '追加分析', exact: true }).click();
      await page.waitForFunction(
        () => {
          const result = document
            .querySelector<HTMLIFrameElement>('#main_list')
            ?.contentDocument?.querySelector('#analysis-result');
          return !!result?.querySelector('h5') || !!result?.textContent?.includes('追加分析失敗');
        },
        {},
        { timeout: 330000 }
      );
      const analysis = await worker.evaluate(async () => {
        const entries = await chrome.storage.local.get();
        return Object.entries(entries).find(([k]) => k.startsWith('analysisCacheV2:'))?.[1];
      });
      evidence.analysis = analysis;
      assert.ok(analysis, '実API追加分析の現行キャッシュがありません');
      assert.equal(analysis.version, 2);
      assert.ok((await summary.innerText()).includes('確認できた事実'));
      evidence.stages.push('live additional analysis preserves facts');
      await worker.evaluate(async () => chrome.storage.sync.set({ experimentalScoring: true }));
      await page.waitForFunction(
        () => {
          const text =
            document
              .querySelector<HTMLIFrameElement>('#main_list')
              ?.contentDocument?.querySelector('.tdnet-digest-summary-row')?.textContent ?? '';
          return text.includes('採点を再試行') || text.includes('材料スコア:');
        },
        {},
        { timeout: 330000 }
      );
      evidence.followupRendered = await summary.innerText();
      assert.ok(evidence.followupRendered.includes('確認できた事実'));
      const score = await worker.evaluate(async () => {
        const entries = await chrome.storage.local.get();
        return Object.entries(entries).find(([k]) => k.startsWith('scoreCacheV4:'))?.[1];
      });
      evidence.score = score ?? null;
      evidence.stages.push(
        score
          ? 'live scoring returns native score'
          : 'live scoring refuses unverifiable comparison; summary retained'
      );
    }
    if (fixed) {
      await summary.getByRole('button', { name: '追加分析', exact: true }).click();
      await page.waitForFunction(
        () =>
          document
            .querySelector<HTMLIFrameElement>('#main_list')
            ?.contentDocument?.querySelector('.tdnet-digest-summary-row')
            ?.textContent?.includes('判断不能'),
        {},
        { timeout: 30000 }
      );
      assert.ok((await summary.innerText()).includes('確認できた事実'));
      evidence.stages.push('explicit additional analysis while scoring OFF');
      failScore = true;
      await worker.evaluate(async () => chrome.storage.sync.set({ experimentalScoring: true }));
      await summary
        .getByRole('button', { name: '採点を再試行', exact: true })
        .waitFor({ timeout: 30000 });
      assert.ok((await summary.innerText()).includes('確認できた事実'));
      evidence.stages.push('scoring ON failure preserves summary');
      failScore = false;
      await summary.getByRole('button', { name: '採点を再試行', exact: true }).click();
      await page.waitForFunction(
        (compare) =>
          document
            .querySelector<HTMLIFrameElement>('#main_list')
            ?.contentDocument?.querySelector('.tdnet-digest-summary-row')
            ?.textContent?.includes(compare ? '55' : '比較値'),
        withComparison,
        { timeout: 30000 }
      );
      assert.ok((await summary.innerText()).includes('確認できた事実'));
      if (withComparison) {
        const score = await worker.evaluate(async () => {
          const entries = await chrome.storage.local.get();
          return Object.entries(entries).find(([k]) => k.startsWith('scoreCacheV4:'))?.[1];
        });
        assert.equal(score?.value, 55);
        assert.equal(score.breakdown[0].previous.value, 2365);
        assert.equal(score.breakdown[0].current.value, 3298);
        evidence.score = score;
      }
      evidence.stages.push(
        withComparison
          ? 'score retry uses native current/previous facts'
          : 'score retry refuses missing comparisons'
      );
      await worker.evaluate(async () => chrome.storage.sync.set({ experimentalScoring: false }));
      await row.getByRole('button', { name: '非表示', exact: true }).click();
      await worker.evaluate(
        async (entry: any) =>
          chrome.storage.local.set({
            [entry.key]: { ...entry.value, facts: { ...entry.value.facts, version: 3 } },
          }),
        stored
      );
      const previousCalls = apiCalls;
      await row.getByRole('button', { name: '表示', exact: true }).click();
      await page.waitForFunction(
        () =>
          document
            .querySelector<HTMLIFrameElement>('#main_list')
            ?.contentDocument?.querySelector('.tdnet-digest-summary-row')
            ?.textContent?.includes('保存された現行要約'),
        {},
        { timeout: 10000 }
      );
      assert.equal(apiCalls, previousCalls);
      evidence.stages.push('old schema refused without conversion or API fallback');
    }

    await context.close();
    context = null;
    evidence.success = true;
  } catch (error) {
    evidence.error = error instanceof Error ? error.message : String(error);
    if (context) {
      const w = context.serviceWorkers()[0];
      if (w)
        evidence.trace = await w.evaluate(
          async () => (await chrome.storage.local.get('summaryLastRunV1')).summaryLastRunV1
        );
    }
    throw error;
  } finally {
    if (context) await context.close();
    await rm(profile, { recursive: true, force: true });
    evidence.elapsedSeconds = Math.round((performance.now() - started) / 1000);
    evidence.apiCalls = apiCalls;
    await mkdir('evaluation/results/local', { recursive: true });
    const runId = new Date().toISOString().replace(/[:.]/g, '-');
    await writeFile(
      `evaluation/results/local/${item.id}-${runId}-browser.json`,
      JSON.stringify(evidence, null, 2)
    );
    console.log(
      JSON.stringify({
        caseId: item.id,
        success: evidence.success,
        api: evidence.api,
        source: evidence.source,
        stages: evidence.stages,
        apiCalls,
        elapsedSeconds: evidence.elapsedSeconds,
        error: evidence.error,
      })
    );
  }
}
