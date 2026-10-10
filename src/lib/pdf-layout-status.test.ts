import { expect, it } from 'vitest';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';
import { extractPageLayout } from './pdf-layout';
import { validatePages } from './fact-validation';

const item = (str: string, rotated = false): TextItem => ({
  str,
  transform: rotated ? [0, 12, -12, 0, 20, 650] : [12, 0, 0, 12, 20, 700],
  width: 84,
  height: 12,
  dir: 'ltr',
  hasEOL: true,
  fontName: 'fixture',
});

// Status owns text availability; horizontal spans own supported evidence mapping.
it.each([
  { name: 'rotated only', items: [item('回転した原文100百万円', true)], spans: 0 },
  {
    name: 'mixed orientation',
    items: [item('水平の本文'), item('回転した原文100百万円', true)],
    spans: 1,
  },
])(
  'preserves $name as extracted text without creating rotated evidence cells',
  ({ items, spans }) => {
    const page = extractPageLayout(items, 1);
    expect(page.status).toBe('ok');
    expect(page.text).toContain('回転した原文100百万円');
    expect(page.sourceItems.map((source) => source.text)).toEqual(
      items.map((source) => source.str)
    );
    expect(page.spans).toHaveLength(spans);
    expect(page.spans.flatMap((span) => span.sourceIds)).not.toContain(`p1i${items.length}`);
    expect(page.quantities).toEqual([]);
    expect(page.tableRegions).toEqual([]);
    expect(() => validatePages([page])).not.toThrow();
    expect(() => validatePages([{ ...page, status: 'empty' }])).toThrow('空ページ');
    expect(() => validatePages([{ ...page, status: 'failed' }])).toThrow('抽出失敗');
  }
);

it.each([{ items: [] }, { items: [item(' \t\n'), item('　', true)] }])(
  'keeps absent or whitespace-only source text empty',
  ({ items }) => {
    const page = extractPageLayout(items, 1);
    expect(page.status).toBe('empty');
    expect(page.text).toBe('');
    expect(page.spans).toEqual([]);
    expect(() => validatePages([page])).not.toThrow();
    expect(() => validatePages([{ ...page, status: 'ok' }])).toThrow('成功ページの原文字欠落');
  }
);

it('still rejects lost horizontal mappings on an otherwise successful page', () => {
  const page = extractPageLayout([item('水平本文')], 1);
  expect(() => validatePages([{ ...page, spans: [], blocks: [] }])).toThrow(
    '成功ページの原文字欠落'
  );
});

it('rejects promoting a rotated raw item into a horizontal numeric evidence cell', () => {
  const page = extractPageLayout([item('100百万円', true)], 1);
  const horizontal = extractPageLayout([item('100百万円')], 1);
  expect(() => validatePages([{ ...horizontal, sourceItems: page.sourceItems }])).toThrow(
    '派生セルと原文字の座標が不一致'
  );
});
