import { describe, expect, it } from 'vitest';
import type { DividendExtraction } from './summary-schema';
import { calculateExperimentalScore, formatExperimentalScore } from './scoring';

function extraction(): DividendExtraction {
  return {
    summary: '増配',
    dividendDetails: {
      interim: null,
      yearEnd: null,
      annual: null,
      payoutRatio: null,
      revision: null,
      comparison: null,
    },
    policy: null,
    investmentView: {
      shortTerm: { stance: 'positive', rationale: [{ text: '増配', page: 2 }] },
      mediumTerm: { stance: 'neutral', rationale: [{ text: '方針維持', page: 1 }] },
      longTerm: { stance: 'negative', rationale: [] },
      positives: [],
      risks: [],
      watchPoints: [],
      rationale: '増配は好材料だが長期余力に懸念。',
    },
    topics: [],
  };
}

describe('実験的スコア', () => {
  it('文書タイプ別の重みで固定換算する', () => {
    const score = calculateExperimentalScore('dividend', extraction());
    expect(score).toMatchObject({ shortTerm: 80, mediumTerm: 50, longTerm: 20, overall: 50 });
    expect(score?.reason).toBe('増配は好材料だが長期余力に懸念。');
    expect(score?.evidencePages).toEqual([1, 2]);
  });

  it('判断不能の時間軸を除外して再加重する', () => {
    const value = extraction();
    value.investmentView.longTerm.stance = 'unknown';
    const score = calculateExperimentalScore('dividend', value);
    expect(score?.longTerm).toBeNull();
    expect(score?.overall).toBe(63);
  });

  it('表示に実験値の注意書きを含める', () => {
    const score = calculateExperimentalScore('dividend', extraction());
    expect(score).not.toBeNull();
    const text = formatExperimentalScore(score!);
    expect(text).toContain('## 実験的スコア（参考）');
    expect(text).toContain('根拠ページ: [p.1, p.2]');
    expect(text).toContain('株価・コンセンサス・バリュエーションは含みません');
  });
});
