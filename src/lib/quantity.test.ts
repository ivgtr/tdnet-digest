import { expect, it } from 'vitest';
import { parseQuantity, proseQuantities } from './quantity';

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
