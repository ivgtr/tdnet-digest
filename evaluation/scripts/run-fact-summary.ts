import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { serializeLayout } from '../../src/lib/pdf-layout';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { extractPageLayout } from '../../src/lib/pdf-layout';
import { serializePagesForAnalysis } from '../../src/lib/page-text';
import {
  FactSummaryGenerationError,
  generateVerifiedFactSummary,
  renderFacts,
} from '../../src/lib/fact-summary';
import { buildAnalysisFingerprint } from '../../src/lib/analysis-version';
import { getProvider } from '../../src/lib/llm-providers';

import { expectedErrors, type Case } from './fact-summary-expectations';
const cases = JSON.parse(
  await readFile('evaluation/fixtures/fact-summary-cases.json', 'utf8')
) as Case[];
const provider = process.env.TDNET_DIGEST_PROVIDER || 'openai';
const model = process.env.TDNET_DIGEST_MODEL || getProvider(provider)?.defaultModel;
const apiKey = process.env.TDNET_DIGEST_API_KEY || process.env[`${provider.toUpperCase()}_API_KEY`];
if (!model || !apiKey) throw new Error('モデルまたはAPIキーを設定してください');
const selected = process.argv[2] ? cases.filter((item) => item.id === process.argv[2]) : cases;
if (!selected.length) throw new Error('評価ケースがありません');
if (process.argv.includes('--browser')) {
  const { checkExtension } = await import('./check-extension');
  for (const item of selected)
    await checkExtension(
      item,
      { provider, model, apiKey, baseUrl: process.env.TDNET_DIGEST_BASE_URL || undefined },
      process.argv
    );
  process.exit(0);
}
await mkdir('evaluation/results/local', { recursive: true });
const implementationFiles = [
  'src/lib/fact-contract.ts',
  'src/lib/quantity.ts',
  'src/lib/document-structure.ts',
  'src/lib/document-links.ts',
  'src/lib/pdf-layout.ts',
  'src/lib/numeric-evidence.ts',
  'src/lib/fact-validation.ts',
  'src/lib/fact-coverage.ts',
  'src/lib/fact-summary.ts',
  'src/lib/llm-client.ts',
];
const implementationHash = createHash('sha256');
for (const file of implementationFiles)
  implementationHash.update(file).update(await readFile(file));
const implementationDigest = implementationHash.digest('hex');

for (const item of selected) {
  const data = new Uint8Array(
    await readFile(path.join('evaluation/fixtures/real-pdfs', `${item.id}.pdf`))
  );
  const sourceHash = createHash('sha256').update(data).digest('hex');
  const pdf = await getDocument({ data }).promise;
  const pages = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    pages.push(extractPageLayout(content.items, pageNumber));
    page.cleanup();
  }
  await pdf.destroy();
  const usage: Array<{
    inputTokens: number | null;
    outputTokens: number | null;
    elapsedMs: number;
  }> = [];
  const started = performance.now();
  let attempt: Awaited<ReturnType<typeof generateVerifiedFactSummary>> | null = null;
  let errors: string[] = [];
  const attempts: Array<{ phase: 'first' | 'repair'; response: string; error: string | null }> = [];
  let failedResponses: { first: string; repaired: string } | null = null;
  try {
    attempt = await generateVerifiedFactSummary(
      {
        provider,
        model,
        apiKey,
        baseUrl: process.env.TDNET_DIGEST_BASE_URL || undefined,
        onUsage: (item) => usage.push(item),
      },
      item.documentType,
      serializePagesForAnalysis(pages),
      pages,
      (attempt) => attempts.push(attempt)
    );
  } catch (error) {
    errors = [error instanceof Error ? error.message : String(error)];
    if (error instanceof FactSummaryGenerationError)
      failedResponses = { first: error.firstResponse, repaired: error.repairedResponse };
  }
  const elapsedSeconds = Number(((performance.now() - started) / 1000).toFixed(1));
  const result = attempt?.facts ?? null;
  if (result) errors.push(...expectedErrors(item, result));
  const output = {
    item,
    schemaVersion: 4,
    analysisFingerprint: buildAnalysisFingerprint({ provider, model, extractionMode: 'full' }),
    implementationDigest,
    requestLimits:
      provider === 'openrouter' ? { maxOutputTokens: 32768, reasoningEffort: 'low' } : null,
    sourceHash,
    inputHash: createHash('sha256').update(serializeLayout(pages)).digest('hex'),
    inputChars: serializeLayout(pages).length,
    usage,
    provider,
    model,
    elapsedSeconds,
    pages: pages.length,
    repairAttempted: attempt?.repairAttempted ?? null,
    success: errors.length === 0,
    errors,
    result,
    summary: result ? renderFacts(result) : null,
    attempts,
    failedResponses,
  };
  const serialized = JSON.stringify(output, null, 2);
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  await writeFile(`evaluation/results/local/${item.id}-${runId}-fact-summary.json`, serialized);
  await writeFile(`evaluation/results/local/${item.id}-fact-summary.json`, serialized);
  console.log(`${item.id}: ${errors.length ? errors.join(' / ') : '成功'} (${elapsedSeconds}秒)`);
  if (result) console.log(renderFacts(result));
  if (errors.length) process.exitCode = 1;
}
