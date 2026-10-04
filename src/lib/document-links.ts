import type { ExtractedPage } from '@/types/summaryMetadata';
import {
  normalized,
  declaredSubjectsIn,
  headingLevel,
  fiscalHeadingRuns,
  isPerformanceReportingTitle,
  forecastReportingTitle,
} from './document-structure';
import { parseExactNumeric, isUncaptionedUnit } from './quantity';
import type { PdfSpan } from './pdf-layout';
import { tableUnitRuns } from './table-layout';

export interface TableContinuation {
  fromPage: number;
  toPage: number;
  rowIds: string[];
  valueIds: string[];
  periodIds: string[];
  periodColumns: string[][];
  contextIds: string[];
  scopeIds: string[];
  columnEdges: number[];
  unitIds: string[];
}
const quantityColumns = (page: ExtractedPage, ids: string[], allowUnitless = false) =>
  page.quantities
    .filter((q) => {
      const n = parseExactNumeric(q.text);
      return (
        ids.includes(q.id) &&
        n &&
        ((allowUnitless && n.unit === null) ||
          (n.unit !== null && isUncaptionedUnit(n.unit) && /円|株|人|件|%/.test(n.unit)))
      );
    })
    .sort((a, b) => a.x - b.x);
/** Continue only a boundary table with the same complete, aligned columns and fiscal headings. */
export function tableContinuations(pages: ExtractedPage[]): TableContinuation[] {
  const links: TableContinuation[] = [];
  for (const current of pages) {
    const previous = pages.find((p) => p.pageNumber === current.pageNumber - 1);
    if (!previous) continue;
    const last = previous.blocks[previous.blocks.length - 1];
    const first = current.blocks[0];
    if (last?.kind !== 'row' || first?.kind !== 'row' || headingLevel(first) !== null) continue;
    const inlineBefore = quantityColumns(previous, last.spanIds);
    const before =
      inlineBefore.length >= 2 ? inlineBefore : quantityColumns(previous, last.spanIds, true);
    const allowUnitless = before.some((q) => parseExactNumeric(q.text)?.unit === null);
    const after = quantityColumns(current, first.spanIds, allowUnitless);
    const own = previous.tableRegions.filter((t) => before.every((q) => t.valueIds.includes(q.id)));
    if (own.length > 1) continue;
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
    const context = [...previous.blocks]
      .reverse()
      .find(
        (b) =>
          b.y < last.y &&
          (isPerformanceReportingTitle(b.text) ||
            /財政状態/.test(normalized(b.text)) ||
            !!forecastReportingTitle(b.text)) &&
          !/[。；]|^\(?注\)?|^※/.test(normalized(b.text))
      );
    if (
      !context ||
      (own.length === 1 && !context.spanIds.every((id) => own[0].spanIds.includes(id)))
    )
      continue;
    const periodBlock = [...previous.blocks]
      .reverse()
      .find(
        (b) =>
          b.y > context.y &&
          b.y < last.y &&
          (own.length === 0 || b.spanIds.every((id) => own[0].spanIds.includes(id))) &&
          (normalized(b.text).match(/20\d{2}年\d{1,2}月期/g)?.length ?? 0) === before.length
      );
    if (!periodBlock) continue;
    // Every explicit section boundary ends the old header's ownership,
    // including nonfinancial sections whose columns happen to align.
    if (previous.blocks.some((b) => b.y > context.y && b.y <= last.y && headingLevel(b) !== null))
      continue;
    const unitRuns = tableUnitRuns(
      previous.spans.filter((s) => s.y > periodBlock.y && s.y < last.y)
    );
    const unitIds =
      own.length === 1
        ? own[0].unitIds
        : unitRuns.length === before.length &&
            unitRuns.every(
              (r, i) =>
                Math.abs(r[0].y - unitRuns[0][0].y) <= r[0].height * 0.3 &&
                r[0].x <= before[i].x + before[i].width &&
                r[r.length - 1].x + r[r.length - 1].width >= before[i].x
            )
          ? unitRuns.flatMap((r) => r.map((s) => s.id))
          : [];
    if (
      (!own.length && unitRuns.length && !unitIds.length) ||
      (before.some((q) => !parseExactNumeric(q.text)?.unit) && !unitIds.length)
    )
      continue;
    const axes = fiscalHeadingRuns(
      periodBlock.spanIds.map((id) => previous.spans.find((s) => s.id === id)!)
    );
    if (
      axes.length !== before.length ||
      axes.some(
        (axis, i) =>
          axis[0].x > before[i].x + before[i].width ||
          axis[axis.length - 1].x + axis[axis.length - 1].width < before[i].x
      )
    )
      continue;
    const scope = [...previous.blocks]
      .reverse()
      .find(
        (b) =>
          b.y < context.y &&
          (declaredSubjectsIn(b).length > 0 ||
            (/概要/.test(b.text) && /株式会社|有限会社/.test(b.text)))
      );
    if (
      !scope ||
      previous.blocks.some(
        (b) => b.y > context.y && b.y < last.y && declaredSubjectsIn(b).length > 0
      )
    )
      continue;
    const rows = [],
      valueIds: string[] = [];
    for (const block of current.blocks) {
      if (block.kind !== 'row' || headingLevel(block) !== null) break;
      const quantities = quantityColumns(current, block.spanIds, allowUnitless);
      if (
        quantities.length !== before.length ||
        quantities.some(
          (q, i) => Math.abs(q.x + q.width - before[i].x - before[i].width) > q.height * 0.5
        )
      )
        break;
      rows.push(block.id);
      valueIds.push(...quantities.map((q) => q.id));
    }
    if (rows.length < 2) continue;
    links.push({
      fromPage: previous.pageNumber,
      toPage: current.pageNumber,
      rowIds: rows,
      valueIds,
      periodIds: axes.flatMap((run) => run.map((s) => s.id)),
      periodColumns: axes.map((run) => run.map((s) => s.id)),
      contextIds: context.spanIds,
      scopeIds: [scope.id],
      columnEdges: before.map((q) => q.x + q.width),
      unitIds,
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
  const inherited = [...link.periodIds, ...link.contextIds, ...link.unitIds].map(
    (id) => owner.spans.find((s) => s.id === id)!
  );
  const top = Math.min(...page.spans.map((s) => s.y));
  const bottom = Math.max(...inherited.map((s) => s.y));
  const offset = top - bottom - Math.max(...inherited.map((s) => s.height)) * 2;
  // Explicit coordinate projection for a confirmed continuation. Original coordinates remain untouched.
  return [...inherited.map((s) => ({ ...s, y: s.y + offset })), ...page.spans];
}
/** Project only proved continuation headers into their destination rows.
 * The persisted page and unrelated regions retain their original membership. */
export function continuationPage(
  pages: ExtractedPage[],
  page: ExtractedPage,
  valueId: string
): ExtractedPage {
  const link = continuationFor(pages, page, valueId);
  if (!link) return page;
  const spans = continuationSpans(pages, page, valueId);
  const rowSpanIds = page.blocks
    .filter((b) => link.rowIds.includes(b.id))
    .flatMap((b) => b.spanIds);
  const valueIds = link.valueIds;
  const spanIds = [
    ...new Set([...rowSpanIds, ...link.periodIds, ...link.contextIds, ...link.unitIds]),
  ];
  const members = spans.filter((s) => spanIds.includes(s.id));
  return {
    ...page,
    spans,
    tableRegions: [
      ...page.tableRegions.filter((t) => !t.valueIds.some((id) => valueIds.includes(id))),
      {
        id: `continued:${link.fromPage}:${link.toPage}`,
        method: 'aligned',
        spanIds,
        valueIds,
        unitIds: link.unitIds,
        cells: [],
        ruleIds: [],
        top: Math.min(...members.map((s) => s.y)) - 1,
        bottom: Math.max(...members.map((s) => s.y)) + 1,
      },
    ],
  };
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
