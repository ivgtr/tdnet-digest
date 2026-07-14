import { describe, expect, it } from 'vitest';
import type { EarningsExtraction } from './summary-schema';
import { refineEarningsExtraction } from './earnings-refinement';

function extraction(): EarningsExtraction {
  return {
    summary: '要約',
    performance: {
      periodLabel: '第1四半期連結実績',
      items: [
        {
          name: '売上収益',
          amount: '43,277百万円',
          previousAmount: '41,824百万円',
          change: '+3.5%',
          page: 1,
        },
        {
          name: '営業利益',
          amount: '3,378百万円',
          previousAmount: '3,049百万円',
          change: '+10.8%',
          page: 1,
        },
        { name: '税引前利益', amount: '3,221百万円', change: '+7.7%', page: 1 },
      ],
    },
    businessPl: {
      items: [
        {
          name: '売上総利益',
          amount: '12,000百万円',
          previousAmount: '10,000百万円',
          change: '+20.0%',
          page: 5,
        },
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
    forecastRevision: {
      direction: 'unchanged',
      metric: null,
      before: null,
      after: null,
      interpretation: '修正なし',
      page: 1,
      confidence: 'high',
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
      capitalActions: [],
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

  it('タイトルから非連結の業績期間ラベルを確定する', () => {
    const data = extraction();
    data.performance.periodLabel = '2026年5月期連結実績';
    const result = refineEarningsExtraction(
      data,
      { period: 'fullYear', accountingStandard: 'jpGaap', isConsolidated: false },
      '2026年5月期 決算短信〔日本基準〕（非連結）'
    );
    expect(result.performance.periodLabel).toBe('2026年5月期 実績');
  });

  it('来期配当予想と当期配当修正の時間軸を混同しない', () => {
    const data = extraction();
    data.dividend = {
      forecastAvailability: 'reported',
      periods: [
        {
          fiscalYear: '2026年5月期',
          status: 'actual',
          interim: '0円00銭',
          yearEnd: '32円00銭',
          annual: '32円00銭',
          comparisonAnnual: '13円50銭',
          comparisonBasis: 'reported',
          assessment: 'increase',
          interpretation: 'unknown',
          evidenceText: '2026年5月期 32円00銭',
          page: 1,
          confidence: 'high',
        },
        {
          fiscalYear: '2027年5月期',
          status: 'forecast',
          interim: '0円00銭',
          yearEnd: '57円00銭',
          annual: '57円00銭',
          comparisonAnnual: '32円00銭',
          comparisonBasis: 'reported',
          assessment: 'increase',
          interpretation: '来期も増配予想',
          evidenceText: '2027年5月期（予想）57円00銭',
          page: 1,
          confidence: 'high',
        },
      ],
      currentRevision: {
        fiscalYear: '2026年5月期',
        before: '30円00銭',
        after: '32円00銭',
        reason: '増配',
        page: 1,
      },
    };
    const result = refineEarningsExtraction(data, {
      period: 'fullYear',
      accountingStandard: 'jpGaap',
      isConsolidated: false,
    });
    expect(result.evaluation?.forecast?.revisionOrDividend).toBe('↑増配（32円→57円）');
    expect(result.dividend?.currentRevision).toMatchObject({ before: '30円00銭', after: '32円00銭' });
    expect(result.dividend?.periods[0].interpretation).toBe('');
  });

  it('LLMが配当の意味説明へnullを返してもクラッシュしない', () => {
    const data = extraction();
    data.dividend = {
      forecastAvailability: 'reported',
      periods: [
        {
          fiscalYear: '2026年11月期',
          status: 'forecast',
          interim: '0.00円',
          yearEnd: '10.00円',
          annual: '10.00円',
          comparisonAnnual: '10.00円',
          comparisonBasis: 'reported',
          assessment: 'unchanged',
          interpretation: null as unknown as string,
          evidenceText: '配当の状況',
          page: 1,
          confidence: 'high',
        },
      ],
      currentRevision: null,
    };
    expect(() => refineEarningsExtraction(data, context)).not.toThrow();
    expect(refineEarningsExtraction(data, context).dividend?.periods[0].interpretation).toBe('');
  });

  it('欠損した配当内訳の区切りを表示文字列へ残さない', () => {
    const data = extraction();
    data.dividend = {
      forecastAvailability: 'reported',
      periods: [
        {
          fiscalYear: '2027年5月期',
          status: 'forecast',
          interim: null,
          yearEnd: '0.00円',
          annual: '0.00円',
          comparisonAnnual: '0.00円',
          comparisonBasis: 'reported',
          assessment: 'unchanged',
          interpretation: '無配継続',
          evidenceText: '配当の状況',
          page: 1,
          confidence: 'high',
        },
      ],
      currentRevision: null,
    };
    const result = refineEarningsExtraction(data, context);
    expect(result.dividend?.periods[0].displayText).toBe('期末0.00円 / 年間0.00円');
    expect(result.dividend?.periods[0].displayText).not.toContain('中間');
  });

  it('営業利益率の比較値がなければ現在値だけを表示対象にする', () => {
    const data = extraction();
    data.earningsQuality.operatingMargin = {
      current: '△21.9%',
      previous: null,
      change: null,
      page: 1,
    };
    const result = refineEarningsExtraction(data, {
      period: 'fullYear',
      accountingStandard: 'jpGaap',
      isConsolidated: true,
    });
    expect(result.earningsQuality.operatingMargin).toMatchObject({
      current: '△21.9%',
      comparisonText: null,
    });
  });

  it.each([
    ['キャッシュ・フロー計算書は作成していない', 'notPrepared'],
    ['当該情報は開示していない', 'notReported'],
  ] as const)('営業CFの非報告表現「%s」を意味分類から非表示にする', (evidenceText, status) => {
    const data = extraction();
    data.earningsQuality.operatingCashFlow = {
      status,
      amount: null,
      direction: 'unknown',
      interpretation: '営業CFは確認できない',
      evidenceText,
      page: 7,
      confidence: 'high',
    };
    expect(refineEarningsExtraction(data, context).earningsQuality.operatingCashFlow).toBeNull();
  });

  it('金額と根拠のある営業CFは会社固有の表現でも保持する', () => {
    const data = extraction();
    data.earningsQuality.operatingCashFlow = {
      status: 'reported',
      amount: '527,243千円',
      direction: 'inflow',
      interpretation: '営業活動による資金は増加',
      evidenceText: '営業活動の結果得られた資金は527,243千円となりました',
      page: 5,
      confidence: 'high',
    };
    expect(refineEarningsExtraction(data, context).earningsQuality.operatingCashFlow).toMatchObject({
      amount: '527,243千円',
      direction: 'inflow',
    });
  });

  it('ゼロをまたぐ予想修正レンジは増減率を作らず金額で表示する', () => {
    const data = extraction();
    data.forecastRevision = {
      direction: 'up',
      metric: '経常利益',
      before: '△100〜100百万円',
      after: '200〜300百万円',
      interpretation: '経常利益予想を上方修正',
      page: 6,
      confidence: 'high',
    };
    const result = refineEarningsExtraction(data, {
      period: 'q2',
      accountingStandard: 'jpGaap',
      isConsolidated: true,
    });
    expect(result.evaluation?.forecast?.revisionOrDividend).toBe(
      '↑上方修正（経常利益：△100〜100百万円→200〜300百万円）'
    );
  });

  it('LLMの意味分類に基づき株主還元だけを表示対象にする', () => {
    const data = extraction();
    data.earningsQuality.capitalActions = [
      {
        type: 'stockSplit',
        purpose: '投資単位の引下げ',
        returnAssessment: 'capitalAction',
        interpretation: '1株を3株に分割',
        reason: '金銭的還元を伴わない',
        evidenceText: '普通株式1株につき3株の割合で株式分割を行う',
        page: 1,
        confidence: 'high',
      },
      {
        type: 'dividend',
        purpose: '利益還元',
        returnAssessment: 'shareholderReturn',
        interpretation: '年間配当を32円へ増額',
        reason: '配当額の増加を伴う',
        evidenceText: '期末配当金を30円から32円に変更予定',
        page: 1,
        confidence: 'high',
      },
    ];
    expect(refineEarningsExtraction(data, context).earningsQuality.capitalActions).toEqual([
      expect.objectContaining({ type: 'dividend', interpretation: '年間配当を32円へ増額' }),
    ]);
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

  it('売上と本業利益を事業P/Lとして別評価する', () => {
    const result = refineEarningsExtraction(extraction(), context);
    expect(result.businessPl?.items).toEqual([
      expect.objectContaining({
        name: '売上収益',
        assessment: '前年同期比+3.5%（増収）',
      }),
      expect.objectContaining({
        name: '売上総利益',
        assessment: '前年同期比+20.0%（粗利増加）',
      }),
      expect.objectContaining({
        name: '営業利益',
        assessment: '前年同期比+10.8%（増益）',
      }),
    ]);
  });

  it('事業P/Lの本業赤字縮小を改善として表示する', () => {
    const data = extraction();
    data.performance.items[1] = {
      name: '営業利益',
      amount: '△5百万円',
      previousAmount: '△16百万円',
      change: null,
      page: 1,
    };
    const result = refineEarningsExtraction(data, context);
    expect(result.businessPl?.items[2]?.assessment).toBe('赤字縮小68.8%: △16百万円 → △5百万円');
  });

  it('黒字転換・赤字転落は増減率がなくても明示判定する', () => {
    const data = extraction();
    data.performance.items[2].change = '黒字転換';
    data.forecast!.items[0].change = '赤字転落';
    const result = refineEarningsExtraction(data, context);
    expect(result.evaluation?.actual.vsLastYear).toBe('★★★★★（黒字転換）');
    expect(result.evaluation?.forecast?.vsLastYear).toBe('★☆☆☆☆（赤字転落）');
  });

  it('比較金額から増減率を補完する', () => {
    const data = extraction();
    data.performance.items[2].change = null;
    data.performance.items[2].previousAmount = '2,990百万円';
    const result = refineEarningsExtraction(data, context);
    expect(result.evaluation?.actual.vsLastYear).toBe('★★★☆☆（前年同期比+7.7%）');
  });

  it('CaSyの前年黒字から当期赤字への文脈を赤字転落として表示する', () => {
    const data = extraction();
    data.performance.items = [
      {
        name: '経常利益',
        amount: '△5,818千円（損失）',
        previousAmount: '16,185千円',
        change: null,
        page: 1,
      },
    ];
    data.forecast = {
      label: '通期予想',
      items: [
        {
          name: '経常利益',
          amount: '△139百万円',
          previousAmount: null,
          change: null,
          page: 1,
        },
      ],
    };
    const result = refineEarningsExtraction(data, {
      period: 'q2',
      accountingStandard: 'jpGaap',
      isConsolidated: true,
    });
    expect(result.evaluation?.actual.vsLastYear).toBe('★☆☆☆☆（赤字転落: 16,185千円 → △5,818千円）');
    expect(result.evaluation?.actual.progressOrLanding).toBe('★★★★★（損失消化率4.2% / 標準50%）');
    expect(result.evaluation?.forecast?.vsLastYear).toBe('★—（赤字・前期比を算出不能）');
    expect(result.progress).toMatchObject({
      ordinaryIncome: '4.2%',
      basis: 'lossConsumption',
    });
  });

  it('赤字継続は金額の文脈から縮小・拡大を区別する', () => {
    const data = extraction();
    data.performance.items[2] = {
      name: '税引前利益',
      amount: '△5百万円',
      previousAmount: '△16百万円',
      change: null,
      page: 1,
    };
    const result = refineEarningsExtraction(data, context);
    expect(result.evaluation?.actual.vsLastYear).toBe(
      '★★★★★（赤字縮小68.8%: △16百万円 → △5百万円）'
    );
  });
});
