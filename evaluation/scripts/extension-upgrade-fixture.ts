import assert from 'node:assert/strict';
import { readFile, cp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Produce a genuine old cache with the old verifier; never convert it into the new contract. */
export async function seedOldExtensionProfile(
  chromium: any,
  executablePath: string,
  profile: string,
  baseline: string
) {
  const load = (file: string) => import(pathToFileURL(path.resolve(baseline, file)).href);
  const [layout, candidates, builder, summary, cache, contract, version] = await Promise.all([
    load('src/lib/pdf-layout.ts'),
    load('src/lib/fact-candidates.ts'),
    load('src/lib/fixtures/candidate-test-source.ts'),
    load('src/lib/fact-summary.ts'),
    load('src/lib/fact-cache.ts'),
    load('src/lib/fact-contract.ts'),
    load('src/lib/analysis-version.ts'),
  ]);
  assert.equal(contract.FACT_SCHEMA_VERSION, 4);
  assert.equal(version.ANALYSIS_SCHEMA_VERSION, 62);
  const id = 'bluememe-20260930';
  const corpus = JSON.parse(
    await readFile(path.join(baseline, 'src/lib/fixtures/ir-semantic-corpus.json'), 'utf8')
  );
  const expected = JSON.parse(
    await readFile(path.join(baseline, 'src/lib/fixtures/ir-semantic-expectations.json'), 'utf8')
  );
  const fixture = corpus.find((item: any) => item.id === id);
  const pages = fixture.pages.map((p: any) => layout.extractPageLayout(p.items, p.pageNumber));
  const reviewed = candidates.reviewCandidates(
    builder.candidateResponse(
      expected.find((item: any) => item.id === id).facts,
      pages,
      'earnings'
    ),
    'earnings',
    pages
  );
  assert.deepEqual(reviewed.unverified, []);
  assert.equal(reviewed.facts.length, 11);
  const facts = summary.parseFactSummary(
    JSON.stringify({ version: 4, documentType: 'earnings', facts: reviewed.facts, unverified: [] }),
    'earnings',
    pages
  );
  cache.validateSavedFacts(facts);
  const rendered = summary.renderFacts(facts);
  const pdf = await readFile(`evaluation/fixtures/real-pdfs/${id}.pdf`);
  const documentHash = createHash('sha256').update(pdf).digest('hex');
  const settings = {
    provider: 'openai',
    model: 'fixture',
    apiKey: 'fixture',
    customUrl: '',
    extensionEnabled: true,
    extractionMode: 'full',
    experimentalScoring: false,
  };
  const fingerprint = version.buildAnalysisFingerprint(settings);
  const pdfUrl = `https://www.release.tdnet.info/inbs/fixture-${id}.pdf`;
  const key = `summaryCacheV2:${version.buildSummaryCacheKey(pdfUrl, fingerprint)}`;
  const value = {
    summary: rendered,
    facts,
    resultId: createHash('sha256')
      .update(contract.canonicalJSON([pdfUrl, fingerprint, documentHash, facts]))
      .digest('hex'),
    metadata: {
      totalPages: pages.length,
      extractedPages: pages.map((p: any) => p.pageNumber),
      extractionMode: 'full',
      documentHash,
      analysisSchemaVersion: 4,
      analysisFingerprint: fingerprint,
      provider: 'openai',
      model: 'fixture',
      summaryMode: 'one-pass',
    },
    title: '2026年3月期 決算短信〔日本基準〕（連結）',
    companyName: '公開PDF検証',
    code: '4069',
    cachedAt: new Date().toISOString(),
  };
  const extensionDirectory = path.join(profile, 'extension');
  await cp(path.resolve(baseline, 'dist'), extensionDirectory, { recursive: true });
  const old = await chromium.launchPersistentContext(profile, {
    executablePath,
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
  });
  let requests = 0;
  let retained = false;
  try {
    // A cache display must never contact any API or download its PDF.
    await old.route('https://api.openai.com/**', async (route: any) => {
      requests++;
      await route.abort();
    });
    await old.route('https://www.release.tdnet.info/**', async (route: any) => {
      const url = route.request().url();
      if (url.endsWith('fixture-main.html'))
        return route.fulfill({
          contentType: 'text/html',
          body: '<html><meta charset="utf-8"><iframe id="main_list" src="fixture-list.html"></iframe></html>',
        });
      if (url.endsWith('fixture-list.html'))
        return route.fulfill({
          contentType: 'text/html',
          body: `<html><meta charset="utf-8"><table id="list-head"><tr><td class="header-R">表題</td></tr></table><table id="main-list-table"><tbody><tr><td class="kjTime oddnew-L">15:00</td><td class="kjCode oddnew-M">4069</td><td class="kjName oddnew-M">公開PDF検証</td><td class="kjTitle oddnew-M"><a href="${pdfUrl}">${value.title}</a></td><td class="oddnew-R"></td></tr></tbody></table></html>`,
        });
      requests++;
      await route.abort();
    });
    const worker = old.serviceWorkers()[0] ?? (await old.waitForEvent('serviceworker'));
    await worker.evaluate(
      async (seed: any) => {
        await chrome.storage.sync.set(seed.settings);
        await chrome.storage.local.set({ [seed.key]: seed.value });
      },
      { settings, key, value }
    );
    const page = await old.newPage();
    await page.goto('https://www.release.tdnet.info/inbs/fixture-main.html');
    const frame = page.frameLocator('#main_list');
    await frame.getByRole('button', { name: '表示', exact: true }).click({ timeout: 20000 });
    await frame.getByRole('heading', { name: '確認できた事実', exact: true }).waitFor();
    assert.equal(await frame.locator('.tdnet-digest-summary-row li').count(), 11);
    assert.equal(requests, 0);
    // Reload the installed unpacked extension through Chrome while retaining
    // the same running profile. Replacing files between browser launches can
    // leave the registered service worker's old script cache in use.
    await page.close();
    await rm(extensionDirectory, { recursive: true });
    await cp(path.resolve('dist'), extensionDirectory, { recursive: true });
    const manager = await old.newPage();
    await manager.goto('chrome://extensions/');
    await manager.evaluate(async (id: string) => {
      const api = (chrome as any).developerPrivate;
      await new Promise<void>((resolve, reject) =>
        api.updateProfileConfiguration({ inDeveloperMode: true }, () =>
          chrome.runtime.lastError ? reject(new Error(chrome.runtime.lastError.message)) : resolve()
        )
      );
      await new Promise<void>((resolve, reject) =>
        api.reload(id, { failQuietly: false }, () =>
          chrome.runtime.lastError ? reject(new Error(chrome.runtime.lastError.message)) : resolve()
        )
      );
    }, new URL(worker.url()).host);
    await manager.close();
    retained = true;
    return { settings, key, value, extensionDirectory, context: old };
  } finally {
    if (!retained) await old.close();
  }
}
