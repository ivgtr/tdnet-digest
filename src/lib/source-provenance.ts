import type { ExtractedPage } from '@/types/summaryMetadata';
import type { VerifiedFact } from './fact-contract';
import { normalized, headingLevel, declaredSubjectsIn } from './document-structure';
import { proseQuantities } from './quantity';
import { tableForValue } from './table-layout';
import { record, exact } from './fact-contract';
import { isPerShareProfit } from './metric-semantics';
import { continuationPage } from './document-links';
import { reportingPeriodText, reportingPeriodShape } from './period-semantics';

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
export function isAdjustments(value: unknown): value is SourceProvenance['adjustments'] {
  return (
    Array.isArray(value) &&
    value.every(
      (a) =>
        record(a) &&
        exact(a, ['kind', 'noteId', 'text', 'basis']) &&
        a.kind === 'stockSplit' &&
        typeof a.noteId === 'string' &&
        typeof a.text === 'string' &&
        ['splitAdjusted', 'beforeSplit', 'afterSplit'].includes(String(a.basis))
    )
  );
}
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
    !isAdjustments(value.adjustments)
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
    ...page.tableRegions.filter((t) => t.top > own.bottom).map((t) => t.top),
    ...page.blocks
      .filter(
        (b) => b.y > own.bottom && (headingLevel(b) !== null || declaredSubjectsIn(b).length > 0)
      )
      .map((b) => b.y)
  );
  return page.blocks.filter(
    (b) =>
      b.kind === 'paragraph' &&
      b.y > own.bottom &&
      b.y < next &&
      /株式分割/.test(normalized(b.text))
  );
}
/** Resolve the EPS name and its reporting-period clause together. */
function epsNames(text: string): string[] {
  return [
    ...normalized(text).matchAll(
      /(基本的|希薄化後|潜在株式調整後)?1株(?:当たり|あたり)(当期|四半期|中間)?純?(利益|損失)|\bEPS\b/gi
    ),
  ].map((m) =>
    m[0].toUpperCase() === 'EPS'
      ? 'EPS'
      : `${/希薄化後|潜在株式調整後/.test(m[1] ?? '') ? 'diluted' : 'basic'}:${m[2] ?? ''}:${m[3]}`
  );
}
function splitPeriodMatches(clause: string, period: string | null): boolean {
  const periods = [
    ...clause.matchAll(/20\d{2}年\d{1,2}月期(?:第[1-4]四半期(?:累計|単独)?|中間期|通期)?/g),
  ].filter((m) => !/^(?:の)?(?:期首|初日|末日)/.test(clause.slice(m.index! + m[0].length)));
  if (!periods.length) return true;
  const target = reportingPeriodText(period ?? '');
  const fy = target.match(/20\d{2}年\d{1,2}月期/)?.[0];
  return periods.some(
    ([p]) =>
      p.match(/20\d{2}年\d{1,2}月期/)?.[0] === fy &&
      (!reportingPeriodShape(p) ||
        reportingPeriodShape(p) === (reportingPeriodShape(target) ?? '通期')) &&
      (!/累計|単独/.test(p) || p.match(/累計|単独/)?.[0] === target.match(/累計|単独/)?.[0])
  );
}
function matchingEpsClauses(text: string, label: string, period: string | null): string[] {
  const names = epsNames(label);
  if (names.length !== 1) return [];
  // A comma starts another clause only when it explicitly restates a fiscal
  // period and EPS subject. A period list sharing one predicate stays intact.
  const clauses = reportingPeriodText(text).split(
    /[。；;]|、(?=20\d{2}年\d{1,2}月期(?:第[1-4]四半期(?:累計|単独)?|中間期|通期)?の?(?:基本的|希薄化後|潜在株式調整後)?1株)/
  );
  return clauses.filter((clause) => {
    if (!epsNames(clause).includes(names[0])) return false;
    if (
      (/配当/.test(clause) || epsNames(clause).length > 1) &&
      new Set(clause.match(/20\d{2}年\d{1,2}月期/g)).size > 1
    )
      throw new Error('STRUCTURE:複数指標の株式分割注記の期間対応を確定できません');
    return splitPeriodMatches(clause, period);
  });
}
/** The same matched clauses own the input qualifier and persisted basis. */
export function splitNoteApplies(text: string, label: string, period: string | null): boolean {
  if (/配当/.test(normalized(label))) return /配当/.test(normalized(text));
  return matchingEpsClauses(text, label, period).length > 0;
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
    if (!splitNoteApplies(text, metric, period)) continue;
    let basis: SourceProvenance['adjustments'][number]['basis'] | null = null;
    if (isPerShareProfit(metric)) {
      const bases = matchingEpsClauses(text, metric, period).map((clause) => {
        const declared: SourceProvenance['adjustments'][number]['basis'][] = [];
        if (/仮定|株式分割の影響を考慮/.test(clause)) declared.push('splitAdjusted');
        if (/(?:株式)?分割前/.test(clause)) declared.push('beforeSplit');
        if (/(?:株式)?分割後/.test(clause)) declared.push('afterSplit');
        return declared;
      });
      if (bases.some((b) => b.length !== 1) || new Set(bases.flat()).size !== 1)
        throw new Error(`STRUCTURE:株式分割注記の適用基準を確定できません: ${note.id}`);
      basis = bases[0][0];
    }
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
    else if (isPerShareProfit(metric) || /配当/.test(metric))
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
    /1株(?:当たり|あたり)/.test(normalized(ev.kind === 'table' ? fact.label : (block?.text ?? '')));
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
        ? applicableSplitNotes(
            continuationPage(pages, page, ev.valueId),
            ev.valueId,
            fact.label,
            fact.period
          )
        : [],
  };
}
