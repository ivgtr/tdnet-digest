/** Local-only 26-page replay; no PDF download, API key, or external network. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { extractPdfPageLayout } from '../../src/lib/pdf-layout';
import { earningsStorySource, replayEarningsStory } from './earnings-story-fixture';
const file = process.argv[2];
assert.ok(
  file,
  'Usage: node --import tsx evaluation/scripts/check-earnings-story.ts /path/to/140120261008547647.pdf'
);
const bytes = await readFile(file);
assert.equal(
  createHash('sha256').update(bytes).digest('hex'),
  earningsStorySource.sha256,
  'Use the exact independently checked public PDF'
);
const document = await getDocument({
  data: new Uint8Array(bytes),
  cMapUrl: `${process.cwd()}/node_modules/pdfjs-dist/cmaps/`,
  cMapPacked: true,
  useWorkerFetch: false,
  isEvalSupported: false,
  useSystemFonts: true,
}).promise;
const pages = [];
try {
  assert.equal(document.numPages, 26);
  for (let n = 1; n <= document.numPages; n++) {
    const page = await document.getPage(n);
    pages.push(await extractPdfPageLayout(page, n, OPS));
    page.cleanup();
  }
} finally {
  await document.destroy();
}
assert.ok(pages.every((page) => page.status === 'ok'));
const { html, markdown, result, ...evidence } = await replayEarningsStory(pages);
await mkdir('evaluation/results/local', { recursive: true });
await writeFile(
  'evaluation/results/local/earnings-user-story.json',
  JSON.stringify({ pdfSha256: earningsStorySource.sha256, ...evidence, result }, null, 2)
);
await writeFile('evaluation/results/local/earnings-user-story.html', html);
await writeFile('evaluation/results/local/earnings-user-story.md', markdown);
console.log(JSON.stringify({ pdfSha256: earningsStorySource.sha256, ...evidence }, null, 2));
