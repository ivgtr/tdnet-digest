import type { TextItem, TextMarkedContent } from 'pdfjs-dist/types/src/display/api';
import type { ExtractedPage } from '@/types/summaryMetadata';
import { groupTextItemsByY } from './pdf-lines';
import { cleanPageText } from './page-text';
import { parseQuantity } from './quantity';

export interface PdfSpan {
  id: string;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 座標はPDFの基線を上から下へ並べる。IDは再抽出時も同じになる。 */
export function extractPageLayout(
  items: Array<TextItem | TextMarkedContent>,
  pageNumber: number
): ExtractedPage {
  const spans: PdfSpan[] = [];
  const sorted = items
    .filter((item): item is TextItem => 'str' in item && !!item.str.trim())
    .sort((a, b) => b.transform[5] - a.transform[5] || a.transform[4] - b.transform[4]);
  for (const item of sorted) {
    // 回転文字は本文に残すが、水平表の根拠としては採用しない。
    if (Math.abs(item.transform[1]) > 0.01 || Math.abs(item.transform[2]) > 0.01) continue;
    const x = item.transform[4];
    const y = -item.transform[5];
    const previous = spans[spans.length - 1];
    if (
      previous &&
      Math.abs(previous.y - y) <= 1 &&
      x - previous.x - previous.width >= -0.5 &&
      x - previous.x - previous.width <= Math.min(item.height, previous.height) * 0.2
    ) {
      previous.text += item.str;
      previous.width = x + item.width - previous.x;
    } else {
      spans.push({ id: '', text: item.str.trim(), x, y, width: item.width, height: item.height });
    }
  }
  // PDF内で数値・単位・円銭が別アイテムでも、隣接する数量セルとして保持する。
  for (let i = 0; i < spans.length; i++) {
    let text = spans[i].text;
    const initial = parseQuantity(text);
    if (initial?.unit && (initial.unit !== '円' || /銭$/.test(text))) continue;
    let yen = initial?.unit === '円';
    let end = i;
    for (let j = i + 1; j < Math.min(i + 4, spans.length); j++) {
      const previous = spans[j - 1],
        next = spans[j];
      if (
        Math.abs(next.y - spans[i].y) > 1 ||
        next.x - previous.x - previous.width > next.height * 0.6
      )
        break;
      text += next.text;
      const normalized = text
        .normalize('NFKC')
        .replace(/[\s,，]/g, '')
        .replace(/^[△▲]/, '-');
      if (yen && !/^-?\d+円(?:\d{2}(?:銭)?)?$/.test(normalized)) break;
      const quantity = parseQuantity(text);
      if (quantity?.unit) {
        end = j;
        if (quantity.unit !== '円' || /銭$/.test(normalized)) break;
        yen = true;
      }
    }
    if (end > i) {
      const last = spans[end];
      spans[i].text = spans
        .slice(i, end + 1)
        .map((s) => s.text)
        .join('');
      spans[i].width = last.x + last.width - spans[i].x;
      spans.splice(i + 1, end - i);
    }
  }
  spans.forEach((span, i) => {
    span.id = `p${pageNumber}s${i + 1}`;
  });
  return {
    pageNumber,
    text: cleanPageText(groupTextItemsByY(items).join('\n'), pageNumber),
    spans,
  };
}

export function serializeLayout(pages: ExtractedPage[]): string {
  return pages
    .map(
      (page) =>
        `[PDF_PAGE:${page.pageNumber}]\n${page.text}\n[根拠セル: id,x,y,幅,文字]\n` +
        page.spans
          .map((s) =>
            JSON.stringify([s.id, +s.x.toFixed(1), +s.y.toFixed(1), +s.width.toFixed(1), s.text])
          )
          .join('\n')
    )
    .join('\n\n');
}
