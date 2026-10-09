import { describe, expect, it } from 'vitest';
import type { FactSummary, VerifiedFact } from './fact-contract';
import type { ExtractedPage } from '@/types/summaryMetadata';
import { textPage, numberCandidate } from './fixtures/v4-test-source';
import { candidateResponse } from './fixtures/candidate-test-source';
import { cells, tableAmount } from './fixtures/fact-review-source';
import { reviewCandidates } from './fact-candidates';
import { parseFactSummary, renderFacts } from './fact-summary';
import { validateSavedFacts } from './fact-cache';
import { buildDocumentContext, isReportingCoverUnit } from './document-context';
import {
  buildPresentation,
  revalidatePresentation,
  validatePresentation,
  type SummaryPresentation,
} from './summary-presentation';
import { sourceInventory } from './summary-source-inventory';
import { earningsTarget } from './summary-earnings-policy';
import { coverageReport } from './fact-coverage';
import { buildSummaryHtml } from '../content/utils/summaryHtmlBuilder';

// Quarter-like characters belong to the literal issuer name, not the period grammar.
const issuer = '株式会社2Qテスト';
const fiscal = '2026年3月期';
type Attributes = Pick<VerifiedFact['semantics'], 'subject' | 'scope' | 'basis'>;
const issuerUnit: Attributes = { subject: issuer, scope: '連結', basis: '日本基準' };
type ActualUnit = Attributes & { value: number; importance?: VerifiedFact['importance'] };

function cover(attributes: Attributes, extraFields: string[] = []): ExtractedPage {
  return textPage(
    [
      `${fiscal} 決算短信${attributes.basis ? `〔${attributes.basis}〕` : ''}${attributes.scope ? `（${attributes.scope}）` : ''}`,
      ...(attributes.subject ? [`会社名 ${attributes.subject}`] : []),
      ...extraFields,
    ].join('\n')
  );
}

function actualSources(firstPage: ExtractedPage, units: ActualUnit[]) {
  const pages = [
    firstPage,
    ...units.map((unit, index) =>
      textPage(
        [
          ...(unit.subject ? [`会社名 ${unit.subject}`] : []),
          `${index + 1}. ${fiscal} ${unit.scope ?? ''}経営成績`,
          ...(unit.basis ? [`会計基準 ${unit.basis}`] : []),
          `${fiscal}の売上高は${unit.value}百万円です。`,
        ].join('\n'),
        index + 2
      )
    ),
  ];
  const inputs = units.map((unit, index) => {
    const input = numberCandidate(pages[index + 1], '売上高', unit.value, fiscal);
    Object.assign(input.semantics, {
      subject: unit.subject,
      scope: unit.scope,
      basis: unit.basis,
    });
    input.importance = unit.importance ?? 'key';
    return input;
  });
  return { pages, inputs };
}

function verifiedSummary(
  pages: ExtractedPage[],
  inputs: VerifiedFact[],
  expectedValues: number[]
): FactSummary {
  const reviewed = reviewCandidates(
    candidateResponse(inputs, pages, 'earnings'),
    'earnings',
    pages
  );
  expect(expectedValues.length).toBeGreaterThan(0);
  expect(reviewed.unverified).toEqual([]);
  expect(reviewed.facts).toHaveLength(expectedValues.length);
  expect(reviewed.facts.map((fact) => fact.value)).toEqual(expectedValues);
  return { version: 6, documentType: 'earnings', facts: reviewed.facts, unverified: [] };
}

const headlineValues = (summary: FactSummary, display: SummaryPresentation) =>
  display.overview.map((id) => summary.facts.find((fact) => fact.id === id)?.value);
const amount = (value: number) => `${value.toLocaleString('en-US')}百万円`;
const headline = (markdown: string) => markdown.split('## 業績と増減要因')[0];

function assertBodyAndRestore(
  summary: FactSummary,
  pages: ExtractedPage[],
  display: SummaryPresentation,
  expectedValues: number[]
) {
  const bodyIds = display.sections.flatMap((section) => section.factIds);
  expect(bodyIds).toHaveLength(expectedValues.length);
  expect(new Set(bodyIds)).toEqual(new Set(summary.facts.map((fact) => fact.id)));
  const markdown = renderFacts(summary, display);
  const body = markdown.slice(markdown.indexOf('## 業績と増減要因'));
  for (const value of expectedValues) expect(body).toContain(amount(value));
  const saved: unknown = JSON.parse(JSON.stringify(summary));
  validateSavedFacts(saved);
  // Both the facts and the presentation are rechecked against the same PDF source blocks.
  const recheckedFacts = parseFactSummary(JSON.stringify(saved), 'earnings', pages, false);
  expect(recheckedFacts.unverified).toEqual([]);
  expect(recheckedFacts.facts.map((fact) => fact.value)).toEqual(expectedValues);
  const restored = revalidatePresentation(
    JSON.parse(JSON.stringify(display)),
    recheckedFacts,
    pages
  );
  expect(renderFacts(recheckedFacts, restored)).toBe(markdown);
  const html = buildSummaryHtml(markdown, null, { companyName: issuer, title: '決算短信' });
  for (const value of expectedValues) expect(html).toContain(amount(value));
  return { markdown, html, restored, saved: recheckedFacts };
}

// Owner: the source-verified actual headline contract. Forecast vocabulary/completeness
// stays in summary-presentation.test; the mixed story below owns the saved-PDF boundary.
describe('報告対象の完全性を候補・冒頭・本文・保存復元で保つ', () => {
  it.each([
    ['TEST GROUP', true],
    ['ACME CO., LTD.', false],
  ] as const)(
    '先頭の%sの後の完全な表紙を文脈・必須判定・冒頭・保存復元で共有する: 節=%s',
    (mark, section) => {
      const page = textPage(
        `${mark}\n${fiscal} 決算短信〔日本基準〕（連結）\n会社名 ${issuer}\n${section ? `1. ${fiscal}連結経営成績\n` : ''}${fiscal}の売上高は1000百万円です。`
      );
      const input = numberCandidate(page, '売上高', 1000, fiscal);
      Object.assign(input.semantics, issuerUnit);
      const summary = verifiedSummary([page], [input], [1000]);
      expect(coverageReport('earnings', [page], []).map((slot) => slot.sourceIds.length)).toEqual([
        1, 0, 0,
      ]);
      if (!section) {
        const context = buildDocumentContext([page]);
        const block = page.blocks.find((block) => block.text.includes('売上高'))!;
        expect(
          isReportingCoverUnit(context.bindings.find((binding) => binding.anchorId === block.id)!, [
            page,
          ])
        ).toBe(true);
      }
      expect(earningsTarget(sourceInventory([page], undefined, 'earnings'))).toMatchObject({
        issue: null,
        target: { fiscal, periodKind: 'fullYear', ...issuerUnit },
      });
      const coverage = coverageReport('earnings', [page], summary.facts);
      expect(coverage.map((slot) => slot.requirement)).toEqual([
        'COVERAGE:当年決算実績の重要指標 revenue',
        'COVERAGE:当年決算実績の重要指標 operatingProfit',
        'COVERAGE:当年決算実績の重要指標 netProfit',
      ]);
      expect(coverage[0]).toMatchObject({
        requirement: 'COVERAGE:当年決算実績の重要指標 revenue',
        status: 'satisfied',
        expected: { period: fiscal, periodKind: 'fullYear', ...issuerUnit },
      });
      expect(coverage[0].sourceIds).toHaveLength(1);
      const display = buildPresentation(summary, [page]);
      expect(headlineValues(summary, display)).toEqual([1000]);
      assertBodyAndRestore(summary, [page], display, [1000]);
    }
  );

  it.each([
    ['', fiscal, 'fullYear', fiscal],
    ['通期', fiscal, 'fullYear', fiscal],
    ['第2四半期', `${fiscal}第2四半期累計`, 'cumulativeQ2', `${fiscal}第2四半期`],
  ] as const)(
    '既知の%s表題では冒頭と必須判定が同じ期間の実績を選ぶ',
    (shape, period, kind, targetPeriod) => {
      const page = textPage(
        `${fiscal} ${shape}決算短信〔日本基準〕（連結）\n会社名 ${issuer}\n1. ${period}連結経営成績\n${period}の売上高は1000百万円です。`
      );
      const input = numberCandidate(page, '売上高', 1000, period);
      Object.assign(input.semantics, issuerUnit, { periodKind: kind });
      const summary = verifiedSummary([page], [input], [1000]);
      expect(earningsTarget(sourceInventory([page], undefined, 'earnings'))).toMatchObject({
        issue: null,
        target: { fiscal, periodKind: kind },
      });
      expect(headlineValues(summary, buildPresentation(summary, [page]))).toEqual([1000]);
      const revenue = coverageReport('earnings', [page], summary.facts).filter(
        (slot) => slot.requirement === 'COVERAGE:当年決算実績の重要指標 revenue'
      );
      expect(revenue).toHaveLength(1);
      expect(revenue[0]).toMatchObject({
        requirement: 'COVERAGE:当年決算実績の重要指標 revenue',
        status: 'satisfied',
        expected: { period: targetPeriod, periodKind: kind },
      });
    }
  );

  it.each([
    ['決算短信〔日本基準〕（連結）\n会社名 ' + issuer, '1. ' + fiscal + '連結経営成績'],
    ['会社名 ' + issuer + '\n範囲 連結\n会計基準 日本基準', fiscal + '連結経営成績'],
  ])(
    '先頭の対象期見出しを%sの属性と共有し、必須判定・冒頭・保存復元を一致させる',
    (prefix, heading) => {
      const page = textPage(`${prefix}\n${heading}\n${fiscal}の売上高は1000百万円です。`);
      const input = numberCandidate(page, '売上高', 1000, fiscal);
      Object.assign(input.semantics, issuerUnit);
      const summary = verifiedSummary([page], [input], [1000]);
      expect(earningsTarget(sourceInventory([page], undefined, 'earnings'))).toMatchObject({
        issue: null,
        target: { fiscal, periodKind: 'fullYear', ...issuerUnit },
      });
      const coverage = coverageReport('earnings', [page], summary.facts);
      expect(coverage.map((slot) => slot.requirement)).toEqual([
        'COVERAGE:当年決算実績の重要指標 revenue',
        'COVERAGE:当年決算実績の重要指標 operatingProfit',
        'COVERAGE:当年決算実績の重要指標 netProfit',
      ]);
      expect(coverage[0]).toMatchObject({
        status: 'satisfied',
        sourceIds: [page.blocks.at(-1)!.id],
        expected: { period: fiscal, periodKind: 'fullYear', ...issuerUnit },
      });
      const display = buildPresentation(summary, [page]);
      expect(headlineValues(summary, display)).toEqual([1000]);
      const { markdown } = assertBodyAndRestore(summary, [page], display, [1000]);
      expect(headline(markdown)).toContain(amount(1000));
      expect(headline(markdown)).not.toContain('報告対象期が未特定');
    }
  );

  it('番号のない四半期表題から通期を推測せず、局所で確認した年次実績は本文と保存復元に保つ', () => {
    const firstPage = textPage(`${fiscal} 四半期決算短信〔日本基準〕（連結）\n会社名 ${issuer}`);
    const { pages, inputs } = actualSources(firstPage, [{ ...issuerUnit, value: 1000 }]);
    const summary = verifiedSummary(pages, inputs, [1000]);
    expect(earningsTarget(sourceInventory(pages, undefined, 'earnings'))).toEqual({
      target: null,
      issue: 'ambiguous',
    });
    const coverage = coverageReport('earnings', pages, summary.facts);
    expect(coverage).toHaveLength(1);
    expect(coverage[0]).toMatchObject({
      requirement: 'COVERAGE:報告対象の決算期を確認できません',
      status: 'unknown',
    });
    expect(coverage[0].expected.periodKind).toBeUndefined();
    const mixedCover = textPage(
      `${fiscal} 決算短信〔日本基準〕（連結）\n第3四半期決算短信〔日本基準〕（連結）\n会社名 ${issuer}`
    );
    expect(earningsTarget(sourceInventory([mixedCover], undefined, 'earnings'))).toEqual({
      target: null,
      issue: 'ambiguous',
    });
    expect(coverageReport('earnings', [mixedCover], [])).toMatchObject([
      { requirement: 'COVERAGE:報告対象の決算期を確認できません', status: 'unknown' },
    ]);
    const display = buildPresentation(summary, pages);
    expect(display.overview).toEqual([]);
    const { markdown } = assertBodyAndRestore(summary, pages, display, [1000]);
    expect(headline(markdown)).toContain('報告対象を一意に特定できません');
    expect(headline(markdown)).not.toContain(amount(1000));
    const altered = structuredClone(display);
    altered.overview = [summary.facts[0].id];
    expect(() => revalidatePresentation(altered, summary, pages)).toThrow('報告対象');
  });

  it.each([
    ['四半期', '', null],
    ['第3四半期', '', null],
    ['通期', '第3四半期累計', null],
    ['', '', 'fullYear'],
    ['第3四半期', '第3四半期累計', 'cumulativeQ3'],
  ] as const)(
    '年のない%s表題と%s業績見出しは、明示した期間形が一致するときだけ対象期を補う',
    (coverShape, headingShape, periodKind) => {
      const page = textPage(
        `${coverShape}決算短信〔日本基準〕（連結）\n会社名 ${issuer}\n範囲 連結\n会計基準 日本基準\n1. ${fiscal}${headingShape}連結経営成績\n売上高は1000百万円です。`
      );
      const resolution = earningsTarget(sourceInventory([page], undefined, 'earnings'));
      const coverage = coverageReport('earnings', [page], []);
      if (periodKind) {
        expect(resolution).toMatchObject({ issue: null, target: { fiscal, periodKind } });
        expect(coverage.map((slot) => slot.requirement)).toEqual([
          'COVERAGE:当年決算実績の重要指標 revenue',
          'COVERAGE:当年決算実績の重要指標 operatingProfit',
          'COVERAGE:当年決算実績の重要指標 netProfit',
        ]);
        expect(coverage[0].sourceIds).toEqual([page.blocks.at(-1)!.id]);
        expect(coverage[0].expected).toMatchObject({
          period: fiscal + headingShape.replace('累計', ''),
          periodKind,
          ...issuerUnit,
        });
      } else {
        expect(resolution).toEqual({ target: null, issue: 'ambiguous' });
        expect(coverage).toHaveLength(1);
        expect(coverage[0]).toMatchObject({
          requirement: 'COVERAGE:報告対象の決算期を確認できません',
          status: 'unknown',
        });
      }
    }
  );

  it('独立した会社名欄を保持し、先にある子会社・別基準・個別の重要値より後の発行会社実績を選ぶ', () => {
    const { pages, inputs } = actualSources(cover(issuerUnit), [
      { ...issuerUnit, subject: '株式会社子会社', value: 900 },
      { ...issuerUnit, basis: 'IFRS', value: 800 },
      { ...issuerUnit, scope: '個別', value: 700 },
      { ...issuerUnit, value: 1000, importance: 'detail' },
    ]);
    const summary = verifiedSummary(pages, inputs, [900, 800, 700, 1000]);
    const excerpts = sourceInventory(pages, undefined, 'earnings');
    expect(excerpts).toContainEqual(
      expect.objectContaining({ page: 1, text: `会社名 ${issuer}`, role: 'document' })
    );
    expect(earningsTarget(excerpts)).toMatchObject({ issue: null, target: issuerUnit });
    const display = buildPresentation(summary, pages);
    expect(headlineValues(summary, display)).toEqual([1000]);
    const reversed = { ...summary, facts: [...summary.facts].reverse() };
    expect(headlineValues(reversed, buildPresentation(reversed, pages))).toEqual([1000]);
    const withoutIssuer = {
      ...summary,
      facts: summary.facts.filter((fact) => fact.value !== 1000),
    };
    expect(buildPresentation(withoutIssuer, pages).overview).toEqual([]);
    const { markdown, html } = assertBodyAndRestore(summary, pages, display, [900, 800, 700, 1000]);
    expect(headline(markdown)).toContain(amount(1000));
    for (const value of [900, 800, 700]) {
      expect(headline(markdown)).not.toContain(amount(value));
      expect(html.split('業績と増減要因')[0]).not.toContain(amount(value));
    }
  });

  it.each([
    ['subject', '(?:主体|会社)'],
    ['scope', '範囲'],
    ['basis', '会計基準'],
  ] as const)(
    '表紙の%s不足を付録から推測せず、原文にもない場合はnullのまま本文を保持する',
    (axis, label) => {
      for (const absentEverywhere of [false, true]) {
        const declared = { ...issuerUnit, [axis]: null };
        const local = absentEverywhere ? declared : issuerUnit;
        const { pages, inputs } = actualSources(cover(declared), [{ ...local, value: 1000 }]);
        const summary = verifiedSummary(pages, inputs, [1000]);
        expect(summary.facts[0].semantics[axis]).toBe(absentEverywhere ? null : issuerUnit[axis]);
        const resolution = earningsTarget(sourceInventory(pages, undefined, 'earnings'));
        expect(resolution.issue).not.toBeNull();
        const display = buildPresentation(summary, pages);
        expect(display.overview).toEqual([]);
        const { markdown } = assertBodyAndRestore(summary, pages, display, [1000]);
        expect(headline(markdown)).toMatch(new RegExp(`報告対象.*${label}.*未特定`));
        expect(headline(markdown)).not.toContain('報告対象を一意に特定できません');
        expect(headline(markdown)).not.toContain(amount(1000));
        const altered = structuredClone(display);
        altered.overview = [summary.facts[0].id];
        expect(() => validatePresentation(altered, summary)).not.toThrow();
        expect(() => revalidatePresentation(altered, summary, pages)).toThrow('報告対象');
      }
    }
  );

  it('同義の表紙属性は統合するが、主体・範囲・基準の明示的な衝突を付録の値で解決しない', () => {
    const aliases: Attributes = { subject: issuer, scope: '単体', basis: 'IFRS会計基準' };
    const fields = ['範囲 個別', '会計基準 国際会計基準'];
    const unit = { subject: issuer, scope: '非連結', basis: 'IFRS', value: 1200 };
    for (const conflict of [null, '会社名 株式会社別会社', '範囲 連結', '会計基準 日本基準']) {
      const { pages, inputs } = actualSources(
        cover(aliases, [...fields, ...(conflict ? [conflict] : [])]),
        [unit]
      );
      const summary = verifiedSummary(pages, inputs, [1200]);
      const resolution = earningsTarget(sourceInventory(pages, undefined, 'earnings'));
      if (conflict) expect(resolution).toEqual({ target: null, issue: 'ambiguous' });
      else
        expect(resolution).toMatchObject({
          issue: null,
          target: { subject: issuer, scope: '非連結', basis: 'IFRS' },
        });
      const display = buildPresentation(summary, pages);
      expect(headlineValues(summary, display)).toEqual(conflict ? [] : [1200]);
      const { markdown } = assertBodyAndRestore(summary, pages, display, [1200]);
      if (conflict) {
        expect(headline(markdown)).toContain('報告対象を一意に特定できません');
        expect(headline(markdown)).not.toContain('報告対象期が未特定');
        expect(headline(markdown)).not.toContain(amount(1200));
      } else expect(headline(markdown)).not.toContain('報告対象を一意に特定できません');
    }
  });

  it('当期対象の既知・不足・衝突と独立した既知の予想を区別し、保存冒頭の別主体は両方ともPDF再検証で拒否する', () => {
    for (const actualTarget of ['known', 'missing', 'ambiguous'] as const) {
      const { pages, inputs } = actualSources(
        cover(
          { ...issuerUnit, basis: actualTarget === 'missing' ? null : issuerUnit.basis },
          actualTarget === 'ambiguous' ? ['範囲 個別'] : []
        ),
        [
          { ...issuerUnit, value: 1000 },
          { ...issuerUnit, subject: '株式会社子会社', value: 900 },
        ]
      );
      // The first explicit forecast declaration is for the issuer, not the later subsidiary.
      for (const [index, subject, value] of [
        [4, issuer, 2000],
        [5, '株式会社子会社', 1900],
      ] as const) {
        pages.push(
          cells(
            [
              [`会社名 ${subject}`, 0, 0, 220],
              ['1. 2027年3月期連結業績予想の修正', 0, 30, 460],
              ['会計基準 日本基準', 0, 60, 180],
              ['売上高', 400, 90, 80],
              ['営業利益', 600, 90, 80],
              ['百万円', 410, 120, 60],
              ['百万円', 610, 120, 60],
              ['前回予想', 0, 150, 320],
              ['100', 410, 150, 30],
              ['10', 610, 150, 30],
              ['修正後予想', 0, 180, 320],
              [String(value), 410, 180, 40],
              ['20', 610, 180, 30],
            ],
            index
          )
        );
      }
      const context = buildDocumentContext(pages);
      for (const [pageNumber, subject, value] of [
        [4, issuer, 2000],
        [5, '株式会社子会社', 1900],
      ] as const) {
        const source = pages.find((page) => page.pageNumber === pageNumber)!;
        const quantity = source.quantities.find((q) => q.text === String(value))!;
        const mapping = context.tableMappings.find((m) => m.valueId === quantity.id)!;
        expect(mapping).toBeDefined();
        inputs.push(
          tableAmount(pages, mapping, {
            period: '2027年3月期',
            subject,
            scope: '連結',
            basis: '日本基準',
            state: 'forecastAfter',
          })
        );
      }
      const summary = verifiedSummary(pages, inputs, [1000, 900, 2000, 1900]);
      const display = buildPresentation(summary, pages);
      expect(headlineValues(summary, display)).toEqual(
        actualTarget === 'known' ? [1000, 2000] : [2000]
      );
      const { markdown, saved, restored } = assertBodyAndRestore(
        summary,
        pages,
        display,
        [1000, 900, 2000, 1900]
      );
      expect(headline(markdown)).toContain(amount(2000));
      if (actualTarget !== 'known') {
        expect(headline(markdown)).toContain('要確認');
        expect(headline(markdown)).not.toContain(amount(1000));
      }
      for (const value of [900, 1900, ...(actualTarget === 'known' ? [] : [1000])]) {
        const altered = structuredClone(restored);
        altered.overview.push(saved.facts.find((fact) => fact.value === value)!.id);
        expect(() => validatePresentation(altered, saved)).not.toThrow();
        expect(() => revalidatePresentation(altered, saved, pages)).toThrow('報告対象');
      }
    }
  });
});
