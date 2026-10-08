import type { VerifiedFact } from './fact-contract';
const compact = (text: string) => text.normalize('NFKC').replace(/[\s,，]/g, '');
export const calendarIntervalSeparator = '(?:[～〜~-]|から)';
export const calendarDatePattern = '20\\d{2}年\\d{1,2}月\\d{1,2}日';

/** Explicit fiscal axes in source notes retain balanced shape/state qualifiers. */
export const REPORTING_STATE_QUALIFIER_PATTERN = '\\((?:予想|実績)\\)';
const noteShape = '(?:第[1-4]四半期|中間期|通期)';
const noteQualifier = '(?:累計|単独)(?:期間)?';
const noteShapeQualified = `(?:${noteShape}(?:${noteQualifier}|\\(${noteQualifier}\\))?|\\(${noteShape}(?:${noteQualifier})?\\)(?:${noteQualifier}|\\(${noteQualifier}\\))?)`;
export const REPORTING_PERIOD_SHAPE_PATTERN = noteShapeQualified;
export const REPORTING_FISCAL_PERIOD_PATTERN = `20\\d{2}年\\d{1,2}月期(?:${REPORTING_STATE_QUALIFIER_PATTERN})?(?:の?${noteShapeQualified})?(?:${REPORTING_STATE_QUALIFIER_PATTERN})?`;

/** Supported source aliases share one meaning; generated fact periods remain canonical. */
export function reportingPeriodText(text: string): string {
  return compact(text)
    .replace(/([1-4])Q/gi, '第$1四半期')
    .replace(/中間(?=決算短信)/g, '中間期');
}
export function reportingPeriodShapes(text: string): string[] {
  return [
    ...new Set(
      (reportingPeriodText(text).match(/第[1-4]四半期|中間期|通期/g) ?? []).map((shape) =>
        shape === '中間期' ? '第2四半期' : shape
      )
    ),
  ];
}
export function reportingPeriodShape(text: string): string | null {
  const shapes = reportingPeriodShapes(text);
  if (shapes.length > 1) throw new Error('PERIOD:異なる報告期間の形が混在しています');
  return shapes[0] ?? null;
}
export function reportingPeriodOwner(
  source: string,
  inherited: string,
  tableCaption = false
): string {
  const local = reportingPeriodText(source),
    context = reportingPeriodText(inherited);
  const localShape = reportingPeriodShape(local);
  if (localShape && !tableCaption) return local;
  const fiscal = /20\d{2}年\d{1,2}月期/g;
  const ownYears = [...new Set(local.match(fiscal) ?? [])],
    contextYears = [...new Set(context.match(fiscal) ?? [])];
  // An explicit different fiscal axis cannot lend a quarter. A heading that
  // supplies only the quarter has no fiscal axis conflicting with the value.
  if (
    ownYears.length &&
    (ownYears.length !== 1 ||
      (contextYears.length > 0 && (contextYears.length !== 1 || ownYears[0] !== contextYears[0])))
  )
    return local;
  if (localShape) {
    const inheritedShapes = reportingPeriodShapes(context);
    if (
      inheritedShapes.length > 1 ||
      (inheritedShapes.length === 1 && inheritedShapes[0] !== localShape)
    )
      return local;
    // A compatible table caption can supply the qualifier missing from its row,
    // without lending its date, year, or another quarter.
    const qualifiers = context.match(/累計|単独|中間期/g) ?? [];
    return local + qualifiers.join('');
  }
  return context;
}

export function periodKind(
  period: string | null,
  source: string,
  inherited = '',
  tableCaption = false
): VerifiedFact['semantics']['periodKind'] {
  if (!period) return 'none';
  const text = reportingPeriodText(period),
    context = reportingPeriodText(source);
  if (/^(?:翌|次|当|前)連結会計年度$/.test(text)) return 'relativeYear';
  if (/20\d{2}年\d{1,2}月\d{1,2}日/.test(text))
    return /[～〜~-]|から/.test(text) ? 'interval' : 'eventDate';
  if (/^20\d{2}年\d{1,2}月(?:度)?$/.test(text)) return 'month';
  // The source that supplies the shape must also prove its qualifier. A claim
  // cannot add a qualifier, and an unrelated heading cannot lend one.
  const owner = reportingPeriodOwner(context, inherited, tableCaption);
  const shape = reportingPeriodShape(text) ?? reportingPeriodShape(owner);
  if (shape === '通期') return 'fullYear';
  const q = shape?.match(/第([1-4])四半期/)?.[1];
  if (q) {
    const qualified = owner;
    if (/累計|中間期/.test(qualified) && /単独/.test(qualified))
      throw new Error('PERIOD:累計・単独が混在しています');
    if (/単独/.test(qualified))
      return (['standaloneQ1', 'standaloneQ2', 'standaloneQ3', 'standaloneQ4'] as const)[
        Number(q) - 1
      ];
    if (/累計|中間期/.test(qualified) || q === '1') {
      if (q === '4') throw new Error('PERIOD:未対応の累計第4四半期');
      return (['cumulativeQ1', 'cumulativeQ2', 'cumulativeQ3'] as const)[Number(q) - 1];
    }
    throw new Error('PERIOD:累計・単独を確認できません');
  }
  if (/20\d{2}年\d{1,2}月期|\d{4}年通期/.test(text)) return 'fullYear';
  throw new Error('PERIOD:未対応の期間形式');
}
/** Source axis owns revision state; ordinary forecast captions apply otherwise. */
export function numericValueKind(axis: string, context: string, nearest = '') {
  axis = compact(axis);
  context = compact(context);
  const local = axis + context;
  if (/予定|取得する株式|買付けの委託を行う/.test(local)) return null;
  // Explicit actual rows keep their state even inside a forecast table.
  if (/実績/.test(axis)) return /予想|見込|見通し|修正前|修正後/.test(axis) ? null : 'actual';
  const kindAxis = /前回|従来|修正前|直近の配当予想|今回|修正後|決定額/.test(axis) ? axis : context;
  if (/前回|従来|修正前/.test(kindAxis) && /今回|修正後/.test(kindAxis)) return null;
  return /前回|従来|修正前|直近の配当予想/.test(kindAxis)
    ? 'forecastBefore'
    : /修正後|決定額/.test(kindAxis) ||
        (/今回/.test(kindAxis) && /修正|変更|決定/.test(context + compact(nearest)))
      ? 'forecastAfter'
      : /予想|見込|見通し/.test(local) || /業績予想/.test(compact(nearest))
        ? 'forecast'
        : 'actual';
}

/** Compare an explicit point or an ordered interval without borrowing a context year. */
export function explicitCalendarAxisMatches(axis: string, target: string): boolean {
  const calendar = /20\d{2}年\d{1,2}月期|20\d{2}年\d{1,2}月\d{1,2}日|20\d{2}年\d{1,2}月(?![\d期])/g;
  const source = [...compact(axis).matchAll(calendar)];
  if (!source.length) return true;
  const claimed = [...compact(target).matchAll(calendar)];
  const interval = (text: string, matches: RegExpMatchArray[]) => {
    matches = matches.filter((m) => /日$/.test(m[0]));
    if (matches.length !== 2) return null;
    const between = compact(text).slice(matches[0].index! + matches[0][0].length, matches[1].index);
    if (!new RegExp(`^${calendarIntervalSeparator}$`).test(between)) return null;
    const keys = matches.map((m) => {
      const [y, month, day] = m[0].match(/\d+/g)!.map(Number);
      const date = new Date(Date.UTC(y, month - 1, day));
      return date.getUTCFullYear() === y &&
        date.getUTCMonth() === month - 1 &&
        date.getUTCDate() === day
        ? date.getTime()
        : NaN;
    });
    return keys.every(Number.isFinite) && keys[0] <= keys[1] ? keys : null;
  };
  const ownInterval = interval(axis, source),
    claimedInterval = interval(target, claimed);
  const dateRange = (text: string) =>
    new RegExp(`20\\d{2}年\\d{1,2}月\\d{1,2}日${calendarIntervalSeparator}`).test(compact(text));
  if (ownInterval || claimedInterval || dateRange(axis) || dateRange(target))
    return (
      !!ownInterval && !!claimedInterval && ownInterval.every((n, i) => n === claimedInterval[i])
    );
  const own = [...new Set(source.map((m) => m[0]))],
    claim = [...new Set(claimed.map((m) => m[0]))];
  return own.length === 1 && claimed.length === 1 && own[0] === claim[0];
}

/** Facts have already proved their source period; coverage compares meaning, not spelling. */
export function matchesReportingPeriod(
  fact: Pick<VerifiedFact, 'period'> & {
    semantics: Pick<VerifiedFact['semantics'], 'periodKind'>;
  },
  period: string,
  quarter?: string
): boolean {
  const text = compact(fact.period ?? '');
  if (text.match(/20\d{2}年\d{1,2}月期/)?.[0] !== period) return false;
  const q = reportingPeriodShape(quarter ?? '')?.match(/第([1-4])四半期/)?.[1];
  if (!q) return fact.semantics.periodKind === 'fullYear';
  return (
    (text.match(/第([1-4])四半期/)?.[1] ?? (/中間期/.test(text) ? '2' : null)) === q &&
    fact.semantics.periodKind === `${/単独/.test(quarter ?? '') ? 'standalone' : 'cumulative'}Q${q}`
  );
}
