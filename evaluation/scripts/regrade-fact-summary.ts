import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { extractPageLayout } from '../../src/lib/pdf-layout';
import { parseFactSummary } from '../../src/lib/fact-summary';
import { expectedErrors, type Case } from './fact-summary-expectations';

// Rechecks saved real responses against current source verification and human expectations.
// This is not a new generation or an assessment of the current prompt's success rate.
const cases: Case[] = JSON.parse(
  await readFile('evaluation/fixtures/fact-summary-cases.json', 'utf8')
);
const diagnosticRenumber = process.argv.includes('--diagnostic-renumber');
for (const file of process.argv.slice(2).filter((a) => a !== '--diagnostic-renumber')) {
  if (
    path.dirname(file) !== 'evaluation/results/local' ||
    !cases.some((item) => path.basename(file).startsWith(`${item.id}-`)) ||
    !/-(fact-summary|browser)\.json$/.test(file)
  )
    throw new Error('ローカル評価JSONのパスを指定してください');
  const savedText = await readFile(file, 'utf8');
  const saved = JSON.parse(savedText);
  const item = cases.find((item) => item.id === (saved.item?.id ?? saved.caseId));
  if (!item) throw new Error('評価ケースがありません');
  const data = new Uint8Array(await readFile(`evaluation/fixtures/real-pdfs/${item.id}.pdf`));
  const sourceHash = createHash('sha256').update(data).digest('hex');
  if (saved.sourceHash !== sourceHash) throw new Error('保存結果と原PDFのハッシュが一致しません');
  const pdf = await getDocument({ data }).promise;
  const pages = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    pages.push(extractPageLayout((await page.getTextContent()).items, n));
    page.cleanup();
  }
  await pdf.destroy();
  const errors: string[] = [];
  let acceptedFacts = 0,
    rejectedFacts = 0;
  const original = saved.result ?? saved.facts;
  if (!original) throw new Error('保存された確定結果がありません');
  const input = diagnosticRenumber
    ? {
        ...original,
        facts: original.facts.map((f: object, i: number) => ({ ...f, id: `f${i + 1}` })),
      }
    : original;
  try {
    const partial = parseFactSummary(JSON.stringify(input), item.documentType, pages, false);
    acceptedFacts = partial.facts.length;
    rejectedFacts = original.facts.length - acceptedFacts;
    const result = parseFactSummary(JSON.stringify(input), item.documentType, pages);
    errors.push(...expectedErrors(item, result));
    if (result.unverified.length !== (saved.result ?? saved.facts).unverified.length)
      errors.push('現行検証で確定事実の拒否が増えました');
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  const checker = createHash('sha256');
  for (const name of [
    'src/lib/fact-contract.ts',
    'src/lib/document-context.ts',
    'src/lib/source-mappings.ts',
    'src/lib/source-periods.ts',
    'src/lib/fact-candidates.ts',
    'src/lib/assertion-semantics.ts',
    'src/lib/quantity.ts',
    'src/lib/document-structure.ts',
    'src/lib/document-links.ts',
    'src/lib/pdf-layout.ts',
    'src/lib/fact-summary.ts',
    'src/lib/fact-validation.ts',
    'src/lib/fact-coverage.ts',
    'src/lib/metric-semantics.ts',
    'src/lib/numeric-evidence.ts',
    'evaluation/scripts/fact-summary-expectations.ts',
    'evaluation/fixtures/fact-summary-cases.json',
  ])
    checker.update(name).update(await readFile(name));
  const output = {
    caseId: item.id,
    sourceFile: file,
    sourceFileHash: createHash('sha256').update(savedText).digest('hex'),
    sourceHash,
    generationSuccess: saved.success,
    generationErrors: saved.errors ?? saved.error ?? [],
    checkerDigest: checker.digest('hex'),
    regradedAt: new Date().toISOString(),
    modelCalls: 0,
    mode: diagnosticRenumber ? 'explicit-ID-renumber-diagnostic-only' : 'strict-saved-contract',
    acceptedFacts,
    rejectedFacts,
    success: errors.length === 0,
    errors,
  };
  const target = path.join(
    'evaluation/results/local',
    `${item.id}-${output.regradedAt.replace(/[:.]/g, '-')}-regraded.json`
  );
  await writeFile(target, JSON.stringify(output, null, 2));
  console.log(JSON.stringify(output));
  if (errors.length) process.exitCode = 1;
}
