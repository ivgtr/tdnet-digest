import { describe, it, expect, vi } from 'vitest';
import { textPage, numberCandidate } from './fixtures/v4-test-source';
import { parseFactSummary } from './fact-summary';
import { validateScoreInput, extractScoreInput, type ScoreFacts } from './score-extraction';
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
    version: 4,
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
});
