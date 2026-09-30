import type { ExtractedPage } from '@/types/summaryMetadata';
import { normalized } from './document-structure';
import { parseExactQuantity } from './quantity';
import type { PdfSpan } from './pdf-layout';

export interface TableContinuation {
  fromPage: number;
  toPage: number;
  rowIds: string[];
  periodIds: string[];
  contextIds: string[];
  scopeIds: string[];
  columnEdges: number[];
}
const quantityColumns = (page: ExtractedPage, ids: string[]) =>
  page.quantities
    .filter(
      (q) => ids.includes(q.id) && /円|株|人|件|%/.test(parseExactQuantity(q.text)?.unit ?? '')
    )
    .sort((a, b) => a.x - b.x);
/** Continue only a boundary table with the same complete, aligned columns and fiscal headings. */
export function tableContinuations(pages: ExtractedPage[]): TableContinuation[] {
  const links: TableContinuation[] = [];
  for (const current of pages) {
    const previous = pages.find((p) => p.pageNumber === current.pageNumber - 1);
    if (!previous) continue;
    const last = previous.blocks[previous.blocks.length - 1];
    const first = current.blocks[0];
    if (last?.kind !== 'row' || first?.kind !== 'row') continue;
    const before = quantityColumns(previous, last.spanIds),
      after = quantityColumns(current, first.spanIds);
    if (
      before.length < 2 ||
      before.length !== after.length ||
      before.some(
        (q, i) =>
          Math.abs(q.x + q.width - after[i].x - after[i].width) >
          Math.min(q.height, after[i].height) * 0.5
      )
    )
      continue;
    const periodBlock = [...previous.blocks]
      .reverse()
      .find(
        (b) =>
          b.y < last.y &&
          (normalized(b.text).match(/20\d{2}年\d{1,2}月期/g)?.length ?? 0) === before.length
      );
    if (!periodBlock) continue;
    const axes = periodBlock.spanIds
      .map((id) => previous.spans.find((s) => s.id === id)!)
      .filter((s) => /20\d{2}年\d{1,2}月期/.test(normalized(s.text)));
    if (
      axes.length !== before.length ||
      axes.some(
        (axis, i) => axis.x > before[i].x + before[i].width || axis.x + axis.width < before[i].x
      )
    )
      continue;
    const scope = [...previous.blocks]
      .reverse()
      .find((b) => b.y < periodBlock.y && /概要/.test(b.text) && /株式会社|有限会社/.test(b.text));
    const context = [...previous.blocks]
      .reverse()
      .find((b) => b.y < periodBlock.y && /経営成績|財政状態/.test(normalized(b.text)));
    if (!scope || !context) continue;
    const rows = [];
    for (const block of current.blocks) {
      if (block.kind !== 'row') break;
      const quantities = quantityColumns(current, block.spanIds);
      if (
        quantities.length !== before.length ||
        quantities.some(
          (q, i) => Math.abs(q.x + q.width - before[i].x - before[i].width) > q.height * 0.5
        )
      )
        break;
      rows.push(block.id);
    }
    if (rows.length < 2) continue;
    links.push({
      fromPage: previous.pageNumber,
      toPage: current.pageNumber,
      rowIds: rows,
      periodIds: axes.map((s) => s.id),
      contextIds: context.spanIds,
      scopeIds: [scope.id],
      columnEdges: before.map((q) => q.x + q.width),
    });
  }
  return links;
}
export function continuationFor(pages: ExtractedPage[], page: ExtractedPage, valueId: string) {
  const row = page.blocks.find((b) => b.spanIds.includes(valueId));
  return tableContinuations(pages).find(
    (link) => link.toPage === page.pageNumber && row && link.rowIds.includes(row.id)
  );
}
/** An explicit definition followed by a deictic note can apply to one adjacent named series. */
export function noteLinks(
  pages: ExtractedPage[]
): Array<{ fromPage: number; headingId: string; noteId: string; metric: string }> {
  const links: Array<{ fromPage: number; headingId: string; noteId: string; metric: string }> = [];
  for (const owner of pages)
    for (const [index, note] of owner.blocks.entries()) {
      if (!/^※本数値/.test(normalized(note.text))) continue;
      const definition = owner.blocks[index - 1];
      const metric =
        definition && normalized(definition.text).match(/^※([\p{L}\p{N}_-]+)[(（]/u)?.[1];
      const prior = pages.find((p) => p.pageNumber === owner.pageNumber - 1);
      if (!metric || !prior) continue;
      const firstRow = prior.blocks.find((b) => b.kind === 'row');
      if (!firstRow) continue;
      const headings = prior.blocks.filter(
        (b) =>
          b.y < firstRow.y &&
          normalized(b.text).includes(metric) &&
          /20\d{2}年\d{1,2}月/.test(normalized(b.text))
      );
      if (headings.length === 1)
        links.push({
          fromPage: prior.pageNumber,
          headingId: headings[0].id,
          noteId: note.id,
          metric,
        });
    }
  return links;
}
export function continuationSpans(
  pages: ExtractedPage[],
  page: ExtractedPage,
  valueId: string
): PdfSpan[] {
  const link = continuationFor(pages, page, valueId);
  if (!link) return page.spans;
  const owner = pages.find((p) => p.pageNumber === link.fromPage)!;
  const inherited = [...link.periodIds, ...link.contextIds].map(
    (id) => owner.spans.find((s) => s.id === id)!
  );
  const top = Math.min(...page.spans.map((s) => s.y));
  const bottom = Math.max(...inherited.map((s) => s.y));
  const offset = top - bottom - Math.max(...inherited.map((s) => s.height)) * 2;
  // Explicit coordinate projection for a confirmed continuation. Original coordinates remain untouched.
  return [...inherited.map((s) => ({ ...s, y: s.y + offset })), ...page.spans];
}
/** Numbered sections delimit local notes; a note never crosses the next peer heading. */
export function paragraphNoteLinks(
  pages: ExtractedPage[]
): Array<{ blockId: string; noteId: string }> {
  const links: Array<{ blockId: string; noteId: string }> = [];
  for (const page of pages) {
    let section: string | null = null,
      blocks: string[] = [];
    for (const block of page.blocks) {
      if (/^\d+[.．]/.test(normalized(block.text))) {
        section = block.id;
        blocks = [];
      }
      if (
        section &&
        /^[(（]注[)）]|^※/.test(normalized(block.text)) &&
        /上限|概算|速報|場合|可能性|条件|ただし|限り/.test(block.text)
      ) {
        for (const blockId of blocks) links.push({ blockId, noteId: block.id });
      } else if (block.kind === 'paragraph') blocks.push(block.id);
    }
  }
  return links;
}
