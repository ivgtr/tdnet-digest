import { describe, expect, it } from 'vitest';
import { calculateAccuracy, compareNormalizedValues, normalizeEvaluationValue } from './evaluation';

describe('calculateAccuracy', () => {
  it('一致件数と正解率を集計する', () => {
    expect(
      calculateAccuracy([
        { expected: 'earnings', actual: 'earnings' },
        { expected: 'dividend', actual: 'other' },
      ])
    ).toEqual({ total: 2, matched: 1, accuracy: 0.5 });
  });

  it('空の評価集合を成功扱いにしない', () => {
    expect(calculateAccuracy([])).toEqual({ total: 0, matched: 0, accuracy: 0 });
  });
});

describe('normalizeEvaluationValue', () => {
  it('全角文字、桁区切り、空白、赤字記号を正規化する', () => {
    expect(normalizeEvaluationValue(' ▲ １，２３４ 百万円 ')).toBe('△1234百万円');
  });
});

describe('compareNormalizedValues', () => {
  it('意味を変えない表記揺れを同一として比較する', () => {
    expect(
      compareNormalizedValues([
        { expected: '1,234百万円', actual: '１，２３４ 百万円' },
        { expected: '△5.0%', actual: '▲5.0％' },
      ])
    ).toEqual({ total: 2, matched: 2, accuracy: 1 });
  });
});
