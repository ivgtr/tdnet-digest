import { describe, expect, it } from 'vitest';
import cases from '../../evaluation/fixtures/real-pdf-cases.json';
import type { DocumentType } from './document-type';
import { detectDocumentType, detectEarningsContext } from './document-type';
import tables from './fixtures/reporting-table-corpus.json';
import { extractPageLayout } from './pdf-layout';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';
import { CANDIDATE_VERSION, reviewCandidates, serializeCandidateSource } from './fact-candidates';
import { normalized } from './document-structure';

describe('TDnet実PDFコーパスのタイトル分類', () => {
  it.each(cases)('$id $title', ({ title, expectedType }) => {
    expect(detectDocumentType(title)).toBe(expectedType as DocumentType);
  });

  it('全角表記のIFRS連結四半期コンテキストを判定する', () => {
    const earnings = cases.find((item) => item.id === '140120260709590576');
    expect(earnings).toBeDefined();
    expect(detectEarningsContext(earnings!.title)).toEqual({
      period: 'q1',
      accountingStandard: 'ifrs',
      isConsolidated: true,
    });
  });

  it('全角表記の日本基準連結中間期コンテキストを判定する', () => {
    const earnings = cases.find((item) => item.id === '140120260714592721');
    expect(earnings).toBeDefined();
    expect(detectEarningsContext(earnings!.title)).toEqual({
      period: 'q2',
      accountingStandard: 'jpGaap',
      isConsolidated: true,
    });
  });

  it.each([
    ['140120260714593346', 'q3', true],
    ['140120260708589925', 'fullYear', false],
    ['140120260713592617', 'q2', true],
  ] as const)('$0 の期区分と連結区分を判定する', (id, period, isConsolidated) => {
    const earnings = cases.find((item) => item.id === id);
    expect(earnings).toBeDefined();
    expect(detectEarningsContext(earnings!.title)).toEqual({
      period,
      accountingStandard: 'jpGaap',
      isConsolidated,
    });
  });

  it.each([
    ['140120260713592426', 'q2', 'ifrs', true],
    ['140120260713591990', 'fullYear', 'jpGaap', true],
    ['140120260713592047', 'q2', 'jpGaap', false],
  ] as const)(
    '$0 の追加決算コンテキストを判定する',
    (id, period, accountingStandard, isConsolidated) => {
      const earnings = cases.find((item) => item.id === id);
      expect(earnings).toBeDefined();
      expect(detectEarningsContext(earnings!.title)).toEqual({
        period,
        accountingStandard,
        isConsolidated,
      });
    }
  );
});

describe('原PDFから独立に固定した表紙の正常受理', () => {
  it.each(tables)('$id の重要数値をモデル入力から選べて確定できる', (fixture) => {
    const pages = fixture.pages.map((p) => extractPageLayout(p.items as TextItem[], p.pageNumber));
    const source = JSON.parse(serializeCandidateSource(pages));
    for (const expected of fixture.expected) {
      expect(source.unitContexts[expected.valueId], expected.valueId).toBeDefined();
      expect(source.pages[0].quantities.some((q: { id: string }) => q.id === expected.valueId)).toBe(true);
    }
    const candidates = fixture.expected.map((expected, i) => ({
      candidateId: `c${i + 1}`, importance: 'key', kind: 'number',
      source: {kind: 'table', valueId: expected.valueId, contextBindingId: `ctx:${expected.valueId}`},
      meaning: {
        subject: expected.subject, scope: expected.scope, basis: expected.basis,
        period: expected.period, periodKind: expected.periodKind, metricKind: expected.metricKind,
        state: expected.state, polarity: 'affirmative',
      },
    }));
    const review = reviewCandidates(JSON.stringify({candidateVersion: CANDIDATE_VERSION, documentType: 'other', candidates, unverified: []}), 'other', pages);
    expect(review.unverified).toEqual([]);
    expect(review.facts.map((f) => [f.value, f.unit, normalized(f.label), f.semantics.state, f.semantics.periodKind])).toEqual(
      fixture.expected.map((f) => [f.value, f.unit, normalized(f.label), f.state, f.periodKind])
    );
  });
});
