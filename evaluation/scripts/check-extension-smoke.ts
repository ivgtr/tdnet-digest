/** Thin, credential-free real-extension smoke. Detailed semantics belong to contract tests. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateSavedFacts } from '../../src/lib/fact-cache';
import { validatePresentation } from '../../src/lib/summary-presentation';
import { SUMMARY_DIAGNOSTICS_KEY } from '../../src/lib/summary-trace';
import {
  preflightExtensionSmoke,
  SMOKE_API,
  SMOKE_PDF,
  type SmokeOutcome,
} from './extension-smoke-fixture';

const mainUrl = 'https://www.release.tdnet.info/inbs/fixture-main.html';
const listUrl = 'https://www.release.tdnet.info/inbs/fixture-list.html';

export async function checkExtensionSmoke(args: string[]) {
  const arg = (flag: string) => {
    const value = args[args.indexOf(flag) + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing option value: ${flag}`);
    return value;
  };
  const selected = args.includes('--smoke-outcome') ? arg('--smoke-outcome') : null;
  if (selected && !['success', 'partial', 'failure'].includes(selected))
    throw new Error('--smoke-outcome must be success, partial or failure');
  const outcomes: SmokeOutcome[] = selected
    ? [selected as SmokeOutcome]
    : ['success', 'partial', 'failure'];
  // Run before importing Playwright or reading dist: fixture drift is locally diagnosable.
  const preflights = [];
  for (const outcome of outcomes) {
    const result = await preflightExtensionSmoke(outcome);
    preflights.push({ outcome, ...result });
    console.log(
      JSON.stringify({
        stage: 'fixture-preflight',
        outcome,
        requests: result.requests,
        success: true,
      })
    );
  }
  if (args.includes('--preflight-only')) return;
  if (!args.includes('--browser-module') || !args.includes('--browser-executable'))
    throw new Error(
      '固定fixtureは正常です。実画面には --browser-module と --browser-executable が必要です'
    );
  const { chromium } = await import(pathToFileURL(path.resolve(arg('--browser-module'))).href);
  const extensionDirectory = path.resolve('dist');
  const manifest = JSON.parse(
    await readFile(path.join(extensionDirectory, 'manifest.json'), 'utf8')
  );
  const digest = createHash('sha256');
  for (const directory of ['src/lib', 'src/background', 'src/offscreen'])
    for (const file of (await readdir(directory))
      .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
      .sort())
      digest.update(`${directory}/${file}`).update(await readFile(`${directory}/${file}`));
  const sourceBuildDigest = digest.digest('hex');

  for (const preflight of preflights) {
    const { outcome, fixture } = preflight;
    const profile = await mkdtemp(path.join(tmpdir(), 'tdnet-smoke-'));
    let context: Awaited<ReturnType<typeof chromium.launchPersistentContext>>;
    let requests = 0,
      pdfRequests = 0;
    const unexpectedRequests: string[] = [];
    const evidence: Record<string, unknown> = {
      outcome,
      success: false,
      sourceBuildDigest,
      stages: ['fixture-preflight'],
    };
    const stages = evidence.stages as string[];
    try {
      context = await chromium.launchPersistentContext(profile, {
        executablePath: arg('--browser-executable'),
        headless: true,
        ignoreDefaultArgs: ['--disable-extensions'],
        args: [
          `--disable-extensions-except=${extensionDirectory}`,
          `--load-extension=${extensionDirectory}`,
          '--no-sandbox',
        ],
      });
      // Fail closed: the fixture credentials must never reach any real service.
      await context.route(
        '**/*',
        async (route: {
          request(): { url(): string; postDataJSON(): Parameters<typeof fixture.response>[0] };
          fulfill(response: { contentType: string; body: string | Buffer }): Promise<void>;
          continue(): Promise<void>;
          abort(): Promise<void>;
        }) => {
          const url = route.request().url();
          if (url === SMOKE_API) {
            requests++;
            return route.fulfill({
              contentType: 'application/json',
              body: JSON.stringify({
                choices: [
                  {
                    message: { content: fixture.response(route.request().postDataJSON()) },
                    finish_reason: 'stop',
                  },
                ],
              }),
            });
          }
          if (url === SMOKE_PDF) {
            pdfRequests++;
            return route.fulfill({
              contentType: 'application/pdf',
              body: Buffer.from(fixture.pdf),
            });
          }
          if (url === mainUrl)
            return route.fulfill({
              contentType: 'text/html',
              body: '<html><meta charset="utf-8"><iframe id="main_list" src="fixture-list.html"></iframe></html>',
            });
          if (url === listUrl)
            return route.fulfill({
              contentType: 'text/html',
              body: '<html><meta charset="utf-8"><table id="list-head"><tr><td class="header-R">表題</td></tr></table><table id="main-list-table"><tbody><tr><td class="kjTime oddnew-L">15:00</td><td class="kjCode oddnew-M">1234</td><td class="kjName oddnew-M">株式会社テスト</td><td class="kjTitle oddnew-M"><a href="fixture-extension-smoke.pdf">営業体制に関するお知らせ</a></td><td class="oddnew-R"></td></tr></tbody></table></html>',
            });
          if (url.startsWith('chrome-extension://')) return route.continue();
          if (!url.endsWith('/favicon.ico')) unexpectedRequests.push(url);
          return route.abort();
        }
      );
      const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
      assert.equal(
        await worker.evaluate(() => chrome.runtime.getManifest().version),
        manifest.version
      );
      await worker.evaluate(async () => {
        await chrome.storage.local.clear();
        await chrome.storage.sync.set({
          provider: 'openai',
          model: 'fixture',
          apiKey: 'fixture',
          customUrl: '',
          extractionMode: 'full',
          extensionEnabled: true,
          experimentalScoring: false,
        });
      });
      const page = await context.newPage();
      await page.goto(mainUrl);
      const frame = page.frameLocator('#main_list');
      const row = frame.locator('#main-list-table tr').first();
      const summary = frame.locator('.tdnet-digest-summary-row');
      await row.getByRole('button', { name: '要約', exact: true }).click({ timeout: 20000 });
      await summary.waitFor({ timeout: 30000 });
      await row.getByRole('button', { name: '閉じる', exact: true }).waitFor({ timeout: 30000 });
      const readStored = () =>
        worker.evaluate(async (traceKey: string) => {
          const data = await chrome.storage.local.get();
          return {
            trace: data[traceKey]?.traces?.find(
              (trace: { pdfUrl: string }) =>
                trace.pdfUrl === 'https://www.release.tdnet.info/inbs/fixture-extension-smoke.pdf'
            ),
            caches: Object.entries(data).filter(([key]) => key.startsWith('summaryCacheV2:')),
          };
        }, SUMMARY_DIAGNOSTICS_KEY);
      const stored = await readStored();
      assert.equal(
        stored.trace.buildDigest,
        sourceBuildDigest,
        'build is stale; run npm run build'
      );
      assert.equal(stored.trace.pdfUrl, SMOKE_PDF);
      assert.equal(
        stored.trace.documentHash,
        createHash('sha256').update(fixture.pdf).digest('hex')
      );
      assert.equal(requests, preflight.requests);
      assert.equal(pdfRequests, 1);
      assert.deepEqual(
        stored.trace.attempts.map((attempt: { phase: string }) => attempt.phase),
        preflight.phases
      );
      assert.ok(
        (
          await worker.evaluate(() =>
            chrome.runtime.getContexts({
              contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
            })
          )
        ).length
      );
      stages.push(
        'content click → background → physical PDF/offscreen → fixed wire responses → HTML'
      );
      evidence.trace = stored.trace;
      if (outcome === 'failure') {
        assert.equal(stored.trace.outcome, 'failure');
        assert.equal(stored.trace.resultId, null);
        assert.match(await summary.innerText(), /SCHEMA/);
        assert.equal(stored.caches.length, 0);
        stages.push('failed repair → visible error; no success cache');
      } else {
        assert.equal(
          stored.trace.outcome,
          outcome === 'success' ? 'firstSuccess' : 'partialSuccess'
        );
        assert.equal(stored.caches.length, 1);
        const saved = stored.caches[0][1];
        validateSavedFacts(saved.facts);
        validatePresentation(saved.presentation, saved.facts);
        assert.deepEqual(saved.facts, preflight.result!.facts);
        assert.equal(
          saved.presentation.organization.status,
          outcome === 'success' ? 'ready' : 'unavailable'
        );
        assert.equal(saved.resultId, stored.trace.resultId);
        assert.equal(saved.diagnosticRunId, stored.trace.runId);
        assert.equal(saved.metadata.generationCalls, preflight.requests);
        const visible = await summary.innerText();
        assert.match(visible, /100/);
        assert.match(visible, /百万円/);
        const sourceToggles = summary.locator('details.tdnet-digest-source');
        assert.ok(await sourceToggles.count());
        if (outcome === 'partial') {
          assert.doesNotMatch(visible, /販売体制を強化している。/);
          await sourceToggles.evaluateAll((nodes: HTMLDetailsElement[]) =>
            nodes.forEach((node) => {
              node.open = true;
            })
          );
          assert.match(await summary.innerText(), /販売体制の強化を進めています/);
          stages.push('unavailable explanation → confirmed amount retained; original accessible');
        }
        // Reload disposes React state; restoring must use chrome.storage without PDF/API calls.
        await page.reload();
        await row.getByRole('button', { name: '表示', exact: true }).click({ timeout: 20000 });
        await summary.waitFor({ timeout: 10000 });
        assert.match(await summary.innerText(), /100/);
        assert.equal(requests, preflight.requests);
        assert.equal(pdfRequests, 1);
        assert.deepEqual((await readStored()).caches, stored.caches);
        stages.push('page reload → same saved facts/presentation without API or PDF');
      }
      assert.deepEqual(unexpectedRequests, []);
      evidence.success = true;
    } catch (error) {
      evidence.error = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      if (context) await context.close();
      await rm(profile, { recursive: true, force: true });
      await mkdir('evaluation/results/local', { recursive: true });
      evidence.apiCalls = requests;
      evidence.pdfRequests = pdfRequests;
      await writeFile(
        `evaluation/results/local/extension-smoke-${outcome}.json`,
        JSON.stringify(evidence, null, 2)
      );
      console.log(JSON.stringify(evidence));
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  await checkExtensionSmoke(process.argv.slice(2));
