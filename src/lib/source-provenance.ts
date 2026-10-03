import type { ExtractedPage } from '@/types/summaryMetadata';
import type { VerifiedFact } from './fact-contract';
import { normalized } from './document-structure';
import { proseQuantities } from './quantity';
import { tableForValue } from './table-layout';
import { record, exact } from './fact-contract';

export interface SourceProvenance {
  tableId: string | null;
  assertion: { id: string; blockId: string; start: number; end: number } | null;
  quantityRange: { id: string; start: number; end: number } | null;
  denominator: {
    value: 1;
    unit: '株';
    proof: 'explicit' | 'metricConvention';
    sourceIds: string[];
  } | null;
  adjustments: Array<{
    kind: 'stockSplit';
    noteId: string;
    text: string;
    basis: 'splitAdjusted' | 'beforeSplit' | 'afterSplit';
  }>;
}
export const assertionId = (blockId: string) => `${blockId}:a1`;
export function checkProvenance(value: unknown): asserts value is SourceProvenance {
  const range = (v: unknown, keys: string[]) =>
    record(v) &&
    exact(v, keys) &&
    typeof v.id === 'string' &&
    Number.isInteger(v.start) &&
    Number.isInteger(v.end) &&
    Number(v.start) >= 0 &&
    Number(v.end) > Number(v.start);
  if (
    !record(value) ||
    !exact(value, ['tableId', 'assertion', 'quantityRange', 'denominator', 'adjustments']) ||
    !(value.tableId === null || typeof value.tableId === 'string') ||
    !(
      value.assertion === null ||
      (range(value.assertion, ['id', 'blockId', 'start', 'end']) &&
        typeof (value.assertion as Record<string, unknown>).blockId === 'string')
    ) ||
    !(value.quantityRange === null || range(value.quantityRange, ['id', 'start', 'end'])) ||
    !(
      value.denominator === null ||
      (record(value.denominator) &&
        exact(value.denominator, ['value', 'unit', 'proof', 'sourceIds']) &&
        value.denominator.value === 1 &&
        value.denominator.unit === '株' &&
        ['explicit', 'metricConvention'].includes(String(value.denominator.proof)) &&
        Array.isArray(value.denominator.sourceIds) &&
        value.denominator.sourceIds.length > 0 &&
        value.denominator.sourceIds.every((id) => typeof id === 'string'))
    ) ||
    !Array.isArray(value.adjustments) ||
    !value.adjustments.every(
      (a) =>
        record(a) &&
        exact(a, ['kind', 'noteId', 'text', 'basis']) &&
        a.kind === 'stockSplit' &&
        typeof a.noteId === 'string' &&
        typeof a.text === 'string' &&
        ['splitAdjusted', 'beforeSplit', 'afterSplit'].includes(String(a.basis))
    )
  )
    throw new Error('SCHEMA:原文範囲・分母・調整基準が不正です');
}
export function sourceTableId(page: ExtractedPage, valueId: string): string {
  const table = tableForValue(page, valueId);
  if (table) return table.id;
  const row = page.blocks.find((b) => b.kind === 'row' && b.spanIds.includes(valueId));
  if (!row) throw new Error('STRUCTURE:数量の表・行への所属を確認できません');
  // Inline-unit/continued row tables have their own explicitly verified row profile.
  return `row:${row.id}`;
}
export function splitNotes(page: ExtractedPage, valueId: string) {
  const own = tableForValue(page, valueId);
  if (!own) return [];
  const next = Math.min(
    Infinity,
    ...page.tableRegions.filter((t) => t.top > own.bottom).map((t) => t.top)
  );
  return page.blocks.filter(
    (b) =>
      b.kind === 'paragraph' &&
      b.y > own.bottom &&
      b.y < next &&
      /株式分割/.test(normalized(b.text))
  );
}
export function applicableSplitNotes(
  page: ExtractedPage,
  valueId: string,
  label: string,
  period: string | null
): SourceProvenance['adjustments'] {
  const result: SourceProvenance['adjustments'] = [];
  for (const note of splitNotes(page, valueId)) {
    const text = normalized(note.text),
      metric = normalized(label),
      fy = normalized(period ?? '').match(/20\d{2}年\d{1,2}月期/)?.[0];
    if (
      !(/1株当たり.*純利益/.test(metric) && /1株当たり.*純利益/.test(text)) &&
      !(/配当/.test(metric) && /配当/.test(text))
    )
      continue;
    let basis: SourceProvenance['adjustments'][number]['basis'] | null = null;
    if (
      /純利益/.test(metric) &&
      /1株当たり.*純利益/.test(text) &&
      /仮定|株式分割の影響を考慮/.test(text)
    )
      basis = 'splitAdjusted';
    if (/配当/.test(metric) && fy) {
      const before = text.match(
        /(20\d{2}年\d{1,2}月期)及び(20\d{2}年\d{1,2}月期)第2四半期末については.*?株式分割前/
      );
      if (before && (fy === before[1] || (fy === before[2] && /第2四半期末/.test(metric))))
        basis = 'beforeSplit';
      const after = text.match(/(20\d{2}年\d{1,2}月期)期末については.*?株式分割後/);
      if (after && fy === after[1] && /期末/.test(metric)) basis = 'afterSplit';
    }
    if (basis) result.push({ kind: 'stockSplit', noteId: note.id, text: note.text, basis });
    else if (/純利益|配当/.test(metric))
      throw new Error(`STRUCTURE:株式分割注記の適用基準を確定できません: ${note.id}`);
  }
  return result;
}
/** Computed from original ranges and structural roles; never supplied as free model semantics. */
export function sourceProvenance(
  fact: Pick<VerifiedFact, 'evidence' | 'label' | 'page' | 'period' | 'kind'> & {
    semantics: Pick<VerifiedFact['semantics'], 'metricKind'>;
  },
  pages: ExtractedPage[]
): SourceProvenance {
  const page = pages.find((p) => p.pageNumber === fact.page);
  if (!page) throw new Error('REFERENCE:原文ページがありません');
  const ev = fact.evidence;
  const numeric = fact.kind === 'number' || fact.kind === 'range';
  const block = ev.kind === 'prose' ? page.blocks.find((b) => b.id === ev.blockId) : undefined;
  const quantity =
    ev.kind === 'prose' && numeric && block
      ? proseQuantities(block).find((q) => q.id === ev.quantityId)
      : null;
  if (ev.kind === 'prose' && (!block || ev.assertionId !== assertionId(block.id)))
    throw new Error('REFERENCE:主張範囲の参照が不正です');
  if (ev.kind === 'prose' && numeric && !quantity)
    throw new Error('QUANTITY:主張範囲の数量がありません');
  if (ev.kind === 'prose' && !numeric && ev.quantityId !== null)
    throw new Error('QUANTITY:出来事へ数量範囲を指定できません');
  const perShare = fact.semantics.metricKind === 'perShare';
  const explicit =
    perShare &&
    /1株当たり/.test(normalized(ev.kind === 'table' ? fact.label : (block?.text ?? '')));
  return {
    tableId: ev.kind === 'table' ? sourceTableId(page, ev.valueId) : null,
    assertion: block
      ? {
          id: assertionId(block.id),
          blockId: block.id,
          start: 0,
          end: block.text.normalize('NFKC').length,
        }
      : null,
    quantityRange: quantity
      ? { id: quantity.id, start: quantity.start, end: quantity.start + quantity.raw.length }
      : null,
    denominator: perShare
      ? {
          value: 1,
          unit: '株',
          proof: explicit ? 'explicit' : 'metricConvention',
          sourceIds: ev.kind === 'table' ? ev.metricIds : [ev.blockId],
        }
      : null,
    adjustments:
      ev.kind === 'table' && perShare
        ? applicableSplitNotes(page, ev.valueId, fact.label, fact.period)
        : [],
  };
}
