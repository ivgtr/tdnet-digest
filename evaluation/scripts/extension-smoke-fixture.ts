/** One physical PDF and fixed source-first wire response; no model-quality claim. */
import assert from 'node:assert/strict';
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { extractPdfPageLayout } from '../../src/lib/pdf-layout';
import { generateSourceSummary } from '../../src/lib/source-summary';
import { ANALYSIS_VERSION } from '../../src/lib/additional-analysis';
import { renderFacts } from '../../src/lib/fact-summary';
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
  const valueRow = page.blocks.find((block) => block.text.includes('100'));
  assert.ok(valueRow, 'physical PDF extraction must contain the tested amount');
  const evidenceIds = [`raw:${valueRow.id}`];
  return {
    pdf,
    pages,
    response(body: { messages: Array<{ role: string; content: string }> }) {
      const prompt = body.messages.find((message) => message.role === 'user')?.content ?? '';
      // Fail closed on a legacy extraction/repair request or an unexpected contract.
      assert.match(prompt, /今回の要求は事実要約/);
      assert.ok(prompt.includes(evidenceIds[0]));
      if (outcome === 'failure') return '{invalid JSON';
      return JSON.stringify({
        version: ANALYSIS_VERSION,
        overallSummary: { text: '営業利益100百万円を発表した。', evidenceIds },
        issues: [
          {
            title: '営業利益の発表',
            conclusion: '営業利益は100百万円。',
            reading: '2026年3月期の連結経営成績として公表している。',
            caveat: '',
            nextCheck: '',
            evidenceIds,
          },
          ...(outcome === 'partial'
            ? [
                {
                  title: '参照不正の項目',
                  conclusion: 'この項目は表示してはいけない。',
                  reading: '存在しない根拠を参照している。',
                  caveat: '',
                  nextCheck: '',
                  evidenceIds: ['raw:missing-smoke-source'],
                },
              ]
            : []),
        ],
      });
    },
  };
}

/** Exercise the active source-first path before importing or launching a browser. */
export async function preflightExtensionSmoke(outcome: SmokeOutcome) {
  const fixture = await extensionSmokeFixture(outcome);
  const previousFetch = globalThis.fetch;
  let requests = 0;
  const phases: string[] = [];
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
      generateSourceSummary(
        { provider: 'openai', model: 'fixture', apiKey: 'fixture' },
        'other',
        fixture.pages,
        (snapshot) => {
          if (snapshot.response !== null && !phases.length) phases.push('summary');
        }
      );
    if (outcome === 'failure') {
      await assert.rejects(generate, /invalid_json/);
      assert.deepEqual(phases, ['summary']);
      assert.equal(requests, 1, 'invalid output must not trigger a paid repair');
      return { fixture, requests, phases, result: null };
    }
    const result = await generate();
    assert.deepEqual(phases, ['summary']);
    assert.equal(requests, 1);
    assert.equal(result.facts.facts.length, 0, 'raw-source summary must not invent verified facts');
    assert.equal(result.presentation.sourceFirst?.summary?.issues.length, 1);
    assert.equal(
      Boolean(result.presentation.sourceFirst?.summary?.notices.length),
      outcome === 'partial'
    );
    const restored = JSON.parse(JSON.stringify(result));
    validateSavedFacts(restored.facts);
    validatePresentation(restored.presentation, restored.facts);
    const rendered = renderFacts(restored.facts, restored.presentation);
    const html = buildSummaryHtml(rendered, null, {
      companyName: '株式会社テスト',
      title: '開示',
      pdfUrl: SMOKE_PDF,
    });
    assert.match(html, /100/);
    assert.match(html, /百万円/);
    assert.doesNotMatch(html, /この項目は表示してはいけない/);
    return { fixture, requests, phases, result };
  } finally {
    globalThis.fetch = previousFetch;
  }
}
