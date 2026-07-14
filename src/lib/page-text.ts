import type { ExtractedPage } from '@/types/summaryMetadata';

const ANALYSIS_PAGE_MARKER = 'PDF_PAGE';

/** PDFページ本文を、ページ境界を壊さずに正規化する。 */
export function cleanPageText(text: string, pageNumber: number): string {
  return (
    text
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t]+\n/g, '\n')
      // eslint-disable-next-line no-irregular-whitespace
      .replace(/　/g, ' ')
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, '')
      .split('\n')
      .filter((line) => {
        const trimmed = line.trim();
        return (
          trimmed !== String(pageNumber) &&
          !new RegExp(`^${pageNumber}\\s*/\\s*\\d+$`).test(trimmed)
        );
      })
      .join('\n')
      .trim()
  );
}

/** LLMへ渡すページ番号付きテキストを生成する。 */
export function serializePagesForAnalysis(pages: ExtractedPage[]): string {
  return pages
    .map(({ pageNumber, text }) => `[${ANALYSIS_PAGE_MARKER}:${pageNumber}]\n${text}`)
    .join('\n\n');
}

/** 既存のセクション検出・ページスコアリング向け形式へ変換する。 */
export function serializePagesForDetection(pages: ExtractedPage[]): string {
  return pages.map(({ pageNumber, text }) => `${pageNumber}\n${text}`).join('\n\n');
}

export function selectExtractedPages(
  pages: ExtractedPage[],
  selectedPageNumbers: number[]
): ExtractedPage[] {
  const selected = new Set(selectedPageNumbers);
  return pages.filter(({ pageNumber }) => selected.has(pageNumber));
}

export function isValidEvidencePage(
  page: number | null,
  totalPages: number,
  extractedPages: number[]
): boolean {
  if (page === null) return true;
  return Number.isInteger(page) && page >= 1 && page <= totalPages && extractedPages.includes(page);
}
