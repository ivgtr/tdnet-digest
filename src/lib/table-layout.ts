import type { PdfSpan } from './pdf-layout';
import type { DrawingLine } from './pdf-drawing';
import type { QuantityCell } from './document-structure';
import {
  lineRuns,
  normalized,
  sameLine,
  isPerformanceReportingTitle,
  forecastReportingTitle,
} from './document-structure';
import { declaredQuantityUnit, isUncaptionedUnit, parseExactNumeric } from './quantity';

export interface TableCell {
  id: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
  spanIds: string[];
}
export interface TableRegion {
  id: string;
  method: 'ruled' | 'aligned';
  spanIds: string[];
  valueIds: string[];
  unitIds: string[];
  cells: TableCell[];
  ruleIds: string[];
  top: number;
  bottom: number;
}
const cx = (s: { x: number; width: number }) => s.x + s.width / 2;
const cy = (s: { y: number; height: number }) => s.y - s.height * 0.4;
const note = (text: string) => /^(?:\(?注\)?|※|\(参考\))/.test(normalized(text));
export const tableUnit = (text: string) => {
  const unit = declaredQuantityUnit(text);
  return unit !== null && isUncaptionedUnit(unit) && !/^(?:年|月|日)$/.test(unit);
};
export function physicalRows(spans: PdfSpan[]): PdfSpan[][] {
  const rows: PdfSpan[][] = [];
  for (const span of [...spans].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const row = rows[rows.length - 1];
    if (row && sameLine(row[0], span)) row.push(span);
    else rows.push([span]);
  }
  return rows.map((row) => row.sort((a, b) => a.x - b.x));
}
/** 円 and 銭 are the two parts of one decimal-yen column convention. */
export function tableUnitRuns(spans: PdfSpan[]): PdfSpan[][] {
  const result: PdfSpan[][] = [];
  for (const row of physicalRows(spans)) {
    const used = new Set<string>();
    for (const run of lineRuns(row, 0.6)) {
      if (tableUnit(run.map((s) => s.text).join(''))) {
        result.push(run);
        run.forEach((s) => used.add(s.id));
      }
    }
    for (const span of row.filter((s) => !used.has(s.id) && tableUnit(s.text))) {
      const sen =
        normalized(span.text) === '円'
          ? row.find(
              (s) =>
                !used.has(s.id) &&
                normalized(s.text) === '銭' &&
                s.x > span.x + span.width &&
                s.x - span.x - span.width < span.height * 3
            )
          : undefined;
      const run = sen ? [span, sen] : [span];
      result.push(run);
      run.forEach((s) => used.add(s.id));
    }
    // Complete runs containing only 円 leave a separated 銭 to be joined explicitly.
    for (const run of result.filter(
      (r) => row.includes(r[0]) && normalized(r.map((s) => s.text).join('')) === '円'
    )) {
      const last = run[run.length - 1];
      const sen = row.find(
        (s) =>
          !used.has(s.id) &&
          normalized(s.text) === '銭' &&
          s.x > last.x + last.width &&
          s.x - last.x - last.width < last.height * 3
      );
      if (sen) {
        run.push(sen);
        used.add(sen.id);
      }
    }
  }
  return result;
}
export function buildTableCells(
  lines: DrawingLine[],
  spans: PdfSpan[],
  pageNumber: number
): TableCell[] {
  if (lines.length > 2000) throw new Error('SOURCE_DRAWING:表の罫線解析の処理上限');
  const snap = (values: number[]) => {
    const groups: number[][] = [];
    for (const value of [...new Set(values)].sort((a, b) => a - b)) {
      const group = groups[groups.length - 1];
      if (group && value - group[0] <= 0.8) group.push(value);
      else groups.push([value]);
    }
    return groups.map((g) => g.reduce((a, b) => a + b, 0) / g.length);
  };
  const horizontal = lines.filter((l) => Math.abs(l.y1 - l.y2) < 0.05),
    vertical = lines.filter((l) => Math.abs(l.x1 - l.x2) < 0.05);
  const xs = snap(vertical.map((l) => l.x1)),
    ys = snap(horizontal.map((l) => l.y1));
  const covers = (segments: Array<[number, number]>, a: number, b: number) => {
    let end = a;
    for (const [start, stop] of segments.sort((x, y) => x[0] - y[0])) {
      if (start > end + 0.8) break;
      end = Math.max(end, stop);
    }
    return end >= b - 0.8;
  };
  const h = (y: number, a: number, b: number) =>
    covers(
      horizontal.filter((l) => Math.abs(l.y1 - y) < 0.8).map((l) => [l.x1, l.x2]),
      a,
      b
    );
  const v = (x: number, a: number, b: number) =>
    covers(
      vertical.filter((l) => Math.abs(l.x1 - x) < 0.8).map((l) => [l.y1, l.y2]),
      a,
      b
    );
  const cells: TableCell[] = [];
  let attempts = 0;
  // A merged cell spans absent internal edges. Its smallest closed rectangle owns its text.
  for (let yi = 0; yi < ys.length - 1; yi++)
    for (let xi = 0; xi < xs.length - 1; xi++) {
      const left = xs[xi],
        top = ys[yi];
      for (let yj = yi + 1; yj < ys.length; yj++) {
        let found = false;
        for (let xj = xi + 1; xj < xs.length; xj++) {
          if (++attempts > 100000) throw new Error('SOURCE_DRAWING:表のセル解析の処理上限');
          const right = xs[xj],
            bottom = ys[yj];
          if (right - left < 8 || bottom - top < 4) continue;
          if (
            h(top, left, right) &&
            h(bottom, left, right) &&
            v(left, top, bottom) &&
            v(right, top, bottom)
          ) {
            cells.push({
              id: `p${pageNumber}cell${cells.length + 1}`,
              left,
              top,
              right,
              bottom,
              spanIds: spans
                .filter((s) => cx(s) > left && cx(s) < right && cy(s) > top && cy(s) < bottom)
                .map((s) => s.id),
            });
            found = true;
            break;
          }
        }
        if (found) break;
      }
    }
  return cells;
}

/** Unit rows and following aligned values define a table. Notes terminate its numeric body. */
export function buildTableRegions(page: {
  pageNumber: number;
  spans: PdfSpan[];
  quantities: QuantityCell[];
  drawingLines: DrawingLine[];
}): TableRegion[] {
  const spans = page.spans,
    runs = lineRuns(spans),
    physical = physicalRows(spans),
    grids = buildTableCells(page.drawingLines, spans, page.pageNumber);
  const units = tableUnitRuns(spans).map((run) => ({
    ids: run.map((s) => s.id),
    x: run[0].x,
    y: run[0].y,
    width: run[run.length - 1].x + run[run.length - 1].width - run[0].x,
    height: run[0].height,
  }));
  const rows: (typeof units)[] = [];
  for (const unit of units.sort((a, b) => a.y - b.y || a.x - b.x)) {
    const row = rows[rows.length - 1];
    if (row && Math.abs(row[0].y - unit.y) <= Math.min(row[0].height, unit.height) * 0.3)
      row.push(unit);
    else rows.push([unit]);
  }
  const numericRuns = runs.filter((run) => !note(run.map((s) => s.text).join('')));
  const result: TableRegion[] = [];
  for (const unitRow of rows.filter((r) => r.length >= 2)) {
    const unitY = unitRow[0].y,
      height = unitRow[0].height;
    const nextUnit = rows.find((r) => r[0].y > unitY + height * 0.3)?.[0].y ?? Infinity;
    const boundary = physical
      .filter(
        (run) =>
          run[0].y > unitY &&
          (note(run.map((s) => s.text).join('')) ||
            isPerformanceReportingTitle(run.map((s) => s.text).join('')) ||
            forecastReportingTitle(run.map((s) => s.text).join('')))
      )
      .map((run) => run[0].y);
    const end = Math.min(nextUnit, ...boundary);
    const values = page.quantities.filter(
      (q) =>
        q.y > unitY &&
        q.y < end &&
        q.y - unitY < height * 24 &&
        parseExactNumeric(q.text)?.unit === null &&
        numericRuns.some((run) => run.some((s) => s.id === q.id)) &&
        cx(q) > cx(unitRow[0]) - height * 3 &&
        cx(q) < cx(unitRow[unitRow.length - 1]) + height * 6 &&
        (physical.some(
          (row) =>
            row.some((s) => Math.abs(s.y - q.y) <= Math.min(s.height, q.height) * 1.2) &&
            /20\d{2}年\d{1,2}月(?:期|\d{1,2}日|度)?|通期|予想|実績|増減/.test(
              normalized(
                row
                  .filter((s) => s.x + s.width < cx(unitRow[0]))
                  .map((s) => s.text)
                  .join('')
              )
            )
        ) ||
          /予想|実績|通期|20\d{2}年/.test(
            normalized(
              tableRowAxis({ cells: grids, valueIds: page.quantities.map((q) => q.id) }, spans, q)
                .map((s) => s.text)
                .join('')
            )
          ))
    );
    if (!values.length) continue;
    const title = physical
      .filter(
        (run) =>
          run[0].y < unitY &&
          (isPerformanceReportingTitle(run.map((s) => s.text).join('')) ||
            forecastReportingTitle(run.map((s) => s.text).join('')) ||
            /配当(?:の状況|予想)/.test(normalized(run.map((s) => s.text).join(''))))
      )
      .sort((a, b) => b[0].y - a[0].y)[0];
    if (!title) continue;
    const lastNote = Math.max(
      -Infinity,
      ...physical
        .filter((run) => run[0].y < unitY && note(run.map((s) => s.text).join('')))
        .map((run) => run[0].y)
    );
    const priorTable = Math.max(-Infinity, ...result.map((t) => t.bottom));
    const valueSpanIds = new Set(values.flatMap((q) => q.spanIds));
    const top = Math.max(unitY - height * 10, title[0].y, lastNote, priorTable),
      bottom =
        Math.max(...spans.filter((s) => valueSpanIds.has(s.id)).map((s) => s.y)) + height * 0.5;
    const members = spans.filter(
      (s) =>
        s.y > top &&
        s.y <= bottom &&
        !physical.some(
          (run) => note(run.map((p) => p.text).join('')) && run.some((p) => p.id === s.id)
        )
    );
    const cells = grids.filter(
      (cell) =>
        cell.top >= top - height * 4 &&
        cell.bottom <= bottom + height * 4 &&
        (cell.spanIds.some((id) => values.some((q) => q.spanIds.includes(id))) ||
          cell.spanIds.some((id) => members.some((s) => s.id === id)))
    );
    const ruled = values.every((q) => cells.some((c) => c.spanIds.includes(q.id)));
    const ruleIds = ruled
      ? page.drawingLines
          .filter((l) => l.y1 >= top - height * 4 && l.y2 <= bottom + height * 4)
          .map((l) => l.id)
      : [];
    result.push({
      id: `p${page.pageNumber}t${result.length + 1}`,
      method: ruled ? 'ruled' : 'aligned',
      spanIds: [...new Set([...members.map((s) => s.id), ...title.map((s) => s.id)])],
      valueIds: values.map((q) => q.id),
      unitIds: unitRow.flatMap((u) => u.ids),
      cells: ruled ? cells : [],
      ruleIds,
      top,
      bottom,
    });
  }
  return result;
}
export function tableForValue(
  page: { tableRegions: TableRegion[] },
  valueId: string
): TableRegion | null {
  const tables = page.tableRegions.filter((t) => t.valueIds.includes(valueId));
  if (tables.length > 1) throw new Error(`STRUCTURE:値が複数の表へ所属します: ${valueId}`);
  return tables[0] ?? null;
}
export function tableColumnBand(
  region: TableRegion,
  unitIds: string[],
  height: number
): [number, number] | null {
  const cells = region.cells
    .filter((c) => unitIds.every((id) => c.spanIds.includes(id)))
    .sort(
      (a, b) => (a.right - a.left) * (a.bottom - a.top) - (b.right - b.left) * (b.bottom - b.top)
    );
  const cell = cells[0];
  // A whole-table cell does not prove an individual column.
  return cell && cell.right - cell.left < height * 14 ? [cell.left, cell.right] : null;
}
/** A complete left cell supplies the row axis; dates in that cell retain their own role. */
export function tableRowAxis(
  region: Pick<TableRegion, 'cells' | 'valueIds'>,
  spans: PdfSpan[],
  value: QuantityCell
): PdfSpan[] {
  const own = region.cells
    .filter((c) => c.spanIds.includes(value.id))
    .sort(
      (a, b) => (a.right - a.left) * (a.bottom - a.top) - (b.right - b.left) * (b.bottom - b.top)
    )[0];
  if (!own) return [];
  const left = region.cells
    .filter((c) => c.right <= own.left + 0.8 && c.top <= cy(value) && c.bottom >= cy(value))
    .sort((a, b) => a.left - b.left)[0];
  if (!left) return [];
  const ids = new Set(left.spanIds);
  const axes = lineRuns(spans.filter((s) => ids.has(s.id))).filter((run) => {
    const text = normalized(run.map((s) => s.text).join(''));
    return !/20\d{2}年\d{1,2}月\d{1,2}日.*発表/.test(text) && !tableUnit(text);
  });
  const reporting = axes.filter((run) =>
    /20\d{2}年\d{1,2}月期|予想|実績|通期/.test(normalized(run.map((s) => s.text).join('')))
  );
  const numericRows = physicalRows(
    spans.filter(
      (s) =>
        region.valueIds.includes(s.id) &&
        s.x >= left.right &&
        cy(s) >= left.top &&
        cy(s) <= left.bottom
    )
  );
  // One physical row cell may contain a state and a fiscal axis on separate lines.
  // A cell spanning multiple data rows does not license borrowing those axes.
  if (reporting.length > 1 && numericRows.length !== 1)
    return reporting.filter((run) => sameLine(run[0], value)).flat();
  return axes.flat();
}
