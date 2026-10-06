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
import { buildPresentation } from '../../src/lib/summary-presentation';
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
/** Verify both the selectable JSON and the actual clipboard, after the user's click. */
async function copiedDiagnostic(row: any, page: any, blocked = false) {
  await row.getByRole('button', { name: '診断をコピー', exact: true }).click();
  if (blocked)
    await row
      .getByRole('alert')
      .filter({ hasText: 'コピーできませんでした' })
      .waitFor({ timeout: 10000 });
  else
    await row.getByRole('status').filter({ hasText: 'コピーしました' }).waitFor({ timeout: 10000 });
  if (!blocked) await row.getByText('診断JSONを表示', { exact: true }).click();
  const text = await row.getByRole('textbox', { name: '診断JSON', exact: true }).inputValue();
  if (blocked) {
    const box = row.getByRole('textbox', { name: '診断JSON', exact: true });
    await box.focus();
    assert.equal(
      await box.evaluate((el: HTMLTextAreaElement) =>
        el.value.slice(el.selectionStart, el.selectionEnd)
      ),
      text
    );
    return JSON.parse(text);
  }
  // Grant read only after copying; the extension must write through the click itself.
  await page
    .context()
    .grantPermissions(['clipboard-read'], { origin: 'https://www.release.tdnet.info' });
  try {
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), text);
  } finally {
    await page.context().clearPermissions();
  }
  return JSON.parse(text);
}
/** Read each visible fact with its shared table context; never use the entire body as one fact. */
async function displayedFacts(summary: any): Promise<string[]> {
  return summary.evaluate(
    new Function(
      'root',
      `
    const text = (node) => node?.textContent ?? '';
    const first = root.querySelector('h2');
    const shared =
      text(root.querySelector('h4')) +
      ' ' +
      (first?.previousElementSibling?.tagName === 'P' ? text(first.previousElementSibling) : '');
    const context = (node) =>
      node.previousElementSibling?.tagName === 'P' ? text(node.previousElementSibling) : '';
    const refs = (node) =>
      node.nextElementSibling?.tagName === 'P' && text(node.nextElementSibling).startsWith('根拠：')
        ? text(node.nextElementSibling)
        : '';
    return [
      ...Array.from(root.querySelectorAll('li'))
        .filter((node) => !node.closest('details'))
        .map(
          (node) =>
            shared +
            ' ' +
            context(node.closest('ul')) +
            ' ' +
            text(node) +
            ' ' +
            refs(node.closest('ul'))
        ),
      ...Array.from(root.querySelectorAll('tbody tr')).flatMap((row) => {
        const table = row.closest('table');
        const wrapper = table.parentElement;
        const headers = Array.from(table.querySelectorAll('thead th'));
        const cells = Array.from(row.children);
        const notes =
          text(headers.at(-1) ?? null) === '条件・基準' ? text(cells.at(-1) ?? null) : '';
        return cells.slice(1, text(headers.at(-1) ?? null) === '条件・基準' ? -1 : undefined).map((cell, offset) => {
          const index = offset + 1;
          const header = text(headers[index]);
          const period = header === '比率（％）' ? text(headers[index - 1]) : header;
          const unit = header.match(/（([^）]+)）$/)?.[1] ?? '';
          // One value cell with its own period, unit, row label and common context.
          return (
            shared +
            ' ' +
            context(wrapper) +
            ' ' +
            text(cells[0]) +
            ' ' +
            period +
            ' ' +
            text(cell) +
            unit +
            ' ' +
            notes +
            ' ' +
            refs(wrapper)
          );
        });
      }),
    ];
  `
    )
  );
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
    throw new Error('追加レビューは固定API・固定PDF専用です');
  const copyBlocked = args.includes('--review-copy-blocked');
  if (copyBlocked && !args.includes('--review-rejected-url'))
    throw new Error('コピー拒否検証は生成前エラーの固定経路専用です');
  const reviewFixture = reviewCase ? await additionalReviewFixture(reviewCase) : null;
  if (reviewFixture)
    item = {
      ...item,
      ...(reviewCase === 'summary-format-kyokuto' ? { id: 'kyokuto-20261005', code: '2300' } : {}),
      ...(reviewCase === 'summary-format-karura' ? { id: 'karura-20261005', code: '2789' } : {}),
      ...(reviewCase === 'summary-format-daiseki' ? { id: 'daiseki-20261005', code: '9793' } : {}),
      ...(reviewCase === 'summary-format-echo' ? { id: 'echo-20261005', code: '7427' } : {}),
      ...(reviewCase === 'summary-format-world' ? { id: 'world-20261005', code: '3612' } : {}),
      ...(reviewCase === 'summary-format-createsd'
        ? { id: 'createsd-20261005', code: '3148' }
        : {}),
      ...(reviewCase?.startsWith('summary-format-nachi')
        ? {
            id:
              reviewCase === 'summary-format-nachi-comparison'
                ? 'nachi-comparison-20261005'
                : 'nachi-20261005',
            code: '6474',
          }
        : {}),
      documentType: reviewFixture.documentType,
      title:
        reviewCase === 'summary-format-echo'
          ? '2027年２月期第２四半期（中間期）業績予想の修正に関するお知らせ'
          : reviewCase === 'summary-format-world'
            ? '2027年２月期 第２四半期（中間期）決算短信〔ＩＦＲＳ〕（連結）'
            : reviewCase === 'summary-format-createsd'
              ? '2027年５月期 第１四半期決算短信〔日本基準〕（連結）'
              : reviewCase === 'summary-format-kyokuto'
                ? '2027年２月期第２四半期（中間期）決算短信〔日本基準〕（非連結）'
                : reviewCase === 'summary-format-karura' || reviewCase === 'summary-format-daiseki'
                  ? '2027年２月期第２四半期（中間期）決算短信〔日本基準〕（連結）'
                  : reviewCase?.startsWith('summary-format-nachi')
                    ? '2026年11月期 第３四半期決算短信〔日本基準〕（連結）'
                    : reviewFixture.documentType === 'earnings'
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
  const narrativeReplay = args.includes('--narrative-replay')
    ? JSON.parse(await readFile(arg('--narrative-replay'), 'utf8'))
    : null;
  if (
    narrativeReplay &&
    (!fixed ||
      !fixtureSource ||
      reviewCase ||
      !narrativeReplay.result ||
      narrativeReplay.presentation?.version !== 6 ||
      !narrativeReplay.presentation?.organization ||
      narrativeReplay.item.id !== item.id)
  )
    throw new Error('説明要約の再生は同じ資料の生成・点検済み記録・固定API・固定PDF専用です');
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
        ? reviewCase === 'summary-format-kyokuto' ||
          reviewCase === 'summary-format-karura' ||
          reviewCase?.startsWith('summary-format-nachi') ||
          reviewCase === 'summary-format-daiseki' ||
          reviewCase === 'summary-format-world' ||
          reviewCase === 'summary-format-createsd' ||
          reviewCase === 'summary-format-echo'
          ? 'public-PDF-through-offscreen'
          : 'synthetic-PDF-through-offscreen'
        : fixtureSource
          ? 'fixture'
          : 'TDnet',
    buildDigest,
    sourceBuildDigest: sourceDigest,
    stages: [],
    narrativeReplay: narrativeReplay ? arg('--narrative-replay') : null,
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
      if (!source && !reviewFixture && !narrativeReplay) throw new Error('固定候補がありません');
      const fixedFacts = (reviewFixture
        ? []
        : structuredClone(source?.facts ?? [])) as unknown as CandidateFact[];
      const fixture = corpus.find((c) => c.id === item.id)!;
      const sourcePages = reviewFixture
        ? reviewFixture.pages
        : (fixture?.pages ?? []).map((p) => extractPageLayout(p.items as TextItem[], p.pageNumber));
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
        if (narrativeReplay) {
          const attempt = narrativeReplay.attempts[apiCalls - 1];
          if (!attempt) throw new Error('固定した説明要約の応答を使い切りました');
          await route.fulfill({
            contentType: 'application/json',
            body: JSON.stringify({
              choices: [{ message: { content: attempt.response }, finish_reason: 'stop' }],
            }),
          });
          return;
        }
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
          headers: copyBlocked ? { 'Permissions-Policy': 'clipboard-write=()' } : {},
          body: '<html><meta charset="utf-8"><iframe id="main_list" src="fixture-list.html" style="width:100%;height:880px"></iframe></html>',
        })
      );
      await context.route('https://www.release.tdnet.info/inbs/fixture-list.html', (route: any) =>
        route.fulfill({
          contentType: 'text/html',
          headers: copyBlocked ? { 'Permissions-Policy': 'clipboard-write=()' } : {},
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
      assert.deepEqual(await copiedDiagnostic(row, page, copyBlocked), trace);
      assert.equal(apiCalls, 0);
      assert.equal(pdfRequests, 0);
      evidence.trace = trace;
      evidence.pdfRequests = pdfRequests;
      evidence.stages.push(
        copyBlocked
          ? 'rejected URL → clipboard denied → selectable JSON; PDF/API requests 0'
          : 'rejected URL → own failed run → diagnostic clipboard copy; PDF/API requests 0'
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
        .getByRole('heading', { name: '開示の要点', exact: true })
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
      assert.deepEqual(await copiedDiagnostic(row, page), trace);
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
            ? ['2026年6月', '338214', 'NJSS', '速報']
            : [];
    for (const term of expected)
      assert.ok(
        body.replace(/(?<=\d),(?=\d)/g, '').includes(term),
        `表示に必要な意味がない: ${term}`
      );
    if (!reviewFixture && item.id.startsWith('monthly'))
      assert.ok(
        ['修正する可能性', '修正される可能性', '修正の可能性'].some((term) => body.includes(term)),
        '月次の速報値が修正される可能性の説明がない'
      );
    const stored = await worker.evaluate(async (version: number) => {
      const data = await chrome.storage.local.get();
      const entry = Object.entries(data).find(
        ([key, value]: [string, any]) =>
          key.startsWith(`summaryCacheV2:v${version}:`) && value.metadata?.extractionMode === 'full'
      );
      return entry ? { key: entry[0], value: entry[1] } : null;
    }, ANALYSIS_SCHEMA_VERSION);
    assert.ok(stored?.value?.facts?.version === FACT_SCHEMA_VERSION);
    assert.ok(stored.value.presentation?.version === 6);
    if (narrativeReplay) {
      // UI replay must preserve the model evaluation outcome, including warnings.
      // It is not a way to turn a failed model assessment into a success.
      const replayErrors = expectedErrors(item, stored.value.facts);
      assert.deepEqual(replayErrors, narrativeReplay.errors);
      assert.deepEqual(stored.value.presentation, narrativeReplay.presentation);
      assert.deepEqual(stored.value.facts, narrativeReplay.result);
      assert.equal(stored.value.metadata.generationCalls, apiCalls);
      assert.equal(apiCalls, narrativeReplay.attempts.length);
      const reading = (await summary.innerText()).normalize('NFKC').replace(/\s|,/g, '');
      assert.ok(!reading.includes('原文抜粋'));
      assert.ok(!reading.includes('本資料に記載されている業績予想につきましては'));
      const tokens = item.id.startsWith('world')
        ? ['B2C', 'B2B', '共通部門', '4559', '3089', '637', 'IFRS']
        : item.id.startsWith('kyokuto')
          ? ['営業', '投資', '財務', '374683', '64186', '265834', '311963']
          : [];
      for (const token of tokens)
        assert.ok(reading.includes(token), `通常表示の要点欠落: ${token}`);
      if (item.id.startsWith('kyokuto'))
        // Cash movement can be stated as the independently verified starting
        // balance (267,301) or the increase (44,662), alongside the closing balance.
        assert.ok(
          reading.includes('267301') || reading.includes('44662'),
          '現金残高の変化がありません'
        );
      if (item.id.startsWith('world')) {
        const rows = await summary.locator('table tbody tr').allTextContents();
        // Independent expectations from the source PDF: the rate must be in
        // the same row, so a prose mention elsewhere cannot mask its absence.
        // Calculated rates use independently verified rounded source amounts;
        // B2B 3,089 / 2,752 gives 12.2%, distinct from the reported 12.3%.
        for (const [business, profit, rate, calculated] of [
          ['B2C', '4559', '0.1%', '0.1%'],
          ['B2B', '3089', '12.3%', '12.2%'],
          ['共通部門', '637', '39.4%', '39.4%'],
        ])
          assert.ok(
            rows.some((row: string) => {
              const text = row.normalize('NFKC').replace(/\s|,/g, '');
              return (
                text.includes(business) &&
                text.includes(profit) &&
                (text.includes(rate) || (text.includes('約') && text.includes(calculated)))
              );
            }),
            `事業別の同一行比較がありません: ${business} ${rate}`
          );
      }
      const toggles = summary.locator('details.tdnet-digest-source');
      assert.ok(await toggles.count());
      assert.ok(
        await toggles.evaluateAll((nodes: HTMLDetailsElement[]) => nodes.every((n) => !n.open))
      );
      await page.screenshot({ path: `evaluation/results/local/${item.id}-v94-summary-top.png` });
      for (const [title, suffix] of [
        ['事業別業績', 'business'],
        ['キャッシュフロー', 'cash-flow'],
      ]) {
        const heading = summary.getByRole('heading', { name: title, exact: true });
        if (!(await heading.count())) continue;
        await heading.scrollIntoViewIfNeeded();
        await heading.evaluate((node: HTMLElement) => {
          const view = node.ownerDocument.defaultView!;
          view.scrollTo(0, view.scrollY + node.getBoundingClientRect().top - 16);
        });
        await page.screenshot({
          path: `evaluation/results/local/${item.id}-v94-summary-${suffix}.png`,
        });
      }
      await summary.evaluate((node: HTMLElement) => node.ownerDocument.defaultView!.scrollTo(0, 0));
      await page.setViewportSize({ width: 600, height: 800 });
      await page.screenshot({ path: `evaluation/results/local/${item.id}-v94-summary-narrow.png` });
      await toggles.evaluateAll((nodes: HTMLDetailsElement[]) =>
        nodes.forEach((n) => (n.open = true))
      );
      const original = (await summary.innerText()).normalize('NFKC').replace(/\s/g, '');
      for (const excerpt of stored.value.presentation.excerpts)
        assert.ok(
          original.includes(excerpt.text.normalize('NFKC').replace(/\s/g, '')),
          `原文欠落: ${excerpt.id}`
        );
      await toggles.evaluateAll((nodes: HTMLDetailsElement[]) =>
        nodes.forEach((n) => (n.open = false))
      );
      await row.getByRole('button', { name: '非表示', exact: true }).click();
      assert.equal(await frame.locator('.tdnet-digest-summary-row').count(), 0);
      await row.getByRole('button', { name: '表示', exact: true }).click();
      await summary.waitFor();
      assert.equal((await summary.innerText()).normalize('NFKC').replace(/\s|,/g, ''), reading);
      assert.equal(apiCalls, narrativeReplay.attempts.length);
      evidence.presentation = stored.value.presentation;
      evidence.modelEvaluationSuccess = narrativeReplay.success;
      evidence.modelEvaluationErrors = narrativeReplay.errors;
      evidence.metadata = stored.value.metadata;
      evidence.reading = reading;
      evidence.pdfHash = pdfHash;
      const trace = await worker.evaluate(
        async () => (await chrome.storage.local.get('summaryLastRunV1')).summaryLastRunV1
      );
      assert.equal(
        trace.outcome,
        narrativeReplay.result.unverified.length ||
          ['partial', 'unavailable'].includes(narrativeReplay.presentation.organization.status)
          ? 'partialSuccess'
          : narrativeReplay.repairAttempted
            ? 'repairSuccess'
            : 'firstSuccess'
      );
      assert.deepEqual(
        trace.attempts.map((a: any) => a.phase),
        narrativeReplay.attempts.map((a: any) => a.phase)
      );
      assert.deepEqual(await copiedDiagnostic(row, page), trace);
      evidence.trace = trace;
      evidence.stages.push(
        'public PDF → Offscreen → replayed extraction/synthesis/review → exact facts/presentation → closed source toggles → full original → cache restore without API → diagnostic clipboard'
      );
      await context.close();
      context = null;
      evidence.success = true;
      return;
    }
    if (
      !reviewFixture &&
      !withComparison &&
      !reviewSettingsChange &&
      item.id === 'bluememe-20260930'
    ) {
      const reading = (await displayedFacts(summary))
        .join('\n')
        .normalize('NFKC')
        .replace(/\s/g, '');
      for (const term of [
        '売上高:↑増収約+39.5%3,298百万円(前期2,365百万円)',
        '営業利益:↑増益約+20.5%47百万円(前期39百万円)',
        '経常利益:↑増益約+75.9%51百万円(前期29百万円)',
        '純利益:↑黒字転換24百万円(前期-10百万円)',
      ])
        assert.ok(reading.includes(term), `成長率・黒字転換が欠落: ${term}`);
      evidence.reading = reading;
    }
    if (reviewCase === 'summary-format-world') {
      const overview = body.split('業績と増減要因')[0].normalize('NFKC').replace(/\s|,/g, '');
      assert.ok(overview.includes('親会社の所有者に帰属する中間利益'));
      for (const term of ['約+4.2%', '5877百万円', '5640百万円'])
        assert.ok(overview.includes(term), `中間利益の当期比較が欠落: ${term}`);
      assert.ok(!overview.includes('12600百万円'), '通期予想が当期実績へ混入しました');
      assert.ok(!overview.includes('サステナビリティ'));
      assert.equal((overview.match(/会社説明\(原文抜粋\)/g) ?? []).length, 1);
      const reading = (await displayedFacts(summary))
        .join('\n')
        .normalize('NFKC')
        .replace(/\s/g, '');
      const excerpts = await summary
        .locator('li')
        .evaluateAll((nodes: HTMLElement[]) =>
          nodes.filter((n) => !n.closest('details')).map((n) => n.textContent?.trim() ?? '')
        );
      assert.ok(
        !excerpts.some((text: string) => /^[)）]を早期適用/.test(text)),
        '引用内の句点で文が分断されました'
      );
      assert.ok(reading.includes('人材オペレーション'), 'ページをまたぐ説明が分断されました');
      assert.ok(!reading.includes('これらの業績予想のみに依拠して投資判断'));
      assert.ok(!reading.includes('業績予想の前提となる条件及び業績予想のご利用'));
      assert.ok(!excerpts.some((text: string) => text === '純損益に振替えられる可能性のある項目'));
      evidence.reading = reading;
      const facts = stored.value.facts.facts;
      for (const [value, year] of [
        [77.11, 2027],
        [82.74, 2026],
      ]) {
        const eps = facts.find(
          (f: any) =>
            f.value === value && f.label.startsWith('基本的') && f.period.startsWith(String(year))
        );
        assert.ok(eps, `基本EPSの当年・前年が欠落: ${year}`);
        assert.equal(eps.unit, '円');
        assert.ok(
          eps.provenance.adjustments.some((a: any) => a.basis === 'splitAdjusted'),
          'EPSの分割注記が欠落'
        );
      }
      assert.equal(completedTrace.outcome, 'firstSuccess');
    }
    if (reviewCase === 'summary-format-createsd') {
      const facts = stored.value.facts.facts;
      for (const [value, periodKind] of [
        [262800, 'cumulativeQ2'],
        [541000, 'fullYear'],
      ] as const) {
        const f = facts.find((f: any) => f.value === value && f.label === '売上高');
        assert.equal(f?.semantics.periodKind, periodKind);
        assert.equal(f?.semantics.state, 'forecast');
      }
      assert.equal(completedTrace.outcome, 'firstSuccess');
      assert.deepEqual(stored.value.facts.unverified, []);
    }
    if (reviewCase === 'summary-format-daiseki') {
      const reading = (await displayedFacts(summary))
        .join('\n')
        .normalize('NFKC')
        .replace(/\s/g, '');
      for (const term of ['74,200', '11,200', '業績予想:変更なし', '配当予想:変更なし'])
        assert.ok(reading.includes(term), `金額・修正有無が欠落: ${term}`);
      assert.equal(completedTrace.outcome, 'repairSuccess');
      const [first, repair] = completedTrace.attempts;
      assert.equal(first.confirmedIds.length, 17);
      assert.equal(first.slots.filter((s: any) => s.status !== 'satisfied').length, 4);
      assert.equal(repair.confirmedIds.length, 21);
      assert.ok(first.confirmedIds.every((id: string) => repair.confirmedIds.includes(id)));
      assert.ok(stored.value.facts.facts.some((f: any) => f.evidence.blockId === 'p4b14'));
      assert.ok(!stored.value.facts.facts.some((f: any) => f.evidence.blockId === 'p1b42'));
      evidence.reading = reading;
    }
    if (reviewCase?.startsWith('summary-format-nachi')) {
      const reading = (await displayedFacts(summary))
        .join('\n')
        .normalize('NFKC')
        .replace(/\s/g, '');
      for (const blockId of ['p2b11', 'p2b12', 'p2b13']) {
        const original = stored.value.presentation.excerpts.find((e: any) => e.blockId === blockId);
        assert.ok(original, `定型文の全文保持が欠落: ${blockId}`);
        assert.equal(original.role, 'document');
        assert.ok(
          !reading.includes(original.text.normalize('NFKC').replace(/\s/g, '')),
          `定型文が通常表示へ混入: ${blockId}`
        );
      }
      const previous = stored.value.facts.facts.filter((f: any) =>
        f.period?.startsWith('2025年11月期')
      );
      assert.equal(previous.length, 5);
      for (const term of [
        '売上高:↑増収約+10.4%192,326百万円(前年同期174,194百万円)',
        '営業利益:↑増益約+72.9%11,457百万円(前年同期6,628百万円)',
        '経常利益:↑増益約+111.5%10,873百万円(前年同期5,141百万円)',
        '純利益:↑増益約+82.1%6,629百万円(前年同期3,640百万円)',
      ])
        assert.ok(reading.includes(term), `前年の確定値による比較が欠落: ${term}`);
      if (reviewCase === 'summary-format-nachi') {
        assert.equal(completedTrace.outcome, 'repairSuccess');
        const [first, repair] = completedTrace.attempts;
        assert.equal(first.confirmedIds.length, 14);
        const missing = first.slots.filter((s: any) => s.requirement.includes('前年決算実績'));
        assert.equal(missing.length, 5);
        assert.ok(missing.every((s: any) => s.status === 'absent'));
        assert.equal(repair.confirmedIds.length, 19);
        assert.ok(first.confirmedIds.every((id: string) => repair.confirmedIds.includes(id)));
      }
      evidence.reading = reading;
    }
    if (reviewCase === 'summary-format-karura') {
      const reading = (await displayedFacts(summary))
        .join('\n')
        .normalize('NFKC')
        .replace(/\s/g, '');
      for (const term of [
        '売上高:↑増収約+1.4%3,989百万円(前年同期3,935百万円)',
        '営業利益:↓減益約−20.1%211百万円(前年同期264百万円)',
        '経常利益:↓減益約−17.9%215百万円(前年同期262百万円)',
        '純利益:↓減益約−66.1%83百万円(前年同期245百万円)',
        '修正あり',
        '修正前の数値・方向は本資料では未確認',
        '人件費及び原材料費',
      ])
        assert.ok(reading.includes(term), `冒頭の変化・説明が欠落: ${term}`);
      for (const blockId of ['p2b14', 'p3b3', 'p3b4', 'p11b4', 'p11b7', 'p11b9']) {
        const original = stored.value.presentation.excerpts.find((e: any) => e.blockId === blockId);
        assert.ok(original, `原文保持が欠落: ${blockId}`);
        assert.ok(
          !reading.includes(original.text.normalize('NFKC').replace(/\s/g, '')),
          `定型文が通常表示へ混入: ${blockId}`
        );
      }
      assert.ok(
        stored.value.presentation.sections
          .find((s: any) => s.title === '通期見通し・前提')
          .excerptIds.includes('source:p5b11')
      );
      evidence.reading = reading;
    }
    if (reviewCase === 'summary-format-kyokuto') {
      const headings = await summary.locator('h2').allTextContents();
      for (const title of ['業績と増減要因', '通期見通し・前提', '配当', '財政状態・資金の動き'])
        assert.equal(headings.filter((heading: string) => heading === title).length, 1);
      assert.ok(!headings.some((heading: string) => /^[１-９1-9（(]/.test(heading)));
      const performance = stored.value.presentation.sections.find(
        (section: any) => section.title === '業績と増減要因'
      );
      assert.ok(
        performance.excerptIds.includes('source:p1b8') &&
          performance.excerptIds.includes('source:p4b7')
      );
      const finance = stored.value.presentation.sections.find(
        (section: any) => section.title === '財政状態・資金の動き'
      );
      assert.ok(finance.excerptIds.includes('source:p7b5'), '貸借対照表の続きは同じ話題へ保持');
      assert.ok(body.includes('前年同期 3,130') && body.includes('前年同期 309'));
      for (const term of ['燃料費', '節約志向', '季節', '年間11']) assert.ok(body.includes(term));
      const reading = (await displayedFacts(summary))
        .join('\n')
        .normalize('NFKC')
        .replace(/\s/g, '');
      for (const term of [
        '燃料費',
        '節約志向',
        '3月から5月に偏る',
        '新規出店3店舗',
        '470店舗',
        '長期化した場合',
        '4.9%',
        '20.2%',
        '18.8%',
        '15.5%',
      ])
        assert.ok(reading.includes(term), `通常表示の説明が欠落: ${term}`);
      for (const block of ['p4b3', 'p4b4', 'p4b7', 'p4b8', 'p4b9']) {
        const original = stored.value.presentation.excerpts.find(
          (e: any) => e.blockId === block
        ).text;
        assert.ok(
          !reading.includes(original.normalize('NFKC').replace(/\s/g, '')),
          `段落全文が抜粋として重複: ${block}`
        );
      }
    }
    const sourceToggles = summary.locator('details.tdnet-digest-source');
    assert.equal(
      await sourceToggles.evaluateAll((nodes: HTMLDetailsElement[]) =>
        nodes.some((node) => node.open)
      ),
      false
    );
    assert.equal(await summary.locator('details').filter({ hasText: '生成情報' }).count(), 1);
    evidence.presentation = stored.value.presentation;
    await page.screenshot({ path: `evaluation/results/local/${item.id}-summary-top.png` });
    await page.setViewportSize({ width: 600, height: 800 });
    await page.screenshot({ path: `evaluation/results/local/${item.id}-summary-narrow.png` });
    await page.setViewportSize({ width: 1280, height: 900 });
    assert.equal(await summary.locator('blockquote').count(), 0);
    if (await sourceToggles.count()) {
      await sourceToggles.first().locator('summary').click();
      assert.equal(
        await sourceToggles.first().evaluate((node: HTMLDetailsElement) => node.open),
        true
      );
      await sourceToggles.evaluateAll((nodes: HTMLDetailsElement[]) => {
        for (const node of nodes) node.open = true;
      });
    }
    const visibleText = (await summary.innerText()).normalize('NFKC').replace(/\s/g, '');
    for (const excerpt of stored.value.presentation.excerpts)
      assert.ok(
        visibleText.includes(excerpt.text.normalize('NFKC').replace(/\s/g, '')),
        `原文の表示が欠落: ${excerpt.id}`
      );
    if (await sourceToggles.count()) {
      await sourceToggles.first().scrollIntoViewIfNeeded();
      await page.screenshot({ path: `evaluation/results/local/${item.id}-summary-supplement.png` });
      await sourceToggles.first().locator('summary').click();
      assert.equal(
        await sourceToggles.first().evaluate((node: HTMLDetailsElement) => node.open),
        false
      );
      await sourceToggles.evaluateAll((nodes: HTMLDetailsElement[]) => {
        for (const node of nodes) node.open = false;
      });
      evidence.stages.push(
        'source toggles closed initially; open reveals all source; close preserves facts'
      );
    }
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
    const exported = await copiedDiagnostic(row, page);
    assert.deepEqual(exported, trace);
    evidence.stages.push('phase/raw/diagnostics/hash/usage trace copied from UI');
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
      .getByRole('heading', { name: '開示の要点', exact: true })
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
      .getByRole('heading', { name: '開示の要点', exact: true })
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
      assert.deepEqual(await copiedDiagnostic(row, page), trace);
      evidence.stages.push('cached result ID matches diagnostic export after reload');
      await worker.evaluate(async () => chrome.storage.sync.set({ apiKey: '' }));
      await summary.getByRole('button', { name: '再要約', exact: true }).click();
      await summary
        .getByText('APIキーが設定されていません', { exact: false })
        .waitFor({ timeout: 10000 });
      const failed = await copiedDiagnostic(row, page);
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
      assert.deepEqual(failed, failure);
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
      assert.deepEqual(await copiedDiagnostic(row, page), trace);
      evidence.stages.push('restored result ID matches exported diagnostic');
      const altered = structuredClone(stored.value.facts);
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
          presentation: buildPresentation(altered, reviewFixture.pages),
          resultId: stored.value.resultId,
          fingerprint: stored.value.metadata.analysisFingerprint,
        }
      );
      await extensionPage.close();
      assert.equal(typeof invalid.error, 'string');
      assert.ok(/(?:冒頭要約|本文)の参照|識別子/.test(invalid.error), invalid.error);
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
      assert.ok((await summary.innerText()).includes('開示の要点'));
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
      assert.ok(evidence.followupRendered.includes('開示の要点'));
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
      assert.ok((await summary.innerText()).includes('開示の要点'));
      evidence.stages.push('explicit additional analysis while scoring OFF');
      failScore = true;
      await worker.evaluate(async () => chrome.storage.sync.set({ experimentalScoring: true }));
      await summary
        .getByRole('button', { name: '採点を再試行', exact: true })
        .waitFor({ timeout: 30000 });
      assert.ok((await summary.innerText()).includes('開示の要点'));
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
      assert.ok((await summary.innerText()).includes('開示の要点'));
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
