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
import { stableFactId, FACT_SCHEMA_VERSION, type VerifiedFact } from '../../src/lib/fact-contract';
import expectations from '../../src/lib/fixtures/ir-semantic-expectations.json';
import { parseFactSummary } from '../../src/lib/fact-summary';
import { ANALYSIS_SCHEMA_VERSION } from '../../src/lib/analysis-version';
import { additionalReviewFixture } from './additional-review-fixture';
import { seedOldExtensionProfile } from './extension-upgrade-fixture';
import {
  expectedErrors,
  renderedFactErrors,
  type Case as BrowserCase,
} from './fact-summary-expectations';
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
/** Match the public source digest embedded by vite.config.ts in the running worker. */
async function sourceBuildDigest(): Promise<string> {
  const digest = createHash('sha256');
  for (const directory of ['src/lib', 'src/background', 'src/offscreen'])
    for (const file of (await readdir(directory))
      .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
      .sort())
      digest.update(`${directory}/${file}`).update(await readFile(`${directory}/${file}`));
  return digest.digest('hex');
}
/** Read each visible fact with its shared table context; never use the entire body as one fact. */
async function displayedFacts(summary: any): Promise<string[]> {
  return summary.evaluate((root: HTMLElement) => [
    ...Array.from(root.querySelectorAll('li')).map((node) => node.textContent ?? ''),
    ...Array.from(root.querySelectorAll('tbody tr')).map((row) => {
      const table = row.closest('table')!;
      const context = table.parentElement!.previousElementSibling?.textContent ?? '';
      return context + ' ' + row.textContent;
    }),
  ]);
}
/** Called by the existing evaluator after its ordinary configuration load. No secrets are logged. */
export async function checkExtension(item: BrowserCase, config: LLMConfig, args: string[]) {
  const arg = (flag: string) => args[args.indexOf(flag) + 1];
  if (!args.includes('--browser-module') || !args.includes('--browser-executable'))
    throw new Error('既存PlaywrightモジュールとChromiumを指定してください');
  const { chromium } = await import(pathToFileURL(arg('--browser-module')).href);
  const reviewCase = args.includes('--additional-review-case')
    ? arg('--additional-review-case')
    : null;
  if (reviewCase && (!args.includes('--fixed-api') || !args.includes('--fixture-source')))
    throw new Error('追加レビューは固定API・合成PDF専用です');
  const reviewFixture = reviewCase ? await additionalReviewFixture(reviewCase) : null;
  if (reviewFixture)
    item = {
      ...item,
      documentType: reviewFixture.documentType,
      title:
        reviewFixture.documentType === 'earnings'
          ? '2027年3月期 決算短信〔日本基準〕（連結）'
          : '追加セルフレビュー用開示',
    };
  const withComparison = args.includes('--with-comparison');
  const fixedFailure =
    args.includes('--fixed-failure') ||
    reviewCase === 'reject' ||
    reviewCase === 'assertion-conflict';
  if (fixedFailure && !args.includes('--fixed-api'))
    throw new Error('拒否表示試験は固定API専用です');
  const smartFull = args.includes('--smart-full');
  if (smartFull && item.id !== 'bluememe-20260930')
    throw new Error('smart/full比較はBlueMemeに限定します');
  if (withComparison && (!args.includes('--fixed-api') || item.id !== 'bluememe-20260930'))
    throw new Error('比較固定試験はBlueMemeの固定APIでのみ使用します');
  const fixed = args.includes('--fixed-api'),
    fixtureSource = args.includes('--fixture-source');
  const reviewUpgrade = args.includes('--review-upgrade');
  if (
    reviewUpgrade &&
    (!fixed ||
      !fixtureSource ||
      item.id !== 'bluememe-20260930' ||
      smartFull ||
      reviewCase ||
      fixedFailure ||
      withComparison ||
      !args.includes('--baseline-dir'))
  )
    throw new Error('更新試験はBlueMeme・固定API・固定一覧と旧版ディレクトリが必要です');
  const reference = args.includes('--same-input-as')
    ? JSON.parse(await readFile(arg('--same-input-as'), 'utf8'))
    : null;
  if (reference && (fixed || fixtureSource || smartFull || args.includes('--live-followups')))
    throw new Error('同条件試行の照合はfullの実PDF・通常生成専用です');
  const reviewRejectedUrl = args.includes('--review-rejected-url');
  if (reviewRejectedUrl && (!fixed || !fixtureSource || reviewCase || fixedFailure))
    throw new Error('拒否URLの診断試験は固定API・固定一覧専用です');
  const reviewDiagnostics = args.includes('--review-diagnostics');
  if (reviewDiagnostics && (!fixed || !fixtureSource || fixedFailure))
    throw new Error('診断対応の回帰は正常な固定API・固定原文ルートで実行してください');
  const reviewSettingsChange = args.includes('--review-settings-change');
  if (reviewSettingsChange && (!fixed || !fixtureSource || fixedFailure))
    throw new Error('応答待ちの設定変更試験は正常な固定API・固定原文ルートで実行してください');
  let signalFirstRequest = () => {},
    releaseFirstResponse = () => {};
  const firstRequest = new Promise<void>((resolve) => {
    signalFirstRequest = resolve;
  });
  const firstResponse = new Promise<void>((resolve) => {
    releaseFirstResponse = resolve;
  });
  const buildDigest = await builtDigest();
  const sourceDigest = await sourceBuildDigest();
  const profile = await mkdtemp(path.join(tmpdir(), 'ir-'));
  let context: any;
  let apiCalls = 0,
    pdfRequests = 0,
    pdfHash: string | null = null,
    failScore = false;
  const requestSettings: any[] = [];
  const requestPromptHashes: string[] = [];
  const started = performance.now();
  const evidence: any = {
    caseId: item.id,
    additionalReviewCase: reviewCase,
    api: fixed ? 'fixed' : 'live',
    expectedOutcome: fixedFailure || reviewRejectedUrl ? 'failure' : 'success',
    source: reviewRejectedUrl
      ? 'rejected-link'
      : reviewFixture
        ? 'synthetic-PDF-through-offscreen'
        : fixtureSource
          ? 'fixture'
          : 'TDnet',
    buildDigest,
    sourceBuildDigest: sourceDigest,
    stages: [],
    success: false,
  };
  try {
    const oldProfile = reviewUpgrade
      ? await seedOldExtensionProfile(
          chromium,
          arg('--browser-executable'),
          profile,
          arg('--baseline-dir')
        )
      : null;
    const extensionDirectory = oldProfile?.extensionDirectory ?? path.resolve('dist');
    context =
      oldProfile?.context ??
      (await chromium.launchPersistentContext(profile, {
        executablePath: arg('--browser-executable'),
        headless: true,
        ignoreDefaultArgs: ['--disable-extensions'],
        env: {
          XDG_CONFIG_HOME: profile,
          XDG_CACHE_HOME: profile,
          TMPDIR: profile,
          PATH: '/usr/local/bin:/usr/bin:/bin',
        },
        args: [
          `--disable-extensions-except=${extensionDirectory}`,
          `--load-extension=${extensionDirectory}`,
          '--no-sandbox',
        ],
        viewport: { width: 1200, height: 900 },
      }));
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    if (oldProfile)
      assert.equal(await worker.evaluate(() => chrome.runtime.getManifest().version), '0.7.3');
    evidence.loadedOffscreenHtml = await worker.evaluate(async () =>
      (await fetch(chrome.runtime.getURL('offscreen.html'))).text()
    );

    const credentials = fixed
      ? { provider: 'openai', model: 'fixture', apiKey: 'fixture', baseUrl: undefined }
      : config;
    if (oldProfile) {
      const restored = await worker.evaluate(
        async (key: string) => ({
          settings: await chrome.storage.sync.get(),
          cache: (await chrome.storage.local.get(key))[key],
        }),
        oldProfile.key
      );
      assert.deepEqual(restored.settings, oldProfile.settings);
      assert.deepEqual(restored.cache, oldProfile.value);
      evidence.stages.push(
        'real v0.7.3 cache displayed without API → same profile updated → settings and old cache retained'
      );
    } else
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
        if (reviewSettingsChange && apiCalls === 1) {
          signalFirstRequest();
          await firstResponse;
        }
        let result: any;
        if (reviewFixture && !prompt.includes('"interpretation"')) {
          await route.fulfill({
            contentType: 'application/json',
            body: JSON.stringify({
              choices: [
                {
                  message: { content: apiCalls === 1 ? reviewFixture.first : reviewFixture.repair },
                  finish_reason: 'stop',
                },
              ],
            }),
          });
          return;
        }
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
        if (request.method() === 'POST' && request.resourceType() === 'fetch') {
          apiCalls++;
          const body = request.postDataJSON();
          requestPromptHashes.push(
            createHash('sha256')
              .update(
                JSON.stringify({
                  system: body.messages.find((m: any) => m.role === 'system')?.content,
                  user: body.messages.find((m: any) => m.role === 'user')?.content,
                })
              )
              .digest('hex')
          );
          requestSettings.push({
            model: body.model,
            temperature: body.temperature,
            maxOutputTokens: body.max_tokens,
            reasoningEffort: body.reasoning?.effort,
          });
        }
      });
    }
    const pdfUrl = reviewRejectedUrl
      ? 'https://example.com/fixture-rejected.pdf'
      : fixtureSource
        ? `https://www.release.tdnet.info/inbs/fixture-${item.id}.pdf`
        : item.url;
    if (fixtureSource) {
      const pdf = reviewFixture
        ? Buffer.from(reviewFixture.pdf)
        : await readFile(`evaluation/fixtures/real-pdfs/${item.id}.pdf`);
      pdfHash = createHash('sha256').update(pdf).digest('hex');
      await context.route(pdfUrl, (route: any) => {
        pdfRequests++;
        return route.fulfill({ contentType: 'application/pdf', body: pdf });
      });
      await context.route('https://www.release.tdnet.info/inbs/fixture-main.html', (route: any) =>
        route.fulfill({
          contentType: 'text/html',
          body: '<html><meta charset="utf-8"><iframe id="main_list" src="fixture-list.html" style="width:100%;height:880px"></iframe></html>',
        })
      );
      await context.route('https://www.release.tdnet.info/inbs/fixture-list.html', (route: any) =>
        route.fulfill({
          contentType: 'text/html',
          body: `<html><meta charset="utf-8"><table id="list-head"><tr><td class="header-R">表題</td></tr></table><table id="main-list-table"><tbody><tr><td class="kjTime oddnew-L">15:00</td><td class="kjCode oddnew-M">${item.code ?? (item.id.startsWith('bluememe') ? '4069' : item.id.startsWith('buyback') ? '9313' : '3979')}</td><td class="kjName oddnew-M">公開PDF検証</td><td class="kjTitle oddnew-M"><a href="${pdfUrl}">${item.title}</a></td><td class="oddnew-R"></td></tr></tbody></table></html>`,
        })
      );
    }
    if (reviewFixture) {
      await worker.evaluate(
        async (seed: any) => {
          const fingerprint = `v${seed.previousVersion}:openai:fixture:full`;
          await chrome.storage.local.set({
            [`summaryCacheV2:${fingerprint}:${seed.pdfUrl}`]: {
              summary: seed.summary,
              facts: seed.facts,
              resultId: 'a'.repeat(64),
              metadata: {
                analysisFingerprint: fingerprint,
                analysisSchemaVersion: 4,
                documentHash: seed.hash,
                extractionMode: 'full',
              },
            },
          });
        },
        {
          previousVersion: ANALYSIS_SCHEMA_VERSION - 1,
          pdfUrl,
          summary: reviewFixture.legacyRendered,
          facts: reviewFixture.legacy,
          hash: pdfHash,
        }
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
      const date = item.publishedDate?.replace(/-/g, '') ?? item.id.match(/(20\d{6})$/)?.[1];
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
    if (oldProfile) {
      assert.equal(await frame.locator('.tdnet-digest-summary-row').count(), 0);
      evidence.stages.push('old fingerprint result not displayed → new summary button available');
    }
    await row.getByRole('button', { name: '要約', exact: true }).click({ timeout: 20000 });
    if (reviewFixture)
      evidence.stages.push(`v${ANALYSIS_SCHEMA_VERSION - 1} cache ignored before generation`);
    const summary = frame.locator('.tdnet-digest-summary-row');
    if (reviewRejectedUrl) {
      await summary
        .getByText('TDnetのPDF URLではありません', { exact: false })
        .waitFor({ timeout: 10000 });
      const trace = await worker.evaluate(
        async () => (await chrome.storage.local.get('summaryLastRunV1')).summaryLastRunV1
      );
      assert.equal(trace.pdfUrl, pdfUrl);
      assert.equal(trace.outcome, 'failure');
      assert.equal(trace.resultId, null);
      assert.deepEqual(trace.attempts, []);
      assert.deepEqual(trace.usage, []);
      const downloadEvent = page.waitForEvent('download', { timeout: 10000 });
      await row.getByRole('button', { name: '診断を保存', exact: true }).click();
      const downloaded = await downloadEvent;
      assert.deepEqual(JSON.parse(await readFile(await downloaded.path(), 'utf8')), trace);
      assert.equal(apiCalls, 0);
      assert.equal(pdfRequests, 0);
      evidence.trace = trace;
      evidence.pdfRequests = pdfRequests;
      evidence.stages.push(
        'rejected URL → own failed run → diagnostic download; PDF/API requests 0'
      );
      await context.close();
      context = null;
      evidence.success = true;
      return;
    }
    if (reviewSettingsChange) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          firstRequest,
          new Promise<void>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error('応答待ちの初回要求を確認できません')),
              10000
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      await worker.evaluate(async () => chrome.storage.sync.set({ model: 'fixture-next' }));
      const button = row.getByRole('button', { name: '要約', exact: true });
      await button.waitFor({ timeout: 10000 });
      assert.equal(await button.isEnabled(), true);
      await button.click();
      evidence.stages.push('model changed while API pending → button enabled → new request');
    }
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
    if (reviewSettingsChange) {
      const currentTrace = await worker.evaluate(
        async () => (await chrome.storage.local.get('summaryLastRunV1')).summaryLastRunV1
      );
      assert.equal(currentTrace.model, 'fixture-next');
      assert.ok(['firstSuccess', 'repairSuccess'].includes(currentTrace.outcome));
      releaseFirstResponse();
      // The bounded settle window supplements the deterministic deferred-request integration tests.
      await page.waitForTimeout(1000);
      const afterOld = await worker.evaluate(
        async () => (await chrome.storage.local.get('summaryLastRunV1')).summaryLastRunV1
      );
      assert.deepEqual(afterOld, currentTrace);
      evidence.stages.push('new result finished before old response → current trace retained');
    }
    evidence.stages.push('button → result/error HTML');
    const completedTrace = await worker.evaluate(
      async () => (await chrome.storage.local.get('summaryLastRunV1')).summaryLastRunV1
    );
    evidence.trace = completedTrace;
    assert.equal(
      completedTrace?.buildDigest,
      sourceDigest,
      '実行Workerと現在の製品ソースが一致しません'
    );
    if (smartFull && completedTrace.outcome === 'failure') {
      assert.ok(completedTrace.error.includes('全文で再要約'));
      assert.equal(apiCalls, 0, '不足したsmart入力でAPIを呼びません');
      assert.deepEqual(completedTrace.attempts, []);
      evidence.smart = { error: completedTrace.error, attempts: completedTrace.attempts };
      await summary.getByRole('button', { name: '全文で再要約', exact: true }).click();
      await summary
        .getByRole('heading', { name: '全体要約', exact: true })
        .waitFor({ timeout: 330000 });
      Object.assign(
        completedTrace,
        await worker.evaluate(
          async () => (await chrome.storage.local.get('summaryLastRunV1')).summaryLastRunV1
        )
      );
      evidence.stages.push('smart completeness failure without API → explicit full retry');
    }
    if (!fixedFailure && completedTrace.outcome === 'failure')
      throw new Error(completedTrace.error);
    if (fixedFailure) {
      evidence.rendered = await summary.innerText();
      assert.ok(
        evidence.rendered.includes(
          reviewCase === 'assertion-conflict'
            ? '確定済み原文の意味'
            : reviewFixture
              ? '数量後'
              : '形式が不正'
        )
      );
      if (reviewFixture) assert.ok(!evidence.rendered.includes('売上高: 100百万円'));
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
      evidence.stages.push(
        reviewCase === 'assertion-conflict'
          ? 'failed delta repair → error HTML → raw diagnostic export'
          : 'failed first/complete-repair → error HTML → raw diagnostic export'
      );
      await context.close();
      context = null;
      evidence.success = true;
      return;
    }

    const body = await summary.innerText();
    evidence.rendered = body;
    const expected = reviewFixture
      ? reviewFixture.expected
      : item.id.startsWith('bluememe')
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
          : item.id.startsWith('monthly')
            ? ['2026年6月', '338214', 'NJSS', '速報', '修正する可能性']
            : [];
    for (const term of expected) assert.ok(body.includes(term), `表示に必要な意味がない: ${term}`);
    const stored = await worker.evaluate(async (version: number) => {
      const data = await chrome.storage.local.get();
      const entry = Object.entries(data).find(
        ([key, value]: [string, any]) =>
          key.startsWith(`summaryCacheV2:v${version}:`) && value.metadata?.extractionMode === 'full'
      );
      return entry ? { key: entry[0], value: entry[1] } : null;
    }, ANALYSIS_SCHEMA_VERSION);
    assert.ok(stored?.value?.facts?.version === FACT_SCHEMA_VERSION);
    assert.ok(stored.value.presentation?.version === 1);
    const visibleText = (await summary.innerText()).normalize('NFKC').replace(/\s/g, '');
    for (const excerpt of stored.value.presentation.excerpts)
      assert.ok(
        visibleText.includes(excerpt.text.normalize('NFKC').replace(/\s/g, '')),
        `原文の表示が欠落: ${excerpt.id}`
      );
    assert.equal(await summary.locator('details').filter({ hasText: '生成情報' }).count(), 1);
    evidence.presentation = stored.value.presentation;
    await page.screenshot({ path: `evaluation/results/local/${item.id}-summary-top.png` });
    await page.setViewportSize({ width: 600, height: 800 });
    await page.screenshot({ path: `evaluation/results/local/${item.id}-summary-narrow.png` });
    await page.setViewportSize({ width: 1280, height: 900 });
    const renderedLines = await displayedFacts(summary);
    assert.deepEqual(renderedFactErrors(stored.value.facts.facts, renderedLines), []);
    evidence.renderedLines = renderedLines;
    if (reviewSettingsChange) {
      assert.equal(
        await worker.evaluate(async () =>
          Object.keys(await chrome.storage.local.get()).some(
            (key) => key.startsWith('summaryCacheV2:') && key.includes(':fixture:full:')
          )
        ),
        false
      );
      assert.equal(stored.value.metadata.model, 'fixture-next');
      evidence.stages.push('stale first-model response never displayed or cached');
    }
    assert.match(stored.value.metadata.documentHash, /^[a-f0-9]{64}$/);
    if (pdfHash) assert.equal(stored.value.metadata.documentHash, pdfHash);
    const trace = await worker.evaluate(
      async () => (await chrome.storage.local.get('summaryLastRunV1')).summaryLastRunV1
    );
    evidence.trace = trace;
    assert.ok(trace?.attempts.length);
    assert.equal(trace.buildDigest, sourceDigest, '実行Workerと現在の製品ソースが一致しません');
    assert.equal(trace.documentHash, stored.value.metadata.documentHash);
    assert.equal(trace.error, null);
    evidence.stages.push('PDF → offscreen → API → verified facts → paired DOM meaning');
    evidence.requestSettings = requestSettings;
    evidence.requestPromptHashes = requestPromptHashes;
    if (reference) {
      assert.equal(reference.success, true);
      assert.equal(trace.documentHash, reference.sourceHash);
      assert.equal(trace.inputHash, reference.inputHash);
      assert.equal(
        requestPromptHashes[0],
        reference.promptHash,
        '初回生成プロンプトがCLI条件と一致しません'
      );
      assert.equal(trace.provider, reference.provider);
      assert.equal(trace.model, reference.model);
      assert.equal(trace.documentType, reference.item.documentType);
      assert.equal(trace.extractionMode, 'full');
      assert.equal(stored.value.facts.version, reference.schemaVersion);
      assert.deepEqual(
        requestSettings,
        trace.attempts.map(() => ({
          model: reference.model,
          temperature: 0,
          maxOutputTokens: reference.requestLimits.maxOutputTokens,
          reasoningEffort: reference.requestLimits.reasoningEffort,
        }))
      );
      evidence.sameConditionsAs = {
        inputHash: reference.inputHash,
        implementationDigest: reference.implementationDigest,
      };
      evidence.stages.push(
        'real normal generation PDF/input/model/mode/contract/request limits match CLI conditions'
      );
    }
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
    if (reviewFixture) {
      const checked = parseFactSummary(
        JSON.stringify(stored.value.facts),
        reviewFixture.documentType,
        reviewFixture.pages
      );
      assert.deepEqual(checked, stored.value.facts);
      assert.equal(trace.attempts.length, reviewFixture.repairRequired ? 2 : 1);
      assert.equal(stored.value.facts.facts.length, reviewFixture.legacy.facts.length);
      assert.deepEqual(stored.value.facts.unverified, reviewFixture.warnings);
      if (reviewCase === 'inherited-outlook-yen' || reviewCase === 'period-outlook-units') {
        const rate = checked.facts.find((f: VerifiedFact) => f.label === '売上高営業利益率');
        const revenue = checked.facts.find((f: VerifiedFact) => f.label === '売上高');
        const forecast = checked.facts.find((f: VerifiedFact) => f.kind === 'event');
        assert.equal(rate?.period, '2026年3月期');
        assert.equal(revenue?.unit, '万円');
        assert.equal(forecast?.semantics.state, 'forecast');
        assert.equal(forecast?.semantics.polarity, 'negative');
        assert.ok(
          !trace.attempts[0].slots.some((s: any) => s.requirement.endsWith('当年営業利益率'))
        );
      }
      if (reviewCase === 'semantic-ownership') {
        assert.equal(checked.facts.length, 20);
        assert.equal(
          checked.facts.find((f: VerifiedFact) => f.label === '営業利益')?.importance,
          'key'
        );
        assert.ok(
          JSON.parse(trace.attempts[0].response).candidates.every(
            (c: any) => c.importance === 'detail'
          )
        );
        assert.ok(checked.unverified.some((d: string) => /STRUCTURE:数量後/.test(d)));
        assert.equal(
          checked.facts.find((f: VerifiedFact) => f.quote.includes('見込めません'))?.semantics
            .polarity,
          'negative'
        );
        assert.equal(
          checked.facts.find((f: VerifiedFact) => f.quote.includes('譲渡実行日'))?.dateRoles[0]
            .state,
          'planned'
        );
        assert.equal(checked.facts[0].semantics.subject, '株式会社テスト');
        assert.equal(
          checked.facts.find((f: VerifiedFact) => f.quote.includes('譲渡実行日'))?.semantics.state,
          'planned'
        );
        assert.deepEqual(
          checked.facts
            .filter((f: VerifiedFact) => f.quote.includes('株式取得を決議しましたが'))
            .map((f: VerifiedFact) => f.kind)
            .sort(),
          ['event', 'status']
        );
        assert.equal(checked.facts.filter((f: VerifiedFact) => f.label === '販売台数').length, 1);
        assert.equal(
          checked.facts.find((f: VerifiedFact) => f.label === '中間配当金')?.quantity?.raw,
          '10円50銭'
        );
        assert.equal(
          checked.facts.find((f: VerifiedFact) => f.quote.includes('取得しない'))?.semantics
            .polarity,
          'negative'
        );
        const rate = checked.facts.find((f: VerifiedFact) => f.label === '売上高営業利益率');
        const bounded = checked.facts.find((f: VerifiedFact) =>
          f.quote.includes('取得価額は100百万円以内')
        );
        const interval = checked.facts.find((f: VerifiedFact) => f.label === '販売件数');
        const dividend = checked.facts.find((f: VerifiedFact) => f.label === '年間配当金');
        assert.equal(rate?.semantics.periodKind, 'cumulativeQ2');
        assert.equal(bounded?.kind, 'event');
        assert.equal(bounded?.value, null);
        assert.equal(interval?.period, '2026年4月1日～2026年4月30日');
        assert.equal(interval?.semantics.periodKind, 'interval');
        assert.equal(dividend?.semantics.state, 'forecast');
        assert.equal(rate?.semantics.scope, '単体');
        assert.equal(
          checked.facts.find((f: VerifiedFact) => f.quote.includes('特別損失に計上する予定'))
            ?.semantics.periodKind,
          'fullYear'
        );
        assert.equal(
          checked.facts.find((f: VerifiedFact) => f.period === '2028年3月期' && f.kind === 'number')
            ?.semantics.periodKind,
          'fullYear'
        );
        assert.equal(
          trace.attempts[0].slots.find((s: any) => s.requirement.includes('損失の計上予定'))
            ?.expected.periodKind,
          undefined
        );
        assert.equal(
          checked.facts.find((f: VerifiedFact) => f.quote.includes('2029年3月期の業績予想を参照'))
            ?.period,
          null
        );
        assert.equal(
          checked.facts.find((f: VerifiedFact) => f.quote.includes('取得しないことを決定'))
            ?.semantics.state,
          'decided'
        );
        assert.equal(
          checked.facts.find((f: VerifiedFact) => f.quote.includes('2028年3月1日～2028年3月31日'))
            ?.period,
          '2028年3月1日～2028年3月31日'
        );
        assert.equal(
          checked.facts.find((f: VerifiedFact) => f.quote.includes('第2四半期の販売金額'))?.kind,
          'event'
        );
        assert.equal(
          checked.facts.find((f: VerifiedFact) => f.quote.includes('第2四半期の販売金額'))?.period,
          null
        );
        assert.ok(
          !trace.attempts[0].slots.some((s: any) => s.requirement.includes('通期予想の重要指標'))
        );
        assert.ok(
          !trace.attempts[0].slots.some(
            (s: any) => s.requirement.endsWith('当年営業利益率') && s.status !== 'satisfied'
          )
        );
        evidence.stages.push(
          'unit proof, cumulative period, ordered interval and context forecast share generation/storage meaning'
        );
      }
      if (reviewCase === 'period-outlook-units') {
        const rate = checked.facts.find((f: VerifiedFact) => f.label === '売上高営業利益率');
        const count = checked.facts.find((f: VerifiedFact) => f.label === '販売数量');
        const dividend = checked.facts.find((f: VerifiedFact) => f.label === '年間配当金');
        assert.equal(rate?.evidence.kind, 'table');
        assert.equal(count?.unit, '台');
        assert.equal(dividend?.semantics.state, 'forecast');
        assert.equal(dividend?.period, '2027年3月期');
        assert.ok(
          trace.attempts[0].slots.some(
            (s: any) => s.requirement.includes('配当の重要事実') && s.expected.state === 'forecast'
          )
        );
        evidence.stages.push('cross-page financial mappings coexist with forecast dividend repair');
      }
      if (reviewCase === 'prose-disclosures') {
        assert.equal(checked.facts[4].semantics.state, 'forecast');
        assert.equal(checked.facts[3].semantics.metricKind, 'rate');
      }
      if (reviewCase === 'repair')
        assert.ok(stored.value.facts.facts.every((f: VerifiedFact) => f.kind === 'event'));
      else if (reviewCase === 'attributes')
        assert.ok(
          stored.value.facts.facts.every(
            (f: VerifiedFact) => f.semantics.scope === '個別' && f.semantics.basis === 'IFRS'
          )
        );
      evidence.stages.push('current stored facts pass ordinary source meaning verification');
    } else assert.deepEqual(expectedErrors(item, stored.value.facts), []);
    await row.getByRole('button', { name: '非表示', exact: true }).click();
    const callsBefore = apiCalls;
    await row.getByRole('button', { name: '表示', exact: true }).click();
    await summary
      .getByRole('heading', { name: '全体要約', exact: true })
      .waitFor({ timeout: 10000 });
    assert.equal(apiCalls, callsBefore);
    assert.deepEqual(
      renderedFactErrors(stored.value.facts.facts, await displayedFacts(summary)),
      []
    );
    evidence.stages.push('hide/show/cache without API');
    const listUrl = page
      .frames()
      .find((f: any) => /I_list_|fixture-list/.test(f.url()))!
      .url();
    if (smartFull)
      await worker.evaluate(async () => chrome.storage.sync.set({ extractionMode: 'full' }));
    await page.reload();
    // Reload resets the list date. Restore the tested date before waiting for its table.
    await page.locator('#main_list').waitFor({ state: 'attached', timeout: 20000 });
    const listFrame = await (await page.locator('#main_list').elementHandle()).contentFrame();
    assert.ok(listFrame, 'reloaded disclosure iframe is available');
    await listFrame.goto(listUrl);
    await frame.locator('#main-list-table').waitFor({ timeout: 20000 });
    await row.getByRole('button', { name: '表示', exact: true }).click({ timeout: 20000 });
    await summary
      .getByRole('heading', { name: '全体要約', exact: true })
      .waitFor({ timeout: 10000 });
    assert.equal(apiCalls, callsBefore);
    const expectedRestored = stored.value.facts;
    assert.deepEqual(renderedFactErrors(expectedRestored.facts, await displayedFacts(summary)), []);
    const restoredValue = await worker.evaluate(
      async (request: any) => {
        const settings = await chrome.storage.sync.get(['provider', 'model', 'extractionMode']);
        const fingerprint = `v${request.version}:${encodeURIComponent(settings.provider)}:${encodeURIComponent(settings.model)}:${settings.extractionMode}`;
        return (await chrome.storage.local.get(`summaryCacheV2:${fingerprint}:${request.pdfUrl}`))[
          `summaryCacheV2:${fingerprint}:${request.pdfUrl}`
        ];
      },
      { version: ANALYSIS_SCHEMA_VERSION, pdfUrl }
    );
    assert.deepEqual(restoredValue.facts, expectedRestored);
    assert.equal(restoredValue.metadata.extractionMode, 'full');
    evidence.restoredFacts = restoredValue.facts;
    evidence.stages.push('page reload restores exact configured-mode facts without API');

    if (reviewDiagnostics) {
      // A cached result has no current request ID, but its exact result ID must match.
      const restoredDownload = page.waitForEvent('download', { timeout: 10000 });
      await row.getByRole('button', { name: '診断を保存', exact: true }).click();
      const restored = await restoredDownload;
      assert.deepEqual(JSON.parse(await readFile(await restored.path(), 'utf8')), trace);
      evidence.stages.push('cached result ID matches diagnostic export after reload');
      await worker.evaluate(async () => chrome.storage.sync.set({ apiKey: '' }));
      await summary.getByRole('button', { name: '再要約', exact: true }).click();
      await summary
        .getByText('APIキーが設定されていません', { exact: false })
        .waitFor({ timeout: 10000 });
      const failedDownload = page.waitForEvent('download', { timeout: 10000 });
      await row.getByRole('button', { name: '診断を保存', exact: true }).click();
      const failed = await failedDownload;
      assert.equal(apiCalls, callsBefore);
      const failure = await worker.evaluate(
        async () => (await chrome.storage.local.get('summaryLastRunV1')).summaryLastRunV1
      );
      assert.notEqual(failure.runId, trace.runId);
      assert.equal(failure.outcome, 'failure');
      assert.equal(failure.error, 'APIキーが設定されていません');
      assert.equal(failure.resultId, null);
      assert.equal(failure.provider, null);
      assert.equal(failure.documentHash, null);
      assert.equal(failure.inputHash, null);
      assert.deepEqual(failure.attempts, []);
      assert.deepEqual(failure.usage, []);
      assert.deepEqual(JSON.parse(await readFile(await failed.path(), 'utf8')), failure);
      evidence.earlyFailureTrace = failure;
      evidence.stages.push(
        'same-PDF settings failure exports its own trace without stale response or API call'
      );
      await context.close();
      context = null;
      evidence.success = true;
      return;
    }

    if (reviewFixture) {
      const priorCalls = apiCalls;
      const restoredDownload = page.waitForEvent('download', { timeout: 10000 });
      await row.getByRole('button', { name: '診断を保存', exact: true }).click();
      const restored = await restoredDownload;
      assert.deepEqual(JSON.parse(await readFile(await restored.path(), 'utf8')), trace);
      evidence.stages.push('restored result ID matches exported diagnostic');
      const altered = structuredClone(reviewFixture.legacy);
      if (reviewCase === 'attributes') {
        altered.facts[0].semantics.scope = '連結';
        altered.facts[0].semantics.basis = '日本基準';
        altered.facts[0].id = stableFactId(altered.facts[0]);
      } else {
        altered.facts[0].semantics.polarity =
          altered.facts[0].semantics.polarity === 'affirmative' ? 'negative' : 'affirmative';
        altered.facts[0].id = stableFactId(altered.facts[0]);
      }
      const extensionPage = await context.newPage();
      await extensionPage.goto(await worker.evaluate(() => chrome.runtime.getURL('options.html')));
      const invalid = await extensionPage.evaluate(
        async (request: any) => chrome.runtime.sendMessage(request),
        {
          action: 'analyze',
          pdfUrl,
          title: item.title,
          code: '1234',
          companyName: '株式会社テスト',
          facts: altered,
          resultId: stored.value.resultId,
          fingerprint: stored.value.metadata.analysisFingerprint,
        }
      );
      await extensionPage.close();
      assert.equal(typeof invalid.error, 'string');
      assert.ok(invalid.error.includes('識別子'));
      assert.equal(apiCalls, priorCalls);
      evidence.stages.push('altered saved facts refused before followup API');
    }
    if ((!fixed || reviewFixture) && args.includes('--live-followups')) {
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
      assert.ok((await summary.innerText()).includes('全体要約'));
      evidence.stages.push(
        reviewFixture
          ? 'fixed additional analysis preserves rechecked facts'
          : 'live additional analysis preserves facts'
      );
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
      assert.ok(evidence.followupRendered.includes('全体要約'));
      const score = await worker.evaluate(async () => {
        const entries = await chrome.storage.local.get();
        return Object.entries(entries).find(([k]) => k.startsWith('scoreCacheV4:'))?.[1];
      });
      evidence.score = score ?? null;
      evidence.stages.push(
        score
          ? 'scoring returns native score'
          : 'scoring refuses unverifiable comparison; summary retained'
      );
    }
    if (fixed && !reviewFixture) {
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
      assert.ok((await summary.innerText()).includes('全体要約'));
      evidence.stages.push('explicit additional analysis while scoring OFF');
      failScore = true;
      await worker.evaluate(async () => chrome.storage.sync.set({ experimentalScoring: true }));
      await summary
        .getByRole('button', { name: '採点を再試行', exact: true })
        .waitFor({ timeout: 30000 });
      assert.ok((await summary.innerText()).includes('全体要約'));
      evidence.stages.push('scoring ON failure preserves summary');
      failScore = false;
      await summary.getByRole('button', { name: '採点を再試行', exact: true }).click();
      await page.waitForFunction(
        (compare) =>
          document
            .querySelector<HTMLIFrameElement>('#main_list')
            ?.contentDocument?.querySelector('.tdnet-digest-summary-row #score-result')
            ?.textContent?.includes(compare ? '55' : '比較値'),
        withComparison,
        { timeout: 30000 }
      );
      assert.ok((await summary.innerText()).includes('全体要約'));
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
        async (request: any) => {
          const settings = await chrome.storage.sync.get(['provider', 'model', 'extractionMode']);
          const fingerprint = `v${request.version}:${encodeURIComponent(settings.provider)}:${encodeURIComponent(settings.model)}:${settings.extractionMode}`;
          const key = `summaryCacheV2:${fingerprint}:${request.pdfUrl}`;
          const entry = { key, value: (await chrome.storage.local.get(key))[key] };
          if (!entry.value) throw new Error('現在の設定で復元したキャッシュがありません');
          await chrome.storage.local.set({
            [entry.key]: { ...entry.value, facts: { ...entry.value.facts, version: 3 } },
          });
        },
        { version: ANALYSIS_SCHEMA_VERSION, pdfUrl }
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
    releaseFirstResponse();
    if (context) await context.close();
    await rm(profile, { recursive: true, force: true });
    evidence.elapsedSeconds = Math.round((performance.now() - started) / 1000);
    evidence.apiCalls = apiCalls;
    await mkdir('evaluation/results/local', { recursive: true });
    const runId = new Date().toISOString().replace(/[:.]/g, '-');
    await writeFile(
      `evaluation/results/local/${item.id}${reviewCase ? `-review-${reviewCase}` : ''}-${runId}-browser.json`,
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
