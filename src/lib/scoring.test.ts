import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  assessClaim,
  compatible,
  directionOf,
  inferExperimentalScore,
  type ScoreClaim,
  type ScoreValue,
} from './scoring';
import { generateText } from './llm-client';
import { buildScoreHtml } from '../content/utils/summaryHtmlBuilder';
vi.mock('./llm-client', () => ({ generateText: vi.fn() }));
function value(
  n: number,
  year: number,
  metric = '営業利益',
  kind: ScoreValue['source']['valueKind'] = 'actual'
): ScoreValue {
  return {
    value: n,
    unit: '百万円',
    source: {
      url: 'https://issuer.example/report.pdf',
      page: 1,
      evidence: null,
      quote: `${year}年3月期 ${metric}${n}百万円`,
      period: `${year}年3月期通期`,
      fiscalYear: year,
      periodKind: 'fullYear',
      valueKind: kind,
      metric,
      basis: '日本基準',
      scope: '連結',
      factId: `${metric}-${year}`,
      semantics: {
        subject: '会社',
        scope: '連結',
        basis: '日本基準',
        periodKind: 'fullYear',
        metricKind: 'amount',
        qualifiers: [],
        state: kind,
        polarity: 'affirmative',
        conditions: [],
      },
    },
  };
}
const claim = (
  current: ScoreValue,
  previous: ScoreValue | null,
  earlier: ScoreValue | null = null
): ScoreClaim => ({
  category: 'operatingProfit',
  label: '営業利益',
  current,
  previous,
  earlier,
  relatedValue: null,
  companyExplanation: null,
});
const config = { provider: 'openai', model: 'test', apiKey: 'test' };
beforeEach(() => vi.mocked(generateText).mockReset());
describe('共通事実の比較とスコア推論', () => {
  it('通期・累計・年度・対象を混ぜない', () => {
    const a = value(100, 2026),
      b = value(80, 2025);
    expect(compatible(a, b)).toBe(true);
    b.source.periodKind = 'cumulativeQ1';
    expect(compatible(a, b)).toBe(false);
    b.source.periodKind = 'fullYear';
    b.source.semantics.subject = '別会社';
    expect(compatible(a, b)).toBe(false);
  });
  it('上限・概算と確定額を同じ比較値にしない', () => {
    const a = value(100, 2026),
      b = value(80, 2025);
    a.source.semantics.qualifiers = ['上限'];
    expect(compatible(a, b)).toBe(false);
  });
  it('通常予想を修正後予想として比較しない', () => {
    const a = value(100, 2026, '営業利益', 'forecast'),
      b = value(80, 2026, '営業利益', 'forecastBefore');
    expect(compatible(a, b, true)).toBe(false);
  });
  it('前年比増益でも加速・鈍化を分ける', async () => {
    const c = claim(value(145.6, 2026), value(130, 2025), value(100, 2024));
    expect(directionOf(c)).toBe('negative');
    vi.mocked(generateText).mockResolvedValueOnce(
      JSON.stringify({ value: 35, factors: [{ index: 0, impact: 'negative', strength: 'medium' }] })
    );
    const result = await inferExperimentalScore(config, 'earnings', {
      claims: [c],
      unverified: [],
      searchStatus: '元資料',
    });
    expect(result.value).toBe(35);
    expect(buildScoreHtml(result)).toContain('35/100');
  });
  it('比較不能なら点数を出さない', async () => {
    const c = claim(value(100, 2026), null);
    expect(assessClaim(c)).toBeNull();
    const result = await inferExperimentalScore(config, 'earnings', {
      claims: [c],
      unverified: [],
      searchStatus: '元資料',
    });
    expect(result.value).toBeNull();
    expect(generateText).not.toHaveBeenCalled();
  });
  it('純利益の一時益を本業改善として採点しない', async () => {
    const current = value(200, 2026, '当期純利益', 'forecastAfter'),
      previous = value(100, 2026, '当期純利益', 'forecastBefore');
    const c: ScoreClaim = {
      ...claim(current, previous),
      category: 'oneOff',
      label: '一時益',
      relatedValue: value(100, 2026, '固定資産売却益', 'forecastAfter'),
    };
    expect(assessClaim(c)).toContain('一時損益');
    vi.mocked(generateText).mockResolvedValueOnce(
      JSON.stringify({ value: 53, factors: [{ index: 0, impact: 'positive', strength: 'small' }] })
    );
    const result = await inferExperimentalScore(config, 'earningsRevision', {
      claims: [c],
      unverified: [],
      searchStatus: '元資料',
    });
    expect(result.value).toBe(53);
  });
  it('自己株取得・増資の規模を同じ主体・範囲・基準日時だけで計算する', () => {
    const current = value(200, 2026, '取得株式数', 'planned'),
      shares = value(10000, 2026, '発行済株式数');
    current.unit = shares.unit = '株';
    const c: ScoreClaim = {
      ...claim(current, null),
      category: 'shareholderReturn',
      relatedValue: shares,
    };
    expect(assessClaim(c)).toContain('2.00%');
    expect(directionOf(c)).toBe('positive');
    current.source.metric = '新株発行株式数';
    c.category = 'capitalAction';
    expect(directionOf(c)).toBe('negative');
    shares.source.period = '2026年2月28日時点';
    expect(assessClaim(c)).toBeNull();
    shares.source.period = current.source.period;
    current.source.scope = shares.source.scope = null;
    current.source.semantics.scope = shares.source.semantics.scope = null;
    expect(assessClaim(c)).toBeNull();
  });
  it('実績と予想、上限、条件の違いを同比較に入れない', () => {
    const a = value(100, 2026),
      b = value(80, 2025);
    b.source.semantics.conditions = ['実施条件'];
    expect(compatible(a, b)).toBe(false);
  });
});
