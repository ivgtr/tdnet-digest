import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { setTimeout } from 'node:timers/promises';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const root = process.cwd();
const manifestPath = path.join(root, 'evaluation/fixtures/real-pdf-cases.json');
const argumentsList = process.argv.slice(2);
const fetchMissing = argumentsList.includes('--fetch');
const pdfDirectory =
  argumentsList.find((argument) => argument !== '--fetch') ||
  path.join(root, 'evaluation/fixtures/real-pdfs');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const results = [];

for (const item of manifest) {
  const filePath = path.join(pdfDirectory, `${item.id}.pdf`);
  let data;
  try {
    data = new Uint8Array(await readFile(filePath));
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      if (!fetchMissing) {
        results.push({ id: item.id, status: 'missing', filePath });
        continue;
      }
      const url = new URL(item.url);
      const jpx =
        url.origin === 'https://www2.jpx.co.jp' &&
        url.pathname === `/disc/${item.code}/${item.id}.pdf`;
      const nagoya =
        url.origin === 'https://www.nse.or.jp' &&
        url.pathname === `/listing/search/files/${item.id}.pdf`;
      if ((!jpx && !nagoya) || url.search || url.hash)
        throw new Error(`評価PDFのURLが不正です: ${item.id}`);
      const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(20_000) });
      if (!response.ok || !response.headers.get('content-type')?.includes('application/pdf'))
        throw new Error(`評価PDFを取得できません: ${item.id} (HTTP ${response.status})`);
      data = new Uint8Array(await response.arrayBuffer());
      if (data.length > 15_000_000 || Buffer.from(data.slice(0, 4)).toString() !== '%PDF')
        throw new Error(`評価PDFの形式またはサイズが不正です: ${item.id}`);
      await mkdir(pdfDirectory, { recursive: true });
      await writeFile(filePath, data);
      await setTimeout(250);
    } else {
      throw error;
    }
  }

  const document = await getDocument({ data, disableWorker: true }).promise;
  const pages = [];
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    const text = content.items
      .map((entry) => ('str' in entry ? entry.str : ''))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    pages.push({ pageNumber, text });
  }

  const markedText = pages
    .map(({ pageNumber, text }) => `[PDF_PAGE:${pageNumber}]\n${text}`)
    .join('\n\n');
  const missingTerms = item.requiredTerms.filter((term) => !markedText.includes(term));
  const result = {
    id: item.id,
    expectedType: item.expectedType,
    pages: document.numPages,
    nonEmptyPages: pages.filter(({ text }) => text.length > 0).length,
    characters: markedText.length,
    pageMarkers: (markedText.match(/\[PDF_PAGE:\d+\]/g) || []).length,
    missingTerms,
    status:
      missingTerms.length === 0 && pages.every(({ text }) => text.length > 0) ? 'ok' : 'warning',
  };
  results.push(result);

  await mkdir(path.join(pdfDirectory, 'text'), { recursive: true });
  await writeFile(path.join(pdfDirectory, 'text', `${item.id}.txt`), markedText, 'utf8');
}

const checked = results.filter(({ status }) => status !== 'missing');
const passed = checked.filter(({ status }) => status === 'ok');
console.table(results);
console.log(
  `PDF extraction: ${passed.length}/${checked.length} passed; missing files: ${results.length - checked.length}`
);
if (checked.length !== manifest.length || passed.length !== manifest.length) process.exitCode = 1;
