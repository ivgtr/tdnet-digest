import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { extractPdfPageLayout } from '../../src/lib/pdf-layout.ts';
import { serializeCandidateSource, reviewCandidates } from '../../src/lib/fact-candidates.ts';
import { parseExactQuantity, parseExactRange } from '../../src/lib/quantity.ts';
import { parseFactSummary } from '../../src/lib/fact-summary.ts';
import { expectedErrors, type Case } from './fact-summary-expectations';
import cases from '../fixtures/source-structure-holdout-cases.json';
import knownCases from '../fixtures/fact-summary-cases.json';
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--case'))
  throw new Error('Usage: npm run test:fact-source -- [--case frozen-case-id]');
const selected = args.length ? [...cases, ...knownCases].filter((c) => c.id === args[1]) : cases;
if (args.length && selected.length !== 1) throw new Error(`Unknown/ambiguous case: ${args[1]}`);
const output = [];
for (const item of selected as Case[]) {
  const raw = await readFile(`evaluation/fixtures/real-pdfs/${item.id}.pdf`);
  const pdfHash = createHash('sha256').update(raw).digest('hex');
  if (!item.sourceHash || item.sourceHash !== pdfHash)
    throw new Error(`${item.id}: frozen PDF hash mismatch`);
  const pdf = await getDocument({ data: new Uint8Array(raw) }).promise;
  const pages = [];
  for (let n = 1; n <= pdf.numPages; n++)
    pages.push(await extractPdfPageLayout(await pdf.getPage(n), n, OPS));
  await pdf.destroy();
  const input = JSON.parse(serializeCandidateSource(pages, undefined, item.documentType));
  const facts = [];
  const results = [];
  for (const [i, expected] of [
    ...item.expected.map((e) => ({ kind: 'number', e })),
    ...(item.expectedRanges ?? []).map((e) => ({ kind: 'range', e })),
  ].entries()) {
    const e = expected.e as any;
    const matches = [];
    const attempts = [];
    for (const page of input.pages)
      for (const q of page.quantities) {
        const scalar = parseExactQuantity(q.text),
          range = parseExactRange(q.text);
        if (
          expected.kind === 'number'
            ? !e.variants.some(
                (v: any) => v.page === page.page && Number(scalar?.decimal) === v.value
              )
            : !(
                page.page === e.page &&
                Number(range?.lower) === e.lower &&
                Number(range?.upper) === e.upper
              )
        )
          continue;
        const candidate = {
          candidateId: `c${i + 1}`,
          importance: 'key',
          kind: expected.kind,
          source: {
            kind: 'table',
            valueId: q.id,
            tableId: q.tableId,
            contextBindingId: `ctx:${q.id}`,
          },
          meaning: { ...e.semantics, period: e.periods[0] },
        };
        const review = reviewCandidates(
          JSON.stringify({
            candidateVersion: 3,
            documentType: item.documentType,
            candidates: [candidate],
            unverified: [],
          }),
          item.documentType,
          pages
        );
        const single = {
          ...item,
          expected: expected.kind === 'number' ? [e] : [],
          expectedRanges: expected.kind === 'range' ? [e] : [],
          expectedEvidence: [],
          expectedConditions: [],
        };
        const errors = expectedErrors(single, review);
        attempts.push({ sourceId: q.id, errors, diagnostics: review.diagnostics });
        if (!errors.length && review.facts.length === 1) matches.push(review.facts[0]);
      }
    results.push({ kind: expected.kind, label: e.labels, choices: matches.length, attempts });
    if (matches.length === 1) facts.push(matches[0]);
  }
  const errors = expectedErrors(item, { facts });
  const saved = { version: 5, documentType: item.documentType, facts, unverified: [] };
  // This proves all frozen numeric expectations and save identity, not a model
  // generation or complete handling of nonnumeric obligations/reasons.
  const restored = parseFactSummary(JSON.stringify(saved), item.documentType, pages, false);
  if (JSON.stringify(restored) !== JSON.stringify(saved)) throw new Error('保存再照合が不一致');
  const result = {
    id: item.id,
    pdfHash,
    externalApiCalls: 0,
    numericFacts: facts.length,
    sourceChoices: results,
    errors,
    success: errors.length === 0,
    completeSummaryVerified: false,
  };
  output.push(result);
  console.log(JSON.stringify({ id: item.id, numericFacts: facts.length, errors }));
  if (errors.length) break;
}
await mkdir('evaluation/results/local/source-structure', { recursive: true });
const runId = new Date().toISOString().replace(/[:.]/g, '-');
await writeFile(
  `evaluation/results/local/source-structure/holdout-source-${runId}.json`,
  JSON.stringify(output, null, 2)
);
if (output.some((r) => !r.success)) process.exitCode = 1;
