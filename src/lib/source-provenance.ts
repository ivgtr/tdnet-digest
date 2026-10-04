import type { ExtractedPage } from '@/types/summaryMetadata';
import type { VerifiedFact } from './fact-contract';
import { normalized, headingLevel, declaredSubjectsIn } from './document-structure';
import { proseQuantities } from './quantity';
import { tableForValue } from './table-layout';
import { record, exact } from './fact-contract';
import { isPerShareProfit, perShareProfitKeys, PER_SHARE_PROFIT_METRIC } from './metric-semantics';
import { continuationPage } from './document-links';
import {
  reportingPeriodText,
  reportingPeriodShape,
  REPORTING_FISCAL_PERIOD_PATTERN,
  REPORTING_STATE_QUALIFIER_PATTERN,
} from './period-semantics';

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
function splitReportingPeriods(clause: string) {
  const periods = [...clause.matchAll(new RegExp(REPORTING_FISCAL_PERIOD_PATTERN, 'g'))];
  if (
    [...clause.matchAll(new RegExp(REPORTING_STATE_QUALIFIER_PATTERN, 'g'))].some(
      (state) =>
        !periods.some(
          (period) =>
            period.index! <= state.index! &&
            period.index! + period[0].length >= state.index! + state[0].length
        )
    )
  )
    throw new Error('STRUCTURE:株式分割注記の状態限定の所属を確定できません');
  return periods.filter((m) => {
    const following = clause.slice(m.index! + m[0].length);
    if (/^(?:の)?(?:\(|第\d+四半期|中間期|通期|累計|単独)/.test(following))
      throw new Error('STRUCTURE:株式分割注記の期間限定を確定できません');
    if (new Set(m[0].match(/予想|実績/g) ?? []).size > 1)
      throw new Error('STRUCTURE:株式分割注記の期間限定が矛盾しています');
    // A split's execution date and a calculation's assumed date do not scope EPS.
    return (
      !/^(?:の)?(?:期首|初日|末日)/.test(following) &&
      !/^に(?:おいて)?[、,]?(?:当社(?:は|の)?)?(?:普通株式)?(?:\d+(?:\.\d+)?株(?:につき|に対して?|を)\d+(?:\.\d+)?株(?:の割合(?:で|をもって)|に|とする))?株式分割を(?:実施|行|予定|決議)/.test(
        following
      )
    );
  });
}
function splitStateMatches(declaration: string, valueKind: VerifiedFact['valueKind']): boolean {
  const state = declaration.match(/\((予想|実績)\)/)?.[1];
  return (
    !state ||
    (state === '実績'
      ? valueKind === 'actual'
      : valueKind === 'forecast' || valueKind === 'forecastBefore' || valueKind === 'forecastAfter')
  );
}
function splitPeriodMatches(
  clause: string,
  period: string | null,
  valueKind: VerifiedFact['valueKind']
): boolean {
  const periods = splitReportingPeriods(clause);
  if (!periods.length) return true;
  const target = reportingPeriodText(period ?? '');
  const fy = target.match(/20\d{2}年\d{1,2}月期/)?.[0];
  return periods.some(
    ([p]) =>
      p.match(/20\d{2}年\d{1,2}月期/)?.[0] === fy &&
      splitStateMatches(p, valueKind) &&
      (!reportingPeriodShape(p) ||
        reportingPeriodShape(p) === (reportingPeriodShape(target) ?? '通期')) &&
      (!/累計|単独|中間期/.test(p) ||
        (/単独/.test(p) ? '単独' : '累計') ===
          (/単独/.test(target) ? '単独' : /累計|中間期/.test(target) ? '累計' : null))
  );
}
function matchingEpsClauses(
  text: string,
  label: string,
  period: string | null,
  valueKind: VerifiedFact['valueKind']
): string[] {
  const names = perShareProfitKeys(label);
  if (names.length !== 1) return [];
  // A comma starts another clause only when it explicitly restates a fiscal
  // period and EPS subject. A period list sharing one predicate stays intact.
  const clauses = reportingPeriodText(text).split(
    new RegExp(`[。；;]|、(?=${REPORTING_FISCAL_PERIOD_PATTERN}の?${PER_SHARE_PROFIT_METRIC})`, 'i')
  );
  return clauses.filter((clause) => {
    if (!perShareProfitKeys(clause).includes(names[0])) return false;
    if (
      !splitReportingPeriods(clause).length &&
      clauses.some(
        (other) =>
          !perShareProfitKeys(other).length &&
          !/配当/.test(other) &&
          splitReportingPeriods(other).length > 0
      )
    )
      throw new Error('STRUCTURE:株式分割注記の共通期間と指標の期間対応を確定できません');
    if (
      (/配当/.test(clause) || perShareProfitKeys(clause).length > 1) &&
      new Set(splitReportingPeriods(clause).map(([p]) => p)).size > 1
    )
      throw new Error('STRUCTURE:複数指標の株式分割注記の期間対応を確定できません');
    return splitPeriodMatches(clause, period, valueKind);
  });
}
/** A fiscal declaration may cover the whole year's dividends or a named component. */
function matchingDividendClauses(
  text: string,
  label: string,
  period: string | null,
  valueKind: VerifiedFact['valueKind']
): string[] {
  if (!/配当/.test(text)) return [];
  const target = reportingPeriodText(period ?? '').match(/20\d{2}年\d{1,2}月期/)?.[0];
  const component = label.match(/第[1-4]四半期末|中間期末|中間|期末|合計|年間$/)?.[0];
  const clauses = reportingPeriodText(text).split(
    new RegExp(
      `[。；;]|、(?=20\\d{2}年\\d{1,2}月期(?:${REPORTING_STATE_QUALIFIER_PATTERN})?の?(?:第[1-4]四半期末|中間期末|中間|期末|年間|配当))`
    )
  );
  return clauses.filter((clause) => {
    // This conditional amount is a separate quantity, not the printed table's basis.
    if (
      /^(?:なお、?)?株式分割を考慮しない場合の/.test(clause) &&
      /配当金は\d+(?:\.\d+)?円/.test(clause)
    )
      return false;
    if (
      !/配当/.test(clause) &&
      (!/(?:株式)?分割前|(?:株式)?分割後|仮定/.test(clause) || isPerShareProfit(clause))
    )
      return false;
    const periods = splitReportingPeriods(clause);
    if (isPerShareProfit(clause) && new Set(periods.map(([p]) => p)).size > 1)
      throw new Error('STRUCTURE:複数指標の株式分割注記の期間対応を確定できません');
    if (!periods.length) {
      if (!/配当/.test(clause)) return false;
      if (
        clauses.some(
          (other) =>
            !/配当/.test(other) && !isPerShareProfit(other) && splitReportingPeriods(other).length
        )
      )
        throw new Error('STRUCTURE:株式分割注記の共通期間と配当の期間対応を確定できません');
      return true;
    }
    return periods.some((match) => {
      const fiscal = match[0].match(/20\d{2}年\d{1,2}月期/)![0];
      const following = clause
        .slice(match.index! + fiscal.length)
        .replace(new RegExp(`^${REPORTING_STATE_QUALIFIER_PATTERN}`), '');
      const stated = following.match(
        /^(?:の)?(第[1-4]四半期末|中間期末|中間|期末|年間(?:配当金)?(?:合計)?)/
      )?.[1];
      return (
        fiscal === target &&
        splitStateMatches(match[0], valueKind) &&
        (!stated ||
          (stated.startsWith('年間') ? /合計|年間$/.test(component ?? '') : stated === component))
      );
    });
  });
}
function splitBasis(
  clauses: string[],
  noteId: string
): SourceProvenance['adjustments'][number]['basis'] {
  const bases = clauses.map((clause) => {
    const declared: SourceProvenance['adjustments'][number]['basis'][] = [];
    if (/仮定|株式分割の影響を考慮/.test(clause)) declared.push('splitAdjusted');
    if (/(?:株式)?分割前/.test(clause)) declared.push('beforeSplit');
    if (/(?:株式)?分割後/.test(clause)) declared.push('afterSplit');
    return declared;
  });
  if (bases.some((b) => b.length !== 1) || new Set(bases.flat()).size !== 1)
    throw new Error(`STRUCTURE:株式分割注記の適用基準を確定できません: ${noteId}`);
  return bases[0][0];
}
/** The same matched clauses own the input qualifier and persisted basis. */
export function splitNoteApplies(
  text: string,
  label: string,
  period: string | null,
  valueKind: VerifiedFact['valueKind']
): boolean {
  if (/配当/.test(normalized(label)))
    return (
      matchingDividendClauses(normalized(text), normalized(label), period, valueKind).length > 0
    );
  return matchingEpsClauses(text, label, period, valueKind).length > 0;
}
export function applicableSplitNotes(
  page: ExtractedPage,
  valueId: string,
  label: string,
  period: string | null,
  valueKind: VerifiedFact['valueKind']
): SourceProvenance['adjustments'] {
  const result: SourceProvenance['adjustments'] = [];
  for (const note of splitNotes(page, valueId)) {
    const text = normalized(note.text),
      metric = normalized(label);
    if (!splitNoteApplies(text, metric, period, valueKind)) continue;
    const clauses = /配当/.test(metric)
      ? matchingDividendClauses(text, metric, period, valueKind)
      : matchingEpsClauses(text, metric, period, valueKind);
    result.push({
      kind: 'stockSplit',
      noteId: note.id,
      text: note.text,
      basis: splitBasis(clauses, note.id),
    });
  }
  return result;
}
/** Computed from original ranges and structural roles; never supplied as free model semantics. */
export function sourceProvenance(
  fact: Pick<VerifiedFact, 'evidence' | 'label' | 'page' | 'period' | 'kind' | 'valueKind'> & {
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
            fact.period,
            fact.valueKind
          )
        : [],
  };
}
