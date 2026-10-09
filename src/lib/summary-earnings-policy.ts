import { reportingAttributeKey, hasCompleteReportingAttributes } from './reporting-attributes';
import type { FactPeriodKind, FactSummary, VerifiedFact } from './fact-contract';
import type { SourceExcerpt } from './summary-source-inventory';
import { reportingMetricKey } from './metric-semantics';
import { reportingPeriodText } from './period-semantics';
import {
  declaredReportingPeriod,
  selectReportingPeriod,
  reportingTargetAttributes,
} from './reporting-period-selection';

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
/** The document declares the headline period; surviving figures cannot redefine it. */
export function earningsTarget(excerpts: SourceExcerpt[]): EarningsTargetResolution {
  const { coverFields, titles, period, issue: periodIssue } = selectReportingPeriod(excerpts);
  if (!period) return { target: null, issue: periodIssue };
  const attributes = reportingTargetAttributes(coverFields, titles);
  if (!attributes) return { target: null, issue: 'ambiguous' };
  const target: EarningsTarget = {
    ...attributes,
    fiscal: period.fiscal,
    periodKind: period.periodKind,
    label: `${period.fiscal}${period.quarter ?? ''}${period.periodKind.startsWith('cumulative') ? '累計' : ''}`,
  };
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
    const previous = {
      ...target,
      fiscal: target.fiscal.replace(/^(20\d{2})年/, (_, year: string) => `${Number(year) - 1}年`),
    };
    const actual = facts.facts.filter((fact) => fact.quantity && fact.semantics.state === 'actual');
    for (const fact of actual) {
      // Only the preceding same-shape period in this reporting unit is comparative.
      // Older history and future actuals cannot create a current obligation.
      if (!matchesEarningsTarget(fact, previous)) continue;
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
  const parsed = declaredReportingPeriod(text);
  const fiscal = fiscalPeriod(text)?.match(/^(20\d{2})年(\d{1,2})月期$/);
  return [
    parsed && target && parsed.fiscal === target.fiscal && parsed.periodKind === target.periodKind
      ? 0
      : 1,
    fiscal ? -(Number(fiscal[1]) * 12 + Number(fiscal[2])) : 0,
    text,
  ];
}
