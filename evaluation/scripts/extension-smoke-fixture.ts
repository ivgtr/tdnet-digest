/** One physical PDF and fixed wire responses for the extension boundary, not model quality. */
import assert from 'node:assert/strict';
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { extractPdfPageLayout } from '../../src/lib/pdf-layout';
import { candidateResponse } from '../../src/lib/fixtures/candidate-test-source';
import { numberCandidate } from '../../src/lib/fixtures/v4-test-source';
import {
  generateVerifiedFactSummary,
  parseFactSummary,
  renderFacts,
} from '../../src/lib/fact-summary';
import { validateSavedFacts } from '../../src/lib/fact-cache';
import { validatePresentation } from '../../src/lib/summary-presentation';
import { buildSummaryHtml } from '../../src/content/utils/summaryHtmlBuilder';
import { textPdf } from './text-pdf-fixture';

export const SMOKE_API = 'https://api.openai.com/v1/chat/completions';
export const SMOKE_PDF = 'https://www.release.tdnet.info/inbs/fixture-extension-smoke.pdf';
export type SmokeOutcome = 'success' | 'partial' | 'failure';
const sourceText = [
  '会社名 株式会社テスト | 会計基準 日本基準 | 範囲 連結',
  '2026年3月期 連結経営成績',
  '営業利益は100百万円です。',
  '販売体制の強化を進めています。',
].join('\n');

export async function extensionSmokeFixture(outcome: SmokeOutcome) {
  const pdf = textPdf([sourceText]);
  const document = await getDocument({ data: pdf.slice(), useSystemFonts: true }).promise;
  let page;
  try {
    const physicalPage = await document.getPage(1);
    page = await extractPdfPageLayout(physicalPage, 1, OPS);
  } finally {
    await document.destroy();
  }
  const pages = [page];
  const candidate = candidateResponse([numberCandidate(page)], pages, 'other');
  // Source IDs refer to actual PDF.js extraction. Meaning and expected values stay explicit.
  const sourceIds = page.blocks.map((block) => `source:${block.id}`);
  const responses = [
    candidate,
    JSON.stringify({
      version: 6,
      contexts: [
        {
          id: 'business',
          topic: 'other',
          entity: null,
          scope: null,
          basis: null,
          period: null,
          state: 'unspecified',
          conditions: [],
          sourceIds,
        },
      ],
      observations: [],
      claims: [{ contextId: 'business', text: '販売体制を強化している。', sourceIds }],
    }),
  ];
  return {
    pdf,
    pages,
    candidate,
    response(body: { messages: Array<{ role: string; content: string }> }) {
      const prompt = body.messages.find((message) => message.role === 'user')?.content ?? '';
      if (outcome === 'failure') return JSON.stringify({ candidateVersion: 0 });
      // Discriminate public request payloads so a repair/new phase cannot consume the next reply.
      if (prompt.includes('\n指標・説明: ')) {
        const ids = JSON.parse(prompt.split('\n対象段落: ')[1]) as string[];
        return JSON.stringify({
          version: 2,
          claims: [
            { id: 'explanation-0', reason: outcome === 'partial' ? '説明の裏付けが不足' : null },
          ],
          sources: ids.map((id) => ({ id, reason: null })),
        });
      }
      if (prompt.startsWith('{"facts":')) return responses[1];
      return responses[0];
    },
  };
}

/** Exercise the same wire fixtures through real code before any browser is imported/launched. */
export async function preflightExtensionSmoke(outcome: SmokeOutcome) {
  const fixture = await extensionSmokeFixture(outcome);
  const previousFetch = globalThis.fetch;
  let requests = 0;
  const phases: string[] = [];
  // No server, credentials or network access. Any unexpected URL fails closed.
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), SMOKE_API);
    assert.equal(init?.method, 'POST');
    requests++;
    return Response.json({
      choices: [
        {
          message: { content: fixture.response(JSON.parse(String(init?.body))) },
          finish_reason: 'stop',
        },
      ],
    });
  };
  try {
    const generate = () =>
      generateVerifiedFactSummary(
        { provider: 'openai', model: 'fixture', apiKey: 'fixture' },
        'other',
        fixture.pages.map((page) => page.text).join('\n'),
        fixture.pages,
        (attempt) => {
          phases.push(attempt.phase);
        }
      );
    if (outcome === 'failure') {
      await assert.rejects(generate, /SCHEMA/);
      assert.deepEqual(phases, ['first', 'repair']);
      assert.equal(requests, 2);
      return { fixture, requests, phases, result: null };
    }
    const result = await generate();
    assert.deepEqual(phases, ['first', 'summary', 'summaryReview']);
    assert.equal(requests, 3);
    assert.equal(
      result.presentation.organization.status,
      outcome === 'success' ? 'ready' : 'unavailable'
    );
    assert.equal(result.facts.facts.length, 1);
    assert.equal(result.facts.facts[0].value, 100);
    assert.equal(result.facts.facts[0].unit, '百万円');
    assert.equal(result.facts.facts[0].period, '2026年3月期');
    const restored = JSON.parse(JSON.stringify(result));
    validateSavedFacts(restored.facts);
    validatePresentation(restored.presentation, restored.facts);
    assert.deepEqual(
      parseFactSummary(JSON.stringify(restored.facts), 'other', fixture.pages),
      result.facts
    );
    const rendered = renderFacts(restored.facts, restored.presentation);
    const html = buildSummaryHtml(rendered, null, {
      companyName: '株式会社テスト',
      title: '開示',
      pdfUrl: SMOKE_PDF,
    });
    assert.match(html, /100/);
    assert.match(html, /百万円/);
    return { fixture, requests, phases, result };
  } finally {
    globalThis.fetch = previousFetch;
  }
}
