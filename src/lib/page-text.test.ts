import { describe, expect, it } from 'vitest';
import {
  cleanPageText,
  isValidEvidencePage,
  selectExtractedPages,
  serializePagesForAnalysis,
  serializePagesForDetection,
} from './page-text';

const pages = [
  { pageNumber: 1, text: '売上高 100百万円' },
  { pageNumber: 2, text: '営業利益 20百万円' },
  { pageNumber: 3, text: '通期予想 30百万円' },
];

describe('page text', () => {
  it('LLM用の曖昧でないページ境界を生成する', () => {
    expect(serializePagesForAnalysis(pages)).toContain('[PDF_PAGE:1]\n売上高');
    expect(serializePagesForAnalysis(pages)).toContain('[PDF_PAGE:3]\n通期予想');
  });

  it('セクション検出用のページ境界を生成する', () => {
    expect(serializePagesForDetection(pages)).toBe(
      '1\n売上高 100百万円\n\n2\n営業利益 20百万円\n\n3\n通期予想 30百万円'
    );
  });

  it('指定ページだけを元の順序で選択する', () => {
    expect(selectExtractedPages(pages, [3, 1])).toEqual([pages[0], pages[2]]);
  });

  it('当該ページのフッターだけを除去し、本文の数値行は保持する', () => {
    expect(cleanPageText('見出し\n100\n2\n2 / 10', 2)).toBe('見出し\n100');
  });

  it('根拠ページの範囲と抽出対象を検証する', () => {
    expect(isValidEvidencePage(null, 3, [1, 3])).toBe(true);
    expect(isValidEvidencePage(3, 3, [1, 3])).toBe(true);
    expect(isValidEvidencePage(2, 3, [1, 3])).toBe(false);
    expect(isValidEvidencePage(4, 3, [1, 3])).toBe(false);
    expect(isValidEvidencePage(0, 3, [1, 3])).toBe(false);
  });
});
