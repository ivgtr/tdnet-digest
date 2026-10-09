import { reportingDocumentCover } from './document-context';
import { declaredSubjectsIn, normalized } from './document-structure';
import {
  reportingScope,
  isReportingCoverTitle,
  reportingFieldSegments,
  reportingBasis,
  bracketedReportingBases,
  reportingAttributeKey,
  hasCompleteReportingAttributes,
  reportingTargetShape,
} from './reporting-attributes';
import type { FactPeriodKind, FactSummary, VerifiedFact } from './fact-contract';
import type { SourceExcerpt } from './summary-source-inventory';
import { reportingMetricKey } from './metric-semantics';
import { reportingPeriodShapes, reportingPeriodText } from './period-semantics';

export interface EarningsTarget {
  fiscal: string;
  periodKind: FactPeriodKind;
  label: string;
  scope: string | null;
  subject: string | null;
  basis: string | null;
}
export interface EarningsTargetResolution {
  target: EarningsTarget | null;
  issue: 'missing' | 'ambiguous' | 'scope' | 'subject' | 'basis' | null;
}

function fiscalPeriod(text: string): string | null {
  const match = reportingPeriodText(text).match(/^(20\d{2})年(\d{1,2})月期/);
  if (!match || Number(match[2]) < 1 || Number(match[2]) > 12) return null;
  return `${match[1]}年${Number(match[2])}月期`;
}
function sourceTarget(text: string): EarningsTarget | null {
  const normalized = reportingPeriodText(text);
  const periods = [...new Set(normalized.match(/20\d{2}年\d{1,2}月期/g) ?? [])];
  if (periods.length !== 1) return null;
  const fiscal = fiscalPeriod(periods[0]);
  const shape = reportingTargetShape(normalized);
  if (!fiscal || !shape) return null;
  const scopes = [
    ...new Set(
      (normalized.match(new RegExp(reportingScope, 'g')) ?? []).map((scope) =>
        reportingAttributeKey('scope', scope)
      )
    ),
  ];
  if (scopes.length > 1) return null;
  const scope = scopes[0] ?? null;
  const bases = [
    ...new Set(
      bracketedReportingBases(normalized).map((basis) => reportingAttributeKey('basis', basis))
    ),
  ];
  if (bases.length > 1) return null;
  const basis = bases[0] ?? null;
  return {
    fiscal,
    scope,
    subject: null,
    basis,
    periodKind: shape.periodKind,
    label: `${fiscal}${shape.quarter ?? ''}${shape.periodKind.startsWith('cumulative') ? '累計' : ''}`,
  };
}

/** The document declares the headline period; surviving figures cannot redefine it. */
export function earningsTarget(excerpts: SourceExcerpt[]): EarningsTargetResolution {
  const coverFields = reportingDocumentCover(excerpts.filter((excerpt) => excerpt.page === 1));
  const coverTitles = coverFields
    .flatMap((excerpt) => reportingFieldSegments(excerpt.text))
    .filter(isReportingCoverTitle);
  // A missing fiscal year may be supplied by a performance heading. An explicit
  // unresolved quarter must not be erased by that separate source selection.
  if (coverTitles.some((title) => !reportingTargetShape(title)))
    return { target: null, issue: 'ambiguous' };
  const cover = coverTitles.filter((text) =>
    /20\d{2}年\d{1,2}月期/.test(reportingPeriodText(text))
  );
  // A dated title or performance heading may supply the year, but cannot
  // replace an explicit cover shape. A plain 決算短信 adds no shape constraint.
  const explicitCoverShapes = coverTitles
    .filter((title) => reportingPeriodShapes(title).length > 0)
    .map((title) => reportingTargetShape(title)!.periodKind);
  const titles = cover.length
    ? cover
    : excerpts
        .filter((excerpt) => excerpt.page === 1 && excerpt.role === 'performance')
        .map((excerpt) => excerpt.text)
        .filter(
          (text) =>
            /経営成績|(?:連結|個別|中間期|四半期)業績/.test(text) &&
            /20[0-9]{2}年\s*[0-9０-９]{1,2}月期/.test(text.normalize('NFKC')) &&
            !/。|予想/.test(text)
        );
  if (!titles.length) return { target: null, issue: 'missing' };
  // Only explicit cover fields before the first section/value belong to the report.
  // A later local company, scope or accounting-basis field must not redefine it.
  const fields: Record<'subject' | 'scope' | 'basis', Set<string>> = {
    subject: new Set(),
    scope: new Set(),
    basis: new Set(),
  };
  for (const excerpt of coverFields) {
    for (const subject of declaredSubjectsIn(excerpt)) fields.subject.add(subject);
    for (const line of reportingFieldSegments(excerpt.text)) {
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
  if (Object.values(fields).some((values) => values.size > 1))
    return { target: null, issue: 'ambiguous' };
  const targets = titles.map(sourceTarget).map((target) => {
    if (!target || explicitCoverShapes.some((shape) => shape !== target.periodKind)) return null;
    const subject = [...fields.subject][0] ?? null;
    const scope = [...fields.scope][0] ?? target.scope;
    const basis = [...fields.basis][0] ?? target.basis;
    if ((target.scope && scope !== target.scope) || (target.basis && basis !== target.basis))
      return null;
    return { ...target, subject, scope, basis };
  });
  const distinct = new Map(
    targets
      .filter((target) => target !== null)
      .map((target) => [
        JSON.stringify([target.label, target.scope, target.subject, target.basis]),
        target,
      ])
  );
  if (targets.some((target) => target === null) || distinct.size !== 1)
    return { target: null, issue: 'ambiguous' };
  const target = [...distinct.values()][0];
  const issue =
    (['scope', 'subject', 'basis'] as const).find((role) => !target[role]?.trim()) ?? null;
  return { target, issue };
}

export function matchesEarningsTarget(
  fact: Pick<VerifiedFact, 'period' | 'semantics'>,
  target: EarningsTarget | null
): boolean {
  return (
    target !== null &&
    hasCompleteReportingAttributes(target) &&
    fiscalPeriod(fact.period ?? '') === target.fiscal &&
    fact.semantics.periodKind === target.periodKind &&
    reportingAttributeKey('scope', fact.semantics.scope ?? '') === target.scope &&
    reportingAttributeKey('basis', fact.semantics.basis ?? '') === target.basis &&
    reportingAttributeKey('subject', fact.semantics.subject ?? '') === target.subject
  );
}

const majorLabels: Record<string, string> = {
  revenue: '売上高・売上収益',
  operatingProfit: '営業利益・損失',
  ordinaryProfit: '経常利益・損失',
  pretaxProfit: '税引前利益・損失',
  netProfit: '純利益・損失',
  '1株当たり利益': '1株当たり利益',
};
const metricOrder = [
  'revenue',
  'operatingProfit',
  'ordinaryProfit',
  'pretaxProfit',
  'netProfit',
  'eps',
  'operatingMargin',
];

export function earningsMetricKey(label: string): string | null {
  return (
    reportingMetricKey(label) ??
    (/^税引前(?:当期|中間|四半期)?(?:利益|損失)$/.test(reportingPeriodText(label))
      ? 'pretaxProfit'
      : null)
  );
}

/** Display order only: an IFRS label is retained, never relabelled as a Japanese-GAAP metric. */
export function earningsMetricOrder(label: string): number {
  const key = earningsMetricKey(label);
  const metric = key?.startsWith('eps:') ? 'eps' : key;
  const index = metric === null ? -1 : metricOrder.indexOf(metric);
  return index < 0 ? metricOrder.length : index;
}

/** Stable, explicit reading order within each period; no magnitude-based ranking. */
export function compareEarningsFacts(a: VerifiedFact, b: VerifiedFact): number {
  return (
    earningsMetricOrder(a.label) - earningsMetricOrder(b.label) ||
    Number(/^親会社/.test(b.label)) - Number(/^親会社/.test(a.label)) ||
    Number(b.importance === 'key') - Number(a.importance === 'key') ||
    a.label.localeCompare(b.label) ||
    (a.semantics.subject ?? '').localeCompare(b.semantics.subject ?? '') ||
    a.id.localeCompare(b.id)
  );
}

/** Required coverage and retained comparative facts are warnings, not invented current values. */
export function earningsMissingMajorLabels(
  facts: FactSummary,
  target: EarningsTarget | null
): string[] {
  const missing = new Set<string>();
  for (const issue of facts.unverified) {
    for (const match of issue.matchAll(
      /COVERAGE:当年決算実績の重要指標\s+(revenue|operatingProfit|ordinaryProfit|netProfit|1株当たり利益)/g
    ))
      missing.add(match[1]);
  }
  if (target) {
    const actual = facts.facts.filter((fact) => fact.quantity && fact.semantics.state === 'actual');
    for (const fact of actual) {
      // A comparative figure from another reporting unit cannot create a current obligation.
      if (!matchesEarningsTarget({ ...fact, period: target.fiscal }, target)) continue;
      const metric = earningsMetricKey(fact.label);
      if (!metric || !(metric in majorLabels) || fact.semantics.metricKind !== 'amount') continue;
      if (
        !actual.some(
          (current) =>
            matchesEarningsTarget(current, target) &&
            current.semantics.metricKind === 'amount' &&
            earningsMetricKey(current.label) === metric
        )
      )
        missing.add(metric);
    }
  }
  return [...missing]
    .sort(
      (a, b) =>
        metricOrder.indexOf(a === '1株当たり利益' ? 'eps' : a) -
        metricOrder.indexOf(b === '1株当たり利益' ? 'eps' : b)
    )
    .map((metric) => majorLabels[metric]);
}

/** Only existing coverage obligations can add forecast/dividend warnings. */
export function earningsAdditionalMajorWarnings(facts: FactSummary): string[] {
  const forecasts = new Set<string>();
  const dividends = new Set<string>();
  for (const issue of facts.unverified) {
    for (const match of issue.matchAll(
      /COVERAGE:通期予想の(?:重要指標\s+(revenue|operatingProfit|ordinaryProfit|netProfit)|(1株当たり利益))/g
    ))
      forecasts.add(match[1] ?? match[2]);
    for (const match of issue.matchAll(
      /COVERAGE:配当の重要事実\s+対象期=(20\d{2}年\d{1,2}月期)\s+区分=(actual|forecast)/g
    ))
      dividends.add(`${match[1]} ${match[2] === 'forecast' ? '予想' : '実績'}`);
    if (issue.includes('COVERAGE:配当の報告対象期・区分を確認できません'))
      dividends.add('報告対象期・区分');
  }
  return [
    ...(forecasts.size
      ? [
          `通期予想：${[...forecasts]
            .sort(
              (a, b) =>
                metricOrder.indexOf(a === '1株当たり利益' ? 'eps' : a) -
                metricOrder.indexOf(b === '1株当たり利益' ? 'eps' : b)
            )
            .map((metric) => majorLabels[metric])
            .join('、')}`,
        ]
      : []),
    ...(dividends.size ? [`配当：${[...dividends].sort().join('、')}`] : []),
  ];
}

/** Unknown/custom axes stay explicit and deterministic, with the document target first. */
export function earningsPeriodOrder(
  period: string | null,
  target: EarningsTarget | null
): [number, number, string] {
  const text = reportingPeriodText(period ?? '');
  const parsed = sourceTarget(text);
  const fiscal = fiscalPeriod(text)?.match(/^(20\d{2})年(\d{1,2})月期$/);
  return [
    parsed && target && parsed.label === target.label ? 0 : 1,
    fiscal ? -(Number(fiscal[1]) * 12 + Number(fiscal[2])) : 0,
    text,
  ];
}
