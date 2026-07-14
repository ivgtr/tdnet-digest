import type { EarningsContext } from './document-type';
import type { EarningsExtraction } from './summary-schema';

type FinancialItem = EarningsExtraction['performance']['items'][number];

export function refineEarningsExtraction(
  extraction: EarningsExtraction,
  context: EarningsContext,
  documentTitle?: string
): EarningsExtraction {
  const actualMetric = findEvaluationMetric(extraction.performance.items, context);
  const forecastMetric = extraction.forecast
    ? findEvaluationMetric(extraction.forecast.items, context)
    : undefined;
  const actualComparison = buildYearComparisonRating(
    actualMetric,
    context.period === 'fullYear' ? '前期比' : '前年同期比'
  );
  const forecastComparison = extraction.forecast
    ? buildYearComparisonRating(forecastMetric, '前期比')
    : null;
  const progress =
    context.period === 'fullYear'
      ? extraction.progress
      : buildProgress(actualMetric, forecastMetric, extraction.progress?.lastYearProgress);

  const previousEvaluation = extraction.evaluation;
  const dividendEvaluation = buildDividendEvaluation(extraction);
  const evaluation = {
    actual: {
      vsLastYear: actualComparison,
      progressOrLanding:
        context.period === 'fullYear'
          ? (previousEvaluation?.actual.progressOrLanding ?? null)
          : progress
            ? buildProgressRating(progress, context)
            : buildUnavailableProgressRating(actualMetric, forecastMetric),
    },
    forecast: extraction.forecast
      ? {
          vsLastYear: forecastComparison,
          revisionOrDividend:
            context.period === 'fullYear'
              ? dividendEvaluation
              : (previousEvaluation?.forecast?.revisionOrDividend ?? null),
        }
      : null,
  };

  return {
    ...extraction,
    performance: {
      ...extraction.performance,
      periodLabel: buildPerformanceLabel(extraction.performance.periodLabel, context, documentTitle),
    },
    businessPl: buildBusinessPl(
      [...(extraction.businessPl?.items ?? []), ...extraction.performance.items],
      context
    ),
    evaluation,
    progress,
    earningsQuality: {
      ...extraction.earningsQuality,
      oneOffItems: extraction.earningsQuality.oneOffItems.filter(isProfitAndLossItem),
      operatingCashFlow: refineOperatingCashFlow(extraction.earningsQuality.operatingCashFlow),
      capitalActions: extraction.earningsQuality.capitalActions.filter(
        (action) =>
          action.returnAssessment === 'shareholderReturn' && action.confidence !== 'low'
      ),
    },
  };
}

function refineOperatingCashFlow(
  cashFlow: EarningsExtraction['earningsQuality']['operatingCashFlow']
): EarningsExtraction['earningsQuality']['operatingCashFlow'] {
  if (
    !cashFlow ||
    cashFlow.status !== 'reported' ||
    !cashFlow.amount ||
    cashFlow.confidence === 'low'
  ) {
    return null;
  }
  return cashFlow;
}

function buildPerformanceLabel(
  llmLabel: string,
  context: EarningsContext,
  documentTitle?: string
): string {
  const fiscalYear = extractFiscalYearLabel(documentTitle) ?? extractFiscalYearLabel(llmLabel);
  const period = {
    q1: '第1四半期',
    q2: '第2四半期',
    q3: '第3四半期',
    fullYear: '',
  }[context.period];
  const consolidation = context.isConsolidated ? '連結' : '';
  return [fiscalYear, `${period}${consolidation}実績`].filter(Boolean).join(' ');
}

function extractFiscalYearLabel(value: string | undefined): string | null {
  const match = value?.normalize('NFKC').match(/\d{4}年\s*\d{1,2}月期/);
  return match ? match[0].replace(/\s+/g, '') : null;
}

function buildDividendEvaluation(extraction: EarningsExtraction): string | null {
  const forecast = extraction.dividend?.periods.find((period) => period.status === 'forecast');
  if (!forecast) return null;
  const before = forecast.comparisonAnnual;
  const after = forecast.annual;
  if (!before || !after) return '—未定or記載なし';

  const comparison = `${normalizeDividendAmount(before)}→${normalizeDividendAmount(after)}`;
  switch (forecast.assessment) {
    case 'increase':
      return `↑増配（${comparison}）`;
    case 'unchanged':
      return `→据置（${comparison}）`;
    case 'decrease':
      return `↓減配（${comparison}）`;
    case 'unknown':
      return `—判定不能（${comparison}）`;
  }
}

function normalizeDividendAmount(value: string): string {
  return value.normalize('NFKC').replace(/(\d+)円00銭/g, '$1円');
}

function buildBusinessPl(
  items: FinancialItem[],
  context: EarningsContext
): NonNullable<EarningsExtraction['businessPl']> | null {
  const candidates = [
    findFirstItem(items, [/^売上高$/, /^売上収益$/, /^営業収益$/]),
    findFirstItem(items, [/売上総利益/, /粗利益/, /粗利/]),
    findFirstItem(items, [/^事業利益$/, /コア営業利益/, /調整後営業利益/, /^営業利益$/]),
  ].filter((item): item is FinancialItem => item !== undefined);

  if (candidates.length === 0) return null;
  const comparisonLabel = context.period === 'fullYear' ? '前期比' : '前年同期比';
  return {
    items: candidates.map((item) => ({
      ...item,
      assessment: buildBusinessPlAssessment(item, comparisonLabel),
    })),
  };
}

function findFirstItem(items: FinancialItem[], patterns: RegExp[]): FinancialItem | undefined {
  for (const pattern of patterns) {
    const item = items.find((candidate) => pattern.test(candidate.name));
    if (item) return item;
  }
  return undefined;
}

function buildBusinessPlAssessment(item: FinancialItem, comparisonLabel: string): string {
  const current = parseFinancialAmount(item.amount);
  const previous = parseFinancialAmount(item.previousAmount);
  const comparison = `${formatComparisonAmount(item.previousAmount)} → ${formatComparisonAmount(item.amount)}`;
  if (current !== null && previous !== null) {
    if (previous > 0 && current < 0) return `赤字転落: ${comparison}`;
    if (previous < 0 && current > 0) return `黒字転換: ${comparison}`;
    if (previous < 0 && current === 0) return `赤字解消: ${comparison}`;
    if (previous < 0 && current < 0) {
      const improvement = ((Math.abs(previous) - Math.abs(current)) / Math.abs(previous)) * 100;
      const state = improvement > 0 ? '赤字縮小' : improvement < 0 ? '赤字拡大' : '赤字横ばい';
      return `${state}${Math.abs(improvement).toFixed(1)}%: ${comparison}`;
    }
  }

  const percentage = parsePercentage(item.change) ?? calculatePercentageChange(current, previous);
  if (percentage === null) return '比較不能';
  const direction = buildBusinessPlDirection(item.name, percentage);
  return `${comparisonLabel}${formatPercentage(percentage)}（${direction}）`;
}

function buildBusinessPlDirection(name: string, percentage: number): string {
  if (percentage === 0) return '横ばい';
  const positive = percentage > 0;
  if (/売上高|売上収益|営業収益/.test(name)) return positive ? '増収' : '減収';
  if (/売上総利益|粗利益|粗利/.test(name)) return positive ? '粗利増加' : '粗利減少';
  return positive ? '増益' : '減益';
}

function findEvaluationMetric(
  items: FinancialItem[],
  context: EarningsContext
): FinancialItem | undefined {
  const preferred = context.accountingStandard === 'jpGaap' ? /経常利益/ : /税引前/;
  return items.find((item) => preferred.test(item.name));
}

function buildYearComparisonRating(item: FinancialItem | undefined, label: string): string {
  const current = parseFinancialAmount(item?.amount);
  const previous = parseFinancialAmount(item?.previousAmount);
  if (current !== null && previous !== null) {
    const comparison = `${formatComparisonAmount(item?.previousAmount)} → ${formatComparisonAmount(item?.amount)}`;
    if (previous > 0 && current < 0) return `★☆☆☆☆（赤字転落: ${comparison}）`;
    if (previous < 0 && current > 0) return `★★★★★（黒字転換: ${comparison}）`;
    if (previous < 0 && current === 0) return `★★★★★（赤字解消: ${comparison}）`;
    if (previous < 0 && current < 0) {
      const improvement = ((Math.abs(previous) - Math.abs(current)) / Math.abs(previous)) * 100;
      const state = improvement > 0 ? '赤字縮小' : improvement < 0 ? '赤字拡大' : '赤字横ばい';
      return `${ratingStars(yearComparisonScore(improvement))}（${state}${Math.abs(improvement).toFixed(1)}%: ${comparison}）`;
    }
  }

  const normalized = item?.change?.normalize('NFKC') ?? '';
  if (normalized.includes('黒字転換')) return '★★★★★（黒字転換）';
  if (normalized.includes('赤字転落')) return '★☆☆☆☆（赤字転落）';
  if (/赤字(?:幅)?(?:拡大|縮小)/.test(normalized)) return '★—（赤字のため評価対象外）';

  const percentage = parsePercentage(item?.change) ?? calculatePercentageChange(current, previous);
  if (percentage === null && current !== null && current < 0) {
    return `★—（赤字・${label}を算出不能）`;
  }
  if (percentage === null) return '—（評価対象指標を取得不能）';
  return `${ratingStars(yearComparisonScore(percentage))}（${label}${formatPercentage(percentage)}）`;
}

function calculatePercentageChange(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null || previous <= 0) return null;
  return ((current - previous) / previous) * 100;
}

function yearComparisonScore(percentage: number): number {
  if (percentage >= 30) return 5;
  if (percentage >= 10) return 4;
  if (percentage >= 3) return 3;
  if (percentage >= -3) return 2;
  return 1;
}

function buildProgress(
  actual: FinancialItem | undefined,
  forecast: FinancialItem | undefined,
  lastYearProgress: string | null | undefined
): EarningsExtraction['progress'] {
  const actualAmount = parseFinancialAmount(actual?.amount);
  const forecastAmounts = parseFinancialAmounts(forecast?.amount).filter((amount) => amount !== 0);
  if (actualAmount === null || actualAmount === 0 || forecastAmounts.length === 0) return null;

  const isLossConsumption =
    actualAmount < 0 && forecastAmounts.every((forecastAmount) => forecastAmount < 0);
  const isProfitProgress =
    actualAmount > 0 && forecastAmounts.every((forecastAmount) => forecastAmount > 0);
  if (!isLossConsumption && !isProfitProgress) return null;

  const rates = forecastAmounts
    .map((amount) => (Math.abs(actualAmount) / Math.abs(amount)) * 100)
    .sort((a, b) => a - b);
  const ordinaryIncome =
    rates.length === 1
      ? `${rates[0].toFixed(1)}%`
      : `${rates[0].toFixed(1)}%〜${rates[rates.length - 1].toFixed(1)}%`;
  return {
    ordinaryIncome,
    basis: isLossConsumption ? 'lossConsumption' : 'profitProgress',
    lastYearProgress: lastYearProgress ?? null,
    page: actual?.page ?? forecast?.page ?? null,
  };
}

function buildProgressRating(
  progress: NonNullable<EarningsExtraction['progress']>,
  context: EarningsContext
): string {
  const rates = parseAmounts(progress.ordinaryIncome);
  if (rates.length === 0) return '—（進捗率を算出不能）';
  const midpoint = rates.reduce((sum, rate) => sum + rate, 0) / rates.length;
  const standard = { q1: 25, q2: 50, q3: 75, fullYear: 100 }[context.period];
  const difference =
    progress.basis === 'lossConsumption' ? standard - midpoint : midpoint - standard;
  let score: number;
  if (difference >= 10) score = 5;
  else if (difference >= 5) score = 4;
  else if (difference > -5) score = 3;
  else if (difference >= -10) score = 2;
  else score = 1;
  const label = progress.basis === 'lossConsumption' ? '損失消化率' : '進捗率';
  return `${ratingStars(score)}（${label}${progress.ordinaryIncome} / 標準${standard}%）`;
}

function buildUnavailableProgressRating(
  actual: FinancialItem | undefined,
  forecast: FinancialItem | undefined
): string {
  const forecastAmount = parseFinancialAmount(forecast?.amount);
  const actualAmount = parseFinancialAmount(actual?.amount);
  if (actualAmount !== null && forecastAmount !== null) {
    if (actualAmount < 0 && forecastAmount > 0) {
      return '★—（赤字実績 / 通期黒字予想）';
    }
    if (actualAmount > 0 && forecastAmount < 0) {
      return '★—（黒字実績 / 通期赤字予想）';
    }
  }
  return '—（進捗率を算出不能）';
}

function parsePercentage(value: string | null | undefined): number | null {
  if (!value) return null;
  const normalized = value.normalize('NFKC').replace(/,/g, '').replace(/▲/g, '△');
  const match = normalized.match(/([+△-]?)(\d+(?:\.\d+)?)%/);
  if (!match) return null;
  const amount = Number(match[2]);
  return match[1] === '△' || match[1] === '-' ? -amount : amount;
}

function parseAmounts(value: string | null | undefined): number[] {
  if (!value) return [];
  const normalized = value.normalize('NFKC').replace(/,/g, '').replace(/▲/g, '△');
  return [...normalized.matchAll(/([△-]?)(\d+(?:\.\d+)?)/g)].map((match) => {
    const amount = Number(match[2]);
    return match[1] === '△' || match[1] === '-' ? -amount : amount;
  });
}

function parseFinancialAmount(value: string | null | undefined): number | null {
  return parseFinancialAmounts(value)[0] ?? null;
}

function parseFinancialAmounts(value: string | null | undefined): number[] {
  if (!value) return [];
  const normalized = value.normalize('NFKC').replace(/,/g, '').replace(/▲/g, '△');
  const multipliers: Record<string, number> = {
    兆円: 1e12,
    億円: 1e8,
    百万円: 1e6,
    千円: 1e3,
    円: 1,
  };
  const sharedUnit = normalized.match(/兆円|億円|百万円|千円|円/)?.[0] ?? '円';
  return [...normalized.matchAll(/([△-]?)(\d+(?:\.\d+)?)(兆円|億円|百万円|千円|円)?/g)].map(
    (match) => {
      const multiplier = multipliers[match[3] ?? sharedUnit] ?? 1;
      const amount = Number(match[2]) * multiplier;
      return match[1] === '△' || match[1] === '-' ? -amount : amount;
    }
  );
}

function formatPercentage(value: number): string {
  if (value < 0) return `△${Math.abs(value).toFixed(1)}%`;
  return `+${value.toFixed(1)}%`;
}

function formatComparisonAmount(value: string | null | undefined): string {
  return (value ?? '').replace(/\s*[（(](?:利益|損失)[）)]\s*$/, '').trim();
}

function ratingStars(score: number): string {
  return `${'★'.repeat(score)}${'☆'.repeat(5 - score)}`;
}

function isProfitAndLossItem(item: { text: string }): boolean {
  return /利益|損失|損益|費用|引当金|減損|売却益|売却損/.test(item.text);
}
