import { describe, it, expect, vi } from 'vitest';
import { textPage, numberCandidate } from './fixtures/v4-test-source';
import { candidateResponse } from './fixtures/candidate-test-source';
import { parseFactSummary } from './fact-summary';
import {
  validateScoreInput,
  extractScoreInput,
  toValue,
  type ScoreFacts,
} from './score-extraction';
import { compatible, assessClaim } from './scoring';
import { proseQuantities } from './quantity';
import { assertionId } from './source-provenance';
import { validateSavedScore } from './fact-cache';
import { generateText } from './llm-client';
vi.mock('./llm-client', () => ({ generateText: vi.fn() }));
const current = textPage(
  '会社名 株式会社テスト | 会計基準 日本基準 | 範囲 連結\n2026年3月期 連結経営成績\n営業利益は100百万円です。'
);
const previous = textPage(
  '会社名 株式会社テスト | 会計基準 日本基準 | 範囲 連結\n2025年3月期 連結経営成績\n営業利益は80百万円です。',
  2
);
const facts = parseFactSummary(
  JSON.stringify({
    version: 6,
    documentType: 'other',
    facts: [
      numberCandidate(current),
      { ...numberCandidate(previous, '営業利益', 80, '2025年3月期'), id: 'f2' },
    ],
    unverified: [],
  }),
  'other',
  [current, previous]
);
const registry: ScoreFacts[] = [
  {
    document: {
      url: 'https://issuer.example/report.pdf',
      issuer: '株式会社テスト',
      code: '1234',
      documentHash: 'a'.repeat(64),
      publishedDate: '2026-09-30',
      pages: [current, previous],
      text: current.text + '\n' + previous.text,
    },
    facts,
  },
];
const claim = {
  category: 'operatingProfit',
  label: '営業利益',
  current: facts.facts[0].id,
  previous: facts.facts[1].id,
  earlier: null,
  relatedValue: null,
  companyExplanation: null,
};
const raw = (candidate: unknown) =>
  JSON.stringify({ version: 4, claims: [candidate], unverified: [] });
describe('共通確定事実からの採点入力', () => {
  it('分割の原文注記と資料を比較まで保持し、未証明の別分割を比較しない', () => {
    const current = structuredClone(facts.facts[0]),
      previous = structuredClone(facts.facts[1]);
    for (const f of [current, previous]) {
      f.label = '1株当たり当期純利益';
      f.unit = '円';
      f.semantics.metricKind = 'perShare';
      f.provenance!.adjustments = [
        {
          kind: 'stockSplit',
          noteId: 'p1b9',
          text: '2026年4月1日に1株を3株に株式分割',
          basis: 'splitAdjusted',
        },
      ];
    }
    const a = toValue(current, registry[0].document),
      b = toValue(previous, registry[0].document);
    expect(a.source.perShareBasis).toEqual(current.provenance!.adjustments);
    expect(compatible(a, b)).toBe(true);
    expect(
      compatible(
        a,
        toValue(previous, { ...registry[0].document, url: 'https://issuer.example/alias.pdf' })
      )
    ).toBe(true);
    const foreign = toValue(previous, {
      ...registry[0].document,
      url: 'https://issuer.example/other.pdf',
      documentHash: 'b'.repeat(64),
    });
    expect(compatible(a, foreign)).toBe(false);
    expect(
      compatible(a, toValue(previous, { ...registry[0].document, documentHash: 'b'.repeat(64) }))
    ).toBe(false);
    for (const text of ['2026年4月1日に1株を2株に株式分割', '2025年4月1日に1株を3株に株式分割']) {
      previous.provenance!.adjustments[0].text = text;
      expect(compatible(a, toValue(previous, registry[0].document))).toBe(false);
    }
  });
  it('値・期間・範囲をモデルに書き直させず確定事実IDで比較する', () => {
    const result = validateScoreInput(raw(claim), registry, '元PDF内');
    expect(result.unverified).toEqual([]);
    expect(result.claims[0].current.value).toBe(100);
    expect(result.claims[0].previous?.value).toBe(80);
    expect(result.claims[0].current.source.semantics).toEqual(facts.facts[0].semantics);
  });
  it.each([
    { current: 'unknown' },
    { current: facts.facts[1].id, previous: facts.facts[0].id },
    { scope: 'IFRS' },
    { current: { value: 100, periodKind: 'fullYear' } },
    { periodKind: 'month' },
  ])('未知・誤対応・意味の付け直し %j を拒否する', (changes) =>
    expect(validateScoreInput(raw({ ...claim, ...changes }), registry, '').claims).toHaveLength(0)
  );
  it('旧入力形式を変換しない', () =>
    expect(() =>
      validateScoreInput(JSON.stringify({ claims: [claim], unverified: [] }), registry, '')
    ).toThrow('v4'));
  it('別資料の後日値・別会社を拒否する', () => {
    const r = [
      registry[0],
      {
        ...registry[0],
        document: {
          ...registry[0].document,
          url: 'https://issuer.example/later.pdf',
          documentHash: 'a'.repeat(64),
          publishedDate: '2026-10-01',
        },
        facts: { ...facts, facts: [{ ...facts.facts[1], id: 'later' }] },
      },
    ];
    expect(validateScoreInput(raw({ ...claim, previous: 'later' }), r, '').claims).toHaveLength(0);
  });
  it('採点生成も同じ確定事実を起点にする', async () => {
    vi.mocked(generateText).mockReset().mockResolvedValueOnce(raw(claim));
    const result = await extractScoreInput(
      { provider: 'openai', model: 'test', apiKey: 'test' },
      'earnings',
      [registry[0].document],
      '',
      facts
    );
    expect(result.claims).toHaveLength(1);
    expect(vi.mocked(generateText).mock.calls[0][1][1].content).toContain(
      '数値・期間・範囲・限定・状態を書き直しません'
    );
  });
  it('過去資料は事実抽出だけで比較でき、表示用の補足生成・点検を要求しない', async () => {
    const historical = {
      ...registry[0].document,
      url: 'https://issuer.example/previous.pdf',
      documentHash: 'b'.repeat(64),
      publishedDate: '2025-09-30',
      pages: [previous],
      text: previous.text,
    };
    vi.mocked(generateText)
      .mockReset()
      .mockResolvedValueOnce(candidateResponse([facts.facts[1]], historical.pages))
      .mockImplementationOnce(async (_config, messages) => {
        const sources = JSON.parse(messages[1].content.split('\n').slice(-1)[0]);
        return raw({ ...claim, previous: sources[1].facts[0].id });
      });
    const result = await extractScoreInput(
      { provider: 'openai', model: 'test', apiKey: 'test' },
      'earnings',
      [registry[0].document, historical],
      '過去PDF',
      { ...facts, facts: [facts.facts[0]] }
    );
    expect(result.unverified).toEqual([]);
    expect(result.claims[0].current.value).toBe(100);
    expect(result.claims[0].previous?.value).toBe(80);
    expect(result.claims[0].previous?.source.url).toBe(historical.url);
    expect(generateText).toHaveBeenCalledTimes(2);
    expect(vi.mocked(generateText).mock.calls[0][0].signal).toBeInstanceOf(AbortSignal);
  });
});

it('据置配当の原文証明を採点入力・保存照合へ渡し、証明なしの配当予想を拒否する', () => {
  const source =
    'なお、配当予想につきましては2026年5月7日公表の1株当たり35円より変更はございません。';
  const pages = [
    textPage('会社名 株式会社テスト\n2026年3月期 修正後配当予想\n年間配当金は40円です。'),
    textPage('会社名 株式会社テスト\n2026年3月期 修正前配当予想\n年間配当金は35円です。', 2),
    textPage(`会社名 株式会社テスト\n2026年3月期 配当予想\n${source}`, 3),
  ];
  const candidates = pages.map((p, i) => {
    const f = numberCandidate(p, i === 2 ? '配当予想' : '年間配当金', i === 0 ? 40 : 35);
    if (i === 2 && f.evidence.kind === 'prose') {
      const block = p.blocks.find((b) => b.text === source)!;
      f.quote = block.text;
      f.evidence.blockId = block.id;
      f.evidence.assertionId = assertionId(block.id);
      f.evidence.quantityId = proseQuantities(block).find((q) => q.raw === '35円')!.id;
    }
    f.id = `f${i + 1}`;
    f.unit = '円';
    f.semantics.scope = f.semantics.basis = null;
    f.semantics.metricKind = 'perShare';
    f.valueKind = f.semantics.state =
      i === 0 ? 'forecastAfter' : i === 1 ? 'forecastBefore' : 'forecast';
    return f;
  });
  const facts = parseFactSummary(
    JSON.stringify({ version: 6, documentType: 'other', facts: candidates, unverified: [] }),
    'other',
    pages
  );
  expect(facts.unverified).toEqual([]);
  expect(facts.facts).toHaveLength(3);
  const document = { ...registry[0].document, pages, text: pages.map((p) => p.text).join('\n') };
  const dividend = facts.facts[2];
  expect(dividend.semantics.scope).toBeNull();
  const v = toValue(dividend, document);
  expect(v.source.quote).toBe(source);
  expect(v.source.semantics.metricKind).toBe('perShare');
  // An ordinary forecast does not become a revision pair merely because its scope is proved.
  expect(compatible(v, v, true)).toBe(false);
  const selected = validateScoreInput(
    raw({
      ...claim,
      category: 'shareholderReturn',
      label: '配当',
      current: facts.facts[0].id,
      previous: facts.facts[1].id,
      relatedValue: dividend.id,
    }),
    [{ document, facts }],
    '元PDF内'
  );
  expect(selected.unverified).toEqual([]);
  expect(selected.claims).toHaveLength(1);
  const comparison = '35→40円（14.3%）';
  expect(assessClaim(selected.claims[0])).toBe(comparison);
  const score = {
    value: 70,
    verdict: '好材料',
    positives: ['配当'],
    negatives: [],
    unverified: [],
    searchStatus: '固定',
    breakdown: [{ ...selected.claims[0], impact: 'positive', strength: 'small', comparison }],
  };
  expect(() => validateSavedScore(score, facts, document.url, document.documentHash)).not.toThrow();
  const unproved = structuredClone(dividend);
  unproved.quote = '配当予想は35円です。';
  expect(() => toValue(unproved, document)).toThrow('範囲');
  const altered = structuredClone(score);
  altered.breakdown[0].relatedValue!.source.quote = unproved.quote;
  expect(() => validateSavedScore(altered, facts, document.url, document.documentHash)).toThrow(
    '意味属性'
  );
});
