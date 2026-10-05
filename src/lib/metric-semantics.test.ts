import { describe, expect, it } from 'vitest';
import {
  classifyMetric,
  perShareProfitKeys,
  isPerShareDividend,
  proseReportingMetrics,
  reportingMetricKey,
} from './metric-semantics';
import { textPage, numberCandidate } from './fixtures/v4-test-source';
import { parseFactSummary } from './fact-summary';
import { toValue, validateScoreInput } from './score-extraction';

describe('数量の指標区分と配当の分母', () => {
  it.each([
    ['年間配当金合計', '円', 'perShare'],
    ['年間配当金期末', '円', 'perShare'],
    ['1株当たり配当金', '千円', 'perShare'],
    ['配当金総額', '百万円', 'amount'],
    ['配当金総額', '円', 'amount'],
    ['配当金', '百万円', 'amount'],
    ['配当金支払額', '円', 'amount'],
    ['配当金増減率', '%', 'rate'],
  ])('%s / %s の意味を分類する', (label, unit, kind) =>
    expect(classifyMetric(label, unit)).toBe(kind)
  );

  it.each([
    ['配当金総額', '百万円'],
    ['配当金総額', '円'],
    ['配当金', '百万円'],
  ])(
    '%s / %s の総額を確定できても範囲・基準なしでは採点せず、perShareへの誤分類を拒否する',
    (label, unit) => {
      const pages = ['修正前予想', '修正後予想'].map((state, index) =>
        textPage(
          `会社名 株式会社テスト\n2026年3月期 ${state}\n${label}は${100 + index * 10}${unit}です。`,
          index + 1
        )
      );
      const candidates = pages.map((page, index) => {
        const fact = numberCandidate(page, label, 100 + index * 10);
        fact.id = `f${index + 1}`;
        fact.unit = unit;
        fact.semantics.scope = fact.semantics.basis = null;
        fact.valueKind = fact.semantics.state = index ? 'forecastAfter' : 'forecastBefore';
        return fact;
      });
      const raw = (facts: unknown[]) =>
        JSON.stringify({ version: 5, documentType: 'other', facts, unverified: [] });
      const facts = parseFactSummary(raw(candidates), 'other', pages);
      expect(facts.unverified).toEqual([]);
      expect(facts.facts).toHaveLength(2);
      const document = {
        url: 'https://www.release.tdnet.info/inbs/test.pdf',
        text: '',
        pages,
        issuer: '株式会社テスト',
        code: '1234',
        documentHash: 'a'.repeat(64),
        publishedDate: null,
      };
      expect(() => toValue(facts.facts[1], document)).toThrow('範囲');
      const input = validateScoreInput(
        JSON.stringify({
          version: 4,
          claims: [
            {
              category: 'shareholderReturn',
              label,
              current: facts.facts[1].id,
              previous: facts.facts[0].id,
              earlier: null,
              relatedValue: null,
              companyExplanation: null,
            },
          ],
          unverified: [],
        }),
        [{ document, facts }],
        '原文'
      );
      expect(input.claims).toHaveLength(0);
      expect(input.unverified.join(' ')).toContain('範囲');
      const wrong = candidates.map((f) => ({
        ...f,
        semantics: { ...f.semantics, metricKind: 'perShare' },
      }));
      expect(parseFactSummary(raw(wrong), 'other', pages, false).facts).toHaveLength(0);
      const forged = structuredClone(facts.facts[1]);
      forged.semantics.metricKind = 'perShare';
      expect(() => toValue(forged, document)).toThrow('範囲');
    }
  );
});

it.each([
  ['EPS', '基本的1株当たり当期利益', true],
  ['基本的1株当たり当期利益', 'eps', true],
  ['EPS', '1株当たり純利益', true],
  ['EPS', '希薄化後1株当たり当期利益', false],
  ['EPS', '希薄化後EPS', false],
  ['EPS', '潜在株式調整後eps', false],
  ['EPS', '基本的EPS', true],
  ['EPS', '潜在株式調整後1株当たり当期利益', false],
  ['EPS', '1株当たり四半期利益', false],
  ['EPS', '1株当たり中間損失', false],
])('EPSの別名を共通の指標キーで照合する: %s / %s', (left, right, equal) => {
  const keys = perShareProfitKeys(left);
  expect(keys).toHaveLength(1);
  expect(keys[0] === perShareProfitKeys(right)[0]).toBe(equal);
});

it.each([
  [
    '配当予想',
    '円',
    'なお、配当予想につきましては2026年5月7日公表の1株当たり35円より変更はございません。',
    true,
  ],
  ['配当予想', '円', '配当予想は35円です。', false],
  [
    '配当予想',
    '百万円',
    'なお、配当予想につきましては2026年5月7日公表の1株当たり35円より変更はございません。',
    false,
  ],
  [
    '配当金総額',
    '円',
    'なお、配当予想につきましては2026年5月7日公表の1株当たり35円より変更はございません。',
    false,
  ],
])(
  '据置配当の分母証明はラベル・単位・原文が揃った場合だけ使う: %s / %s / %s',
  (label, unit, source, perShare) => {
    expect(isPerShareDividend(label, unit, source)).toBe(perShare);
    expect(classifyMetric(label, unit, source)).toBe(perShare ? 'perShare' : 'amount');
  }
);

it.each([
  ['(1)調整後経常利益は9百万円\n(2)経常利益は10百万円', ['経常利益']],
  ['調整後経常\n利益は9百万円', []],
  ['調整後経常利益は9百万円', []],
  ['コア営業利益は9百万円', []],
  ['調整後の経常利益は9百万円', []],
  ['非経常利益は9百万円', []],
  ['調整後純利益は9百万円', []],
  ['修正EPSは9円', []],
  ['経常利益は9百万円、調整後経常利益は10百万円', ['経常利益']],
  ['2027年3月期の経常利益は9百万円', ['経常利益']],
  ['2027年1月の売上高は9百万円', ['売上高']],
  ['当社の売上高は100百万円、営業利益は10百万円', ['売上高', '営業利益']],
  ['基本的1株当たり当期利益は42円、希薄化後EPSは40円', ['基本的1株当たり当期利益', '希薄化後EPS']],
])('本文の修飾語を標準指標の境界へ読み替えない: %s', (text, labels) => {
  expect(proseReportingMetrics(text).map((m) => m.label)).toEqual(labels);
});

it('指標の前置きは明示された主体だけを使い、未知の修飾を補わない', () => {
  const text = '株式会社テストの2027年3月期(予想)の経常利益は9百万円';
  expect(proseReportingMetrics(text)).toEqual([]);
  expect(proseReportingMetrics(text, '', ['株式会社テスト']).map((m) => m.label)).toEqual([
    '経常利益',
  ]);
  expect(
    proseReportingMetrics('株式会社テストの調整後経常利益は9百万円', '', ['株式会社テスト'])
  ).toEqual([]);
});

it.each(['当社グループ', '当グループ', '当社', '株式会社テストグループ'])(
  '主体名を短い接頭辞で切らず最長の宣言で照合する: %s',
  (owner) => {
    const owners = owner.startsWith('株式会社') ? ['株式会社テスト', owner] : [];
    expect(
      proseReportingMetrics(`${owner}の売上高は100百万円`, '', owners).map((m) => m.label)
    ).toEqual(['売上高']);
    expect(proseReportingMetrics(`${owner}の調整後営業利益は10百万円`, '', owners)).toEqual([]);
  }
);
it.each([
  ['経常利益(△)', 'ordinaryProfit'],
  ['経常利益又は経常損失(△)', 'ordinaryProfit'],
  ['営業利益又は営業損失(△)', 'operatingProfit'],
  ['当期純利益又は当期純損失(△)', 'netProfit'],
  ['親会社株主に帰属する当期純利益又は損失(△)', 'netProfit'],
  ['営業損失(△)', 'operatingProfit'],
  ['調整後経常利益(△)', null],
  ['経常利益又は調整後経常損失(△)', null],
])('利益/損失の標準表記全体を指標に対応させる: %s', (label, key) => {
  expect(reportingMetricKey(label)).toBe(key);
});
