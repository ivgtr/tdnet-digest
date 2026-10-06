import { candidateResponse, candidateFixture } from './fixtures/candidate-test-source';
import { describe, it, expect, vi } from 'vitest';
import { generateText } from './llm-client';
import {
  parseFactSummary,
  generateVerifiedFacts as generateVerifiedFactSummary,
  renderFacts,
} from './fact-summary';
import { textPage, numberCandidate } from './fixtures/v4-test-source';
import type { VerifiedFact } from './fact-contract';
import { serializeLayout } from './pdf-layout';
vi.mock('./llm-client', () => ({ generateText: vi.fn() }));
const page = textPage(
  '会社名 株式会社テスト | 会計基準 日本基準 | 範囲 連結\n2026年3月期 連結経営成績\n営業利益は100百万円です。'
);
const fact = numberCandidate(page);
const raw = (facts: VerifiedFact[], version = 6) =>
  JSON.stringify({ version, documentType: 'other', facts, unverified: [] });
const parse = (candidate: VerifiedFact, source = [page]) =>
  parseFactSummary(raw([candidate]), 'other', source, false);
describe('v4の原文と意味の照合', () => {
  it('本文の桁区切りを候補・生成・保存で保持する', async () => {
    const source = [
      textPage(
        '2027年3月期 決算短信〔日本基準〕（連結）\n会社名 株式会社テスト\n売上高は1,000百万円です。\n営業利益は100百万円です。\n当期純利益は50百万円です。'
      ),
    ];
    const fs = [
      ['売上高', 1000],
      ['営業利益', 100],
      ['当期純利益', 50],
    ].map(([m, v]) => numberCandidate(source[0], m as string, v as number, '2027年3月期'));
    vi.mocked(generateText)
      .mockReset()
      .mockResolvedValueOnce(candidateResponse(fs, source, 'earnings'));
    const r = await generateVerifiedFactSummary(
      { provider: 'openai', model: 'fixture', apiKey: 'fixture' },
      'earnings',
      'source',
      source
    );
    expect(r.repairAttempted).toBe(false);
    expect(r.facts.facts[0].quantity).toMatchObject({ raw: '1,000', decimal: '1000' });
    expect(parseFactSummary(JSON.stringify(r.facts), 'earnings', source)).toEqual(r.facts);
    const system = vi.mocked(generateText).mock.calls[0][1][0].content;
    expect(system).toContain('本文のnumber/rangeは参照するquantity.kindと一致させます');
    expect(system).toContain('event/statusのみassertions.allowedKindsから選びます');
  });
  it('原数量・共通属性を保持し、保存した事実を再検証する', () => {
    const result = parse(fact);
    expect(result.unverified).toEqual([]);
    expect(result.facts[0].quantity?.decimal).toBe('100');
    expect(result.facts[0].id).toMatch(/^fact-/);
    expect(parseFactSummary(raw(result.facts), 'other', [page], false)).toEqual(result);
    expect(result.facts[0]).toMatchObject({
      value: 100,
      unit: '百万円',
      period: '2026年3月期',
      semantics: { subject: '株式会社テスト', scope: '連結', basis: '日本基準', state: 'actual' },
    });
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
  it('smartで未選択の見出し本文・IDを入力せず、同ページの事実や根拠参照を拒否する', async () => {
    const omitted = textPage(
      '会社名 株式会社テスト\n2026年3月期 業績予想\n取得の方法は翌月の市場買付です。',
      2
    );
    omitted.selection = 'omitted';
    const sources = [page, omitted];
    const text = serializeLayout(sources);
    expect(text).not.toContain('取得の方法は翌月の市場買付です。');
    expect(text).not.toContain('p2b');
    expect(text).not.toContain('p2s');
    const event: VerifiedFact = {
      ...fact,
      id: 'f2',
      kind: 'event',
      label: omitted.blocks[2].text,
      value: null,
      unit: null,
      period: null,
      valueKind: null,
      statement: omitted.blocks[2].text,
      quote: omitted.blocks[2].text,
      page: 2,
      evidence: {
        kind: 'prose',
        blockId: omitted.blocks[2].id,
        assertionId: `${omitted.blocks[2].id}:a1`,
        quantityId: null,
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
        state: 'unspecified',
        polarity: 'affirmative',
        qualifiers: [],
        conditions: [],
      },
      quantity: null,
      dateRoles: null,
    };
    expect(parseFactSummary(raw([event]), 'other', sources, false).unverified.join(' ')).toContain(
      '未選択ページ'
    );
    const wrongReference = structuredClone(fact);
    wrongReference.evidence.scopeIds = [omitted.blocks[0].id];
    expect(
      parseFactSummary(raw([wrongReference]), 'other', sources, false).unverified.join(' ')
    ).toContain('未選択ページの根拠');
    vi.mocked(generateText)
      .mockReset()
      .mockResolvedValueOnce(candidateResponse([fact, event], sources));
    await expect(
      generateVerifiedFactSummary(
        { provider: 'openai', model: 'test', apiKey: 'test' },
        'other',
        page.text,
        sources
      )
    ).rejects.toThrow('全文で再要約');
    expect(vi.mocked(generateText)).not.toHaveBeenCalled();
    omitted.status = 'failed';
    expect(() => parseFactSummary(raw([fact]), 'other', sources)).toThrow('抽出失敗');
  });
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
      label: p.text,
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
        assertionId: `${p.blocks[0].id}:a1`,
        quantityId: null,
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
        state: 'unspecified',
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
      .mockResolvedValueOnce(
        JSON.stringify({
          candidateVersion: 1,
          documentType: 'other',
          candidates: [
            {
              ...candidateFixture(fact, [page]),
              meaning: { ...candidateFixture(fact, [page]).meaning, period: '2025年3月期' },
            },
          ],
          unverified: [],
        })
      )
      .mockResolvedValueOnce(candidateResponse([{ ...fact, id: 'f7' }], [page]));
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
