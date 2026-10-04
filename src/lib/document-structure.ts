import type { PdfSpan } from './pdf-layout';
import type { ExtractedPage } from '@/types/summaryMetadata';
import { isQuantityPrefix, parseExactQuantity, parseExactRange } from './quantity';
import {
  calendarDatePattern,
  calendarIntervalSeparator,
  explicitCalendarAxisMatches,
} from './period-semantics';
import {
  tableRowAxis,
  tableColumnBand,
  tableUnitRuns,
  physicalRows,
  type TableRegion,
} from './table-layout';

export interface SourceItem extends PdfSpan {
  transform: number[];
  direction: string;
  hasEOL: boolean;
}
export interface TextBlock {
  id: string;
  kind: 'paragraph' | 'row';
  page: number;
  text: string;
  spanIds: string[];
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface QuantityCell {
  id: string;
  spanIds: string[];
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}
export const normalized = (text: string) => text.normalize('NFKC').replace(/\s/g, '');
export const reportingScope = '非連結|個別|単体|連結';
export const reportingScopeHeading = `(${reportingScope})(?:累計期間)?(?:の)?`;
/** Whole supported reporting titles, never a forecast used as a noun modifier. */
export function forecastReportingTitle(text: string): { period: string | null } | null {
  const title = normalized(text).replace(/^(?:\(\d+\)|\d+[.．]|■|\(?[①-⑳]\)?)/, '');
  const match = title.match(
    new RegExp(
      `^(?:(20\\d{2}年\\d{1,2}月期)(?:の)?)?(?:通期)?(?:${reportingScopeHeading})?業績予想(?:数値)?(?:(?:の修正)?(?:及び|および|並びに)配当予想)?(?:(?:の修正|の概要)?(?:について|に関するお知らせ)?|に関する(?:説明|定性的情報)|などの将来予測情報に関する説明)(?:\\(${calendarDatePattern}${calendarIntervalSeparator}${calendarDatePattern}\\))?$`
    )
  );
  if (match) return { period: match[1] ?? null };
  return /^(?:20\d{2}年\d{1,2}月期(?:の)?)?今後の見通し(?:について)?$/.test(title)
    ? { period: null }
    : null;
}
/** A date-only caption borrows an explicit FY only through the identical reporting interval. */
export function resolveForecastReportingTitle(
  caption: TextBlock,
  blocks: TextBlock[],
  spans: PdfSpan[]
): { period: string; sourceIds: string[] } | null {
  const title = forecastReportingTitle(caption.text);
  if (!title) return null;
  if (title.period) return { period: title.period, sourceIds: [] };
  const interval = normalized(caption.text).match(
    new RegExp(`\\((${calendarDatePattern}${calendarIntervalSeparator}${calendarDatePattern})\\)$`)
  )?.[1];
  if (!interval || !explicitCalendarAxisMatches(interval, interval)) return null;
  const associations: Array<{ period: string; sourceIds: string[] }> = [];
  for (const block of blocks) {
    if (
      block.page !== caption.page ||
      block.y >= caption.y ||
      block.kind !== 'paragraph' ||
      !/^(?:当社|当グループ)/.test(normalized(block.text)) ||
      !/業績予想/.test(normalized(block.text)) ||
      blocks.some(
        (boundary) =>
          boundary.page === caption.page &&
          boundary.y > block.y &&
          boundary.y < caption.y &&
          /^(?:\d+[.．]|\(\d+\)|■)/.test(normalized(boundary.text))
      )
    )
      continue;
    for (const match of normalized(block.text).matchAll(
      new RegExp(
        `(20\\d{2}年\\d{1,2}月期)\\((${calendarDatePattern}${calendarIntervalSeparator}${calendarDatePattern})\\)`,
        'g'
      )
    )) {
      if (!explicitCalendarAxisMatches(match[2], interval)) continue;
      const [year, month] = match[1].match(/\d+/g)!.map(Number);
      const end = match[2].match(/(20\d{2})年(\d{1,2})月\d{1,2}日$/)!;
      if (year !== Number(end[1]) || month !== Number(end[2])) continue;
      const parts = block.spanIds.map((id) => spans.find((s) => s.id === id)!);
      if (
        parts.some((s) => !s) ||
        normalized(parts.map((s) => s.text).join('')) !== normalized(block.text)
      )
        continue;
      let offset = 0;
      const sourceIds = parts
        .filter((s) => {
          const start = offset;
          offset += normalized(s.text).length;
          return start < match.index! + match[1].length && offset > match.index!;
        })
        .map((s) => s.id);
      associations.push({ period: match[1], sourceIds });
    }
  }
  const periods = new Set(associations.map((a) => a.period));
  return periods.size === 1
    ? {
        period: associations[0].period,
        sourceIds: [...new Set(associations.flatMap((a) => a.sourceIds))],
      }
    : null;
}
export function isPerformanceReportingTitle(text: string): boolean {
  return new RegExp(`経営成績|損益計算書|${reportingScopeHeading}業績(?!予想)`).test(
    normalized(text)
  );
}
export const sameLine = (a: PdfSpan, b: PdfSpan) =>
  Math.abs(a.y - b.y) <= Math.min(a.height, b.height) * 0.3;

/** Numeric runs retain every source span, including an incomplete decimal or separated sign. */
export function quantityCells(spans: PdfSpan[]): QuantityCell[] {
  const cells: QuantityCell[] = [];
  const ordered = [...spans].sort((a, b) => a.y - b.y || a.x - b.x);
  for (let i = 0; i < ordered.length; i++) {
    const first = ordered[i];
    if (
      !isQuantityPrefix(first.text) &&
      !parseExactQuantity(first.text) &&
      !parseExactRange(first.text)
    )
      continue;
    let text = first.text,
      end = i;
    if (isQuantityPrefix(text)) {
      while (end + 1 < ordered.length) {
        const previous = ordered[end],
          next = ordered[end + 1];
        const gap = next.x - previous.x - previous.width;
        if (
          !sameLine(first, next) ||
          gap < -0.5 ||
          gap > Math.min(previous.height, next.height) * 0.6 ||
          !isQuantityPrefix(text + next.text)
        )
          break;
        text += next.text;
        end++;
      }
    }
    if (parseExactQuantity(text) || parseExactRange(text)) {
      const last = ordered[end];
      cells.push({
        id: first.id,
        spanIds: ordered.slice(i, end + 1).map((s) => s.id),
        text,
        x: first.x,
        y: first.y,
        width: last.x + last.width - first.x,
        height: first.height,
      });
      i = end;
    }
  }
  return cells;
}

/** Horizontal text runs are a structural unit; a band intersecting a run does not own it. */
export function lineRuns(spans: PdfSpan[], gapScale = 0.3): PdfSpan[][] {
  const runs: PdfSpan[][] = [];
  for (const span of [...spans].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const run = runs[runs.length - 1],
      last = run?.[run.length - 1];
    const gap = last ? span.x - last.x - last.width : Infinity;
    if (
      last &&
      sameLine(last, span) &&
      gap >= -0.5 &&
      gap <= Math.min(last.height, span.height) * gapScale
    )
      run.push(span);
    else runs.push([span]);
  }
  return runs;
}

export function buildBlocks(
  page: Pick<ExtractedPage, 'pageNumber' | 'spans'> & { tableRegions?: TableRegion[] }
): TextBlock[] {
  const lines: PdfSpan[][] = [];
  for (const span of [...page.spans].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const line = lines[lines.length - 1];
    if (line && sameLine(line[0], span)) line.push(span);
    else lines.push([span]);
  }
  const blocks: TextBlock[] = [];
  for (const line of lines) {
    line.sort((a, b) => a.x - b.x);
    const first = line[0],
      last = line[line.length - 1];
    const text = line
      .map(
        (s, i) =>
          (i && s.x - line[i - 1].x - line[i - 1].width > first.height * 0.6 ? ' ' : '') + s.text
      )
      .join('');
    const isRow =
      (quantityCells(line).length >= 2 ||
        page.tableRegions?.some((t) => line.some((s) => t.valueIds.includes(s.id)))) &&
      !/[。；]|は、|で、|おいて|とおり|いたし|するこ/.test(text) &&
      !/^[(（]注[)）]|^※/.test(normalized(text)) &&
      (!/\d{4}年\d{1,2}月\d{1,2}日/.test(normalized(text)) ||
        page.tableRegions?.some((t) => line.some((s) => t.valueIds.includes(s.id))));
    const previous = blocks[blocks.length - 1];
    // Wrap a paragraph only when both lines share margins and the preceding sentence continues.
    if (
      previous &&
      previous.kind === 'paragraph' &&
      !isRow &&
      !/[。！？]$/.test(previous.text.trim()) &&
      first.y - previous.y - previous.height <= first.height * 1.2 &&
      first.y > previous.y &&
      (Math.abs(first.x - previous.x) <= first.height * 2.5 ||
        (/^[(（]注[)）]/.test(previous.text) &&
          first.x - previous.x >= 0 &&
          first.x - previous.x <= first.height * 6)) &&
      last.x + last.width <= previous.x + previous.width + first.height * 4
    ) {
      previous.text += '\n' + text;
      previous.spanIds.push(...line.map((s) => s.id));
      previous.height = first.y - previous.y + first.height;
    } else
      blocks.push({
        id: `p${page.pageNumber}b${blocks.length + 1}`,
        kind: isRow ? 'row' : 'paragraph',
        page: page.pageNumber,
        text,
        spanIds: line.map((s) => s.id),
        x: first.x,
        y: first.y,
        width: last.x + last.width - first.x,
        height: first.height,
      });
  }
  return blocks;
}

/** Structural hints only: no values, periods, or semantics are confirmed here. */
export function tableReferenceHints(
  page: Pick<ExtractedPage, 'spans' | 'quantities' | 'tableRegions'>
) {
  return page.tableRegions.flatMap((region) =>
    rawTableReferenceHints(
      {
        spans: page.spans.filter((s) => region.spanIds.includes(s.id)),
        quantities: page.quantities.filter((q) => region.valueIds.includes(q.id)),
      },
      region
    )
  );
}
function rawTableReferenceHints(
  page: Pick<ExtractedPage, 'spans' | 'quantities'>,
  region: TableRegion
) {
  const spans = page.spans,
    cells = page.quantities;
  const midpoint = (s: { x: number; width: number }) => s.x + s.width / 2;
  const hints: Array<{
    valueId: string;
    metricIds: string[];
    periodIds: string[];
    unitIds: string[];
    contextIds: string[];
  }> = [];
  const unitRows = tableUnitRuns(spans);
  const headers = unitRows.map((run) => ({
    id: run[0].id,
    ids: run.map((s) => s.id),
    text: run.map((s) => s.text).join(''),
    x: run[0].x,
    y: run[0].y,
    width: run[run.length - 1].x + run[run.length - 1].width - run[0].x,
    height: run[0].height,
  }));
  const runs = lineRuns(spans);
  const periodRunIds = new Set(
    runs
      .filter((run) =>
        /20\d{2}年\d{1,2}月(?:期|\d{1,2}日)/.test(normalized(run.map((s) => s.text).join('')))
      )
      .flatMap((run) => run.map((s) => s.id))
  );
  for (const value of cells) {
    if (periodRunIds.has(value.id)) continue;
    if (parseExactQuantity(value.text)?.unit || parseExactRange(value.text)?.unit) continue;
    const prior = headers.filter(
      (h) =>
        h.y < value.y &&
        value.y - h.y < value.height * 24 &&
        headers.filter((other) => sameLine(h, other)).length >= 2
    );
    const nearestY = Math.max(-Infinity, ...prior.map((h) => h.y));
    const peers = prior
      .filter((h) => Math.abs(h.y - nearestY) <= h.height * 0.3)
      .sort((a, b) => midpoint(a) - midpoint(b));
    if (peers.length < 2) continue;
    const distances = peers.map((h) => Math.abs(midpoint(h) - midpoint(value)));
    const distance = Math.min(...distances);
    const slots = distances
      .map((d, i) => (Math.abs(d - distance) < 0.1 ? i : -1))
      .filter((i) => i >= 0);
    if (slots.length !== 1) continue;
    const i = slots[0],
      unit = peers[i];
    const drawnBand = tableColumnBand(region, unit.ids, value.height);
    const left =
      drawnBand?.[0] ??
      (i
        ? (midpoint(peers[i - 1]) + midpoint(unit)) / 2
        : midpoint(unit) - (midpoint(peers[1]) - midpoint(unit)) / 2);
    const right =
      drawnBand?.[1] ??
      (i + 1 < peers.length
        ? (midpoint(unit) + midpoint(peers[i + 1])) / 2
        : midpoint(unit) + (midpoint(unit) - midpoint(peers[i - 1])) / 2);
    const metricRight =
      peers[i + 1]?.text === '%' && unit.text !== '%'
        ? i + 2 < peers.length
          ? (midpoint(peers[i + 1]) + midpoint(peers[i + 2])) / 2
          : right + (midpoint(peers[i + 1]) - midpoint(unit)) / 2
        : right;
    const priorRows = cells.filter(
      (q) =>
        q.y < unit.y &&
        !periodRunIds.has(q.id) &&
        parseExactQuantity(q.text)?.unit === null &&
        cells.filter((other) => sameLine(q, other) && parseExactQuantity(other.text)?.unit === null)
          .length >= 2
    );
    const top = Math.max(unit.y - value.height * 10, ...priorRows.map((q) => q.y));
    const metricRuns = runs
      .filter(
        (run) =>
          run[0].y > top && run[0].y < unit.y && run.every((s) => value.y - s.y < value.height * 18)
      )
      .filter((run) => {
        const text = normalized(run.map((s) => s.text).join(''));
        return (
          !isPerformanceReportingTitle(text) &&
          !/20\d{2}年|業績予想|配当の状況|決算短信|表示は|未満(?:切捨て|四捨五入)|単位[:：]|^(?:\(?連結\)?|\(?個別\)?)$/.test(
            text
          ) &&
          (text === '年間配当金' ||
            (midpoint({
              x: run[0].x,
              width: run[run.length - 1].x + run[run.length - 1].width - run[0].x,
            }) > left &&
              midpoint({
                x: run[0].x,
                width: run[run.length - 1].x + run[run.length - 1].width - run[0].x,
              }) < metricRight))
        );
      });
    const metrics = metricRuns.flat();
    if (!metrics.length) continue;
    const rowCells = cells.filter((q) => sameLine(q, value) && !periodRunIds.has(q.id));
    const minX = Math.min(...rowCells.map((q) => q.x));
    const dataRows = [
      ...new Set(
        cells
          .filter((q) => q.y > unit.y && cells.filter((other) => sameLine(q, other)).length >= 2)
          .map((q) => q.y)
      ),
    ];
    const axisParts = spans.filter(
      (s) =>
        s.x + s.width < minX &&
        Math.abs(s.y - value.y) <= Math.min(s.height, value.height) * 1.2 &&
        Math.abs(s.y - value.y) <= Math.min(...dataRows.map((y) => Math.abs(y - s.y))) + 0.1
    );
    const cellAxis = tableRowAxis(region, spans, value);
    const axes = cellAxis.length
      ? cellAxis
      : runs.filter((run) => run.some((s) => axisParts.some((part) => part.id === s.id))).flat();
    if (!/予想|実績|通期|四半期|月|20\d{2}年/.test(normalized(axes.map((s) => s.text).join(''))))
      continue;
    const context = physicalRows(spans)
      .map((row) => row.filter((s) => !/(?:%|％)表示は/.test(s.text)))
      .filter((row) => row.length)
      .filter(
        (run) =>
          run[0].y < Math.min(...metrics.map((s) => s.y)) &&
          value.y - run[0].y < value.height * 32 &&
          (isPerformanceReportingTitle(run.map((s) => s.text).join('')) ||
            forecastReportingTitle(run.map((s) => s.text).join('')) ||
            /配当(?:の状況|予想)/.test(normalized(run.map((s) => s.text).join(''))))
      )
      .sort((a, b) => b[0].y - a[0].y)[0];
    if (!axes.length || !context) continue;
    hints.push({
      valueId: value.id,
      metricIds: metrics.map((s) => s.id),
      periodIds: axes.map((s) => s.id),
      unitIds: unit.ids,
      contextIds: context.map((s) => s.id),
    });
  }
  return hints;
}
