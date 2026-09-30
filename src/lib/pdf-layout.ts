import type { TextItem, TextMarkedContent } from 'pdfjs-dist/types/src/display/api';
import type { ExtractedPage } from '@/types/summaryMetadata';
import { groupTextItemsByY } from './pdf-lines';
import { cleanPageText } from './page-text';
import { parseQuantity } from './quantity';
import {
  buildBlocks,
  quantityCells,
  tableReferenceHints,
  type SourceItem,
} from './document-structure';
import { tableContinuations, noteLinks, paragraphNoteLinks } from './document-links';

export interface PdfSpan {
  id: string;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  sourceIds?: string[];
}

/** 座標はPDFの基線を上から下へ並べる。IDは再抽出時も同じになる。 */
export function extractPageLayout(
  items: Array<TextItem | TextMarkedContent>,
  pageNumber: number
): ExtractedPage {
  const spans: PdfSpan[] = [];
  const textItems = items.filter((item): item is TextItem => 'str' in item);
  const sourceIndex = new Map(textItems.map((item, i) => [item, `p${pageNumber}i${i + 1}`]));
  const sourceItems: SourceItem[] = items
    .filter((item): item is TextItem => 'str' in item)
    .map((item, i) => ({
      id: `p${pageNumber}i${i + 1}`,
      text: item.str,
      transform: [...item.transform],
      x: item.transform[4],
      y: -item.transform[5],
      width: item.width,
      height: item.height,
      direction: item.dir,
      hasEOL: item.hasEOL,
    }));
  const sorted = items
    .filter((item): item is TextItem => 'str' in item && !!item.str.trim())
    .sort((a, b) => b.transform[5] - a.transform[5] || a.transform[4] - b.transform[4]);
  for (const item of sorted) {
    // 回転文字は本文に残すが、水平表の根拠としては採用しない。
    if (Math.abs(item.transform[1]) > 0.01 || Math.abs(item.transform[2]) > 0.01) continue;
    const x = item.transform[4];
    const y = -item.transform[5];
    const sourceId = sourceIndex.get(item)!;
    const previous = spans[spans.length - 1];
    if (
      previous &&
      (!parseQuantity(previous.text) ||
        parseQuantity(previous.text + item.str)?.unit === null ||
        /^-?\d+円\d{2}銭$/.test(
          (previous.text + item.str)
            .normalize('NFKC')
            .replace(/[\s,，]/g, '')
            .replace(/^[△▲]/, '-')
        )) &&
      Math.abs(previous.y - y) <= 1 &&
      x - previous.x - previous.width >= -0.5 &&
      x - previous.x - previous.width <= Math.min(item.height, previous.height) * 0.2
    ) {
      previous.text += item.str;
      previous.sourceIds!.push(sourceId);
      previous.width = x + item.width - previous.x;
    } else {
      spans.push({
        id: '',
        text: item.str.trim(),
        x,
        y,
        width: item.width,
        height: item.height,
        sourceIds: [sourceId],
      });
    }
  }
  // 円銭は数値表記の構文から結合できる。一般の後続語は単位か見出しかを
  // 抽出時に決めず、別IDを保って根拠参照の検証へ渡す。
  for (let i = 0; i < spans.length; i++) {
    let text = spans[i].text;
    if (!/^[△▲-]?\d+(?:円(?:\d{2})?)?$/.test(text.normalize('NFKC').replace(/[\s,，]/g, '')))
      continue;
    let end = i;
    for (let j = i + 1; j < Math.min(i + 4, spans.length); j++) {
      const previous = spans[j - 1],
        next = spans[j];
      if (
        Math.abs(next.y - spans[i].y) > 1 ||
        next.x - previous.x - previous.width < -0.5 ||
        next.x - previous.x - previous.width > next.height * 0.6
      )
        break;
      text += next.text;
      const normalized = text
        .normalize('NFKC')
        .replace(/[\s,，]/g, '')
        .replace(/^[△▲]/, '-');
      if (/^-?\d+円\d{2}銭$/.test(normalized)) {
        end = j;
        break;
      }
      if (!/^-?\d+円(?:\d{2})?$/.test(normalized)) break;
    }
    if (end > i) {
      const last = spans[end];
      spans[i].text = spans
        .slice(i, end + 1)
        .map((s) => s.text)
        .join('');
      spans[i].sourceIds = spans.slice(i, end + 1).flatMap((s) => s.sourceIds!);
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
    sourceItems,
    status: spans.length ? 'ok' : 'empty',
    selection: 'selected',
    blocks: buildBlocks({ pageNumber, spans }),
    quantities: quantityCells(spans),
  };
}

export function serializeLayout(pages: ExtractedPage[]): string {
  const headings = pages.flatMap((p) =>
    p.blocks
      .filter(
        (b) =>
          /会社名|上場会社名|決算短信|概要|基準|経営成績|業績予想|配当の状況|取得対象株式の種類|取得の方法/.test(
            b.text.normalize('NFKC').replace(/\s/g, '')
          ) ||
          /^(?:株式会社[\p{L}\p{N}・&]+|[\p{L}\p{N}・&]+株式会社)$/u.test(
            b.text.normalize('NFKC').replace(/\s/g, '')
          )
      )
      .map((b) => [b.id, b.text])
  );
  return (
    `[会社・範囲の見出し候補: 会社名が明記された数量はsubjectと会社見出しのscopeIdsが必須]\n${JSON.stringify(headings)}\n[検証可能な表継続関係]\n${JSON.stringify(tableContinuations(pages))}\n[検証可能な系列注記関係]\n${JSON.stringify(noteLinks(pages))}\n[同じ節の本文注記: 数量はnoteIdをqualifierIdsで参照]\n${JSON.stringify(paragraphNoteLinks(pages))}\n` +
    pages
      .filter((p) => p.selection === 'selected')
      .map(
        (page) =>
          `[PDF_PAGE:${page.pageNumber}] 状態=${page.status}\n[表参照の構造候補: 確定事実ではありません。値に対応する行区分/列指標/単位/見出しを原文と検証してください]\n${JSON.stringify(tableReferenceHints(page))}\n[段落/行: blockId,種類,構成spanIds,全文]\n${page.blocks.map((b) => JSON.stringify(b.kind === 'row' ? [b.id, b.kind, b.spanIds] : [b.id, b.kind, b.spanIds, b.text])).join('\n')}\n[複数spanの数量: valueId,全spanIds,原数量。単独数量は根拠セルのIDを使う]\n${page.quantities
            .filter((q) => q.spanIds.length > 1)
            .map((q) => JSON.stringify([q.id, q.spanIds, q.text]))
            .join('\n')}\n[根拠セル: spanId,x,y,幅,文字]\n` +
          page.spans
            .map((s) =>
              JSON.stringify([s.id, +s.x.toFixed(1), +s.y.toFixed(1), +s.width.toFixed(1), s.text])
            )
            .join('\n')
      )
      .join('\n\n')
  );
}
