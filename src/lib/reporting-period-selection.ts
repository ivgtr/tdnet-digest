import { reportingDocumentCover } from './document-context';
import { declaredSubjectsIn, headingLevel, normalized } from './document-structure';
import {
  bracketedReportingBases,
  isReportingCoverTitle,
  reportingAttributeKey,
  reportingBasis,
  reportingFieldSegments,
  reportingScope,
  reportingTargetShape,
} from './reporting-attributes';
import {
  calendarDatePattern,
  calendarIntervalSeparator,
  REPORTING_PERIOD_SHAPE_PATTERN,
  reportingPeriodShapes,
  reportingPeriodText,
} from './period-semantics';
import type { FactPeriodKind, VerifiedFact } from './fact-contract';

interface ReportingSource {
  id: string;
  page: number;
  text: string;
  kind?: 'paragraph' | 'row' | 'heading';
}
export interface ReportingPeriod {
  fiscal: string;
  periodKind: FactPeriodKind;
  quarter?: string;
}

/** Merge only the proved cover prefix and selected period titles, never later fields. */
export function reportingTargetAttributes(
  coverFields: Pick<ReportingSource, 'text'>[],
  titles: string[]
): Pick<VerifiedFact['semantics'], 'subject' | 'scope' | 'basis'> | null {
  const fields: Record<'subject' | 'scope' | 'basis', Set<string>> = {
    subject: new Set(),
    scope: new Set(),
    basis: new Set(),
  };
  const titleAttributes = (title: string) => {
    for (const scope of normalized(title).match(new RegExp(reportingScope, 'g')) ?? [])
      fields.scope.add(reportingAttributeKey('scope', scope));
    for (const basis of bracketedReportingBases(title))
      fields.basis.add(reportingAttributeKey('basis', basis));
  };
  for (const source of coverFields) {
    for (const subject of declaredSubjectsIn(source)) fields.subject.add(subject);
    for (const line of reportingFieldSegments(source.text)) {
      if (isReportingCoverTitle(line)) titleAttributes(line);
      const text = normalized(line);
      const field = line
        .normalize('NFKC')
        .trim()
        .match(/^(範囲|会計基準)(?:\s*:\s*|\s+)([^。；]+)$/);
      const scopeAtom = text.match(
        new RegExp(`^(?:範囲:?)?(?:\\((${reportingScope})\\)|(${reportingScope}))$`)
      );
      const scope = field?.[1] === '範囲' ? field[2] : (scopeAtom?.[1] ?? scopeAtom?.[2]);
      if (scope) fields.scope.add(reportingAttributeKey('scope', scope));
      const basis =
        field?.[1] === '会計基準'
          ? field[2]
          : text.match(new RegExp(`^(?:会計基準:?)?(${reportingBasis})$`, 'i'))?.[1];
      if (basis) fields.basis.add(reportingAttributeKey('basis', basis));
    }
  }
  for (const title of titles) titleAttributes(title);
  if (Object.values(fields).some((values) => values.size > 1)) return null;
  return {
    subject: [...fields.subject][0] ?? null,
    scope: [...fields.scope][0] ?? null,
    basis: [...fields.basis][0] ?? null,
  };
}

export function declaredReportingPeriod(text: string): ReportingPeriod | null {
  const periods = [...new Set(reportingPeriodText(text).match(/20\d{2}年\d{1,2}月期/g) ?? [])];
  const match = periods.length === 1 ? periods[0].match(/^(20\d{2})年(\d{1,2})月期$/) : null;
  const shape = reportingTargetShape(text);
  if (!match || Number(match[2]) < 1 || Number(match[2]) > 12 || !shape) return null;
  return { fiscal: `${match[1]}年${Number(match[2])}月期`, ...shape };
}

/** A complete actual title proves the year; a reading role or body mention cannot. */
function datedPerformanceHeading(source: ReportingSource): boolean {
  // Inventory's derived heading label is not proof; recheck the original text,
  // retaining the physical row rules when the source is a row.
  if (headingLevel({ ...source, kind: source.kind === 'row' ? 'row' : 'paragraph' }) === null)
    return false;
  const text = reportingPeriodText(source.text).replace(/^(?:\(\d+\)|\d+[.．]|■|\(?[①-⑳]\)?)/, '');
  return new RegExp(
    `^20\\d{2}年\\d{1,2}月期(?:の)?(?:${REPORTING_PERIOD_SHAPE_PATTERN}|四半期)?(?:\\(中間期\\))?(?:の)?(?:${reportingScope})?(?:経営成績|業績)(?:\\(${calendarDatePattern}${calendarIntervalSeparator}${calendarDatePattern}\\))?$`
  ).test(text);
}

/** Headline and coverage share the same source-owned period and cover constraints. */
export function selectReportingPeriod<T extends ReportingSource>(
  sources: T[]
): {
  coverFields: T[];
  titles: string[];
  period: ReportingPeriod | null;
  issue: 'missing' | 'ambiguous' | null;
} {
  const first = sources.filter((source) => source.page === 1);
  const coverFields = reportingDocumentCover(first);
  const coverTitles = coverFields
    .flatMap((source) => reportingFieldSegments(source.text))
    .filter(isReportingCoverTitle);
  const result = { coverFields, titles: [] as string[], period: null };
  if (coverTitles.some((title) => !reportingTargetShape(title)))
    return { ...result, issue: 'ambiguous' };
  const datedCovers = coverTitles.filter((title) =>
    /20\d{2}年\d{1,2}月期/.test(reportingPeriodText(title))
  );
  const titles = [...datedCovers];
  if (!titles.length) {
    // Only the leading actual unit can supply a missing year. Metadata without a
    // 短信 title is also supported; later sections, references and body close it.
    const boundary = coverFields.length
      ? first.indexOf(coverFields[coverFields.length - 1]) + 1
      : 0;
    for (const source of first.slice(boundary)) {
      if (!source.text.trim()) continue;
      if (!datedPerformanceHeading(source)) break;
      titles.push(source.text);
    }
  }
  if (!titles.length) return { ...result, issue: 'missing' };
  const periods = titles.map(declaredReportingPeriod);
  const period = periods[0];
  // An undated plain title imposes no shape. Explicit quarter/annual declarations
  // still constrain the dated source, including unresolved quarter declarations.
  const coverShapes = coverTitles
    .filter((title) => reportingPeriodShapes(title).length > 0)
    .map((title) => reportingTargetShape(title)!.periodKind);
  if (
    !period ||
    periods.some(
      (other) => !other || other.fiscal !== period.fiscal || other.periodKind !== period.periodKind
    ) ||
    coverShapes.some((shape) => shape !== period.periodKind)
  )
    return { ...result, titles, issue: 'ambiguous' };
  return { coverFields, titles, period, issue: null };
}
