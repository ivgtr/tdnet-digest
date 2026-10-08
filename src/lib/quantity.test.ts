import { expect, it } from 'vitest';
import {
  parseQuantity,
  proseQuantities,
  parseExactNumeric,
  isUncaptionedUnit,
  quantityNumber,
  parseExactRange,
} from './quantity';
import { quantityCells } from './document-structure';
import type { PdfSpan } from './pdf-layout';
import { buildTableCells, buildTableRegions, type TableCell } from './table-layout';

it.each([
  ['120店舗', 120, '店舗'],
  ['500人', 500, '人'],
  ['30件', 30, '件'],
  ['5台', 5, '台'],
  ['50kWh', 50, 'kWh'],
  ['120㎡', 120, 'm2'],
  ['1,300百万円', 1300, '百万円'],
  ['▲6百万円', -6, '百万円'],
  ['△ 1,000株', -1000, '株'],
  ['15円00銭', 15, '円'],
  ['1円14銭', 1.14, '円'],
  ['-0円05銭', -0.05, '円'],
  ['11.1％', 11.1, '%'],
] as const)('数量 %s の値と原文の単位を保持する', (text, value, unit) => {
  expect(parseQuantity(text)).toEqual({ value, unit });
});

it.each(['120店舗500人', '－', '未定', '2026年7月14日', '10円123銭', '15.2円00銭', '15円00'])(
  '数量を一意に読めない文字列 %s を拒否する',
  (text) => {
    expect(parseQuantity(text)).toBeNull();
  }
);

it('本文の単位証明は構文と後続の述語を区別する', () => {
  for (const unit of [
    '台',
    '口',
    '件/月',
    'kg',
    'm2',
    '人日',
    'か月',
    '店舗',
    'kWh',
    'トン',
    '百万ドル',
    '千kWh',
    '百万kWh',
    '千トン',
  ]) {
    const block = { id: 'b', text: `数量は100 ${unit}です。` };
    expect(proseQuantities(block)).toEqual([{ id: 'b:q1', raw: `100 ${unit}`, start: 3 }]);
  }
  for (const suffix of [
    '以内',
    '未達',
    '強',
    '弱',
    '以上',
    '未満',
    '程度',
    '増加しました',
    'ではありません',
    'に満たない',
    'と仮定した試算です',
    'の説明です',
    '見込みです',
  ]) {
    expect(isUncaptionedUnit(`百万円${suffix}`)).toBe(false);
    expect(proseQuantities({ id: 'b', text: `取得価額は100百万円${suffix}です。` })[0].raw).toBe(
      '100百万円'
    );
  }
  for (const unit of ['独自数量単位', '超', '強', '弱', 'not'])
    expect(proseQuantities({ id: 'b', text: `数量は100${unit}です。` })).toEqual([]);
});

it.each(['10円50銭', '１０円５０銭', '-0円05銭'])('円銭の本文原数量を分断しない: %s', (raw) => {
  expect(proseQuantities({ id: 'b', text: `配当金は${raw}です。` })).toEqual([
    { id: 'b:q1', raw: raw.normalize('NFKC'), start: 4 },
  ]);
});

function wrappedSpans(lines: string[]): PdfSpan[] {
  return lines.map((text, i) => ({
    id: `s${i}`,
    text,
    x: 10,
    y: 10 + i * 12,
    width: 30,
    height: 10,
  }));
}
function physicalCell(spans: PdfSpan[], id = 'cell'): TableCell {
  return { id, left: 0, top: 0, right: 50, bottom: 100, spanIds: spans.map((s) => s.id) };
}
function adjacentSpans(texts: string[]): PdfSpan[] {
  return texts.map((text, i) => ({
    id: `s${i}`,
    text,
    x: 10 + i * 19,
    y: 10,
    width: 15,
    height: 10,
  }));
}
it.each([
  ['100', '20'],
  ['△', '10'],
  ['100', '.20'],
  ['3', ',963,389'],
  ['100', '～', '200'],
])('同じ閉じたセルの数量断片は従来の間隔で全IDを結合する: %j', (...texts) => {
  const spans = adjacentSpans(texts);
  const cell = { ...physicalCell(spans), right: 100 };
  const parent = { ...cell, id: 'parent', right: 150 };
  for (const cells of [[cell], [parent, cell], [cell, structuredClone(cell)]]) {
    expect(quantityCells(spans, cells)).toEqual([
      expect.objectContaining({ text: texts.join(''), spanIds: spans.map((s) => s.id) }),
    ]);
  }
});
it('近い別セルの100と20を有効だが誤った10020へ結合しない', () => {
  const spans = adjacentSpans(['100', '20']);
  const left = { ...physicalCell([spans[0]], 'left'), right: 27 };
  const right = { ...physicalCell([spans[1]], 'right'), left: 27 };
  const parent = physicalCell(spans, 'parent');
  for (const cells of [[left, right], [parent, left, right], [parent, left], [left], [right]]) {
    expect(quantityCells(spans, cells).map((q) => [q.text, q.spanIds])).toEqual([
      ['100', ['s0']],
      ['20', ['s1']],
    ]);
  }
  // No proved boundary: preserve the existing unruled split-digit rule.
  expect(quantityCells(spans).map((q) => q.text)).toEqual(['10020']);
});
it('重なりが曖昧なセルを面積の小ささだけで所有者にしない', () => {
  const spans = adjacentSpans(['100', '20']);
  const cell = physicalCell(spans);
  for (const other of [
    { ...cell, id: 'same-area' },
    { ...cell, id: 'overlap', left: 5, right: 55, bottom: 110 },
  ])
    expect(quantityCells(spans, [cell, other])).toEqual([]);
});
it.each([
  ['3', ',963,389'],
  ['△', '10'],
  ['100', '.20'],
])('曖昧な所属で分断した数量から短い値や符号なしの値を復活させない: %j', (...texts) => {
  const spans = adjacentSpans(texts);
  const cell = physicalCell(spans);
  for (const ambiguous of [spans, [spans[0]], [spans[1]]]) {
    const overlap = {
      ...physicalCell(ambiguous, 'overlap'),
      left: 5,
      right: 55,
      bottom: 110,
    };
    expect(quantityCells(spans, [cell, overlap])).toEqual([]);
  }
  for (const partial of [
    { ...physicalCell([spans[0]]), right: 27 },
    { ...physicalCell([spans[1]]), left: 27 },
  ])
    expect(quantityCells(spans, [partial])).toEqual([]);
});
it.each([
  ['670', '～800'],
  ['670～', '800'],
  ['670', '～', '800'],
  ['△4～', '△2'],
])('同じ閉じたセルの範囲構文は改行と全原文IDを保つ: %j', (...lines) => {
  const spans = wrappedSpans(lines),
    original = structuredClone(spans);
  const quantities = quantityCells(spans, [physicalCell(spans)]);
  expect(quantities).toHaveLength(1);
  expect(quantities[0].spanIds).toEqual(spans.map((s) => s.id));
  expect(quantities[0].text).toBe(lines.join('\n'));
  expect(parseExactNumeric(quantities[0].text)?.kind).toBe('range');
  expect(spans).toEqual(original);
});
it('改行範囲も一意な最小セルを使い、親セル・曖昧な重なりで別セルを跨がない', () => {
  const spans = wrappedSpans(['670', '～800']);
  const cell = physicalCell(spans);
  const parent = { ...cell, id: 'parent', right: 100 };
  expect(quantityCells(spans, [parent, cell, structuredClone(cell)])[0].spanIds).toEqual([
    's0',
    's1',
  ]);
  const child = { ...physicalCell([spans[0]], 'child'), bottom: 15 };
  expect(quantityCells(spans, [cell, child]).map((q) => q.text)).toEqual(['670']);
  expect(
    quantityCells(spans, [cell, { ...cell, id: 'overlap', left: 5, right: 55, bottom: 110 }])
  ).toEqual([]);
});
it('範囲記号のない複数行・介在文字・別セル・未証明セルを近さで結合しない', () => {
  for (const lines of [
    ['100', '200'],
    ['100百万円', '10%'],
    ['670', '内訳', '～800'],
  ]) {
    const spans = wrappedSpans(lines);
    expect(quantityCells(spans, [physicalCell(spans)]).every((q) => q.spanIds.length === 1)).toBe(
      true
    );
  }
  const spans = wrappedSpans(['670', '～800']);
  for (const cells of [[], spans.map((s, i) => physicalCell([s], `cell${i}`))])
    expect(quantityCells(spans, cells).map((q) => q.text)).toEqual(['670']);
});

it('表の最終行が複数行数量でも全断片を表の所属へ渡す', () => {
  const labels: [string, number, number][] = [
    ['2027年3月期業績予想', 0, 10],
    ['売上高', 110, 30],
    ['営業利益', 210, 30],
    ['百万円', 110, 45],
    ['百万円', 210, 45],
    ['通期', 0, 70],
    ['100～', 110, 70],
    ['200～', 210, 70],
    ['150', 110, 82],
    ['250', 210, 82],
  ];
  const spans = labels.map(([text, x, y], i) => ({
    id: `s${i}`,
    text,
    x,
    y,
    width: text.length * 5,
    height: 10,
  }));
  const drawingLines = [
    [90, 55, 180, 90],
    [190, 55, 280, 90],
  ].flatMap(([l, t, r, b], i) =>
    [
      [l, t, r, t],
      [r, t, r, b],
      [r, b, l, b],
      [l, b, l, t],
    ].map(([x1, y1, x2, y2], j) => ({
      id: `rule${i}-${j}`,
      x1: Math.min(x1, x2),
      y1: Math.min(y1, y2),
      x2: Math.max(x1, x2),
      y2: Math.max(y1, y2),
      operatorIndices: [i * 4 + j],
    }))
  );
  const quantities = quantityCells(spans, buildTableCells(drawingLines, spans, 1));
  const table = buildTableRegions({ pageNumber: 1, spans, quantities, drawingLines })[0];
  const ranges = quantities.filter((q) => parseExactNumeric(q.text)?.kind === 'range');
  expect(ranges).toHaveLength(2);
  expect(table.valueIds).toEqual(ranges.map((q) => q.id));
  expect(ranges.flatMap((q) => q.spanIds).every((id) => table.spanIds.includes(id))).toBe(true);
});

it('数量の数値化で精度を失う値を採用しない', () => {
  expect(quantityNumber('9007199254740993')).toBeNull();
  expect(quantityNumber('1.0000000000000001')).toBeNull();
  expect(quantityNumber('1.40')?.value).toBe(1.4);
});

it('範囲数量の両端・符号・順序を保持し、不完全な構文を拒否する', () => {
  for (const raw of ['200～100', '1,00～200', '1～', '～2', '1～2～3'])
    expect(parseExactRange(raw)).toBeNull();
  expect(parseExactRange('−1.5～−0.1百万円')).toMatchObject({ lower: '-1.5', upper: '-0.1' });
});
