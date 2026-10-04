import type { FactSemantics } from './fact-contract';
import type { TableEvidence } from './numeric-evidence';
import type { DocumentType } from './document-type';
import { generateText, type LLMConfig } from './llm-client';
import { getProviderCapabilities } from './structured-output';
import { isPerShareDividend } from './metric-semantics';

export type ScoreCategory =
  | 'operatingProfit'
  | 'revenue'
  | 'margin'
  | 'kpi'
  | 'coreForecast'
  | 'oneOff'
  | 'shareholderReturn'
  | 'capitalAction'
  | 'cashFlow';
export type PeriodKind =
  | 'fullYear'
  | 'cumulativeQ1'
  | 'cumulativeQ2'
  | 'cumulativeQ3'
  | 'standaloneQ1'
  | 'standaloneQ2'
  | 'standaloneQ3'
  | 'standaloneQ4'
  | 'month'
  | 'eventDate';
export type ValueKind =
  | 'actual'
  | 'forecast'
  | 'forecastBefore'
  | 'forecastAfter'
  | 'planned'
  | 'decided'
  | 'contracted'
  | 'completed';
export interface ScoreSource {
  factId: string;
  semantics: FactSemantics;
  url: string;
  documentHash: string;
  page: number;
  quote: string;
  evidence: TableEvidence | null;
  period: string;
  fiscalYear: number;
  periodKind: PeriodKind;
  valueKind: ValueKind;
  metric: string;
  basis: string | null;
  scope: string | null;
  perShareBasis: Array<{
    kind: 'stockSplit';
    noteId: string;
    text: string;
    basis: 'splitAdjusted' | 'beforeSplit' | 'afterSplit';
  }> | null;
}
export interface ScoreValue {
  value: number;
  unit: string;
  source: ScoreSource;
}
export interface ScoreClaim {
  category: ScoreCategory;
  label: string;
  current: ScoreValue;
  previous: ScoreValue | null;
  earlier: ScoreValue | null;
  relatedValue: ScoreValue | null;
  companyExplanation: string | null;
}
export interface ScoreInput {
  claims: ScoreClaim[];
  unverified: string[];
  searchStatus: string;
}
export interface ScoreBreakdown {
  category: ScoreCategory;
  label: string;
  impact: 'positive' | 'negative' | 'neutral';
  strength: 'small' | 'medium' | 'large';
  current: ScoreValue;
  previous: ScoreValue | null;
  earlier: ScoreValue | null;
  comparison: string;
  companyExplanation: string | null;
  relatedValue: ScoreValue | null;
}
export interface ExperimentalScore {
  value: number | null;
  verdict: string;
  positives: string[];
  negatives: string[];
  breakdown: ScoreBreakdown[];
  unverified: string[];
  searchStatus: string;
}
// These limits bound each category's influence; they do not determine the score by addition.
export const SCORE_LIMITS: Record<ScoreCategory, number> = {
  operatingProfit: 20,
  revenue: 10,
  margin: 10,
  kpi: 10,
  coreForecast: 20,
  oneOff: 4,
  shareholderReturn: 10,
  capitalAction: 10,
  cashFlow: 5,
};
export function hasComparableScope(
  scope: unknown,
  metric: string,
  metricKind: FactSemantics['metricKind'],
  unit: string
): boolean {
  return (
    (typeof scope === 'string' && !!scope.trim()) ||
    (scope === null && metricKind === 'perShare' && isPerShareDividend(metric, unit))
  );
}
export function compatible(a: ScoreValue, b: ScoreValue, forecast = false): boolean {
  const x = a.source,
    y = b.source;
  return (
    hasComparableScope(x.scope, x.metric, x.semantics.metricKind, a.unit) &&
    hasComparableScope(y.scope, y.metric, y.semantics.metricKind, b.unit) &&
    a.unit === b.unit &&
    // A generic adjustment category does not prove the same share denominator.
    // Cross-document split events remain incomparable without an event proof.
    ((!x.perShareBasis?.length && !y.perShareBasis?.length) ||
      (/^[a-f0-9]{64}$/.test(x.documentHash) && x.documentHash === y.documentHash)) &&
    JSON.stringify(x.perShareBasis) === JSON.stringify(y.perShareBasis) &&
    x.semantics.polarity === y.semantics.polarity &&
    JSON.stringify(x.semantics.qualifiers) === JSON.stringify(y.semantics.qualifiers) &&
    JSON.stringify(x.semantics.conditions) === JSON.stringify(y.semantics.conditions) &&
    x.semantics.subject === y.semantics.subject &&
    x.metric === y.metric &&
    x.basis === y.basis &&
    x.scope === y.scope &&
    x.periodKind === y.periodKind &&
    samePeriodShape(x.period, y.period, x.periodKind, forecast) &&
    (forecast
      ? x.fiscalYear === y.fiscalYear &&
        x.valueKind === 'forecastAfter' &&
        y.valueKind === 'forecastBefore'
      : x.valueKind === 'actual' && y.valueKind === 'actual' && x.fiscalYear === y.fiscalYear + 1)
  );
}
function samePeriodShape(a: string, b: string, kind: PeriodKind, forecast: boolean): boolean {
  const left = a.normalize('NFKC').replace(/\s/g, '');
  const right = b.normalize('NFKC').replace(/\s/g, '');
  if (forecast) return left === right;
  const month = (period: string) => period.match(/\d{4}年(\d{1,2})月/)?.[1] ?? null;
  const x = month(left),
    y = month(right);
  if (x === null || y === null || x !== y) return false;
  if (kind === 'eventDate') {
    const day = (period: string) => period.match(/\d{4}年\d{1,2}月(\d{1,2})日/)?.[1] ?? null;
    return day(left) === day(right);
  }
  return true;
}
export function rate(current: number, previous: number): number | null {
  return previous === 0 || !Number.isFinite(current) || !Number.isFinite(previous)
    ? null
    : (100 * (current - previous)) / Math.abs(previous);
}
export function assessClaim(claim: ScoreClaim): string | null {
  const { current, previous, earlier, category } = claim;
  const capitalRatio = ownershipRatio(claim);
  if (capitalRatio !== null)
    return `${current.source.metric} ${current.value}${current.unit}／${claim.relatedValue!.source.metric} ${claim.relatedValue!.value}${claim.relatedValue!.unit}（${capitalRatio.toFixed(2)}%）`;
  if (['operatingProfit', 'revenue', 'margin', 'kpi', 'cashFlow'].includes(category)) {
    if (!previous || !compatible(current, previous)) return null;
    if (category === 'margin')
      return `利益率 ${previous.value}${previous.unit}→${current.value}${current.unit}（${(current.value - previous.value).toFixed(2)}ポイント）`;
    const growth = rate(current.value, previous.value);
    if (growth === null) return null;
    if (earlier && compatible(previous, earlier)) {
      const prior = rate(previous.value, earlier.value);
      if (prior !== null)
        return `前年比 ${prior.toFixed(1)}%→${growth.toFixed(1)}%（${(growth - prior).toFixed(1)}ポイント）`;
    }
    return `前年比 ${growth.toFixed(1)}%（加速・鈍化は未確認）`;
  }
  if (!previous || !compatible(current, previous, true)) return null;
  const change = rate(current.value, previous.value);
  if (change === null) return null;
  if (category === 'oneOff') {
    if (
      !claim.relatedValue ||
      !/純利益/.test(current.source.metric) ||
      !/特別|売却益|売却損|減損|一時|補償金|評価損|評価益/.test(claim.relatedValue.source.metric) ||
      claim.relatedValue.unit !== current.unit ||
      claim.relatedValue.source.url !== current.source.url ||
      claim.relatedValue.source.basis !== current.source.basis ||
      claim.relatedValue.source.scope !== current.source.scope ||
      claim.relatedValue.source.fiscalYear !== current.source.fiscalYear ||
      claim.relatedValue.source.periodKind !== current.source.periodKind ||
      claim.relatedValue.source.period !== current.source.period
    )
      return null;
    return `純利益予想 ${previous.value}→${current.value}${current.unit}（${change.toFixed(1)}%）、一時損益 ${claim.relatedValue.value}${claim.relatedValue.unit}`;
  }
  return `${category === 'coreForecast' ? '本業予想 ' : ''}${previous.value}→${current.value}${current.unit}（${change.toFixed(1)}%）`;
}
function ownershipRatio(claim: ScoreClaim): number | null {
  if (
    !['shareholderReturn', 'capitalAction'].includes(claim.category) ||
    claim.previous ||
    !claim.relatedValue
  )
    return null;
  const a = claim.current,
    b = claim.relatedValue;
  const metric = a.source.metric;
  if (claim.category === 'shareholderReturn' && !/取得.*株式数|買付.*株式数/.test(metric))
    return null;
  if (claim.category === 'capitalAction' && !/新株.*株式数|発行株式数/.test(metric)) return null;
  if (
    !/発行済株式数/.test(b.source.metric) ||
    a.unit !== b.unit ||
    b.value <= 0 ||
    a.value <= 0 ||
    a.source.url !== b.source.url ||
    a.source.fiscalYear !== b.source.fiscalYear ||
    a.source.period !== b.source.period ||
    a.source.periodKind !== b.source.periodKind ||
    !hasComparableScope(a.source.scope, a.source.metric, a.source.semantics.metricKind, a.unit) ||
    !hasComparableScope(b.source.scope, b.source.metric, b.source.semantics.metricKind, b.unit) ||
    a.source.scope !== b.source.scope
  )
    return null;
  return (100 * a.value) / b.value;
}
export function directionOf(claim: ScoreClaim): 'positive' | 'negative' | 'neutral' | null {
  if (!assessClaim(claim)) return null;
  const ratio = ownershipRatio(claim);
  if (ratio !== null)
    return ratio < 1 ? 'neutral' : claim.category === 'shareholderReturn' ? 'positive' : 'negative';
  if (!claim.previous) return null;
  let delta = claim.current.value - claim.previous.value;
  let threshold = 0;
  if (claim.category === 'margin') threshold = 0.5;
  else {
    const change = rate(claim.current.value, claim.previous.value);
    if (change === null) return null;
    delta = change;
    threshold = claim.category === 'coreForecast' ? 3 : 2;
    if (
      ['operatingProfit', 'revenue', 'kpi'].includes(claim.category) &&
      claim.earlier &&
      compatible(claim.previous, claim.earlier)
    ) {
      const prior = rate(claim.previous.value, claim.earlier.value);
      if (prior !== null) delta -= prior;
    }
  }
  if (claim.category === 'capitalAction' && /希薄化|発行済株式数/.test(claim.current.source.metric))
    delta *= -1;
  return Math.abs(delta) < threshold ? 'neutral' : delta > 0 ? 'positive' : 'negative';
}
export function scoreVerdict(value: number | null): string {
  if (value === null) return '算出不能';
  if (value >= 70) return '好材料';
  if (value >= 55) return 'やや好材料';
  if (value >= 45) return '中立';
  if (value >= 30) return 'やや悪材料';
  return '悪材料';
}
export async function inferExperimentalScore(
  config: LLMConfig,
  documentType: DocumentType,
  input: ScoreInput
): Promise<ExperimentalScore> {
  const unverified = [...input.unverified];
  const candidates = input.claims.flatMap((claim) => {
    const comparison = assessClaim(claim);
    if (!comparison) {
      unverified.push(`${claim.label}の比較条件または変化量を確認できません`);
      return [];
    }
    if (['operatingProfit', 'revenue', 'kpi'].includes(claim.category) && !claim.earlier)
      unverified.push(`${claim.label}の前々期比較を確認できず、加速・鈍化は未判定`);
    return [{ claim, comparison, expected: directionOf(claim) }];
  });
  const empty = (reason: string): ExperimentalScore => ({
    value: null,
    verdict: '算出不能',
    positives: [],
    negatives: [],
    breakdown: [],
    unverified: [...new Set([...unverified, reason])],
    searchStatus: input.searchStatus,
  });
  if (!candidates.length) return empty('採点できる方向性の事実がありません');
  const facts = candidates.map(({ claim, comparison, expected }, index) => ({
    index,
    category: claim.category,
    label: claim.label,
    comparison,
    expected,
    cap: SCORE_LIMITS[claim.category],
    companyExplanation: claim.companyExplanation,
  }));
  try {
    const raw = await generateText(
      {
        ...config,
        temperature: 0,
        ...((config.provider === 'openrouter' ||
          getProviderCapabilities(config.provider).jsonObject) && {
          responseFormat: 'json_object' as const,
        }),
      },
      [
        {
          role: 'system',
          content:
            '開示資料の検算済み事実だけを評価してください。市場予想、株価、資料にない因果関係を使わないでください。固定加点の合計ではなく、変化の規模、本業との関係、継続性、併存材料から点数を推論します。未確認項目の重みを他へ移さず、JSONのみ返してください。',
        },
        {
          role: 'user',
          content: `文書種別: ${documentType}\n確認済み事実: ${JSON.stringify(facts)}\n未確認: ${JSON.stringify(unverified)}\n50を中立の目安とします。capは各分類全体の影響上限で、合計式ではありません。一時益だけで本業改善とみなさず、本業鈍化は前年比増益でも悪材料になり得ます。取得枠は実行済みとみなさず、全事実について方向と強さを返してください。形式: {"value":整数,"factors":[{"index":整数,"impact":"positive|negative|neutral","strength":"small|medium|large"}]}。他のキーは禁止。`,
        },
      ]
    );
    const parsed: unknown = JSON.parse(
      raw
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/, '')
        .trim()
    );
    if (
      !exactKeys(parsed, ['value', 'factors']) ||
      !Number.isInteger(parsed.value) ||
      (parsed.value as number) < 0 ||
      (parsed.value as number) > 100 ||
      !Array.isArray(parsed.factors) ||
      parsed.factors.length !== candidates.length
    )
      throw new Error('推論結果の形式が不正です');
    const seen = new Set<number>();
    const breakdown = parsed.factors.map((item: unknown) => {
      if (
        !exactKeys(item, ['index', 'impact', 'strength']) ||
        !Number.isInteger(item.index) ||
        (item.index as number) < 0 ||
        (item.index as number) >= candidates.length ||
        seen.has(item.index as number) ||
        !['positive', 'negative', 'neutral'].includes(item.impact as string) ||
        !['small', 'medium', 'large'].includes(item.strength as string)
      )
        throw new Error('推論要因の形式が不正です');
      seen.add(item.index as number);
      const { claim, comparison, expected } = candidates[item.index as number];
      if (
        (expected && expected !== item.impact && claim.category !== 'oneOff') ||
        (claim.category === 'oneOff' && expected === 'positive' && item.impact === 'negative') ||
        (claim.category === 'oneOff' && expected === 'negative' && item.impact === 'positive')
      )
        throw new Error('検算した方向と推論要因が一致しません');
      return {
        category: claim.category,
        label: claim.label,
        impact: item.impact,
        strength: item.strength,
        current: claim.current,
        previous: claim.previous,
        earlier: claim.earlier,
        relatedValue: claim.relatedValue,
        comparison,
        companyExplanation: claim.companyExplanation,
      } as ScoreBreakdown;
    });
    const value = parsed.value as number;
    const directional = breakdown.filter((item) => item.impact !== 'neutral');
    const capFor = (impact: 'positive' | 'negative') =>
      [
        ...new Set(breakdown.filter((item) => item.impact === impact).map((item) => item.category)),
      ].reduce((sum, category) => sum + SCORE_LIMITS[category], 0);
    const upper = 50 + capFor('positive');
    const lower = 50 - capFor('negative');
    if (value < lower || value > upper) throw new Error('確認した項目の影響上限を超えました');
    if (!directional.length && (value < 45 || value >= 55))
      throw new Error('方向性のない事実から点数を動かしました');
    if (
      (directional.length &&
        directional.every((item) => item.impact === 'positive') &&
        value < 50) ||
      (directional.length && directional.every((item) => item.impact === 'negative') && value > 50)
    )
      throw new Error('点数の方向と確認済み事実が一致しません');
    if (
      directional.length &&
      directional.every((item) => item.impact === 'negative') &&
      candidates.some(({ claim }) => isStrongOperatingSlowdown(claim)) &&
      value >= 45
    )
      throw new Error('本業の明確な鈍化が判定に反映されていません');
    if (directional.length === 1) {
      const sole = directional[0];
      if (sole.category === 'oneOff' && (value < 45 || value >= 55))
        throw new Error('一時損益だけで強い判定にしました');
      if (Math.abs(value - 50) > SCORE_LIMITS[sole.category])
        throw new Error('単独事実の影響上限を超えました');
    }
    const rank = { large: 3, medium: 2, small: 1 };
    const headline = (impact: 'positive' | 'negative') =>
      breakdown
        .filter((item) => item.impact === impact)
        .sort((a, b) => rank[b.strength] - rank[a.strength])
        .slice(0, 2)
        .map((item) => `${item.label}: ${item.comparison}`);
    return {
      value,
      verdict: scoreVerdict(value),
      positives: headline('positive'),
      negatives: headline('negative'),
      breakdown,
      unverified: [...new Set(unverified)],
      searchStatus: input.searchStatus,
    };
  } catch (error) {
    return empty(
      `点数の推論を検証できません: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
function isStrongOperatingSlowdown(claim: ScoreClaim): boolean {
  if (
    claim.category !== 'operatingProfit' ||
    !claim.previous ||
    !claim.earlier ||
    !compatible(claim.current, claim.previous) ||
    !compatible(claim.previous, claim.earlier)
  )
    return false;
  const latest = rate(claim.current.value, claim.previous.value);
  const prior = rate(claim.previous.value, claim.earlier.value);
  return latest !== null && prior !== null && latest - prior <= -5;
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function exactKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  return (
    record(value) && Object.keys(value).length === keys.length && keys.every((key) => key in value)
  );
}
