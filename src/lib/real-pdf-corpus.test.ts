import { describe, expect, it } from 'vitest';
import cases from '../../evaluation/fixtures/real-pdf-cases.json';
import type { DocumentType } from './document-type';
import { detectDocumentType, detectEarningsContext } from './document-type';

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
