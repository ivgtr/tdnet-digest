import { expect, it } from 'vitest';
import { parseQuantity, proseQuantities, parseExactNumeric } from './quantity';
import { quantityCells } from './document-structure';
import type { PdfSpan } from './pdf-layout';
import type { TableCell } from './table-layout';

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
  ]) {
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
