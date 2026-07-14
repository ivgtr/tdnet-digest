export interface EvaluationCount {
  total: number;
  matched: number;
  accuracy: number;
}

export interface FieldComparison<T> {
  expected: T;
  actual: T;
}

/**
 * 評価件数と一致件数から、0〜1の正解率を返す。
 * 空の評価集合は成功扱いにせず0とする。
 */
export function calculateAccuracy<T>(comparisons: FieldComparison<T>[]): EvaluationCount {
  const matched = comparisons.filter(({ expected, actual }) => expected === actual).length;
  return {
    total: comparisons.length,
    matched,
    accuracy: comparisons.length === 0 ? 0 : matched / comparisons.length,
  };
}

/**
 * LLM出力に含まれる表記揺れを評価前に最小限だけ正規化する。
 * 単位変換や数値の推測は行わない。
 */
export function normalizeEvaluationValue(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/[\s,，]/g, '')
    .replace(/▲/g, '△')
    .trim();
}

export function compareNormalizedValues(comparisons: FieldComparison<string>[]): EvaluationCount {
  return calculateAccuracy(
    comparisons.map(({ expected, actual }) => ({
      expected: normalizeEvaluationValue(expected),
      actual: normalizeEvaluationValue(actual),
    }))
  );
}
