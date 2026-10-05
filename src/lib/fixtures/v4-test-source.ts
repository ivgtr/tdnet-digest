import type { TextItem } from 'pdfjs-dist/types/src/display/api';
import { extractPageLayout, type PdfSpan } from '../pdf-layout';
import type { VerifiedFact } from '../fact-contract';
import { assertionId } from '../source-provenance';
import { proseQuantities, parseExactQuantity, parseExactRange } from '../quantity';
export function textPage(text: string, pageNumber = 1) {
  const items = text.split('\n').map((str, i) => ({
    str,
    dir: 'ltr',
    transform: [10, 0, 0, 10, 0, 800 - i * 24],
    width: str.length * 10,
    height: 10,
    hasEOL: true,
    fontName: 'test',
  }));
  return extractPageLayout(items as TextItem[], pageNumber);
}
export function layoutPage(spans: PdfSpan[], pageNumber = 1) {
  const items = spans.map((s) => ({
    str: s.text,
    dir: 'ltr',
    transform: [s.height, 0, 0, s.height, s.x, -s.y],
    width: s.width,
    height: s.height,
    hasEOL: false,
    fontName: 'test',
  }));
  return extractPageLayout(items as TextItem[], pageNumber);
}
export function numberCandidate(
  page: ReturnType<typeof textPage>,
  label = '営業利益',
  value = 100,
  period = '2026年3月期'
): VerifiedFact {
  const block = page.blocks.find((b) => b.text.includes(label))!;
  return {
    id: 'f1',
    importance: 'key',
    kind: 'number',
    label,
    value,
    unit: '百万円',
    period,
    valueKind: 'actual',
    column: null,
    statement: null,
    page: page.pageNumber,
    quote: block.text,
    evidence: {
      kind: 'prose',
      blockId: block.id,
      assertionId: assertionId(block.id),
      quantityId:
        proseQuantities(block).find(
          (q) =>
            Number(parseExactQuantity(q.raw)?.decimal) === value || parseExactRange(q.raw) !== null
        )?.id ?? `${block.id}:q0`,
      contextIds: [page.blocks[1].id],
      scopeIds: [page.blocks[0].id],
      qualifierIds: [],
    },
    semantics: {
      subject: '株式会社テスト',
      scope: '連結',
      basis: '日本基準',
      periodKind: 'fullYear',
      metricKind: 'amount',
      qualifiers: [],
      state: 'actual',
      polarity: 'affirmative',
      conditions: [],
    },
    quantity: null,
    dateRoles: null,
    provenance: null,
  };
}
