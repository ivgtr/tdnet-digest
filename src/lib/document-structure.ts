import type { PdfSpan } from './pdf-layout';
import type { ExtractedPage } from '@/types/summaryMetadata';
import { isQuantityPrefix, parseExactQuantity, parseExactRange, proseQuantities } from './quantity';
import {
  calendarDatePattern,
  calendarIntervalSeparator,
  explicitCalendarAxisMatches,
  REPORTING_PERIOD_SHAPE_PATTERN,
  reportingPeriodShapes,
} from './period-semantics';
import {
  tableRowAxis,
  tableColumnBand,
  tableMetricColumnBand,
  tableUnitRuns,
  physicalRows,
  buildTableCells,
  type TableCell,
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
/** Explicit company fields and standalone legal names share one source vocabulary. */
export function declaredSubjectsIn(block: TextBlock): string[] {
  return [
    ...new Set(
      block.text.split('\n').flatMap((line) => {
        const text = normalized(line).replace(/^(?:\(\d+\)|\d+[.．])/, '');
        const field = text.match(/^(?:上場会社名|会社名|名称):?([^:].*)$/)?.[1];
        if (field) return [field.split(/[|｜]|上場取引所|コード番号|URL|代表者名/)[0]];
        return /^(?:株式会社|有限会社|合同会社|投資法人)[\p{L}\p{N}・&.-]+$|^[\p{L}\p{N}・&.-]+(?:株式会社|有限会社|合同会社|投資法人)$/u.test(
          text
        )
          ? [text]
          : [];
      })
    ),
  ].filter(Boolean);
}
/** A numbered title is a boundary, not every body mention of a scope/period. */
export function headingLevel(
  block: Pick<TextBlock, 'id' | 'text'> & Partial<Pick<TextBlock, 'kind'>>
): number | null {
  const text = normalized(block.text);
  const raw = block.text.normalize('NFKC').trim();
  const numbered = /^■/.test(text)
    ? 1
    : /^\d+\.(?:\s|[^\d]|20\d{2}年)/.test(raw)
      ? 1
      : /^\(\d+\)/.test(text)
        ? 2
        : /^\(?[①-⑳]\)?/.test(text)
          ? 3
          : null;
  if (block.kind === 'row') return !/[。；]/.test(text) ? numbered : null;
  const quantities = proseQuantities({ id: block.id, text });
  if (
    text.length > 180 ||
    /[。；]/.test(text) ||
    quantities.some((q) =>
      /^(?:十|百|千|万|百万|千万|億|兆)?(?:円|株)$/.test(parseExactQuantity(q.raw)?.unit ?? '')
    ) ||
    (/^20\d{2}年/.test(text) && quantities.length)
  )
    return null;
  if (/^■/.test(text)) return 1;
  if (forecastReportingTitle(text) && /に関するお知らせ$/.test(text)) return 1;
  if (
    /^20\d{2}年.*(?:経営成績|予想|配当|月度|実績|取得予定)/.test(text) &&
    (text.match(/20\d{2}年\d{1,2}月期/g)?.length ?? 0) <= 1
  )
    return 3;
  if (numbered !== null) return numbered;
  if (
    /^\((?:連結|個別)?(?:損益計算書|貸借対照表|キャッシュ.*|重要な.*|追加情報|.*関係)\)$/.test(text)
  )
    return 3;
  return null;
}
export const reportingScope = '非連結|個別|単体|連結';
export const reportingScopeHeading = `(${reportingScope})(?:累計期間)?(?:の)?`;
/** Whole supported reporting titles, never a forecast used as a noun modifier. */
export function forecastReportingTitle(text: string): { period: string | null } | null {
  const title = normalized(text).replace(/^(?:\(\d+\)|\d+[.．]|■|\(?[①-⑳]\)?)/, '');
  const match = title.match(
    new RegExp(
      `^(?:(20\\d{2}年\\d{1,2}月期)(?:の?${REPORTING_PERIOD_SHAPE_PATTERN})?(?:\\(中間期\\))?(?:の)?)?(?:通期)?(?:${reportingScopeHeading})?業績予想(?:数値)?(?:(?:の修正)?(?:及び|および|並びに)配当予想)?(?:(?:の修正|の概要)?(?:について|に関するお知らせ)?|に関する(?:説明|定性的情報)|などの将来予測情報に関する説明)(?:\\(${calendarDatePattern}${calendarIntervalSeparator}${calendarDatePattern}\\))?$`
    )
  );
  if (match && reportingPeriodShapes(title).length <= 1) return { period: match[1] ?? null };
  return /^(?:20\d{2}年\d{1,2}月期(?:の)?)?今後の見通し(?:について)?$/.test(title)
    ? { period: null }
    : null;
}
/** A period declaration has no financial-reporting role of its own. */
export function forecastPeriodDeclaration(
  text: string
): { period: string; interval: string | null } | null {
  const match = normalized(text)
    .replace(/^(?:\(\d+\)|\d+[.．])/, '')
    .match(
      new RegExp(
        `^(20\\d{2}年\\d{1,2}月期)(?:通期)?(?:\\((${calendarDatePattern}${calendarIntervalSeparator}${calendarDatePattern})\\))?$`
      )
    );
  if (!match) return null;
  if (match[2]) {
    const end = match[2].match(/(20\d{2})年(\d{1,2})月\d{1,2}日$/)!;
    const [year, month] = match[1].match(/\d+/g)!.map(Number);
    if (
      !explicitCalendarAxisMatches(match[2], match[2]) ||
      year !== Number(end[1]) ||
      month !== Number(end[2])
    )
      return null;
  }
  return { period: match[1], interval: match[2] ?? null };
}
/** Only original declarations in this table's header may supplement its caption.
 * Conflicting declarations remain evidence, so downstream checks cannot hide them.
 */
export function forecastTablePeriodSources(
  caption: TextBlock,
  blocks: TextBlock[],
  spans: PdfSpan[],
  table: TableRegion
): TextBlock[] {
  const firstUnit = Math.min(...spans.filter((s) => table.unitIds.includes(s.id)).map((s) => s.y));
  return blocks.filter(
    (b) =>
      b.page === caption.page &&
      b.y > caption.y &&
      b.y < firstUnit &&
      b.spanIds.length > 0 &&
      b.spanIds.every((id) => table.spanIds.includes(id)) &&
      !!forecastPeriodDeclaration(b.text) &&
      !blocks.some(
        (boundary) =>
          boundary.page === caption.page &&
          boundary.y > caption.y &&
          boundary.y < b.y &&
          ((/^(?:\d+[.．]|\(\d+\)|■)/.test(normalized(boundary.text)) &&
            !forecastPeriodDeclaration(boundary.text)) ||
            /^(?:会社名|上場会社名|名称|親会社名)/.test(normalized(boundary.text)))
      )
  );
}
/** Caption, same-table declaration, or the identical interval in issuer prose. */
export function resolveForecastReportingTitle(
  caption: TextBlock,
  blocks: TextBlock[],
  spans: PdfSpan[],
  table?: TableRegion
): { period: string; sourceIds: string[] } | null {
  const title = forecastReportingTitle(caption.text);
  if (!title) return null;
  const declarations = table ? forecastTablePeriodSources(caption, blocks, spans, table) : [];
  const periods = new Set([
    ...(title.period ? [title.period] : []),
    ...declarations.map((b) => forecastPeriodDeclaration(b.text)!.period),
  ]);
  if (periods.size > 1) return null;
  if (periods.size === 1)
    return { period: [...periods][0], sourceIds: declarations.flatMap((b) => b.spanIds) };
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
          /^(?:\d+[.．]|\(\d+\)|■|会社名|上場会社名|名称|親会社名)/.test(normalized(boundary.text))
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
  const associatedPeriods = new Set(associations.map((a) => a.period));
  return associatedPeriods.size === 1
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
export const sameLine = (a: Pick<PdfSpan, 'y' | 'height'>, b: Pick<PdfSpan, 'y' | 'height'>) =>
  Math.abs(a.y - b.y) <= Math.min(a.height, b.height) * 0.3;

/** Only a unique innermost closed cell proves ownership; overlapping cells do not. */
export function physicalCellOwners(sourceCells: TableCell[]): Map<string, TableCell | null> {
  const candidates = new Map<string, TableCell[]>();
  for (const cell of sourceCells)
    for (const id of cell.spanIds) {
      const owners = candidates.get(id) ?? [];
      // A physical cell can be included in more than one table region.
      if (
        !owners.some(
          (other) =>
            other.id === cell.id &&
            other.left === cell.left &&
            other.top === cell.top &&
            other.right === cell.right &&
            other.bottom === cell.bottom
        )
      )
        owners.push(cell);
      candidates.set(id, owners);
    }
  const inside = (inner: TableCell, outer: TableCell) =>
    inner.left >= outer.left &&
    inner.top >= outer.top &&
    inner.right <= outer.right &&
    inner.bottom <= outer.bottom &&
    (inner.left > outer.left ||
      inner.top > outer.top ||
      inner.right < outer.right ||
      inner.bottom < outer.bottom);
  return new Map(
    [...candidates].map(([id, owners]) => {
      const innermost = owners.filter((cell) =>
        owners.every((other) => cell === other || inside(cell, other))
      );
      return [id, innermost.length === 1 ? innermost[0] : null];
    })
  );
}

/** Unruled text keeps its proximity rule; partial or ambiguous ownership cannot join. */
export function canJoinWithinCells(
  owners: ReadonlyMap<string, TableCell | null>,
  leftId: string,
  rightId: string
): boolean {
  const left = owners.get(leftId),
    right = owners.get(rightId);
  return left !== null && right !== null && left?.id === right?.id;
}

/** Numeric runs retain every source span, including an incomplete decimal or separated sign. */
export function quantityCells(spans: PdfSpan[], sourceCells: TableCell[] = []): QuantityCell[] {
  const cells: QuantityCell[] = [];
  const owners = physicalCellOwners(sourceCells);
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
      end = i,
      ambiguous = owners.get(first.id) === null;
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
        const previousOwner = owners.get(previous.id),
          nextOwner = owners.get(next.id);
        if (previousOwner === null || nextOwner === null) ambiguous = true;
        else if (!canJoinWithinCells(owners, previous.id, next.id)) {
          // One closed side alone does not prove that an incomplete fragment
          // belongs to a separate quantity. Do not expose its valid prefix.
          if (
            (!previousOwner || !nextOwner) &&
            ((!parseExactQuantity(text) && !parseExactRange(text)) ||
              (!parseExactQuantity(next.text) && !parseExactRange(next.text)))
          )
            ambiguous = true;
          else break;
        }
        text += next.text;
        end++;
      }
    }
    // An unresolved cell relationship cannot turn a split decimal, grouping
    // separator or sign into a shorter, individually parseable quantity.
    if (ambiguous) {
      i = end;
      continue;
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
  // A range may wrap inside a closed physical cell. Require the explicit
  // separator and uninterrupted numeric runs; proximity alone never joins rows.
  const members = new Map<string, PdfSpan[]>();
  for (const span of spans) {
    const owner = owners.get(span.id);
    if (owner) members.set(owner.id, [...(members.get(owner.id) ?? []), span]);
  }
  for (const cell of sourceCells) {
    const rows = physicalRows(members.get(cell.id) ?? []);
    for (let i = 0; i < rows.length - 1; i++) {
      const first = rows[i];
      if (lineRuns(first, 0.6).length !== 1) continue;
      let parts = [...first],
        raw = parts.map((s) => s.text).join('');
      if (!isQuantityPrefix(raw) || parseExactRange(raw)) continue;
      for (let j = i + 1; j < rows.length; j++) {
        const next = rows[j];
        if (lineRuns(next, 0.6).length !== 1) break;
        const continued = raw + '\n' + next.map((s) => s.text).join('');
        if (!/[～〜~]/.test(continued) || !isQuantityPrefix(continued)) break;
        raw = continued;
        parts = [...parts, ...next];
        if (!parseExactRange(raw)) continue;
        const ids = parts.map((s) => s.id);
        // An existing run must be wholly represented by this range.
        if (
          cells.some(
            (q) =>
              q.spanIds.some((id) => ids.includes(id)) && q.spanIds.some((id) => !ids.includes(id))
          )
        )
          break;
        for (let k = cells.length - 1; k >= 0; k--)
          if (cells[k].spanIds.some((id) => ids.includes(id))) cells.splice(k, 1);
        const x = Math.min(...parts.map((s) => s.x));
        cells.push({
          id: parts[0].id,
          spanIds: ids,
          text: raw,
          x,
          y: parts[0].y,
          width: Math.max(...parts.map((s) => s.x + s.width)) - x,
          height: parts[0].height,
        });
        i = j;
        break;
      }
    }
  }
  return cells.sort((a, b) => a.y - b.y || a.x - b.x);
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
  page: Pick<ExtractedPage, 'pageNumber' | 'spans'> &
    Partial<Pick<ExtractedPage, 'tableRegions' | 'drawingLines'>>,
  sourceCells = page.drawingLines
    ? buildTableCells(page.drawingLines, page.spans, page.pageNumber)
    : (page.tableRegions?.flatMap((t) => t.cells) ?? [])
): TextBlock[] {
  const owners = physicalCellOwners(sourceCells);
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
    const cellBoundaries = new Set(
      line.flatMap((s, i) =>
        i > 0 && !canJoinWithinCells(owners, line[i - 1].id, s.id) ? [i] : []
      )
    );
    const text = line
      .map(
        (s, i) =>
          (cellBoundaries.has(i)
            ? ' │ '
            : i && s.x - line[i - 1].x - line[i - 1].width > first.height * 0.6
              ? ' '
              : '') + s.text
      )
      .join('');
    const isRow =
      (quantityCells(line, sourceCells).length >= 2 ||
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
      // A hard boundary survives whitespace normalization, including a split
      // sign or unit across physical rows. It is not a metadata field delimiter.
      previous.text +=
        (canJoinWithinCells(owners, previous.spanIds[previous.spanIds.length - 1], first.id)
          ? '\n'
          : '\n│ ') + text;
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

/** A fiscal column is a complete horizontal run, retaining every source span. */
export function fiscalHeadingRuns(spans: PdfSpan[]): PdfSpan[][] {
  return lineRuns(spans).filter(
    (run) =>
      (normalized(run.map((s) => s.text).join('')).match(/20\d{2}年\d{1,2}月期/g)?.length ?? 0) ===
      1
  );
}

/** Column-owned header fragments, independent of quantity mappings. */
export function tableHeaderColumns(region: TableRegion, spans: PdfSpan[]) {
  const midpoint = (s: { x: number; width: number }) => s.x + s.width / 2;
  const headers = tableUnitRuns(spans)
    .filter((run) => run.every((s) => region.unitIds.includes(s.id)))
    .map((run) => ({
      ids: run.map((s) => s.id),
      text: run.map((s) => s.text).join(''),
      x: run[0].x,
      y: run[0].y,
      height: run[0].height,
      width: run[run.length - 1].x + run[run.length - 1].width - run[0].x,
    }));
  const runs = lineRuns(spans);
  return headers.flatMap((unit) => {
    const peers = headers
      .filter((h) => sameLine(h, unit))
      .sort((a, b) => midpoint(a) - midpoint(b));
    if (peers.length < 2) return [];
    const i = peers.indexOf(unit);
    const drawnBand = tableColumnBand(region, unit.ids, unit.height);
    const parentBand = tableMetricColumnBand(region, unit.ids, unit.height);
    const left =
      parentBand?.[0] ??
      drawnBand?.[0] ??
      (i
        ? (midpoint(peers[i - 1]) + midpoint(unit)) / 2
        : midpoint(unit) - (midpoint(peers[1]) - midpoint(unit)) / 2);
    const right =
      parentBand?.[1] ??
      drawnBand?.[1] ??
      (i + 1 < peers.length
        ? (midpoint(unit) + midpoint(peers[i + 1])) / 2
        : midpoint(unit) + (midpoint(unit) - midpoint(peers[i - 1])) / 2);
    const metricRight =
      parentBand?.[1] ??
      (normalized(peers[i + 1]?.text ?? '') === '%' && normalized(unit.text) !== '%'
        ? i + 2 < peers.length
          ? (midpoint(peers[i + 1]) + midpoint(peers[i + 2])) / 2
          : right + (midpoint(peers[i + 1]) - midpoint(unit)) / 2
        : right);
    const top = Math.max(region.top, unit.y - unit.height * 10);
    const metricIds = runs
      .filter((run) => {
        const text = normalized(run.map((s) => s.text).join(''));
        const center = midpoint({
          x: run[0].x,
          width: run[run.length - 1].x + run[run.length - 1].width - run[0].x,
        });
        return (
          run[0].y > top &&
          run[0].y < unit.y &&
          !isPerformanceReportingTitle(text) &&
          !/20\d{2}年|業績予想|配当の状況|決算短信|表示は|未満(?:切捨て|四捨五入)|単位[:：]|^(?:\(?連結\)?|\(?個別\)?)$/.test(
            text
          ) &&
          (text === '年間配当金' || (center > left && center < metricRight))
        );
      })
      .flatMap((run) => run.map((s) => s.id));
    return [{ unitIds: unit.ids, metricIds }];
  });
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
  const columnHeaders = tableHeaderColumns(region, spans);
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
    const priorRows = cells.filter(
      (q) =>
        q.y < unit.y &&
        !periodRunIds.has(q.id) &&
        parseExactQuantity(q.text)?.unit === null &&
        cells.filter((other) => sameLine(q, other) && parseExactQuantity(other.text)?.unit === null)
          .length >= 2
    );
    const top = Math.max(unit.y - value.height * 10, ...priorRows.map((q) => q.y));
    const metrics = (
      columnHeaders.find(
        (column) =>
          column.unitIds.length === unit.ids.length &&
          column.unitIds.every((id) => unit.ids.includes(id))
      )?.metricIds ?? []
    ).map((id) => spans.find((s) => s.id === id)!);
    if (metrics.some((s) => s.y <= top || value.y - s.y >= value.height * 18)) continue;
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
          (isPerformanceReportingTitle(run.map((s) => s.text).join('')) ||
            forecastReportingTitle(run.map((s) => s.text).join('')) ||
            /配当(?:の状況|予想)/.test(normalized(run.map((s) => s.text).join(''))))
      )
      .sort((a, b) => b[0].y - a[0].y)[0];
    // The region already owns this title and stops at intervening section headings.
    // Notes between related tables do not change that ownership.
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
