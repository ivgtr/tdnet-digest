import type { EarningsContext } from './document-type';
import type { EarningsExtraction } from './summary-schema';

type FinancialItem = EarningsExtraction['performance']['items'][number];

export function refineEarningsExtraction(
  extraction: EarningsExtraction,
  context: EarningsContext
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
  const evaluation = {
    actual: {
      vsLastYear: actualComparison,
      progressOrLanding:
        context.period === 'fullYear'
          ? (previousEvaluation?.actual.progressOrLanding ?? null)
          : progress
            ? buildProgressRating(progress.ordinaryIncome, context)
            : buildUnavailableProgressRating(actualMetric, forecastMetric),
    },
    forecast: extraction.forecast
      ? {
          vsLastYear: forecastComparison,
          revisionOrDividend: previousEvaluation?.forecast?.revisionOrDividend ?? null,
        }
      : null,
  };

  return {
    ...extraction,
    evaluation,
    progress,
    earningsQuality: {
      ...extraction.earningsQuality,
      oneOffItems: extraction.earningsQuality.oneOffItems.filter(isProfitAndLossItem),
    },
  };
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
    if (previous < 0 && current < 0) {
      const state = Math.abs(current) < Math.abs(previous) ? '赤字縮小' : '赤字拡大';
      return `★—（${state}: ${comparison}）`;
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
  const actualAmount = parseAmounts(actual?.amount)[0];
  const forecastAmounts = parseAmounts(forecast?.amount).filter((amount) => amount > 0);
  if (actualAmount === undefined || actualAmount <= 0 || forecastAmounts.length === 0) return null;

  const rates = forecastAmounts
    .map((amount) => (actualAmount / amount) * 100)
    .sort((a, b) => a - b);
  const ordinaryIncome =
    rates.length === 1
      ? `${rates[0].toFixed(1)}%`
      : `${rates[0].toFixed(1)}%〜${rates[rates.length - 1].toFixed(1)}%`;
  return {
    ordinaryIncome,
    lastYearProgress: lastYearProgress ?? null,
    page: actual?.page ?? forecast?.page ?? null,
  };
}

function buildProgressRating(progress: string, context: EarningsContext): string {
  const rates = parseAmounts(progress);
  if (rates.length === 0) return '—（進捗率を算出不能）';
  const midpoint = rates.reduce((sum, rate) => sum + rate, 0) / rates.length;
  const standard = { q1: 25, q2: 50, q3: 75, fullYear: 100 }[context.period];
  const difference = midpoint - standard;
  let score: number;
  if (difference >= 10) score = 5;
  else if (difference >= 5) score = 4;
  else if (difference > -5) score = 3;
  else if (difference >= -10) score = 2;
  else score = 1;
  return `${ratingStars(score)}（進捗率${progress} / 標準${standard}%）`;
}

function buildUnavailableProgressRating(
  actual: FinancialItem | undefined,
  forecast: FinancialItem | undefined
): string {
  const forecastAmount = parseFinancialAmount(forecast?.amount);
  if (forecastAmount !== null && forecastAmount <= 0) {
    return '★—（赤字予想のため進捗率対象外）';
  }
  const actualAmount = parseFinancialAmount(actual?.amount);
  if (actualAmount !== null && actualAmount <= 0) {
    return '★—（赤字実績のため進捗率対象外）';
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
  if (!value) return null;
  const normalized = value.normalize('NFKC').replace(/,/g, '').replace(/▲/g, '△');
  const match = normalized.match(/([△-]?)(\d+(?:\.\d+)?)(兆円|億円|百万円|千円|円)?/);
  if (!match) return null;
  const multipliers: Record<string, number> = {
    兆円: 1e12,
    億円: 1e8,
    百万円: 1e6,
    千円: 1e3,
    円: 1,
  };
  const multiplier = multipliers[match[3] ?? '円'] ?? 1;
  const amount = Number(match[2]) * multiplier;
  return match[1] === '△' || match[1] === '-' ? -amount : amount;
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
