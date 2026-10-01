import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import corpus from '../../src/lib/fixtures/pdf-layout-corpus.json';
import semanticCorpus from '../../src/lib/fixtures/ir-semantic-corpus.json';
import { createHash } from 'node:crypto';
import { extractPageLayout, serializeLayout } from '../../src/lib/pdf-layout';

// 公開PDFだけを読む。環境ファイル、API、ブラウザーの保存設定は使用しない。
const directory = process.argv[2] ?? 'evaluation/fixtures/real-pdfs';
const results = [];
for (const fixture of [...corpus, ...semanticCorpus]) {
  const data = new Uint8Array(await readFile(path.join(directory, `${fixture.id}.pdf`)));
  if ('sha256' in fixture && createHash('sha256').update(data).digest('hex') !== fixture.sha256)
    throw new Error(`${fixture.id}: PDF内容ハッシュの不一致`);
  const started = performance.now();
  const document = await getDocument({ data }).promise;
  const pages = [];
  for (const entry of fixture.pages) {
    const page = await document.getPage(entry.pageNumber);
    const content = await page.getTextContent();
    const extracted = extractPageLayout(content.items, entry.pageNumber);
    const expected = extractPageLayout(entry.items as typeof content.items, entry.pageNumber);
    if (JSON.stringify(extracted) !== JSON.stringify(expected))
      throw new Error(`${fixture.id} p.${entry.pageNumber}: 保存した位置情報と実PDFが一致しません`);
    pages.push(extracted);
    page.cleanup();
  }
  results.push({
    id: fixture.id,
    pages: pages.length,
    extractionMs: Math.round(performance.now() - started),
    textChars: pages.reduce((sum, p) => sum + p.text.length, 0),
    promptChars: serializeLayout(pages).length,
    spans: pages.reduce((sum, p) => sum + p.spans.length, 0),
    payloadBytes: Buffer.byteLength(JSON.stringify(pages)),
  });
  await document.destroy();
}
console.table(results);
