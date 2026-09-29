import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assessClaim,
  compatible,
  directionOf,
  inferExperimentalScore,
  type ScoreClaim,
  type ScoreValue,
} from './scoring';
import { extractScoreInput, validateScoreInput, type ScoreDocument } from './score-extraction';
import { buildScoreHtml } from '../content/utils/summaryHtmlBuilder';
import { ScoreBadge } from '../content/ScoreBadge';
import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';

const { generateText } = vi.hoisted(() => ({ generateText: vi.fn() }));
vi.mock('./llm-client', () => ({ generateText }));
const url = 'https://issuer.example/report.pdf';
const config = { provider: 'openai', apiKey: 'test', model: 'test' };
function value(
  number: number,
  year: number,
  metric = '営業利益',
  kind: ScoreValue['source']['valueKind'] = 'actual'
): ScoreValue {
  const period = `${year}年3月期通期`;
  return {
    value: number,
    unit: '百万円',
    source: {
      url,
      page: 1,
      quote: `${period} ${metric} ${number}百万円`,
      period,
      fiscalYear: year,
      periodKind: 'fullYear',
      valueKind: kind,
      metric,
      basis: '日本基準',
      scope: '連結',
    },
  };
}
function claim(
  category: ScoreClaim['category'],
  current: ScoreValue,
  previous: ScoreValue | null,
  earlier: ScoreValue | null = null
): ScoreClaim {
  return {
    category,
    label: category,
    current,
    previous,
    earlier,
    relatedValue: null,
    companyExplanation: null,
  };
}
function input(claims: ScoreClaim[]) {
  return { claims, unverified: [], searchStatus: '元PDF内を確認' };
}
function answer(value: number, impacts: Array<'positive' | 'negative' | 'neutral'>) {
  return JSON.stringify({
    value,
    factors: impacts.map((impact, index) => ({ index, impact, strength: 'medium' })),
  });
}
beforeEach(() => generateText.mockReset());

describe('検算済み事実からの推論スコア', () => {
  it('通期と四半期、開示年度の順序を誤比較しない', () => {
    const current = value(145, 2026);
    const previous = value(130, 2025);
    previous.source.periodKind = 'cumulativeQ1';
    expect(compatible(current, previous)).toBe(false);
    expect(assessClaim(claim('operatingProfit', current, previous))).toBeNull();
    previous.source.periodKind = 'fullYear';
    previous.source.fiscalYear = 2027;
    expect(compatible(current, previous)).toBe(false);
    previous.source.fiscalYear = 2025;
    previous.source.periodKind = 'fullYear';
    previous.source.period = '2025年12月期通期';
    expect(compatible(current, previous)).toBe(false);
  });

  it('前年比増益でも成長鈍化を悪材料と判定する', async () => {
    const profit = claim('operatingProfit', value(145.6, 2026), value(130, 2025), value(100, 2024));
    const sales = claim(
      'revenue',
      value(1209.6, 2026, '売上高'),
      value(1120, 2025, '売上高'),
      value(1000, 2024, '売上高')
    );
    expect(directionOf(profit)).toBe('negative');
    generateText.mockResolvedValueOnce(answer(28, ['negative', 'negative']));
    const score = await inferExperimentalScore(config, 'earnings', input([profit, sales]));
    expect(score.value).toBe(28);
    expect(score.verdict).toBe('悪材料');
    expect(score.negatives).toHaveLength(2);
  });

  it('純利益だけの一時益と本業改善を別々に扱う', async () => {
    const oneOff = claim(
      'oneOff',
      value(1500, 2026, '純利益予想', 'forecastAfter'),
      value(1000, 2026, '純利益予想', 'forecastBefore')
    );
    oneOff.relatedValue = value(500, 2026, '株式売却益', 'forecastAfter');
    const oneOffDoc: ScoreDocument = {
      url,
      publishedDate: '2026-07-14',
      issuer: '会社',
      code: '1234',
      text: `[PDF_PAGE:1]\n会社 日本基準 連結\n${oneOff.current.source.quote}\n${oneOff.previous?.source.quote}\n${oneOff.relatedValue.source.quote}`,
    };
    expect(
      validateScoreInput(JSON.stringify({ claims: [oneOff], unverified: [] }), [oneOffDoc], '')
        .claims
    ).toHaveLength(1);
    generateText.mockResolvedValueOnce(answer(53, ['positive']));
    const onlyGain = await inferExperimentalScore(config, 'earningsRevision', input([oneOff]));
    expect(onlyGain.verdict).toBe('中立');
    const core = claim(
      'coreForecast',
      value(1150, 2026, '営業利益予想', 'forecastAfter'),
      value(1000, 2026, '営業利益予想', 'forecastBefore')
    );
    generateText.mockResolvedValueOnce(answer(73, ['positive', 'positive']));
    const both = await inferExperimentalScore(config, 'earningsRevision', input([core, oneOff]));
    expect(both.verdict).toBe('好材料');
    expect(both.positives).toHaveLength(2);
    oneOff.relatedValue.source.scope = '別事業';
    expect(assessClaim(oneOff)).toBeNull();
  });

  it('比較不能なら点数を出さず未確認を詳細に表示する', async () => {
    const result = await inferExperimentalScore(config, 'earnings', {
      claims: [],
      unverified: ['検索候補の対象期が不一致'],
      searchStatus: '候補不採用',
    });
    expect(result.value).toBeNull();
    expect(buildScoreHtml(result)).toContain('検索候補の対象期が不一致');
    expect(generateText).not.toHaveBeenCalled();
  });

  it('数値だけ一致し、指標・期間・単位がない引用を拒否する', () => {
    const current = value(500, 2026);
    current.source.quote = '500';
    const doc: ScoreDocument = {
      url,
      text: '[PDF_PAGE:1]\n会社 日本基準 連結 2026年3月期通期 営業利益 400百万円 500',
      publishedDate: '2026-07-14',
      issuer: '会社',
      code: '1234',
    };
    const raw = JSON.stringify({
      claims: [claim('operatingProfit', current, value(400, 2025))],
      unverified: [],
    });
    const result = validateScoreInput(raw, [doc], '');
    expect(result.claims).toHaveLength(0);
    expect(result.unverified.join('')).toContain('数値・単位・指標・期間');
  });

  it('表の近くの期間と単位見出しを数値行に結び付ける', () => {
    const current = value(1150, 2026, '営業利益予想', 'forecastAfter');
    const previous = value(1000, 2026, '営業利益予想', 'forecastBefore');
    current.source.quote = '営業利益予想 1150';
    previous.source.quote = '営業利益予想 1000';
    const doc: ScoreDocument = {
      url,
      publishedDate: '2026-07-14',
      issuer: '会社',
      code: '1234',
      text: '[PDF_PAGE:1]\n会社 日本基準 連結\n2026年3月期通期\n単位: 百万円\n営業利益予想 1150\n営業利益予想 1000',
    };
    const result = validateScoreInput(
      JSON.stringify({
        claims: [claim('coreForecast', current, previous)],
        unverified: [],
      }),
      [doc],
      ''
    );
    expect(result.claims).toHaveLength(1);
    current.source.quote = '営業利益予想 1000 1150';
    previous.source.quote = current.source.quote;
    doc.text += '\n営業利益予想 1000 1150';
    const ambiguous = validateScoreInput(
      JSON.stringify({
        claims: [claim('coreForecast', current, previous)],
        unverified: [],
      }),
      [doc],
      ''
    );
    expect(ambiguous.claims).toHaveLength(0);
  });

  it('会社公開の配当資料の決定額と直近予想を同じ基準日で照合する', async () => {
    const issuerUrl = 'https://www.meikonet.co.jp/ja/ir/ir-news/auto_20260714593367/pdfFile.pdf';
    const quote =
      '基準日 2026 年８月 31 日 2026 年８月 31 日 2025 年８月 31 日\n１株当たり配当金 15 円 00 銭 14 円 00 銭 14 円 00 銭';
    const document: ScoreDocument = {
      url: issuerUrl,
      text: `[PDF_PAGE:1]\n2026年７月14日\n株式会社明光ネットワークジャパン\n１．配当の内容\n直近の配当予想 前期実績（期末）\n決定額\n（2025年10月14日公表）\n${quote}\n期末配当を従来予想より１円増配の 15 円とします。`,
      publishedDate: '2026-07-14',
      issuer: '株式会社明光ネットワークジャパン',
      code: '4668',
    };
    const dividend = (amount: number, kind: 'forecastBefore' | 'forecastAfter'): ScoreValue => ({
      value: amount,
      unit: '円',
      source: {
        url: issuerUrl,
        page: 1,
        quote,
        period: '2026年8月31日',
        fiscalYear: 2026,
        periodKind: 'eventDate',
        valueKind: kind,
        metric: '1株当たり配当金',
        basis: '非財務',
        scope: '1株当たり配当金',
      },
    });
    const raw = JSON.stringify({
      claims: [
        claim('shareholderReturn', dividend(15, 'forecastAfter'), dividend(14, 'forecastBefore')),
      ],
      unverified: [],
    });
    const extracted = validateScoreInput(raw, [document], '元PDF内を確認');
    expect(extracted.claims).toHaveLength(1);
    const reversed = validateScoreInput(
      JSON.stringify({
        claims: [
          claim('shareholderReturn', dividend(14, 'forecastAfter'), dividend(15, 'forecastBefore')),
        ],
        unverified: [],
      }),
      [document],
      ''
    );
    expect(reversed.claims).toHaveLength(0);
    const direct = await extractScoreInput(config, 'dividend', [document], '元PDF内を確認');
    expect(direct.claims).toHaveLength(1);
    expect(generateText).not.toHaveBeenCalled();
    generateText.mockResolvedValueOnce(answer(56, ['positive']));
    const score = await inferExperimentalScore(config, 'dividend', extracted);
    expect(score.verdict).toBe('やや好材料');
    expect(buildScoreHtml(score)).toContain('pdfFile.pdf#page=1');
    expect(renderToStaticMarkup(React.createElement(ScoreBadge, { score }))).toContain('56/100');
  });

  it('後日公開された候補と事業範囲の違う項目だけを比較から外す', () => {
    const current = value(1150, 2026, '営業利益予想', 'forecastAfter');
    const previous = value(1000, 2026, '営業利益予想', 'forecastBefore');
    previous.source.scope = '海外事業含む';
    const sales = claim('revenue', value(1200, 2026, '売上高'), value(1000, 2025, '売上高'));
    const doc: ScoreDocument = {
      url,
      publishedDate: '2026-07-14',
      issuer: '会社',
      code: '1234',
      text: `[PDF_PAGE:1]\n会社 日本基準 連結 国内事業 海外事業含む\n${current.source.quote}\n${previous.source.quote}\n${sales.current.source.quote}\n${sales.previous?.source.quote}`,
    };
    const checked = validateScoreInput(
      JSON.stringify({
        claims: [claim('coreForecast', current, previous), sales],
        unverified: [],
      }),
      [doc],
      ''
    );
    expect(checked.claims.map((item) => item.category)).toEqual(['revenue']);
    expect(checked.unverified.join('')).toContain('比較の期間・指標・会計基準・範囲');

    const pastUrl = 'https://issuer.example/newer.pdf';
    const later = value(1000, 2025, '売上高');
    later.source.url = pastUrl;
    const futureDoc: ScoreDocument = { ...doc, url: pastUrl, publishedDate: '2026-08-01' };
    const futureInput = validateScoreInput(
      JSON.stringify({
        claims: [claim('revenue', sales.current, later)],
        unverified: [],
      }),
      [doc, futureDoc],
      ''
    );
    expect(futureInput.claims).toHaveLength(0);
    expect(futureInput.unverified.join('')).toContain('開示日の前後');
  });

  it('自己株取得と増資は発行済株式数に対する規模を検算して方向を分ける', async () => {
    const base = value(1000, 2026, '発行済株式数', 'actual');
    base.unit = '株';
    base.source.period = '2026年7月14日';
    base.source.periodKind = 'eventDate';
    base.source.basis = '非財務';
    base.source.scope = '普通株式';
    base.source.quote = '2026年7月14日 発行済株式数 1000株 普通株式';
    const make = (metric: string) => {
      const current = {
        ...base,
        value: 50,
        source: {
          ...base.source,
          metric,
          valueKind: 'forecastAfter' as const,
          quote: `2026年7月14日 ${metric} 50株 普通株式`,
        },
      };
      return current;
    };
    const buyback = claim('shareholderReturn', make('取得上限株式数'), null);
    buyback.relatedValue = base;
    const issue = claim('capitalAction', make('新株発行株式数'), null);
    issue.relatedValue = base;
    const doc: ScoreDocument = {
      url,
      publishedDate: '2026-07-14',
      issuer: '会社',
      code: '1234',
      text: `[PDF_PAGE:1]\n会社 普通株式\n${base.source.quote}\n${buyback.current.source.quote}\n${issue.current.source.quote}`,
    };
    const checked = validateScoreInput(
      JSON.stringify({ claims: [buyback, issue], unverified: [] }),
      [doc],
      ''
    );
    expect(checked.claims).toHaveLength(2);
    expect(assessClaim(checked.claims[0])).toContain('5.00%');
    expect(directionOf(checked.claims[0])).toBe('positive');
    expect(directionOf(checked.claims[1])).toBe('negative');
    generateText.mockResolvedValueOnce(answer(51, ['positive', 'negative']));
    const result = await inferExperimentalScore(config, 'capitalPolicy', checked);
    expect(result.breakdown).toHaveLength(2);
  });
});
