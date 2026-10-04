import type { ExtractedPage } from '@/types/summaryMetadata';
import {
  normalized,
  headingLevel,
  fiscalHeadingRuns,
  tableReferenceHints,
  isPerformanceReportingTitle,
  forecastReportingTitle,
  resolveForecastReportingTitle,
  forecastTablePeriodSources,
} from './document-structure';
import { tableContinuations, continuationPage } from './document-links';
import { tableUnitRuns } from './table-layout';
import {
  declaredQuantityUnit,
  parseExactQuantity,
  parseExactNumeric,
  isUncaptionedUnit,
} from './quantity';
export type TableMapping = ReturnType<typeof tableReferenceHints>[number];
function inlineMappings(page: ExtractedPage): TableMapping[] {
  const result: TableMapping[] = [];
  for (const row of page.blocks.filter((b) => b.kind === 'row' && headingLevel(b) === null)) {
    const cells = page.quantities.filter((q) => row.spanIds.includes(q.id));
    const units = cells
      .flatMap((q) => {
        const inline = parseExactNumeric(q.text)?.unit;
        if (inline && isUncaptionedUnit(inline)) return [{ q, unit: inline, unitIds: [q.id] }];
        const suffix = page.spans.filter(
          (s) =>
            row.spanIds.includes(s.id) &&
            !q.spanIds.includes(s.id) &&
            s.x >= q.x + q.width &&
            s.x - (q.x + q.width) < q.height * 1.2 &&
            declaredQuantityUnit(s.text) !== null
        );
        return suffix.length === 1
          ? [{ q, unit: declaredQuantityUnit(suffix[0].text)!, unitIds: [suffix[0].id] }]
          : [];
      })
      .filter((c) => !/^(年|月|日)$/.test(c.unit))
      .sort((a, b) => a.q.x - b.q.x);
    if (units.length < 2) continue;
    const fiscal = fiscalHeadingRuns(
      page.spans.filter((s) => s.y < row.y && row.y - s.y < row.height * 32)
    );
    if (!fiscal.length) continue;
    const top = Math.max(...fiscal.map((run) => run[0].y));
    const axes = fiscal
      .filter((run) => top - run[0].y <= run[0].height * 1.2)
      .sort((a, b) => a[0].x - b[0].x);
    const left = page.spans.filter(
      (s) => row.spanIds.includes(s.id) && s.x + s.width < units[0].q.x
    );
    const month = /^\d{1,2}月$/.test(normalized(left.map((s) => s.text).join('')));
    if (month) {
      const amounts = units.filter((c) => !/%/.test(c.unit));
      if (amounts.length !== axes.length) continue;
      const firstRow = page.blocks.find((b) => b.kind === 'row' && b.y > top)!;
      const headers = page.spans.filter(
        (s) => s.y > top && s.y < firstRow.y && !/20\d{2}年|当期|前期/.test(normalized(s.text))
      );
      const metrics = headers.filter(
        (s) =>
          !parseExactQuantity(s.text) &&
          !declaredQuantityUnit(s.text)?.match(/^(?:千|百万|億)?円|%$/) &&
          !/比|率/.test(normalized(s.text))
      );
      if (metrics.length !== 1) continue;
      const caption = page.blocks
        .filter((b) => b.y < top && /20\d{2}年\d{1,2}月(?!期)/.test(normalized(b.text)))
        .sort((a, b) => b.y - a.y)[0];
      if (
        !caption ||
        page.blocks.some((b) => b.y > caption.y && b.y <= row.y && headingLevel(b) !== null)
      )
        continue;
      for (const [i, c] of amounts.entries())
        result.push({
          valueId: c.q.id,
          metricIds: [metrics[0].id],
          periodIds: left.map((s) => s.id),
          unitIds: c.unitIds,
          contextIds: [...caption.spanIds, ...axes[i].map((s) => s.id)],
        });
    } else {
      if (units.length !== axes.length || !left.length) continue;
      const caption = page.blocks
        .filter(
          (b) =>
            b.y < top &&
            (isPerformanceReportingTitle(b.text) ||
              forecastReportingTitle(b.text) ||
              /財政状態/.test(normalized(b.text)))
        )
        .sort((a, b) => b.y - a.y)[0];
      const context =
        caption?.spanIds ??
        page.spans
          .filter(
            (s) =>
              s.y < top &&
              (isPerformanceReportingTitle(s.text) || /財政状態/.test(normalized(s.text)))
          )
          .map((s) => s.id);
      if (!context.length) continue;
      const contextY = Math.max(...context.map((id) => page.spans.find((s) => s.id === id)!.y));
      if (page.blocks.some((b) => b.y > contextY && b.y <= row.y && headingLevel(b) !== null))
        continue;
      for (const [i, c] of units.entries())
        result.push({
          valueId: c.q.id,
          metricIds: left.map((s) => s.id),
          periodIds: axes[i].map((s) => s.id),
          unitIds: c.unitIds,
          contextIds: context,
        });
    }
  }
  return result;
}
/** Structural proposals; complete geometry and semantic ownership are still verified on use. */
export function buildTableMappings(pages: ExtractedPage[]): TableMapping[] {
  const mappings = pages.flatMap((p) => [...tableReferenceHints(p), ...inlineMappings(p)]);
  for (const mapping of mappings) {
    const page = pages.find((p) => p.quantities.some((q) => q.id === mapping.valueId))!;
    const caption = page.blocks.find(
      (b) =>
        forecastReportingTitle(b.text) && b.spanIds.every((id) => mapping.contextIds.includes(id))
    );
    const tables = page.tableRegions.filter((t) => t.valueIds.includes(mapping.valueId));
    const table = tables.length === 1 ? tables[0] : undefined;
    const declarations =
      caption && table ? forecastTablePeriodSources(caption, page.blocks, page.spans, table) : [];
    mapping.contextIds = [
      ...new Set([...mapping.contextIds, ...declarations.flatMap((b) => b.spanIds)]),
    ];
    const resolved =
      caption && resolveForecastReportingTitle(caption, page.blocks, page.spans, table);
    if (resolved) mapping.contextIds = [...new Set([...mapping.contextIds, ...resolved.sourceIds])];
  }
  for (const link of tableContinuations(pages)) {
    const page = pages.find((p) => p.pageNumber === link.toPage)!;
    const ids = link.valueIds;
    if (!ids.length) continue;
    const projected = continuationPage(pages, page, ids[0]);
    const inheritedUnits = tableUnitRuns(
      projected.spans.filter((s) => link.unitIds.includes(s.id))
    );
    const continuedRows: TableMapping[] = [];
    if (inheritedUnits.length === link.periodColumns.length) {
      for (const row of page.blocks.filter((b) => link.rowIds.includes(b.id))) {
        const values = page.quantities
          .filter((q) => row.spanIds.includes(q.id) && ids.includes(q.id))
          .sort((a, b) => a.x - b.x);
        if (values.length !== link.periodColumns.length) continue;
        const metricIds = page.spans
          .filter((s) => row.spanIds.includes(s.id) && s.x + s.width < values[0].x)
          .map((s) => s.id);
        if (!metricIds.length) continue;
        for (const [i, q] of values.entries())
          continuedRows.push({
            valueId: q.id,
            metricIds,
            periodIds: link.periodColumns[i],
            unitIds: inheritedUnits[i].map((s) => s.id),
            contextIds: link.contextIds,
          });
      }
    }
    for (const mapping of [
      ...tableReferenceHints(projected),
      ...inlineMappings(projected),
      ...continuedRows,
    ].filter((h) => ids.includes(h.valueId)))
      if (!mappings.some((h) => JSON.stringify(h) === JSON.stringify(mapping)))
        mappings.push({ ...mapping, contextIds: link.contextIds });
  }
  return mappings;
}
export function uniqueTableMapping(mappings: TableMapping[], valueId: string): TableMapping {
  const choices = mappings.filter((h) => h.valueId === valueId);
  if (choices.length !== 1)
    throw new Error(
      `STRUCTURE:表の根拠対応が一意に構成できません: ${valueId} 候補数=${choices.length}`
    );
  return choices[0];
}
