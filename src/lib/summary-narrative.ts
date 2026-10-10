import type { ExtractedPage } from '@/types/summaryMetadata';
import type { FactSummary } from './fact-contract';
import {
  parseExactNumeric,
  proseQuantities,
  declaredQuantityUnit,
  isUncaptionedUnit,
  isUnitToken,
} from './quantity';
import type { SourceExcerpt } from './summary-source-inventory';
import { headingLevel, physicalCellOwners, canJoinWithinCells } from './document-structure';
import { physicalRows, tableUnitRuns, buildTableCells } from './table-layout';

/** Literal quantities for presentation. They are not semantic facts used for scoring. */
export interface NarrativeValue {
  id: string;
  raw: string;
  decimal: string | null;
  unit: string | null;
  sourceIds: string[];
  /** Required for a fact-backed value; points directly to its original literal. */
  sourceQuantityId?: string;
}
export interface NarrativeLine {
  id: string;
  text: string;
  sourceIds: string[];
}
const compact = (s: string) => s.normalize('NFKC').replace(/\s/g, '');
/** Compound amounts remain whole literal expressions, never a partial scalar. */
export function parseNarrativeQuantity(raw: string) {
  const simple = parseExactNumeric(raw);
  if (simple) return simple;
  const text = compact(raw);
  const match = text.match(/^[△▲−-]?((?:\d[\d,]*(?:兆|億|千万|百万|十万|万|千|百|十))+\d*)円$/);
  if (!match) return null;
  const scales: Record<string, number> = {
    兆: 12,
    億: 8,
    千万: 7,
    百万: 6,
    十万: 5,
    万: 4,
    千: 3,
    百: 2,
    十: 1,
  };
  const parts = [...match[1].matchAll(/(\d[\d,]*)(兆|億|千万|百万|十万|万|千|百|十)/g)];
  if (parts.length < 2 || parts.some((p, i) => i > 0 && scales[p[2]] >= scales[parts[i - 1][2]]))
    return null;
  return { kind: 'compound' as const, raw, unit: '円' };
}
function displayQuantities(block: { id: string; text: string }) {
  const source = block.text.normalize('NFKC');
  const original = proseQuantities(block);
  const added = [
    // Whitespace may separate complete scale groups, never digits within a group.
    ...source.matchAll(/[△▲−-]?(?:\d[\d,]*(?:兆|億|千万|百万|十万|万|千|百|十)[^\S\n]*){2,}\d*円/g),
    ...source.matchAll(
      /\d[\d,]*(?:万)?(?:つ|区分|領域|項目|部門|分野|点|拠点|機関|世帯|カ国|割|テーマ)/g
    ),
    // A line break may split the unit glyphs, but never concatenate digits.
    ...[
      ...source.matchAll(/[△▲−-]?\d[\d,]*(?:\.\d+)?\s*(?:(?:十|百|千|万|百万|千万|億|兆)\s*)?円/g),
    ].filter((m) => /\s/.test(m[0])),
  ].filter((m) => parseNarrativeQuantity(m[0]));
  return [
    ...original.filter(
      (q) =>
        !added.some((m) => q.start < m.index! + m[0].length && q.start + q.raw.length > m.index!)
    ),
    ...added.map((m, i) => ({
      // Rendering may accept whitespace within a complete unit that the source
      // parser already owns. Preserve that exact interval's original identity.
      id:
        original.find((q) => q.start === m.index && q.raw === m[0])?.id ??
        `${block.id}:q${original.length + i + 1}`,
      raw: m[0],
      start: m.index!,
    })),
  ];
}
const scalar = (raw: string) => {
  const q = parseNarrativeQuantity(raw);
  return q ? { decimal: q.kind === 'number' ? q.decimal : null, unit: q.unit } : null;
};
const decimalIdentity = (s: string) =>
  s
    .replace(/^(-?)0+(?=\d)/, '$1')
    .replace(/(\.\d*?)0+$/, '$1')
    .replace(/\.$/, '')
    .replace(/^-0$/, '0');

// Display evidence includes chart captions and column headings as well as
// formal table captions. Only explicit, known units can type a literal cell.
function displayUnitCaption(raw: string): string | null {
  const text = compact(raw);
  const wrapped = text.match(/^(?:金額|数量)?\(([^()]+)\)$/);
  const unit = wrapped
    ? declaredQuantityUnit(wrapped[1])
    : /^\(?単位/.test(text)
      ? declaredQuantityUnit(text)
      : null;
  return unit && isUncaptionedUnit(unit) ? unit : null;
}

/** Keep a split literal's complete unit, never a valid-looking prefix of it. */
function completePhysicalQuantity(
  native: ExtractedPage['quantities'][number],
  spans: ExtractedPage['spans'],
  owners: ReturnType<typeof physicalCellOwners>
) {
  const parsed = scalar(native.text);
  if (!parsed) return null;
  const ids = [...native.spanIds];
  let text = native.text,
    unit = parsed.unit,
    last = spans.find((s) => s.id === ids[ids.length - 1])!;
  while (last) {
    const next = spans
      .filter(
        (s) =>
          !ids.includes(s.id) &&
          Math.abs(s.y - last.y) <= Math.min(s.height, last.height) * 0.25 &&
          s.x - last.x - last.width >= -0.5
      )
      .sort((a, b) => a.x - b.x)[0];
    if (!next || next.x - last.x - last.width > Math.min(next.height, last.height) * 0.6) break;
    if (!canJoinWithinCells(owners, last.id, next.id)) break;
    const continued = (unit ?? '') + compact(next.text);
    if (!isUnitToken(continued)) {
      if (unit !== null && isUncaptionedUnit(compact(next.text))) return null;
      break;
    }
    unit = continued;
    text += next.text;
    ids.push(next.id);
    last = next;
  }
  if (unit !== null && !isUncaptionedUnit(unit)) return null;
  return {
    ...native,
    text,
    spanIds: ids,
    width: Math.max(native.x + native.width, last.x + last.width) - native.x,
  };
}

/** A labelled row unit overrides a column caption only inside one proved table.
 * This is source syntax, not a metric-name list: e.g. 増減率（％） or 数量（台）.
 * A nearby caption in another row/table cannot lend its unit to these cells. */
export function explicitTableRowUnit(
  page: ExtractedPage,
  quantityId: string
): { unit: string; spanIds: string[] } | null {
  const quantity = page.quantities.find((q) => q.id === quantityId);
  const tables = page.tableRegions.filter((table) => table.valueIds.includes(quantityId));
  if (!quantity || tables.length !== 1) return null;
  const table = tables[0];
  const row = page.spans.filter(
    (span) =>
      table.spanIds.includes(span.id) &&
      Math.abs(span.y - quantity.y) <= Math.min(span.height, quantity.height) * 0.25
  );
  const cells = page.quantities.filter(
    (q) =>
      table.valueIds.includes(q.id) &&
      Math.abs(q.y - quantity.y) <= Math.min(q.height, quantity.height) * 0.25
  );
  if (!cells.length) return null;
  const firstX = Math.min(...cells.map((q) => q.x));
  const labels = row.filter((span) => span.x + span.width <= firstX);
  // Do not cross two separately labelled groups on one physical line.
  if (row.some((span) => span.x >= firstX && !cells.some((q) => q.spanIds.includes(span.id))))
    return null;
  const text = compact(labels.map((span) => span.text).join(''));
  const match = text.match(/^[^()。！？]+\(([^()]+)\)$/);
  const unit = match ? declaredQuantityUnit(match[1]) : null;
  return unit && isUncaptionedUnit(unit) ? { unit, spanIds: labels.map((span) => span.id) } : null;
}

export function narrativeValues(
  facts: FactSummary,
  pages: ExtractedPage[],
  excerpts: SourceExcerpt[]
): NarrativeValue[] {
  const values = new Map<string, NarrativeValue>();
  const physicalQuantitySpans = new Map<string, string[]>();
  const sourceAliases = new Map<string, string>();
  for (const page of pages.filter((p) => p.selection === 'selected')) {
    const owners = physicalCellOwners(
      buildTableCells(page.drawingLines, page.spans, page.pageNumber)
    );
    const consumed = new Set<string>();
    for (const native of page.quantities) {
      if (consumed.has(native.id)) continue;
      const q = completePhysicalQuantity(native, page.spans, owners);
      if (!q) continue;
      for (const id of q.spanIds.slice(1)) consumed.add(id);
      const sources = excerpts.filter(
        (e) => e.page === page.pageNumber && q.spanIds.some((id) => e.spanIds.includes(id))
      );
      // Administrative blocks are deliberately absent from the source inventory.
      // A nearby unit caption cannot provide ownership for their quantities.
      if (!sources.length) continue;
      const parsed = scalar(q.text);
      if (!parsed) continue;
      // Block classification is a reading aid, not evidence of numeric ownership.
      // A multi-line table or a chart label may be classified as a paragraph.
      // Exclude numeric fragments embedded in a prose expression using actual
      // neighboring glyphs; never expose the scalar pieces of 億＋百万円.
      const neighbors = page.spans.filter(
        (s) =>
          !q.spanIds.includes(s.id) && Math.abs(s.y - q.y) <= Math.min(s.height, q.height) * 0.25
      );
      if (
        neighbors.some((s) => {
          const left = q.x - s.x - s.width;
          const right = s.x - q.x - q.width;
          const edgeId =
            left >= -0.5 && left <= q.height * 0.6
              ? q.spanIds[0]
              : right >= -0.5 && right <= q.height * 0.6
                ? q.spanIds[q.spanIds.length - 1]
                : null;
          // Only two uniquely owned, distinct cells prove independence.
          // Unowned or ambiguous neighbors can still be prose continuations.
          return (
            edgeId !== null &&
            (canJoinWithinCells(owners, edgeId, s.id) ||
              !owners.get(edgeId) ||
              !owners.get(s.id)) &&
            !isUncaptionedUnit(compact(s.text))
          );
        })
      )
        continue;
      const adjacent = page.spans
        .filter(
          (s) =>
            Math.abs(s.y - q.y) <= Math.min(s.height, q.height) * 0.25 &&
            s.x >= q.x + q.width &&
            s.x - q.x - q.width <= q.height * 0.6
        )
        .sort((a, b) => a.x - b.x)[0];
      const adjacentUnit =
        adjacent &&
        canJoinWithinCells(owners, q.spanIds[q.spanIds.length - 1], adjacent.id) &&
        isUncaptionedUnit(adjacent.text.normalize('NFKC').replace(/\s/g, ''))
          ? declaredQuantityUnit(adjacent.text)
          : null;
      // A unit row can be legible even when metric/period ownership is unresolved.
      // Match the complete numeric row to all unit columns, not a nearest token.
      const owner = page.blocks.find((b) => b.spanIds.includes(q.id));
      const cells = page.quantities
        .filter((v) => Math.abs(v.y - q.y) <= Math.min(v.height, q.height) * 0.25 && scalar(v.text))
        .sort((a, b) => a.x - b.x);
      const unitRows = physicalRows(page.spans.filter((s) => s.y < q.y))
        .map((row) => tableUnitRuns(row))
        .filter((runs) => runs.length >= 2)
        .sort((a, b) => b[0][0].y - a[0][0].y);
      const unitRow = unitRows[0];
      const dataCells = unitRow
        ? cells.filter((cell) => cell.x + cell.width >= unitRow[0][0].x - cell.height * 3)
        : [];
      const matchedColumns = unitRow
        ? dataCells.map((cell) =>
            unitRow.flatMap((run, i) => {
              const right = Math.max(...run.map((s) => s.x + s.width));
              return Math.abs(cell.x + cell.width - right) <= cell.height * 0.6 ? [i] : [];
            })
          )
        : [];
      const columnIndex = dataCells.findIndex((cell) => cell.id === q.id);
      const columnContext =
        owner &&
        unitRow &&
        columnIndex >= 0 &&
        matchedColumns.every((indices) => indices.length === 1) &&
        new Set(matchedColumns.flat()).size === dataCells.length &&
        !page.blocks.some(
          (b) =>
            b.y > unitRow[0][0].y &&
            b.y <= q.y &&
            (headingLevel(b) !== null || (b.kind !== 'row' && /[。！？]/.test(b.text)))
        ) &&
        dataCells.length > 0
          ? unitRow[matchedColumns[columnIndex][0]]
          : null;
      const columnUnit = columnContext
        ? declaredQuantityUnit(columnContext.map((s) => s.text).join(''))
        : null;
      const tables = page.tableRegions.filter((t) => t.valueIds.includes(q.id));
      const preceding = page.blocks.filter((b) => b.y <= q.y).sort((a, b) => a.y - b.y);
      const captionSpan = [...page.spans]
        .filter((s) => s.y <= q.y && displayUnitCaption(s.text))
        .sort((a, b) => b.y - a.y)[0];
      const captionBlock = captionSpan
        ? preceding.find((b) => b.spanIds.includes(captionSpan.id))
        : undefined;
      const captionRun = captionBlock ? preceding.filter((b) => b.y >= captionBlock.y) : [];
      const openCaption =
        captionBlock &&
        !captionRun.some(
          (b) =>
            b.id !== captionBlock.id &&
            (headingLevel(b) !== null || (b.kind !== 'row' && /[。！？]/.test(b.text)))
        );
      const captions =
        tables.length === 1
          ? page.spans
              .filter((s) => s.y <= q.y && tables[0].spanIds.includes(s.id))
              .flatMap((s) => {
                const unit = displayUnitCaption(s.text);
                return unit ? [{ unit, id: s.id }] : [];
              })
          : openCaption
            ? [{ unit: displayUnitCaption(captionSpan!.text)!, id: captionSpan!.id }]
            : [];
      const common = [...new Set(captions.map((c) => c.unit))];
      // A common caption cannot override column-specific units in a mixed table.
      const columnUnits =
        tables.length === 1
          ? page.spans
              .filter((s) => s.y <= q.y && tables[0].spanIds.includes(s.id))
              .map((s) => declaredQuantityUnit(s.text))
              .filter((u) => u !== null && isUncaptionedUnit(u))
          : openCaption
            ? page.spans
                .filter((s) => captionRun.some((b) => b.spanIds.includes(s.id)))
                .map((s) => declaredQuantityUnit(s.text))
                .filter((u) => u !== null && isUncaptionedUnit(u))
            : [];
      const commonUnit =
        common.length === 1 && columnUnits.every((u) => u === common[0]) ? common[0] : null;
      const rowUnit = explicitTableRowUnit(page, q.id);
      const unitSources =
        parsed.unit === null &&
        (adjacentUnit !== null || rowUnit !== null || columnUnit !== null || commonUnit !== null)
          ? excerpts.filter((e) =>
              adjacentUnit !== null
                ? e.spanIds.includes(adjacent!.id)
                : rowUnit !== null
                  ? rowUnit.spanIds.some((id) => e.spanIds.includes(id))
                  : columnUnit !== null
                    ? columnContext!.some((s) => e.spanIds.includes(s.id))
                    : captions.some((c) => e.spanIds.includes(c.id))
            )
          : [];
      values.set(q.id, {
        id: q.id,
        raw: q.text,
        decimal: parsed.decimal,
        unit: parsed.unit ?? adjacentUnit ?? rowUnit?.unit ?? columnUnit ?? commonUnit,
        sourceIds: [...new Set([...sources, ...unitSources].map((e) => e.id))],
      });
      // A neighboring unit is part of this literal's physical extent only when
      // the same-row/gap checks above selected it. Captions never extend a cell.
      physicalQuantitySpans.set(q.id, [
        ...q.spanIds,
        ...(parsed.unit === null && adjacentUnit !== null ? [adjacent!.id] : []),
      ]);
    }
    for (const e of excerpts.filter((e) => e.page === page.pageNumber && e.kind !== 'heading')) {
      // A physical quantity can also be read as prose, regardless of the block's
      // reading classification. Require its complete glyph interval, not its value.
      const spans = e.spanIds.map((id) => page.spans.find((span) => span.id === id)!);
      let offset = 0;
      const blockText = compact(e.text);
      let mappedBlock = true;
      const intervals = new Map(
        spans.map((span) => {
          const raw = compact(span.text);
          // The block's structural cell separator consumes text offset but is
          // not an original glyph. Match every original span in order as well.
          while (!blockText.startsWith(raw, offset) && blockText[offset] === '│') offset++;
          const start = offset;
          mappedBlock &&= blockText.startsWith(raw, offset);
          offset += raw.length;
          return [span.id, { start, end: offset }] as const;
        })
      );
      mappedBlock &&= offset === blockText.length;
      for (const q of displayQuantities({ id: e.blockId, text: e.text })) {
        const start = compact(e.text.normalize('NFKC').slice(0, q.start)).length;
        const end = start + compact(q.raw).length;
        const matching = mappedBlock
          ? page.quantities.filter((native) => {
              const ids = physicalQuantitySpans.get(native.id);
              return (
                ids &&
                intervals.get(ids[0])?.start === start &&
                intervals.get(ids[ids.length - 1])?.end === end &&
                compact(
                  ids.map((id) => page.spans.find((span) => span.id === id)!.text).join('')
                ) === compact(q.raw)
              );
            })
          : [];
        if (matching.length === 1) {
          sourceAliases.set(q.id, matching[0].id);
          continue;
        }
        const parsed = scalar(q.raw);
        const text = e.text.normalize('NFKC');
        const before = text.slice(0, q.start);
        const after = text.slice(q.start + q.raw.length);
        if (!parsed || /(?:億|兆|万)\s*$/.test(before) || /^\s*\d.*?(?:億|兆|万円)/.test(after))
          continue;
        values.set(q.id, { id: q.id, raw: q.raw, ...parsed, sourceIds: [e.id] });
      }
    }
  }
  for (const fact of facts.facts) {
    if (!fact.quantity) continue;
    const anchor = fact.evidence.kind === 'table' ? fact.evidence.valueId : fact.evidence.blockId;
    const evidenceIds = Object.values(fact.evidence).flatMap((v) => (Array.isArray(v) ? v : []));
    const sources = excerpts.filter(
      (e) =>
        e.blockId === anchor || e.spanIds.some((id) => id === anchor || evidenceIds.includes(id))
    );
    if (!sources.length) throw new Error('NARRATIVE_SOURCE:確定数量の原文がありません');
    if (fact.evidence.kind === 'table' && values.has(fact.evidence.valueId)) {
      const physical = values.get(fact.evidence.valueId)!;
      physical.unit = fact.unit;
      physical.sourceIds = [...new Set([...physical.sourceIds, ...sources.map((e) => e.id)])];
    }
    values.set(fact.id, {
      id: fact.id,
      raw: fact.quantity.raw + fact.unit,
      decimal: fact.quantity.decimal,
      unit: fact.unit,
      sourceIds: sources.map((e) => e.id),
      sourceQuantityId:
        fact.evidence.kind === 'table'
          ? fact.evidence.valueId
          : (sourceAliases.get(fact.evidence.quantityId!) ?? fact.evidence.quantityId!),
    });
  }
  return [...values.values()];
}

export const NARRATIVE_TOKEN = /\{\{(value|change|delta):([^{}]+)\}\}/g;

/** A confirmed fact is an alias of its explicit source quantity, never of an equal amount. */
export function sourceQuantityId(id: string, facts: FactSummary, values: NarrativeValue[]): string {
  const original = values.find((value) => value.id === id)?.sourceQuantityId;
  if (original) return original;
  const fact = facts.facts.find((f) => f.id === id);
  return fact?.evidence.kind === 'table'
    ? fact.evidence.valueId
    : fact?.evidence.kind === 'prose'
      ? (fact.evidence.quantityId ?? id)
      : id;
}

const NARRATIVE_LABEL =
  /1株当たり|20\d{2}年(?:\d{1,2}月(?:\d{1,2}日|期(?:第[1-4]四半期|中間期)?)?)?|過去\d+(?:ヶ|ヵ|か|カ)?月|\d{1,2}月(?:\d{1,2}日)?|(?:午前|午後)?\d{1,2}時(?:\d{1,2}分)?|\d{1,2}:\d{2}|第\d+条(?:第\d+項)?|第[1-4]四半期|第\d+(?:期|回)|IFRS(?:第)?\d+号|\d+(?:丁目|番地?|号|以外)|\b(?:[A-Za-z][A-Za-z0-9-]*|\d+[A-Za-z][A-Za-z0-9-]*)\b/g;
// Editorial grouping/duration is a proposed semantic statement, not a verified
// business quantity. Never turn these into scoring facts or fill a missing KPI.
const NARRATIVE_EDITORIAL_COUNT = /\d+(?:つ|区分|領域|項目|分野|テーマ|(?:ヶ|ヵ|か|カ)月)/g;
// URL path/query digits identify a resource, not a financial quantity. The
// complete URI must still match a cited source; prefixes are not sufficient.
const NARRATIVE_URL = /https?:\/\/[A-Za-z0-9._~:/?#[\]@!$&'*+,;=%-]+/g;
function nativeLiteralValues(raw: string, values: NarrativeValue[]) {
  const parsed = scalar(raw);
  if (!parsed?.unit) return [];
  return values.filter(
    (v) =>
      v.unit === parsed.unit &&
      (parsed.decimal !== null
        ? v.decimal !== null && decimalIdentity(v.decimal) === decimalIdentity(parsed.decimal)
        : compact(v.raw) === compact(raw))
  );
}
const quantityExcerpts = (value: NarrativeValue, excerpts: SourceExcerpt[]) =>
  excerpts.filter((e) => e.spanIds.includes(value.id) || value.id.startsWith(`${e.blockId}:q`));
/** Compiles exact, cited, complete source quantities.
 * No missing value, unit, date, or meaning is supplied by the compiler. */
export function bindLiteralQuantities(
  input: string,
  ids: string[],
  values: NarrativeValue[],
  excerpts: SourceExcerpt[]
): string {
  const text = input
    .normalize('NFKC')
    .replace(NARRATIVE_TOKEN, (token, kind: string, args: string) => {
      if (kind === 'value') return token;
      const parts = args.split('|');
      if (parts.length !== (kind === 'change' ? 3 : 2))
        throw new Error('NARRATIVE_QUANTITY:比較には単位付きの当期値と比較値を指定してください');
      const boundIds = parts.slice(0, 2).map((raw) => {
        if (values.some((value) => value.id === raw)) return raw;
        const bound = bindLiteralQuantities(raw, ids, values, excerpts);
        const match = bound.match(/^\{\{value:([^{}]+)\}\}$/);
        if (!match)
          throw new Error(`NARRATIVE_QUANTITY:比較値は原文と同じ完全な数量が必要です ${raw}`);
        return match[1];
      });
      return `{{${kind}:${[...boundIds, ...parts.slice(2)].join('|')}}}`;
    });
  const protectedRanges = [
    ...text.matchAll(NARRATIVE_TOKEN),
    ...text.matchAll(NARRATIVE_LABEL),
    ...text.matchAll(NARRATIVE_URL),
  ]
    .filter((m) => {
      const unit = m[0].match(/^\d+([A-Za-z][A-Za-z0-9/-]*)$/)?.[1];
      // A metric immediately followed by a fractional quantity is not a new
      // product name (e.g. ROE12.5%). Leave that complete number for binding.
      const fractionalSuffix =
        /[A-Za-z]\d+$/.test(m[0]) && /^\.\d/.test(text.slice(m.index! + m[0].length));
      return (!unit || !isUncaptionedUnit(unit)) && !fractionalSuffix;
    })
    .map((m) => [m.index!, m.index! + m[0].length]);
  const quantities = displayQuantities({ id: 'draft', text });
  let result = text;
  const errors: string[] = [];
  for (const quantity of [...quantities].sort((a, b) => b.start - a.start)) {
    const start = quantity.start;
    const end = start + quantity.raw.length;
    if (protectedRanges.some(([a, b]) => start < b && end > a)) continue;
    const parsed = scalar(quantity.raw);
    if (!parsed?.unit) continue; // Bare digits remain invalid in the stored contract.
    const native = nativeLiteralValues(quantity.raw, values);
    const matching = native.filter((v) =>
      quantityExcerpts(v, excerpts).some((e) => ids.includes(e.id))
    );
    if (!matching.length) {
      // Only a closed set of editorial counts can remain proposed prose. Money,
      // rates, shares, customers, orders and other business KPIs still require
      // exact native quantity evidence. Semantic review must justify the count.
      if (new RegExp(`^(?:${NARRATIVE_EDITORIAL_COUNT.source})$`).test(quantity.raw)) continue;
      const candidates = native.flatMap((v) => quantityExcerpts(v, excerpts).map((e) => e.id));
      errors.push(
        `NARRATIVE_QUANTITY:「${quantity.raw}」に値・単位が一致する数量が引用原文にありません。対象文=${text}。原文候補=${[...new Set(candidates)].slice(0, 12).join(',')}。意味と対象が一致する原文だけを参照し、未知の値や単位は補わないでください`
      );
      continue;
    }
    // Identical quantities may be printed in both a table and prose. Choose a
    // stable display identity for the exact same value/unit; retain every cited
    // source. Which period/subject it describes remains a semantic review task.
    const representative = matching.sort((a, b) => a.id.localeCompare(b.id))[0];
    result = result.slice(0, start) + `{{value:${representative.id}}}` + result.slice(end);
  }
  if (errors.length) throw new Error(errors.join('\n'));
  return result;
}
/** Model-selected quantity anchors are authoritative; code attaches their native unit/context proof. */
export function quantitySourceClosure(
  text: string,
  sourceIds: string[],
  values: NarrativeValue[],
  excerpts: SourceExcerpt[],
  facts: FactSummary
): string[] {
  const closure = new Set(sourceIds);
  for (const match of text.matchAll(NARRATIVE_TOKEN)) {
    const selected = match[1] === 'value' ? [match[2]] : match[2].split('|').slice(0, 2);
    for (const id of selected) {
      const value = values.find((v) => v.id === id);
      if (!value) throw new Error('NARRATIVE_REFERENCE:存在しない数量IDです');
      const fact = facts.facts.find((f) => f.id === id);
      const anchor =
        fact?.evidence.kind === 'table' ? fact.evidence.valueId : fact?.evidence.blockId;
      const owners = excerpts.filter(
        (e) =>
          e.spanIds.includes(anchor ?? id) ||
          e.blockId === anchor ||
          id.startsWith(`${e.blockId}:q`)
      );
      if (!owners.some((e) => sourceIds.includes(e.id)))
        throw new Error('NARRATIVE_REFERENCE:選択数量の原文を明示してください');
      for (const sourceId of value.sourceIds) closure.add(sourceId);
    }
  }
  return [...closure];
}

export function checkText(
  text: unknown,
  sourceIds: string[],
  values: NarrativeValue[],
  excerpts: SourceExcerpt[],
  facts: FactSummary,
  _tableContext = false
): asserts text is string {
  if (typeof text !== 'string' || !text.trim() || text.length > 1200 || /[\r\n]/.test(text))
    throw new Error('NARRATIVE_SCHEMA:説明・セルの形式が不正です');
  const byId = new Map(values.map((v) => [v.id, v]));
  let rest = text.replace(NARRATIVE_TOKEN, (_token, kind: string, args: string, offset: number) => {
    const parts = args.split('|');
    // Prose quantity IDs contain a colon, so a value token consumes its complete ID.
    const selected = kind === 'value' ? [args] : parts.slice(0, 2);
    if (
      kind !== 'value' &&
      (parts.length !== (kind === 'change' ? 3 : 2) ||
        (kind === 'change' && !['profit', 'loss', 'revenue', 'stock', 'flow'].includes(parts[2])))
    )
      throw new Error('NARRATIVE_REFERENCE:比較参照の形式が不正です');
    const quantities = selected.map((id) => byId.get(id));
    if (quantities.some((v) => !v))
      throw new Error(
        `NARRATIVE_REFERENCE:存在しない数量ID=${selected.filter((_, i) => !quantities[i]).join(',')}。対象文=${text}。valuesに列挙された現行IDだけを選んでください。原文IDから数量IDを作らないでください`
      );
    if (quantities.some((v) => !v!.sourceIds.every((id) => sourceIds.includes(id))))
      throw new Error(
        `NARRATIVE_REFERENCE:数量と説明の原文参照が一致しません。参照=${selected.join(',')}。対象文=${text}`
      );
    if (
      kind === 'value' &&
      quantities[0]!.unit &&
      text
        .slice(offset + _token.length)
        .normalize('NFKC')
        .trimStart()
        .startsWith(quantities[0]!.unit!.normalize('NFKC'))
    )
      throw new Error(
        `NARRATIVE_QUANTITY:数量参照は単位も表示します。単位を重複させないでください。対象文=${text}`
      );
    if (
      kind !== 'value' &&
      (sourceQuantityId(selected[0], facts, values) ===
        sourceQuantityId(selected[1], facts, values) ||
        quantities.some((v) => v!.decimal === null) ||
        !quantities[0]!.unit ||
        quantities[0]!.unit !== quantities[1]!.unit)
    )
      throw new Error(
        `NARRATIVE_COMPARISON:単位・数量の比較が未解決です。参照=${selected.map((id, i) => `${id}（${quantities[i]?.unit ?? '単位未確認'}）`).join(' / ')}。未確認の単位で計算せず、別の単位付き原文数量または開示済みの率を参照してください`
      );
    if (
      kind === 'change' &&
      parts[2] === 'loss' &&
      quantities.some((v) => v!.decimal!.startsWith('-'))
    )
      throw new Error('NARRATIVE_COMPARISON:損失額は正の大きさで比較してください');
    return '';
  });
  if (/\{\{|\}\}/.test(rest)) throw new Error('NARRATIVE_REFERENCE:未知の数量参照です');
  // Compare label spelling with the same NFKC form used for the source. This does
  // not turn a literal quantity into an accepted numeric reference.
  rest = rest.normalize('NFKC');
  const nativeUrls = new Set(
    excerpts
      .filter((e) => sourceIds.includes(e.id))
      .flatMap((e) => [...e.text.normalize('NFKC').matchAll(NARRATIVE_URL)].map((m) => m[0]))
  );
  rest = rest.replace(NARRATIVE_URL, (url) => {
    if (!nativeUrls.has(url))
      throw new Error(`NARRATIVE_REFERENCE:URL「${url}」の引用原文がありません`);
    return '';
  });
  // The denominator in this metric name is not a newly stated share count.
  rest = rest.replace(/1株当たり/g, '株当たり');
  // Dates, reporting periods and named classifications are semantic labels.
  // Their source meaning is checked with each caption/row/claim by the independent
  // reviewer. Literal spelling (中間期 vs 第2四半期) cannot establish or reject it.
  // Financial/physical quantities still require a native quantity token.
  rest = rest.replace(NARRATIVE_LABEL, (label) => {
    const leadingNumber = label.match(/^\d+([A-Za-z][A-Za-z0-9/-]*)$/);
    return leadingNumber && isUncaptionedUnit(leadingNumber[1]) ? label : '';
  });
  rest = rest.replace(NARRATIVE_EDITORIAL_COUNT, '');
  if (/\d|[０-９]/.test(rest))
    throw new Error(
      `NARRATIVE_QUANTITY:数量は原文と同じ単位付きで記載してください。原文にない数値や期間の個数は生成できません。対象文=${text}`
    );
  if (
    compact(rest).length > 80 &&
    excerpts.some((e) => sourceIds.includes(e.id) && compact(e.text).includes(compact(rest)))
  )
    throw new Error('NARRATIVE_STYLE:長い原文転載を説明要約として表示できません');
  if (/原文抜粋|会社説明（/.test(text))
    throw new Error('NARRATIVE_STYLE:抜粋を説明要約として表示できません');
}

export function parseNarrativeResponse(raw: string, kind = 'NARRATIVE_REVIEW'): unknown {
  const parsed: unknown = JSON.parse(raw);
  const tokens = raw.match(/"(?:\\.|[^"\\])*"|[{}[\]:,]|[^\s{}[\]:,]+/g)!;
  let at = 0;
  const visit = () => {
    const token = tokens[at++];
    if (token === '{') {
      const keys = new Set<string>();
      while (tokens[at] !== '}') {
        const key: string = JSON.parse(tokens[at++]);
        if (keys.has(key)) throw new Error(`${kind}:重複した判定キーがあります`);
        keys.add(key);
        at++; // colon; JSON syntax has already been checked
        visit();
        if (tokens[at] === ',') at++;
      }
      at++;
    } else if (token === '[') {
      while (tokens[at] !== ']') {
        visit();
        if (tokens[at] === ',') at++;
      }
      at++;
    }
  };
  visit();
  return parsed;
}
