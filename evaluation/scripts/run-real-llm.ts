import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { detectEarningsContext, type DocumentType } from '../../src/lib/document-type';
import { getFormatPrompt } from '../../src/lib/format-prompts';
import { generateText, type ChatMessage, type LLMConfig } from '../../src/lib/llm-client';
import { getProvider } from '../../src/lib/llm-providers';
import { getExtractionPrompt } from '../../src/lib/prompts';
import { getJsonSchema } from '../../src/lib/summary-schema';
import {
  buildJsonRepairMessages,
  getProviderCapabilities,
  parseAndValidateExtraction,
} from '../../src/lib/structured-output';

interface RealPdfCase {
  id: string;
  publishedDate: string;
  code: string;
  company: string;
  title: string;
  expectedType: DocumentType;
  url: string;
}

const root = process.cwd();
const provider = process.env.TDNET_DIGEST_PROVIDER || 'openai';
const apiKey = getApiKey(provider);
const model = process.env.TDNET_DIGEST_MODEL || getProvider(provider)?.defaultModel;
const baseUrl = process.env.TDNET_DIGEST_BASE_URL || undefined;
const caseId = process.env.TDNET_EVAL_CASE_ID || process.argv[2];
const pdfDirectory = process.env.TDNET_EVAL_PDF_DIR || process.argv[3];

if (!caseId) throw new Error('TDNET_EVAL_CASE_IDまたは第1引数で評価対象IDを1件指定してください。');
if (!pdfDirectory) {
  throw new Error('TDNET_EVAL_PDF_DIRまたは第2引数でPDF評価ディレクトリを指定してください。');
}
if (!apiKey) {
  throw new Error(
    'APIキーがありません。TDNET_DIGEST_API_KEYまたはプロバイダー別APIキーを.envに設定してください。'
  );
}
if (!model) throw new Error('TDNET_DIGEST_MODELを設定してください。');
if (provider === 'custom' && !baseUrl) {
  throw new Error('customプロバイダーではTDNET_DIGEST_BASE_URLが必要です。');
}

const manifest = JSON.parse(
  await readFile(path.join(root, 'evaluation/fixtures/real-pdf-cases.json'), 'utf8')
) as RealPdfCase[];
const item = manifest.find(({ id }) => id === caseId);
if (!item) throw new Error(`評価対象ID ${caseId} はreal-pdf-cases.jsonにありません。`);

const pdfText = await readFile(path.join(pdfDirectory, 'text', `${item.id}.txt`), 'utf8');
const totalPages = (pdfText.match(/\[PDF_PAGE:\d+\]/g) || []).length;
if (totalPages === 0) {
  throw new Error(
    'ページ境界付きテキストがありません。先にcheck-real-pdfs.mjsを実行してください。'
  );
}

const earningsContext =
  item.expectedType === 'earnings' ? detectEarningsContext(item.title) : undefined;
const capabilities = getProviderCapabilities(provider);
const extractionConfig: LLMConfig = {
  provider,
  apiKey,
  model,
  baseUrl,
  temperature: 0,
  ...(capabilities.jsonObject && { responseFormat: 'json_object' as const }),
};

console.log(`Evaluating ${item.id}: ${item.company} / ${item.expectedType}`);
console.log(`Provider: ${provider}, model: ${model}, pages: ${totalPages}`);

const extractionPrompt = getExtractionPrompt(item.expectedType, pdfText, earningsContext);
let extractedText = await generateText(extractionConfig, toMessages(extractionPrompt));
let validation = parseAndValidateExtraction(extractedText, item.expectedType, totalPages);
let repairAttempted = false;

if (!validation.success) {
  repairAttempted = true;
  extractedText = await generateText(
    extractionConfig,
    buildJsonRepairMessages(
      extractedText,
      validation.errors,
      getJsonSchema(item.expectedType, earningsContext)
    )
  );
  validation = parseAndValidateExtraction(extractedText, item.expectedType, totalPages);
}

if (!validation.success || !validation.data) {
  await saveResult({
    item,
    provider,
    model,
    totalPages,
    repairAttempted,
    success: false,
    validationErrors: validation.errors,
  });
  throw new Error(`JSON検証に失敗しました: ${validation.errors.join(' / ')}`);
}

const formatPrompt = getFormatPrompt(item.expectedType, validation.data, earningsContext);
const summary = await generateText(
  { ...extractionConfig, responseFormat: undefined, temperature: 0.3 },
  toMessages(formatPrompt)
);
const outputPath = await saveResult({
  item,
  provider,
  model,
  totalPages,
  repairAttempted,
  success: true,
  extraction: validation.data,
  summary,
});

console.log(`Validation: success${repairAttempted ? ' after one repair' : ''}`);
console.log(`Result: ${outputPath}`);
console.log('\n' + summary);

function getApiKey(selectedProvider: string): string | undefined {
  if (process.env.TDNET_DIGEST_API_KEY) return process.env.TDNET_DIGEST_API_KEY;
  const names: Record<string, string> = {
    openai: 'OPENAI_API_KEY',
    anthropic: 'ANTHROPIC_API_KEY',
    openrouter: 'OPENROUTER_API_KEY',
    google: 'GOOGLE_API_KEY',
  };
  const name = names[selectedProvider];
  return name ? process.env[name] : undefined;
}

function toMessages(prompt: { system: string; user: string }): ChatMessage[] {
  return [
    { role: 'system', content: prompt.system },
    { role: 'user', content: prompt.user },
  ];
}

async function saveResult(result: Record<string, unknown>): Promise<string> {
  const directory = path.join(root, 'evaluation/results/local');
  await mkdir(directory, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outputPath = path.join(directory, `${caseId}-${provider}-${timestamp}.json`);
  await writeFile(
    outputPath,
    JSON.stringify({ createdAt: new Date().toISOString(), ...result }, null, 2)
  );
  return outputPath;
}
