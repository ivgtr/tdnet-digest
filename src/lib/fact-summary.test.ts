import { describe, it, expect, vi } from 'vitest';
import { generateText } from './llm-client';
import { parseFactSummary, generateVerifiedFactSummary, renderFacts } from './fact-summary';
import { textPage, numberCandidate } from './fixtures/v4-test-source';
import type { VerifiedFact } from './fact-contract';
vi.mock('./llm-client', () => ({ generateText: vi.fn() }));
const page = textPage(
  '会社名 株式会社テスト | 会計基準 日本基準 | 範囲 連結\n2026年3月期 連結経営成績\n営業利益は100百万円です。'
);
const fact = numberCandidate(page);
const raw = (facts: VerifiedFact[], version = 4) =>
  JSON.stringify({ version, documentType: 'other', facts, unverified: [] });
const parse = (candidate: VerifiedFact, source = [page]) =>
  parseFactSummary(raw([candidate]), 'other', source, false);
describe('v4の原文と意味の照合', () => {
  it('原数量・共通属性を保持し、保存した事実を再検証する', () => {
    const result = parse(fact);
    expect(result.unverified).toEqual([]);
    expect(result.facts[0].quantity?.decimal).toBe('100');
    expect(result.facts[0].id).toMatch(/^fact-/);
    expect(parseFactSummary(raw(result.facts), 'other', [page], false)).toEqual(result);
    expect(renderFacts(result)).toContain('100百万円（2026年3月期、株式会社テスト、連結、実績');
  });
  it.each([
    { value: 101 },
    { period: '2025年3月期' },
    { unit: '億円' },
    { page: 2 },
    { quote: '営業利益は100百万円' },
    { label: '営業利益率' },
  ])('誤対応 %j を拒否する', (change) =>
    expect(parse({ ...fact, ...change }).facts).toHaveLength(0)
  );
  it('旧スキーマ・未知項目・欠損を受け入れない', () => {
    expect(() => parseFactSummary(raw([fact], 3), 'other', [page])).toThrow('形式');
    expect(parse({ ...fact, extra: 1 } as never).facts).toHaveLength(0);
    expect(parse({ ...fact, semantics: undefined } as never).facts).toHaveLength(0);
  });
  it('別セクションのscope/basisを借用しない', () => {
    const other = textPage(page.text + '\nIFRS 非連結');
    const bad = numberCandidate(other);
    bad.evidence.scopeIds = [other.blocks[3].id];
    bad.semantics.basis = 'IFRS';
    bad.semantics.scope = '非連結';
    expect(parse(bad, [other]).facts).toHaveLength(0);
  });
  it('ページ抽出失敗を成功した本文で補わない', () =>
    expect(() => parse(fact, [page, { ...textPage('', 2), status: 'failed' }])).toThrow(
      '抽出失敗'
    ));
  it('原文字の欠損を旧形式のページで補わない', () =>
    expect(() => parse(fact, [{ ...page, sourceItems: undefined } as never])).toThrow('原文字'));
  it('月次の他月割当を拒否し、正しい暦月を採用する', () => {
    const monthly = textPage(
      '会社名 株式会社テスト | 会計基準 日本基準 | 範囲 連結\n2026年7月実績\n店舗数は120店舗です。\n2026年8月実績\n店舗数は130店舗です。'
    );
    const candidate = numberCandidate(monthly, '店舗数', 120, '2026年7月');
    candidate.unit = '店舗';
    candidate.semantics.metricKind = 'count';
    candidate.semantics.periodKind = 'month';
    expect(parse(candidate, [monthly]).facts).toHaveLength(1);
    expect(parse({ ...candidate, period: '2026年8月' }, [monthly]).facts).toHaveLength(0);
  });
  it('Q1の期間と区分を省略できない', () => {
    const quarterly = textPage(
      '会社名 株式会社テスト | 会計基準 日本基準 | 範囲 連結\n2026年3月期 第1四半期連結累計期間の経営成績\n営業利益は100百万円です。'
    );
    const candidate = numberCandidate(quarterly);
    expect(parse(candidate, [quarterly]).facts).toHaveLength(0);
    candidate.period = '2026年3月期第1四半期累計';
    candidate.semantics.periodKind = 'cumulativeQ1';
    expect(parse(candidate, [quarterly]).facts).toHaveLength(1);
  });
  it('否定の末尾を切った出来事を拒否する', () => {
    const p = textPage('配当増額を決定していません。');
    const event: VerifiedFact = {
      ...fact,
      kind: 'event',
      label: '配当増額',
      value: null,
      unit: null,
      period: null,
      valueKind: null,
      statement: p.text,
      page: 1,
      quote: p.text,
      evidence: {
        kind: 'prose',
        blockId: p.blocks[0].id,
        contextIds: [],
        scopeIds: [],
        qualifierIds: [],
      },
      semantics: {
        subject: null,
        scope: null,
        basis: null,
        periodKind: 'none',
        metricKind: 'none',
        qualifiers: [],
        state: 'decided',
        polarity: 'negative',
        conditions: [],
      },
      quantity: null,
    };
    expect(parse(event, [p]).facts).toHaveLength(1);
    expect(renderFacts(parse(event, [p]))).toContain('決定していません');
    expect(parse({ ...event, statement: '配当増額を決定' }, [p]).facts).toHaveLength(0);
    expect(
      parse({ ...event, semantics: { ...event.semantics, polarity: 'affirmative' } }, [p]).facts
    ).toHaveLength(0);
  });
  it('上限と予定の欠落を拒否し、完全な限定を表示する', () => {
    const p = textPage(
      '会社名 株式会社テスト | 株式種類 普通株式\n2026年7月15日取得予定\n取得する株式の総数は200,000株（上限）です。'
    );
    const f = numberCandidate(p, '取得する株式の総数', 200000, '2026年7月15日');
    f.unit = '株';
    f.valueKind = null;
    f.semantics = {
      ...f.semantics,
      basis: null,
      scope: '普通株式',
      periodKind: 'eventDate',
      metricKind: 'count',
      state: 'planned',
      qualifiers: ['上限'],
    };
    expect(parse(f, [p]).facts).toHaveLength(1);
    expect(renderFacts(parse(f, [p]))).toContain('実施予定、上限');
    expect(parse({ ...f, semantics: { ...f.semantics, qualifiers: [] } }, [p]).facts).toHaveLength(
      0
    );
    expect(
      parse({ ...f, valueKind: 'actual', semantics: { ...f.semantics, state: 'actual' } }, [p])
        .facts
    ).toHaveLength(0);
  });
  it('f1の付け替えに依存せず修復前の事実を維持する', async () => {
    vi.mocked(generateText)
      .mockReset()
      .mockResolvedValueOnce(raw([{ ...fact, value: 999 }]))
      .mockResolvedValueOnce(raw([{ ...fact, id: 'f7' }]));
    const result = await generateVerifiedFactSummary(
      { provider: 'openai', model: 'test', apiKey: 'test' },
      'other',
      page.text,
      [page]
    );
    expect(result.repairAttempted).toBe(true);
    expect(result.facts.facts).toHaveLength(1);
    expect(result.facts.facts[0].id).toMatch(/^fact-/);
  });
});
