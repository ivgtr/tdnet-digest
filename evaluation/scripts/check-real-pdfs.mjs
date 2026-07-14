import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const root = process.cwd();
const manifestPath = path.join(root, 'evaluation/fixtures/real-pdf-cases.json');
const pdfDirectory = process.argv[2] || path.join(root, 'evaluation/fixtures/real-pdfs');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const results = [];

for (const item of manifest) {
  const filePath = path.join(pdfDirectory, `${item.id}.pdf`);
  let data;
  try {
    data = new Uint8Array(await readFile(filePath));
  } catch {
    results.push({ id: item.id, status: 'missing', filePath });
    continue;
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
if (checked.length === 0 || passed.length !== checked.length) process.exitCode = 1;
