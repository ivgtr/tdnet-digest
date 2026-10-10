import { describe, expect, it } from 'vitest';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';
import fixture from './fixtures/yaskawa-source-first-items.json';
import { extractPageLayout } from './pdf-layout';
import { buildPresentation, revalidatePresentation } from './summary-presentation';
import { buildAnalysisInput } from './analysis-input';
import {
  analysisPrompt,
  assertAnalysisInputBudget,
  parseAnalysis,
  parseAnalysisResponse,
} from './additional-analysis';
import { acquireSourceComparisons } from './source-comparison';
import { buildDocumentContext } from './document-context';
import { summaryComparison, comparisonGrowth } from './summary-comparison';
import { renderFacts } from './fact-summary';
import { reviewCandidates } from './fact-candidates';
import { buildAnalysisCalculations } from './analysis-calculations';
import type { FactSummary } from './fact-contract';
import { buildAnalysisStageHtml } from '../content/utils/summaryHtmlBuilder';

// Public PDF.js native text items, not captured model traces. Expectations below
// were checked against the rendered PDF (physical pages, not printed page labels).
const pages = fixture.pages.map((page) =>
  extractPageLayout(
    page.items.map((item) => {
      const [str, transform, width, height, dir, hasEOL] = item;
      return { str, transform, width, height, dir, hasEOL, fontName: 'fixture' } as TextItem;
    }),
    page.pageNumber
  )
);
const noFacts: FactSummary = { version: 6, documentType: 'earnings', facts: [], unverified: [] };
const presentation = buildPresentation(noFacts, pages);
const input = buildAnalysisInput(noFacts, presentation);

// The following are human-selected candidates, not evidence of model recall.
function pretaxCandidates() {
  return {
    candidateVersion: 4,
    documentType: 'earnings',
    candidates: [
      ['p1s53', 'p1t1', '2027年2月期第2四半期', 'cumulativeQ2', 'actual'],
      ['p1s62', 'p1t1', '2026年2月期第2四半期', 'cumulativeQ2', 'actual'],
      ['p1s164', 'p1t4', '2027年2月期', 'fullYear', 'forecast'],
    ].map(([valueId, tableId, period, periodKind, state], i) => ({
      candidateId: `c${i + 1}`,
      importance: 'key',
      kind: 'number',
      source: { kind: 'table', valueId, tableId, contextBindingId: `ctx:${valueId}` },
      meaning: {
        subject: '株式会社安川電機',
        scope: '連結',
        basis: 'IFRS',
        period,
        periodKind,
        metricKind: 'amount',
        state,
        polarity: 'affirmative',
      },
    })),
    unverified: [],
  };
}

describe('source-first public PDF regression', () => {
  it('retains every extracted row/cell, including financial evidence not selected by a summary', () => {
    const document = input.sourceDocument!;
    expect(document.pages.map((p) => p.pageNumber)).toEqual([1, 5, 7, 13, 15, 16]);
    expect(document.coverage.rows).toBe(pages.reduce((n, p) => n + p.blocks.length, 0));
    // Source record counts include headings, administrative text and notes, not only financial rows.
    expect(document.coverage.rows).toBe(186);
    expect(input.coverage.facts).toBe(0);
    expect(input.coverage.calculations).toBe(0);
    for (const page of pages) {
      const projected = document.pages.find((p) => p.pageNumber === page.pageNumber)!;
      expect(projected.rows.map((r) => r[0])).toEqual(page.blocks.map((b) => b.id));
      const cells = [...projected.rows.flatMap((r) => r[2]), ...projected.looseSpans];
      for (const span of page.spans)
        expect(cells.some((c) => c[0] === span.id && c[1] === span.text)).toBe(true);
    }
    const source = (page: number) =>
      document.pages
        .find((p) => p.pageNumber === page)!
        .rows.map((r) => r[1])
        .join('\n');
    // Pretax actuals/forecast, old forecast and changed FX assumptions.
    for (const value of ['25,963', '25,204', '65,500']) expect(source(1)).toContain(value);
    for (const value of ['65,000', '145.00', '155.00', '170.00', '180.00', '20.50', '22.00'])
      expect(source(7)).toContain(value);
    // CFO, investing/financing, cash change, FX and beginning/ending balance.
    for (const value of ['45,628', '△29,642', '△12,776', '3,208', '1,651', '61,223', '66,083'])
      expect(source(13)).toContain(value);
    for (const value of ['112,837', '119,204', '12,024', '10,542'])
      expect(source(15)).toContain(value);
    for (const value of ['137,286', '118,404', '15,973', '5,974'])
      expect(source(16)).toContain(value);
    expect(presentation.values.find((v) => v.id === 'p5b14:q3')).toMatchObject({
      raw: '1,184億 4百万円',
      unit: '円',
      decimal: null,
    });
    for (const id of ['p7s46', 'p7s47', 'p7s48', 'p7s49', 'p7s50'])
      expect(presentation.values.find((v) => v.id === id)?.unit).toBe('%');
    expect(input.evidence.every((e) => e.kind === 'source')).toBe(true);
    expect(analysisPrompt(input)[1].content).toContain('65,000');
    expect(() => assertAnalysisInputBudget(analysisPrompt(input))).not.toThrow();
  });

  it('accepts explicitly selected pretax cells as verified facts, separately from raw retention', () => {
    const reviewed = reviewCandidates(JSON.stringify(pretaxCandidates()), 'earnings', pages);
    expect(reviewed.diagnostics.every((d) => d.status === 'valid')).toBe(true);
    expect(reviewed.facts.map((f) => [f.label, f.quantity?.decimal, f.unit])).toEqual([
      ['税引前利益', '25963', '百万円'],
      ['税引前利益', '25204', '百万円'],
      ['税引前利益', '65500', '百万円'],
    ]);
    // A selected current cell must recover its omitted prior-year partner through
    // the ordinary verifier, independently of a model recalling the prior cell.
    const currentOnly = pretaxCandidates();
    currentOnly.candidates = currentOnly.candidates.slice(0, 1);
    currentOnly.candidates[0].importance = 'detail';
    currentOnly.candidates[0].meaning.period = '2027年2月期中間期';
    const acquired = acquireSourceComparisons(
      reviewCandidates(JSON.stringify(currentOnly), 'earnings', pages),
      'earnings',
      pages,
      buildDocumentContext(pages)
    );
    expect(acquired.facts.map((f) => f.quantity?.decimal)).toEqual(['25963', '25204']);
    expect(acquired.facts[1].evidence).toMatchObject({ valueId: 'p1s62', metricIds: ['p1s38'] });
    const comparison = summaryComparison(acquired.facts[0], acquired.facts)!;
    expect(comparisonGrowth(acquired.facts[0], comparison)).toEqual({
      kind: 'change',
      rate: '+3.0%',
    });
    const acquiredFacts = { ...noFacts, facts: acquired.facts };
    const acquiredDisplay = buildPresentation(acquiredFacts, pages);
    const rendered = renderFacts(acquiredFacts, acquiredDisplay);
    expect(rendered).toContain('25,204');
    expect(rendered).not.toContain('前年の値が要約に未抽出');
    expect(
      renderFacts(acquiredFacts, revalidatePresentation(acquiredDisplay, acquiredFacts, pages))
    ).toBe(rendered);
    const facts = { ...noFacts, facts: reviewed.facts };
    const display = buildPresentation(facts, pages);
    const selected = buildAnalysisInput(facts, display);
    expect(selected.evidence.filter((e) => e.kind === 'fact')).toHaveLength(3);
    const calculations = buildAnalysisCalculations(facts, display);
    expect(calculations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'difference',
          value: '759',
          unit: '百万円',
        }),
      ])
    );
  });

  it('restores source citations without promoting raw text and rejects changed saved evidence/source', () => {
    const row = input.evidence.find((e) => e.id === 'raw:p1b13')!;
    const response = {
      version: 4,
      issues: [
        {
          title: '営業利益と税引前利益の違い',
          conclusion: '原文の異なる利益段階を分けて確認する。',
          evidenceIds: [row.id],
          reading: '営業利益の減少と税引前利益の増加は同じ指標ではない。',
          caveat: '',
          nextCheck: '',
        },
      ],
    };
    const result = parseAnalysisResponse(JSON.stringify(response), input);
    expect(result.issues).toHaveLength(1);
    expect(result.evidence).toEqual([row]);
    expect(JSON.stringify(result).length).toBeLessThan(20_000);
    expect(result).not.toHaveProperty('sourceDocument');
    expect(result).not.toHaveProperty('sourceLedger');
    const restoredPresentation = revalidatePresentation(
      JSON.parse(JSON.stringify(presentation)),
      noFacts,
      pages
    );
    const restored = parseAnalysis(JSON.stringify(result), noFacts, restoredPresentation);
    const html = buildAnalysisStageHtml(
      { data: restored, loading: false, error: null },
      noFacts.facts,
      fixture.url
    );
    expect(html).toContain('25,963');
    expect(html).toContain('抽出原文');
    const editedResult = structuredClone(result);
    editedResult.evidence[0].text = 'changed text';
    expect(() =>
      parseAnalysis(JSON.stringify(editedResult), noFacts, restoredPresentation)
    ).toThrow();
    const changedPages = structuredClone(pages);
    changedPages[0].spans.find((s) => s.id === 'p1s53')!.text = '25,964';
    expect(() =>
      parseAnalysis(JSON.stringify(result), noFacts, buildPresentation(noFacts, changedPages))
    ).toThrow();
  });
});
