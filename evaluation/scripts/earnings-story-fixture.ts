/** Fixed facts independently read from the public 2026-10-08 earnings cover.
 * Source coordinates locate the original quantities; expected values never come from product output.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';
import source from '../../src/lib/fixtures/earnings-cover-source.json';
import { extractPageLayout } from '../../src/lib/pdf-layout';
import type { ExtractedPage } from '../../src/types/summaryMetadata';
import type { DrawingOperation } from '../../src/lib/pdf-drawing';
import {
  CANDIDATE_VERSION,
  type Candidate,
  serializeCandidateSource,
} from '../../src/lib/fact-candidates';
import { buildDocumentContext } from '../../src/lib/document-context';
import { sourceTableId } from '../../src/lib/source-provenance';
import { coverageReport } from '../../src/lib/fact-coverage';
import { inspectCandidateSource } from '../../src/lib/source-preflight';
import {
  generateVerifiedFactSummary,
  parseFactSummary,
  renderFacts,
} from '../../src/lib/fact-summary';
import { validateSavedFacts } from '../../src/lib/fact-cache';
import { validatePresentation, revalidatePresentation } from '../../src/lib/summary-presentation';
import { buildSummaryHtml } from '../../src/content/utils/summaryHtmlBuilder';
import { summaryResultId } from '../../src/lib/summary-result-id';
import { earningsTarget } from '../../src/lib/summary-earnings-policy';
import { buildAnalysisFingerprint } from '../../src/lib/analysis-version';
import type { SummaryAttempt } from '../../src/lib/summary-trace';

export { source as earningsStorySource };
interface Expected {
  x: number;
  y: number;
  raw: string;
  value: number;
  label: string;
  year: number;
  state: 'actual' | 'forecast';
  metricKind: 'amount' | 'perShare';
  scope: '連結' | null;
}
// The seven columns are visibly distinct from their adjacent percentages.
const metrics = [
  '売上収益',
  '事業利益',
  '営業利益',
  '税引前利益',
  '当期利益',
  '親会社の所有者に帰属する当期利益',
  '当期包括利益合計額',
];
const xs = [133.22857, 198.72857, 256.72857, 314.72857, 372.72857, 434.22857, 492.22857];
const actuals = [
  {
    year: 2026,
    y: -557.6911,
    raw: ['3,963,389', '718,499', '743,128', '802,505', '584,141', '542,516', '878,726'],
  },
  {
    year: 2025,
    y: -546.3911,
    raw: ['3,400,539', '551,156', '564,265', '650,574', '459,153', '433,009', '509,673'],
  },
];
export const earningsExpectations: Expected[] = [
  ...actuals.flatMap(({ year, y, raw }) =>
    raw.map(
      (value, index): Expected => ({
        x: xs[index],
        y,
        raw: value,
        value: Number(value.replace(/,/g, '')),
        label: metrics[index],
        year,
        state: 'actual',
        metricKind: 'amount',
        scope: '連結',
      })
    )
  ),
  {
    x: 179.97857,
    y: -488.0911,
    raw: '1,768.08',
    value: 1768.08,
    label: '基本的1株当たり当期利益',
    year: 2026,
    state: 'actual',
    metricKind: 'perShare',
    scope: '連結',
  },
  {
    x: 179.97857,
    y: -477.0911,
    raw: '1,411.44',
    value: 1411.44,
    label: '基本的1株当たり当期利益',
    year: 2025,
    state: 'actual',
    metricKind: 'perShare',
    scope: '連結',
  },
  ...[
    [136.72857, '4,450,000', 4450000, '売上収益'],
    [209.22857, '830,000', 830000, '事業利益'],
    [274.22857, '830,000', 830000, '営業利益'],
    [338.72857, '880,000', 880000, '税引前利益'],
    [403.72857, '560,000', 560000, '親会社の所有者に帰属する当期利益'],
    [508.22857, '1,825.06', 1825.06, '基本的1株当たり当期利益'],
  ].map(
    ([x, raw, value, label]): Expected => ({
      x: Number(x),
      y: -111.0911,
      raw: String(raw),
      value: Number(value),
      label: String(label),
      year: 2027,
      state: 'forecast',
      metricKind: String(label).includes('1株') ? 'perShare' : 'amount',
      scope: '連結',
    })
  ),
  {
    x: 348.47857,
    y: -202.5911,
    raw: '900.00',
    value: 900,
    label: '合計',
    year: 2027,
    state: 'forecast',
    metricKind: 'perShare',
    scope: null,
  },
];

export function earningsCoverPage(): ExtractedPage {
  return extractPageLayout(
    source.page.items as TextItem[],
    1,
    source.page.drawingOperations as DrawingOperation[]
  );
}

export async function replayEarningsStory(pages: ExtractedPage[]) {
  assert.equal(pages[0].pageNumber, 1);
  const cover = pages[0];
  const candidates: Candidate[] = earningsExpectations.map((expected, i) => {
    const quantity = cover.quantities.find(
      (q) => Math.abs(q.x - expected.x) < 0.001 && Math.abs(q.y - expected.y) < 0.001
    );
    assert.ok(quantity, `Missing source quantity: ${expected.year} ${expected.label}`);
    assert.equal(
      quantity.text,
      expected.raw,
      `Adjacent-cell contamination: ${expected.year} ${expected.label}`
    );
    return {
      candidateId: `c${i + 1}`,
      importance: expected.year === 2025 ? 'key' : 'detail',
      kind: 'number',
      source: {
        kind: 'table',
        valueId: quantity.id,
        tableId: sourceTableId(cover, quantity.id),
        contextBindingId: `ctx:${quantity.id}`,
      },
      meaning: {
        subject: '株式会社ファーストリテイリング',
        scope: expected.scope,
        basis: expected.scope === '連結' ? 'IFRS会計基準' : null,
        period: `${expected.year}年8月期`,
        periodKind: 'fullYear',
        metricKind: expected.metricKind,
        state: expected.state,
        polarity: 'affirmative',
      },
    };
  });
  for (const [x, rate, amountX] of [
    [170.97857, '16.6', 133.22857],
    [286.97857, '31.7', 256.72857],
    [464.47857, '25.3', 434.22857],
  ] as const) {
    const quantity = cover.quantities.find(
      (q) => Math.abs(q.x - x) < 0.001 && Math.abs(q.y + 557.6911) < 0.001
    );
    const amount = cover.quantities.find(
      (q) => Math.abs(q.x - amountX) < 0.001 && Math.abs(q.y + 557.6911) < 0.001
    )!;
    assert.equal(quantity?.text, rate);
    assert.ok(quantity!.spanIds.every((id) => !amount.spanIds.includes(id)));
  }
  const context = buildDocumentContext(pages);
  const input = serializeCandidateSource(pages, context, 'earnings');
  const sourceIssues = inspectCandidateSource('earnings', pages, context, input);
  assert.deepEqual(sourceIssues, []);
  const slots = coverageReport('earnings', pages, [], [], context);
  assert.ok(
    slots
      .filter((slot) => slot.requirement.startsWith('COVERAGE:当年決算実績'))
      .every((slot) => slot.sourceIds.length > 0)
  );
  const previousFetch = globalThis.fetch;
  const attempts: SummaryAttempt[] = [];
  const phases: string[] = [];
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), 'https://api.openai.com/v1/chat/completions');
    assert.equal(init?.method, 'POST');
    const request = JSON.parse(String(init?.body));
    const prompt = request.messages.find((m: { role: string }) => m.role === 'user')
      .content as string;
    const organization = prompt.startsWith('{"facts":');
    phases.push(organization ? 'summary' : 'first');
    // An empty optional explanation is deliberately honest; do not claim model quality.
    const content = organization
      ? JSON.stringify({ version: 6, contexts: [], observations: [], claims: [] })
      : JSON.stringify({
          candidateVersion: CANDIDATE_VERSION,
          documentType: 'earnings',
          candidates: [...candidates].reverse(),
          unverified: [],
        });
    return Response.json({ choices: [{ message: { content }, finish_reason: 'stop' }] });
  };
  try {
    const result = await generateVerifiedFactSummary(
      { provider: 'openai', model: 'fixture', apiKey: 'fixture' },
      'earnings',
      pages.map((p) => p.text).join('\n'),
      pages,
      (attempt) => {
        attempts.push(attempt);
      }
    );
    assert.deepEqual(phases, ['first', 'summary']);
    assert.equal(result.repairAttempted, false);
    assert.deepEqual(result.facts.unverified, []);
    assert.deepEqual(earningsTarget(result.presentation.excerpts), {
      issue: null,
      target: {
        fiscal: '2026年8月期',
        periodKind: 'fullYear',
        label: '2026年8月期',
        scope: '連結',
        subject: '株式会社ファーストリテイリング',
        basis: 'IFRS',
      },
    });
    for (const [index, expected] of earningsExpectations.entries()) {
      const candidate = candidates[index];
      assert.equal(candidate.source.kind, 'table');
      const fact = result.facts.facts.find(
        (f) =>
          f.evidence.kind === 'table' &&
          f.evidence.valueId === (candidate.source as { valueId: string }).valueId
      );
      assert.ok(
        fact,
        `Unverified ${expected.year} ${expected.label}: ${JSON.stringify(attempts[0].diagnostics)}`
      );
      assert.equal(fact.value, expected.value);
      assert.equal(fact.unit, expected.metricKind === 'amount' ? '百万円' : '円');
      assert.equal(fact.period, `${expected.year}年8月期`);
      assert.equal(fact.semantics.state, expected.state);
      assert.equal(fact.semantics.scope, expected.scope);
      assert.equal(fact.semantics.basis, expected.scope === '連結' ? 'IFRS会計基準' : null);
      assert.equal(fact.page, 1);
    }
    const restored = JSON.parse(JSON.stringify(result));
    validateSavedFacts(restored.facts);
    validatePresentation(restored.presentation, restored.facts);
    assert.deepEqual(
      parseFactSummary(JSON.stringify(restored.facts), 'earnings', pages),
      result.facts
    );
    const refreshed = revalidatePresentation(restored.presentation, restored.facts, pages);
    const markdown = renderFacts(result.facts, result.presentation);
    assert.equal(renderFacts(restored.facts, refreshed), markdown);
    const overview = result.presentation.overview
      .map((id) => result.facts.facts.find((f) => f.id === id))
      .filter(Boolean);
    assert.ok(overview.length >= 3);
    assert.ok(
      overview.every((f) => f!.period === '2026年8月期' && f!.semantics.state === 'actual')
    );
    assert.deepEqual(
      overview.slice(0, 2).map((f) => f!.value),
      [3963389, 743128]
    );
    const html = buildSummaryHtml(markdown, null, {
      companyName: 'ファーストリテイリング',
      title: '2026年8月期 決算短信〔IFRS〕（連結）',
      pdfUrl: source.url,
    });
    assert.match(html, /税引前利益/);
    assert.doesNotMatch(markdown, /^\|\s*経常利益\s*\|/m);
    assert.ok(
      result.facts.facts.some((fact) => fact.label === '税引前利益' && fact.value === 802505)
    );
    const fingerprint = await buildAnalysisFingerprint({
      provider: 'openai',
      model: 'fixture',
      extractionMode: 'full',
    });
    assert.equal(
      await summaryResultId(source.url, fingerprint, restored.facts, source.sha256, refreshed),
      await summaryResultId(
        source.url,
        fingerprint,
        result.facts,
        source.sha256,
        result.presentation
      )
    );
    return {
      pages: pages.length,
      quantities: earningsExpectations.length,
      sourceIssues,
      coverage: coverageReport('earnings', pages, result.facts.facts, [], context),
      phases,
      inputSha256: createHash('sha256').update(input).digest('hex'),
      markdown,
      html,
      result,
    };
  } finally {
    globalThis.fetch = previousFetch;
  }
}
