import { describe, expect, it } from 'vitest';
import type { EarningsExtraction } from './summary-schema';
import { refineEarningsExtraction } from './earnings-refinement';

function extraction(): EarningsExtraction {
  return {
    summary: '要約',
    performance: {
      periodLabel: '第1四半期連結実績',
      items: [
        { name: '営業利益', amount: '3,378百万円', change: '+10.8%', page: 1 },
        { name: '税引前利益', amount: '3,221百万円', change: '+7.7%', page: 1 },
      ],
    },
    evaluation: {
      actual: { vsLastYear: '★★★★★（前年同期比+10.8%）', progressOrLanding: null },
      forecast: {
        vsLastYear: '★★★★☆（前期比+1.8%）',
        revisionOrDividend: '→据置',
      },
    },
    progress: null,
    forecast: {
      label: '通期予想',
      items: [{ name: '税引前利益', amount: '8,000百万円', change: '+1.8%', page: 1 }],
    },
    revision: '修正なし',
    dividend: null,
    earningsQuality: {
      operatingMargin: null,
      coreEarnings: null,
      oneOffItems: [
        { text: 'SFPとの合併により経営効率化を推進', page: 4 },
        { text: '減損損失115百万円を計上', page: 12 },
      ],
      operatingCashFlow: null,
      financialHealth: [],
      shareholderReturns: [],
    },
    investmentView: {
      shortTerm: { stance: 'neutral', rationale: [] },
      mediumTerm: { stance: 'neutral', rationale: [] },
      longTerm: { stance: 'neutral', rationale: [] },
      positives: [],
      risks: [],
      watchPoints: [],
      rationale: '理由',
    },
    topics: [],
  };
}

describe('決算抽出の決定論的補正', () => {
  const context = {
    period: 'q1' as const,
    accountingStandard: 'ifrs' as const,
    isConsolidated: true,
  };

  it('IFRSの税引前利益で対前年と通期予想を再評価する', () => {
    const result = refineEarningsExtraction(extraction(), context);
    expect(result.evaluation?.actual.vsLastYear).toBe('★★★☆☆（前年同期比+7.7%）');
    expect(result.evaluation?.forecast?.vsLastYear).toBe('★★☆☆☆（前期比+1.8%）');
  });

  it('実績と通期予想から四半期進捗を再計算する', () => {
    const result = refineEarningsExtraction(extraction(), context);
    expect(result.progress?.ordinaryIncome).toBe('40.3%');
    expect(result.evaluation?.actual.progressOrLanding).toBe('★★★★★（進捗率40.3% / 標準25%）');
  });

  it('損益ではない合併説明を一時損益から除外する', () => {
    const result = refineEarningsExtraction(extraction(), context);
    expect(result.earningsQuality.oneOffItems).toEqual([
      { text: '減損損失115百万円を計上', page: 12 },
    ]);
  });

  it('黒字転換・赤字転落は増減率がなくても明示判定する', () => {
    const data = extraction();
    data.performance.items[1].change = '黒字転換';
    data.forecast!.items[0].change = '赤字転落';
    const result = refineEarningsExtraction(data, context);
    expect(result.evaluation?.actual.vsLastYear).toBe('★★★★★（黒字転換）');
    expect(result.evaluation?.forecast?.vsLastYear).toBe('★☆☆☆☆（赤字転落）');
  });
});
