import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { TextItem, TextMarkedContent } from 'pdfjs-dist/types/src/display/api';
import { groupTextItemsByY } from '../../src/lib/pdf-lines';
import { cleanPageText, serializePagesForAnalysis } from '../../src/lib/page-text';
import {
  FactSummaryGenerationError,
  generateVerifiedFactSummary,
  renderFacts,
} from '../../src/lib/fact-summary';
import type { DocumentType } from '../../src/lib/document-type';
import { getProvider } from '../../src/lib/llm-providers';

interface Expected {
  label: string;
  variants: { value: number; unit: string; page: number }[];
  periodContains: string;
  valueKind: 'actual' | 'forecast' | 'forecastBefore' | 'forecastAfter';
}
interface Case {
  id: string;
  title: string;
  documentType: DocumentType;
  url: string;
  expected?: Expected[];
  expectedEvents?: string[];
}
const cases = JSON.parse(
  await readFile('evaluation/fixtures/fact-summary-cases.json', 'utf8')
) as Case[];
const provider = process.env.TDNET_DIGEST_PROVIDER || 'openai';
const model = process.env.TDNET_DIGEST_MODEL || getProvider(provider)?.defaultModel;
const apiKey = process.env.TDNET_DIGEST_API_KEY || process.env[`${provider.toUpperCase()}_API_KEY`];
if (!model || !apiKey) throw new Error('モデルまたはAPIキーを設定してください');
const selected = process.argv[2] ? cases.filter((item) => item.id === process.argv[2]) : cases;
if (!selected.length) throw new Error('評価ケースがありません');
await mkdir('evaluation/results/local', { recursive: true });
for (const item of selected) {
  const data = new Uint8Array(
    await readFile(path.join('evaluation/fixtures/real-pdfs', `${item.id}.pdf`))
  );
  const pdf = await getDocument({ data, disableWorker: true }).promise;
  const pages = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    pages.push({
      pageNumber,
      text: cleanPageText(
        groupTextItemsByY(content.items as Array<TextItem | TextMarkedContent>).join('\n'),
        pageNumber
      ),
    });
    page.cleanup();
  }
  const started = performance.now();
  let attempt: Awaited<ReturnType<typeof generateVerifiedFactSummary>> | null = null;
  let errors: string[] = [];
  let failedResponses: { first: string; repaired: string } | null = null;
  try {
    attempt = await generateVerifiedFactSummary(
      { provider, model, apiKey, baseUrl: process.env.TDNET_DIGEST_BASE_URL || undefined },
      item.documentType,
      serializePagesForAnalysis(pages),
      pages
    );
  } catch (error) {
    errors = [error instanceof Error ? error.message : String(error)];
    if (error instanceof FactSummaryGenerationError)
      failedResponses = { first: error.firstResponse, repaired: error.repairedResponse };
  }
  const elapsedSeconds = Number(((performance.now() - started) / 1000).toFixed(1));
  const result = attempt?.facts ?? null;
  if (result) {
    for (const expected of item.expected ?? []) {
      const compact = (text: string) => text.normalize('NFKC').replace(/\s/g, '');
      if (
        !result.facts.some(
          (fact) =>
            fact.kind === 'number' &&
            fact.label.includes(expected.label) &&
            fact.valueKind === expected.valueKind &&
            fact.period &&
            compact(fact.period).includes(compact(expected.periodContains)) &&
            expected.variants.some(
              (variant) =>
                fact.value === variant.value &&
                fact.unit &&
                compact(fact.unit).startsWith(compact(variant.unit)) &&
                fact.page === variant.page
            )
        )
      ) {
        errors.push(
          `重要事実が不足: ${expected.label} ${expected.variants.map((variant) => `${variant.value}${variant.unit} p.${variant.page}`).join(' または ')}`
        );
      }
    }
    for (const term of item.expectedEvents ?? []) {
      if (!result.facts.some((fact) => fact.kind === 'event' && fact.statement?.includes(term)))
        errors.push(`重要事項が不足: ${term}`);
    }
  }
  const output = {
    item,
    provider,
    model,
    elapsedSeconds,
    pages: pages.length,
    repairAttempted: attempt?.repairAttempted ?? null,
    success: errors.length === 0,
    errors,
    result,
    summary: result ? renderFacts(result) : null,
    failedResponses,
  };
  await writeFile(
    `evaluation/results/local/${item.id}-fact-summary.json`,
    JSON.stringify(output, null, 2)
  );
  console.log(`${item.id}: ${errors.length ? errors.join(' / ') : '成功'} (${elapsedSeconds}秒)`);
  if (result) console.log(renderFacts(result));
  if (errors.length) process.exitCode = 1;
}
