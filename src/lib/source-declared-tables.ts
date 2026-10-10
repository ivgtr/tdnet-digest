import type { ExtractedPage } from '@/types/summaryMetadata';
import type { DocumentContext } from './document-context';
import { isPerformanceReportingTitle, forecastReportingTitle } from './document-structure';
import { parseExactNumeric } from './quantity';
import { sourceTableId } from './source-provenance';
import type { TableMapping } from './source-mappings';

/** Additive selection markers, not obligations or a claim that a cell has been verified.
 * Axis identity is its source spans, never a normalized/known financial metric name.
 */
export function sourceDeclaredTables(pages: ExtractedPage[], context: DocumentContext) {
  const texts = new Map(
    pages.flatMap((p) => [...p.spans, ...p.blocks].map((s) => [s.id, s.text] as const))
  );
  const references = (ids: string[]) => ids.map((id) => ({ id, text: texts.get(id) ?? '' }));
  return pages
    .filter((p) => p.selection === 'selected')
    .flatMap((page) => {
      const groups = new Map(page.tableRegions.map((t) => [t.id, [] as TableMapping[]]));
      for (const mapping of context.tableMappings) {
        if (!page.quantities.some((q) => q.id === mapping.valueId)) continue;
        const id = sourceTableId(page, mapping.valueId);
        if (!groups.has(id)) groups.set(id, []);
        groups.get(id)!.push(mapping);
      }
      return [...groups].map(([tableId, mappings]) => {
        const table = page.tableRegions.find((t) => t.id === tableId);
        const valueIds = table?.valueIds ?? [...new Set(mappings.map((m) => m.valueId))];
        const headingIds = [
          ...new Set([
            ...mappings.flatMap((m) => m.contextIds),
            ...context.bindings
              .filter((b) => valueIds.includes(b.anchorId))
              .flatMap((b) => b.contextIds),
          ]),
        ];
        const headings = references(headingIds);
        const axes = (role: 'metricIds' | 'periodIds' | 'unitIds') => {
          const groups = new Map<
            string,
            { sourceIds: string[]; text: string; valueIds: string[] }
          >();
          for (const mapping of mappings) {
            const ids = mapping[role];
            const key = JSON.stringify(ids);
            if (!groups.has(key))
              groups.set(key, {
                sourceIds: ids,
                text: ids.map((id) => texts.get(id) ?? '').join(''),
                valueIds: [],
              });
            const axis = groups.get(key)!;
            if (!axis.valueIds.includes(mapping.valueId)) axis.valueIds.push(mapping.valueId);
          }
          return [...groups.values()];
        };
        const mapped = new Set(
          mappings.flatMap((m) => [...m.metricIds, ...m.periodIds, ...m.unitIds, ...m.contextIds])
        );
        const quantitySpans = new Set(
          page.quantities
            .filter((q) => valueIds.includes(q.id))
            .flatMap((q) => [q.id, ...q.spanIds])
        );
        return {
          tableId,
          page: page.pageNumber,
          selectionRole: headings.some(
            (h) => isPerformanceReportingTitle(h.text) || forecastReportingTitle(h.text)
          )
            ? 'financialPerformance'
            : 'sourceTable',
          headings,
          metricAxes: axes('metricIds'),
          periodAxes: axes('periodIds'),
          unitAxes: axes('unitIds'),
          // Keep unresolved table text visible without pretending it is a proved heading.
          unresolvedText: references(
            (table?.spanIds ?? []).filter(
              (id) =>
                !mapped.has(id) && !quantitySpans.has(id) && !parseExactNumeric(texts.get(id) ?? '')
            )
          ),
          unmappedValueIds: valueIds.filter((id) => !mappings.some((m) => m.valueId === id)),
        };
      });
    });
}
