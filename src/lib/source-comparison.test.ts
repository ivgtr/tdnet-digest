import { describe, expect, it } from 'vitest';
import { cells, tableAmount } from './fixtures/fact-review-source';
import { candidateResponse } from './fixtures/candidate-test-source';
import { buildDocumentContext } from './document-context';
import { reviewCandidates } from './fact-candidates';
import { acquireSourceComparisons } from './source-comparison';

function fixture(metric = '独自利益', previous = '2025年3月期') {
  const pages = [
    cells(
      [
        ['2026年3月期 決算短信〔IFRS〕（連結）', 0, 0, 350],
        ['会社名 株式会社テスト', 0, 25, 220],
        ['1. 連結経営成績', 0, 50, 180],
        [metric, 230, 80, 100],
        ['営業利益', 365, 80, 90],
        ['百万円', 230, 100, 50],
        ['百万円', 365, 100, 50],
        ['2026年3月期', 0, 125, 170],
        ['120', 230, 125, 35],
        ['70', 365, 125, 35],
        [previous, 0, 150, 190],
        ['100', 230, 150, 35],
        ['80', 365, 150, 35],
      ],
      1
    ),
  ];
  const context = buildDocumentContext(pages);
  const mapping = context.tableMappings.find(
    (m) => pages[0].quantities.find((q) => q.id === m.valueId)?.text === '120'
  )!;
  const fact = tableAmount(pages, mapping, {
    period: '2026年3月期',
    subject: '株式会社テスト',
    scope: '連結',
    basis: 'IFRS',
    state: 'actual',
  });
  const review = reviewCandidates(
    candidateResponse([fact], pages, 'earnings'),
    'earnings',
    pages,
    context
  );
  expect(review.facts).toHaveLength(1);
  return { pages, context, review };
}

describe('source-axis comparison acquisition', () => {
  it.each(['独自利益', '税引前利益', '経常利益', '調整後税引前利益'])(
    'uses original metric-axis identity rather than a financial-name whitelist: %s',
    (label) => {
      const { pages, context, review } = fixture(label);
      const result = acquireSourceComparisons(review, 'earnings', pages, context);
      expect(result.facts.map((f) => [f.label, f.quantity?.decimal])).toEqual([
        [label, '120'],
        [label, '100'],
      ]);
      expect(review.facts).toHaveLength(1);
    }
  );

  it.each(['2024年3月期', '2025年3月期（予想）', '2025年3月期第1四半期'])(
    'does not borrow another year, state or period shape: %s',
    (period) => {
      const { pages, context, review } = fixture('独自利益', period);
      expect(acquireSourceComparisons(review, 'earnings', pages, context).facts).toHaveLength(1);
    }
  );

  it('does not override rejected source candidates or supplement non-earnings documents', () => {
    const { pages, context, review } = fixture();
    const previous = context.tableMappings.find(
      (m) => pages[0].quantities.find((q) => q.id === m.valueId)?.text === '100'
    )!;
    review.candidateSources.set('c2', {
      kind: 'table',
      valueId: previous.valueId,
      tableId: review.facts[0].provenance!.tableId!,
      contextBindingId: `ctx:${previous.valueId}`,
    });
    expect(acquireSourceComparisons(review, 'earnings', pages, context).facts).toHaveLength(1);
    expect(acquireSourceComparisons(review, 'other', pages, context)).toBe(review);
  });

  it.each(['subject', 'scope', 'basis', 'qualifiers', 'conditions', 'polarity'] as const)(
    'keeps comparison safeguards when the prior source cannot prove the current %s',
    (role) => {
      const { pages, context, review } = fixture();
      Object.assign(review.facts[0].semantics, {
        [role]:
          role === 'qualifiers' || role === 'conditions'
            ? ['異なる条件']
            : role === 'polarity'
              ? 'negative'
              : '異なる属性',
      });
      expect(acquireSourceComparisons(review, 'earnings', pages, context).facts).toHaveLength(1);
    }
  );

  it('does not join different metric axes even if their text is identical', () => {
    const { pages, context, review } = fixture();
    const current = review.facts[0];
    if (current.evidence.kind !== 'table') throw new Error('expected table');
    current.evidence.metricIds = ['different-axis'];
    expect(acquireSourceComparisons(review, 'earnings', pages, context).facts).toHaveLength(1);
  });
});
