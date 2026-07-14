import { describe, expect, it } from 'vitest';
import cases from '../../evaluation/fixtures/real-pdf-cases.json';
import type { DocumentType } from './document-type';
import { detectDocumentType, detectEarningsContext } from './document-type';

describe('TDnet実PDFコーパスのタイトル分類', () => {
  const knownClassificationIssues = new Set(['140120260612569757', '140120260714592726']);

  it.each(cases.filter(({ id }) => !knownClassificationIssues.has(id)))(
    '$id $title',
    ({ title, expectedType }) => {
      expect(detectDocumentType(title)).toBe(expectedType as DocumentType);
    }
  );

  it.fails.each(cases.filter(({ id }) => knownClassificationIssues.has(id)))(
    '既知の分類不具合: $id $title',
    ({ title, expectedType }) => {
      expect(detectDocumentType(title)).toBe(expectedType as DocumentType);
    }
  );

  it.fails('全角表記のIFRS連結四半期コンテキストを判定する', () => {
    const earnings = cases.find((item) => item.id === '140120260709590576');
    expect(earnings).toBeDefined();
    expect(detectEarningsContext(earnings!.title)).toEqual({
      period: 'q1',
      accountingStandard: 'ifrs',
      isConsolidated: true,
    });
  });
});
