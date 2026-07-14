import { describe, expect, it } from 'vitest';
import fixtures from '../../evaluation/fixtures/classification-cases.json';
import { detectDocumentType, detectEarningsContext } from './document-type';

interface ClassificationFixture {
  id: string;
  title: string;
  baselineType: ReturnType<typeof detectDocumentType>;
  targetType: string;
  expectedContext?: ReturnType<typeof detectEarningsContext>;
}

const cases = fixtures as ClassificationFixture[];

describe('文書分類', () => {
  it.each(cases)('$id: $title', ({ title, targetType }) => {
    expect(detectDocumentType(title)).toBe(targetType);
  });

  it.each(cases.filter(({ expectedContext }) => expectedContext))(
    '$id: 決算コンテキストを判定する',
    ({ title, expectedContext }) => {
      expect(detectEarningsContext(title)).toEqual(expectedContext);
    }
  );

  it('Phase 0から再分類した対象を記録している', () => {
    const pending = cases.filter(({ baselineType, targetType }) => baselineType !== targetType);
    expect(pending.length).toBeGreaterThan(0);
  });
});
