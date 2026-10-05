import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { serializeCandidateSource } from '../../src/lib/fact-candidates';
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { extractPdfPageLayout } from '../../src/lib/pdf-layout';
import { FACT_SCHEMA_VERSION } from '../../src/lib/fact-contract';
import { serializePagesForAnalysis } from '../../src/lib/page-text';
import {
  FactSummaryGenerationError,
  generateVerifiedFactSummary,
  factSummaryRequestLimits,
  factPrompt,
  renderFacts,
  parseFactSummary,
} from '../../src/lib/fact-summary';
import contentExpectations from '../../src/lib/fixtures/summary-content-expectations.json';
import { validateSavedFacts } from '../../src/lib/fact-cache';
import { buildAnalysisFingerprint } from '../../src/lib/analysis-version';
import { getProvider } from '../../src/lib/llm-providers';
import type { SummaryAttempt } from '../../src/lib/summary-trace';

import { expectedErrors, independentAssessment, type Case } from './fact-summary-expectations';
import { parseFactSummaryArgs } from './fact-summary-args';
const cli = parseFactSummaryArgs(process.argv.slice(2));
const cases = JSON.parse(
  await readFile(
    cli.holdout
      ? 'evaluation/fixtures/source-structure-holdout-cases.json'
      : 'evaluation/fixtures/fact-summary-cases.json',
    'utf8'
  )
) as Case[];
const selected = cli.caseId ? cases.filter((item) => item.id === cli.caseId) : cases;
if (!selected.length) throw new Error('評価ケースがありません');
if (cli.listCases) {
  console.log(
    JSON.stringify({ suite: cli.holdout ? 'holdout' : 'known', caseIds: selected.map((c) => c.id) })
  );
  process.exit(0);
}
const provider = process.env.TDNET_DIGEST_PROVIDER || 'openai';
const model = process.env.TDNET_DIGEST_MODEL || getProvider(provider)?.defaultModel;
const apiKey = process.env.TDNET_DIGEST_API_KEY || process.env[`${provider.toUpperCase()}_API_KEY`];
if (!model || !apiKey) throw new Error('モデルまたはAPIキーを設定してください');
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
  'src/lib/document-context.ts',
  'src/lib/source-mappings.ts',
  'src/lib/source-periods.ts',
  'src/lib/fact-candidates.ts',
  'src/lib/assertion-semantics.ts',
  'src/lib/dividend-semantics.ts',
  'src/lib/forecast-revision-semantics.ts',
  'src/lib/metric-semantics.ts',
  'src/lib/quantity.ts',
  'src/lib/period-semantics.ts',
  'src/lib/document-structure.ts',
  'src/lib/document-links.ts',
  'src/lib/pdf-layout.ts',
  'src/lib/pdf-drawing.ts',
  'src/lib/table-layout.ts',
  'src/lib/source-provenance.ts',
  'src/lib/source-preflight.ts',
  'src/lib/numeric-evidence.ts',
  'src/lib/fact-validation.ts',
  'src/lib/fact-coverage.ts',
  'src/lib/fact-summary.ts',
  'src/lib/summary-content-policy.ts',
  'src/lib/summary-source-inventory.ts',
  'src/lib/summary-presentation.ts',
  'src/lib/summary-narrative.ts',
  'src/lib/summary-narrative-schema.ts',
  'src/lib/summary-narrative-renderer.ts',
  'src/lib/summary-renderer.ts',
  'src/lib/summary-result-id.ts',
  'src/lib/llm-client.ts',
  'src/lib/llm-providers.ts',
  'src/lib/structured-output.ts',
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
  if (item.sourceHash && sourceHash !== item.sourceHash)
    throw new Error('固定した原PDFのhashと一致しません');
  const extractionStarted = performance.now();
  const pdf = await getDocument({ data }).promise;
  const pages = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
    const page = await pdf.getPage(pageNumber);
    pages.push(await extractPdfPageLayout(page, pageNumber, OPS));
    page.cleanup();
  }
  await pdf.destroy();
  const extractionMs = Math.round(performance.now() - extractionStarted);
  const sourceInput = serializeCandidateSource(pages, undefined, item.documentType);
  await writeFile(`evaluation/results/local/${item.id}-source-input.json`, sourceInput);
  await writeFile(`evaluation/results/local/${item.id}-source-pages.json`, JSON.stringify(pages));
  const usage: Array<{
    inputTokens: number | null;
    outputTokens: number | null;
    elapsedMs: number;
  }> = [];
  const started = performance.now();
  let attempt: Awaited<ReturnType<typeof generateVerifiedFactSummary>> | null = null;
  let errors: string[] = [];
  const attempts: SummaryAttempt[] = [];
  let failedResponses: { first: string; repaired: string } | null = null;
  try {
    attempt = await generateVerifiedFactSummary(
      {
        provider,
        model,
        signal: AbortSignal.timeout(300_000),
        apiKey,
        baseUrl: process.env.TDNET_DIGEST_BASE_URL || undefined,
        onUsage: (item) => usage.push(item),
      },
      item.documentType,
      serializePagesForAnalysis(pages),
      pages,
      (attempt) => {
        attempts.push(attempt);
        console.log(`${item.id}: ${attempt.phase} ${attempt.error ? '拒否' : '完了'}`);
      }
    );
  } catch (error) {
    errors = [error instanceof Error ? error.message : String(error)];
    if (error instanceof FactSummaryGenerationError)
      failedResponses = { first: error.firstResponse, repaired: error.repairedResponse };
  }
  const elapsedSeconds = Number(((performance.now() - started) / 1000).toFixed(1));
  const result = attempt?.facts ?? null;
  const compact = (text: string) => text.normalize('NFKC').replace(/\s/g, '');
  const retainedText = compact(attempt?.presentation.excerpts.map((e) => e.text).join('\n') ?? '');
  const missingSourceContent =
    contentExpectations.realPdfs
      .find((c) => c.id === item.id)
      ?.retained.filter((text) => !retainedText.includes(compact(text))) ?? [];
  if (result) {
    errors.push(...missingSourceContent.map((text) => `原文の説明・条件が不足: ${text}`));
    errors.push(...expectedErrors(item, result));
    validateSavedFacts(result);
    const restored = parseFactSummary(JSON.stringify(result), item.documentType, pages);
    if (JSON.stringify(restored) !== JSON.stringify(result))
      errors.push('保存再照合で確定結果が変わりました');
  }
  const output = {
    item,
    schemaVersion: FACT_SCHEMA_VERSION,
    analysisFingerprint: buildAnalysisFingerprint({ provider, model, extractionMode: 'full' }),
    implementationDigest,
    requestLimits: factSummaryRequestLimits({ provider, model }),
    sourceHash,
    inputHash: createHash('sha256')
      .update(serializeCandidateSource(pages, undefined, item.documentType))
      .digest('hex'),
    promptHash: createHash('sha256')
      .update(JSON.stringify(factPrompt(item.documentType, sourceInput)))
      .digest('hex'),
    missingSourceContent,
    independentAssessment: result ? independentAssessment(item, result) : null,
    inputChars: serializeCandidateSource(pages, undefined, item.documentType).length,
    extractionMs,
    sourceBytes: Buffer.byteLength(JSON.stringify(pages)),
    drawingOperations: pages.reduce((n, p) => n + p.drawingOperations.length, 0),
    tableRegions: pages.reduce((n, p) => n + p.tableRegions.length, 0),
    usage,
    provider,
    model,
    elapsedSeconds,
    pages: pages.length,
    repairAttempted: attempt?.repairAttempted ?? attempts.some((a) => a.phase === 'repair'),
    success: errors.length === 0,
    errors,
    result,
    presentation: attempt?.presentation ?? null,
    summary: result && attempt ? renderFacts(result, attempt.presentation) : null,
    attempts,
    failedResponses,
  };
  const serialized = JSON.stringify(output, null, 2);
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  await writeFile(`evaluation/results/local/${item.id}-${runId}-fact-summary.json`, serialized);
  await writeFile(`evaluation/results/local/${item.id}-fact-summary.json`, serialized);
  console.log(`${item.id}: ${errors.length ? errors.join(' / ') : '成功'} (${elapsedSeconds}秒)`);
  if (result && attempt) console.log(renderFacts(result, attempt.presentation));
  if (errors.length) process.exitCode = 1;
}
