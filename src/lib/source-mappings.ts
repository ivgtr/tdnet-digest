import type { ExtractedPage } from '@/types/summaryMetadata';
import { normalized, tableReferenceHints } from './document-structure';
import { tableContinuations, continuationSpans } from './document-links';
import { declaredQuantityUnit, parseExactQuantity } from './quantity';
export type TableMapping = ReturnType<typeof tableReferenceHints>[number];
function inlineMappings(page: ExtractedPage): TableMapping[] {
  const result: TableMapping[] = [];
  for (const row of page.blocks.filter((b) => b.kind === 'row')) {
    const cells = page.quantities.filter((q) => row.spanIds.includes(q.id));
    const units = cells
      .flatMap((q) => {
        const inline = parseExactQuantity(q.text)?.unit;
        if (inline && declaredQuantityUnit(inline)) return [{ q, unit: inline, unitIds: [q.id] }];
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
    const fiscal = page.spans.filter(
      (s) =>
        s.y < row.y &&
        row.y - s.y < row.height * 32 &&
        /20\d{2}年\d{1,2}月期/.test(normalized(s.text))
    );
    if (!fiscal.length) continue;
    const top = Math.max(...fiscal.map((s) => s.y));
    const axes = fiscal.filter((s) => top - s.y <= s.height * 1.2).sort((a, b) => a.x - b.x);
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
      if (!caption) continue;
      for (const [i, c] of amounts.entries())
        result.push({
          valueId: c.q.id,
          metricIds: [metrics[0].id],
          periodIds: left.map((s) => s.id),
          unitIds: c.unitIds,
          contextIds: [...caption.spanIds, axes[i].id],
        });
    } else {
      if (units.length !== axes.length || !left.length) continue;
      const caption = page.blocks
        .filter((b) => b.y < top && /経営成績|財政状態|業績予想/.test(normalized(b.text)))
        .sort((a, b) => b.y - a.y)[0];
      const context =
        caption?.spanIds ??
        page.spans
          .filter((s) => s.y < top && /経営成績|財政状態/.test(normalized(s.text)))
          .map((s) => s.id);
      if (!context.length) continue;
      for (const [i, c] of units.entries())
        result.push({
          valueId: c.q.id,
          metricIds: left.map((s) => s.id),
          periodIds: [axes[i].id],
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
  for (const link of tableContinuations(pages)) {
    const page = pages.find((p) => p.pageNumber === link.toPage)!;
    const ids = page.quantities
      .filter((q) =>
        page.blocks.some((b) => link.rowIds.includes(b.id) && b.spanIds.includes(q.id))
      )
      .map((q) => q.id);
    if (!ids.length) continue;
    const projected = { ...page, spans: continuationSpans(pages, page, ids[0]) };
    for (const mapping of [...tableReferenceHints(projected), ...inlineMappings(projected)].filter(
      (h) => ids.includes(h.valueId)
    ))
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
