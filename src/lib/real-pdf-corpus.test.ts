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
});
