import { forgedProvenance } from './fixtures/fact-review-source';
import {
  assertionCandidate,
  prose,
  evidence,
  saved,
  report,
  event,
  period,
} from './fixtures/fact-review-source';
import { describe, expect, it, vi } from 'vitest';
import { textPage, layoutPage, numberCandidate } from './fixtures/v4-test-source';
import { candidateResponse } from './fixtures/candidate-test-source';
import { buildDocumentContext, bindingFor, resolveScopeIds } from './document-context';
import { proseQuantities, reviewCandidates, serializeCandidateSource } from './fact-candidates';
import { generateVerifiedFactSummary, renderFacts, parseFactSummary } from './fact-summary';
import { verifyCoverage, coverageReport, standardMetric } from './fact-coverage';
import { stableFactId, type VerifiedFact } from './fact-contract';
import { validateSavedFacts } from './fact-cache';
import { generateText } from './llm-client';
import { buildSummaryHtml } from '../content/utils/summaryHtmlBuilder';
import { assertionPolarity, assertionStates } from './assertion-semantics';
vi.mock('./llm-client', () => ({ generateText: vi.fn() }));
const config = { provider: 'openai', model: 'fixture', apiKey: 'fixture' };
const rejected = [
  '100百万円ではなく200百万円を見込んでおります。',
  '100百万円に満たない見込みです。',
  '100百万円に届かない見込みです。',
  '100百万円（ではなく）200百万円の見込みです。',
  '100百万円」に満たない見込みです。',
  '100百万円には届かない見込みです。',
  '100百万円に達しない見込みです。',
  '100百万円の見込みではありません。',
  '100百万円の見込みですが確定していません。',
  '100百万円と仮定した試算です。',
  '100百万円の見込みですらない。',
  '100百万円の見込みです。実際には100百万円に届かない見込みです。',
];
describe('本文数量の完結した意味照合', () => {
  it.each(['(2)', '（２）'])('実抽出で結合した次の番号付き欄を独立境界にする: %s', (marker) => {
    const source = textPage(
      `会社名 株式会社テスト\n${period} 業績予想\n${period}の売上高は100百万円です\n${marker}取得条件は別途決定します`
    );
    source.spans[3].y = source.spans[2].y + 20;
    const pages = [layoutPage(source.spans)];
    const f = numberCandidate(pages[0], '売上高', 100, period);
    f.valueKind = f.semantics.state = 'forecast';
    f.semantics.scope = f.semantics.basis = null;
    expect(f.quote).toContain(`\n${marker}`);
    const r = reviewCandidates(candidateResponse([f], pages), 'other', pages);
    expect(r.unverified).toEqual([]);
    expect(r.facts).toHaveLength(1);
    expect(saved(r.facts, pages, 'other', true).facts).toEqual(r.facts);
  });
  it('同じ行のセミコロンと番号で数値再指定を候補・保存から受理しない', () => {
    const { pages, f } = prose(`(1)${period}の売上高は100百万円です。；(2)売上高は120百万円です。`);
    expect(f.quote).not.toContain('\n');
    expect(reviewCandidates(candidateResponse([f], pages), 'other', pages).facts).toEqual([]);
    expect(saved([evidence(f, pages)], pages).facts).toEqual([]);
  });
  it.each(rejected)('後続を含む原文の意味を確定額へ変換しない: %s', (tail) => {
    const { pages, f } = prose(`${period}の売上高は${tail}`);
    const r = reviewCandidates(candidateResponse([f], pages), 'other', pages);
    expect(r.facts).toEqual([]);
    expect(saved([evidence(f, pages)], pages).facts).toEqual([]);
    // Complete persisted v4 facts must fail meaning, not just shape or integrity.
    if (f.evidence.kind !== 'prose') throw new Error('expected prose');
    const blockId = f.evidence.blockId;
    const block = pages[0].blocks.find((b) => b.id === blockId)!;
    f.quantity = {
      raw: '100',
      decimal: '100',
      sourceIds: block.spanIds.flatMap((id) => pages[0].spans.find((s) => s.id === id)!.sourceIds!),
    };
    f.dateRoles = [];
    f.provenance = forgedProvenance(f, pages);
    f.id = stableFactId(f);
    validateSavedFacts({ version: 5, documentType: 'other', facts: [f], unverified: [] });
    expect(saved([f], pages).facts).toEqual([]);
    expect(
      renderFacts({ version: 5, documentType: 'other', facts: r.facts, unverified: r.unverified })
    ).not.toContain('- 売上高: 100百万円');
  });
  it('対応がない置換先の200も推測で採用しない', () => {
    const { pages, f } = prose(
      `${period}の売上高は100百万円ではなく200百万円を見込んでおります。`,
      200
    );
    expect(reviewCandidates(candidateResponse([f], pages), 'other', pages).facts).toEqual([]);
    expect(saved([evidence(f, pages)], pages).facts).toEqual([]);
  });
  it.each([
    '100百万円の見込みです。',
    '100百万円」を見込んでおります。',
    '100百万円です。',
    '100百万円（概算）の見込みです。',
  ])('直接対応する数量と明示限定を保持する: %s', (tail) => {
    const { pages, f } = prose(`${period}の売上高は${tail}`);
    const r = reviewCandidates(candidateResponse([f], pages), 'other', pages);
    expect(r.unverified).toEqual([]);
    expect(r.facts).toHaveLength(1);
    expect(saved(r.facts, pages, 'other', true).facts).toEqual(r.facts);
  });
  it.each(['negative', 'mixed'] as const)('極性の付け直しで否定数量を通さない: %s', (polarity) => {
    const { pages, f } = prose(`${period}の売上高は100百万円の見込みではありません。`);
    f.semantics.polarity = polarity;
    expect(reviewCandidates(candidateResponse([f], pages), 'other', pages).facts).toEqual([]);
    expect(saved([evidence(f, pages)], pages).facts).toEqual([]);
  });
  it.each([...rejected.slice(0, 3), '100百万円（には満たない見込み）です。'])(
    '通常の意味検証を通した完結eventへ1回修復する: %s',
    async (tail) => {
      const { pages, f } = prose(`${period}の売上高は${tail}`);
      const event: VerifiedFact = {
        ...f,
        kind: 'event',
        label: f.quote,
        statement: f.quote,
        value: null,
        unit: null,
        valueKind: null,
        semantics: {
          ...f.semantics,
          metricKind: 'none',
          polarity: tail.includes('ではなく') ? 'mixed' : 'negative',
        },
      };
      vi.mocked(generateText)
        .mockReset()
        .mockResolvedValueOnce(candidateResponse([f], pages))
        .mockResolvedValueOnce(candidateResponse([event], pages));
      const r = await generateVerifiedFactSummary(config, 'other', pages[0].text, pages);
      expect(r.repairAttempted).toBe(true);
      expect(generateText).toHaveBeenCalledTimes(2);
      expect(r.facts.facts[0]).toMatchObject({
        kind: 'event',
        statement: f.quote,
        semantics: { state: 'forecast', polarity: event.semantics.polarity },
      });
      expect(parseFactSummary(JSON.stringify(r.facts), 'other', pages)).toEqual(r.facts);
      const html = buildSummaryHtml(renderFacts(r.facts), null, {
        companyName: '株式会社テスト',
        title: '業績予想',
      });
      expect(html).toContain(tail);
    }
  );
  it('括弧で否定の一主張を混合極性へ分割しない', () => {
    const { pages, f } = prose(`${period}の売上高は100百万円（には満たない見込み）です。`);
    expect(assertionPolarity(f.quote)).toBe('negative');
    const event = {
      ...f,
      kind: 'event' as const,
      label: f.quote,
      statement: f.quote,
      value: null,
      unit: null,
      valueKind: null,
      semantics: { ...f.semantics, metricKind: 'none' as const, polarity: 'mixed' as const },
    };
    expect(reviewCandidates(candidateResponse([event], pages), 'other', pages).facts).toEqual([]);
    expect(saved([evidence(event, pages)], pages).facts).toEqual([]);
  });
  it('同じ段落の別数量を修復しても、未対応の番号付き欄の警告は消さない', async () => {
    const source = textPage(
      `会社名 株式会社テスト\n${period} 業績予想\n${period}の売上高は100百万円の見込みです\n(2)補足指標は200百万円を検討しています。`
    );
    source.spans[3].y = source.spans[2].y + 20;
    const pages = [layoutPage(source.spans)];
    const good = numberCandidate(pages[0], '売上高', 100, period);
    good.valueKind = good.semantics.state = 'forecast';
    good.semantics.scope = good.semantics.basis = null;
    const wrong = structuredClone(good);
    wrong.semantics.scope = '連結';
    const optional = numberCandidate(pages[0], '補足指標', 200, period);
    optional.valueKind = optional.semantics.state = 'forecast';
    optional.semantics.scope = optional.semantics.basis = null;
    const initial = candidateResponse([wrong, optional], pages);
    const warnings = reviewCandidates(initial, 'other', pages).unverified;
    expect(warnings).toHaveLength(2);
    vi.mocked(generateText)
      .mockReset()
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(candidateResponse([good], pages));
    const r = await generateVerifiedFactSummary(config, 'other', 'source', pages);
    expect(r.facts.facts).toHaveLength(1);
    expect(r.facts.unverified).toEqual([warnings[1]]);
    expect(generateText).toHaveBeenCalledTimes(2);
  });
  it('誤候補を繰り返す修復は最終失敗とし、3回目を呼ばない', async () => {
    const { pages, f } = prose(`${period}の売上高は100百万円に届かない見込みです。`);
    vi.mocked(generateText)
      .mockReset()
      .mockResolvedValue(candidateResponse([f], pages));
    await expect(
      generateVerifiedFactSummary(config, 'other', pages[0].text, pages)
    ).rejects.toThrow('重要事実');
    expect(generateText).toHaveBeenCalledTimes(2);
  });
});
function localReport(heading: string, fields = '範囲 個別\n会計基準 IFRS', headline = false) {
  const forecast = heading.includes('予想') || heading === '今後の見通し';
  const pages = [
    textPage(
      headline && fields
        ? '2027年3月期 決算短信〔IFRS〕（個別）\n上場会社名 株式会社テスト'
        : '2027年3月期 決算短信〔日本基準〕（連結）\n上場会社名 株式会社テスト'
    ),
    textPage(
      `1. ${period} ${heading}\n${fields}\n${['売上高', '営業利益', '当期純利益'].map((label) => `${period}の${label}は100百万円${forecast ? 'の見込みです' : 'です'}。`).join('\n')}`,
      2
    ),
  ];
  const facts = ['売上高', '営業利益', '当期純利益'].map((label, i) => {
    const f = numberCandidate(pages[1], label, 100, period);
    f.id = `f${i + 1}`;
    f.semantics.scope = fields ? '個別' : '連結';
    f.semantics.basis = fields ? 'IFRS' : '日本基準';
    if (forecast) f.valueKind = f.semantics.state = 'forecast';
    return evidence(f, pages);
  });
  return { pages, facts };
}
describe('局所属性と表紙宣言の適用', () => {
  it('事業節の予想値で通期予想を代替せず、正しい報告節の候補へ修復する', async () => {
    const report = localReport('経営成績', undefined, true);
    const future = textPage(localReport('業績予想').pages[1].text, 3);
    const business = textPage(`1. 事業説明\n${period}の売上高は200百万円の見込みです。`, 4);
    const pages = [...report.pages, future, business];
    const forecasts = ['売上高', '営業利益', '当期純利益'].map((label) => {
      const f = numberCandidate(future, label, 100, period);
      f.valueKind = f.semantics.state = 'forecast';
      f.semantics.scope = '個別';
      f.semantics.basis = 'IFRS';
      return f;
    });
    const substitute = numberCandidate(business, '売上高', 200, period);
    substitute.valueKind = substitute.semantics.state = 'forecast';
    substitute.semantics.scope = substitute.semantics.basis = null;
    const initial = candidateResponse(
      [...report.facts, ...forecasts.slice(1), substitute],
      pages,
      'earnings'
    );
    const r = reviewCandidates(initial, 'earnings', pages);
    expect(r.unverified).toEqual([]);
    expect(() => verifyCoverage('earnings', pages, r.facts)).toThrow('通期予想の重要指標 revenue');
    vi.mocked(generateText)
      .mockReset()
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(candidateResponse([forecasts[0]], pages, 'earnings'));
    const final = await generateVerifiedFactSummary(config, 'earnings', 'source', pages);
    expect(final.repairAttempted).toBe(true);
    expect(final.facts.facts).toHaveLength(7);
    expect(saved(final.facts.facts, pages, 'earnings', true).facts).toEqual(final.facts.facts);
    expect(generateText).toHaveBeenCalledTimes(2);
  });
  it.each(['1. セグメント情報', '1. 経営成績\n(1) セグメント情報'])(
    '同名の事業数量で当年決算実績の必須値を代替しない: %s',
    (heading) => {
      const report = localReport('経営成績', undefined, true);
      const page = textPage(`${heading}\n${period}の売上高は200百万円です。`, 3);
      const pages = [...report.pages, page];
      const extra = numberCandidate(page, '売上高', 200, period);
      const financial = heading.includes('経営成績');
      extra.semantics.scope = financial ? '個別' : null;
      extra.semantics.basis = financial ? 'IFRS' : null;
      const r = reviewCandidates(
        candidateResponse([...report.facts.slice(1), extra], pages, 'earnings'),
        'earnings',
        pages
      );
      expect(r.unverified).toEqual([]);
      expect(r.facts).toHaveLength(3);
      expect(() => verifyCoverage('earnings', pages, r.facts)).toThrow('revenue');
      expect(
        coverageReport('earnings', pages, r.facts).find((s) => s.requirement.includes('revenue'))
          ?.status
      ).not.toBe('satisfied');
      expect(() => saved(r.facts, pages, 'earnings', true)).toThrow('revenue');
      const valid = reviewCandidates(
        candidateResponse([...report.facts, extra], pages, 'earnings'),
        'earnings',
        pages
      );
      expect(() => verifyCoverage('earnings', pages, valid.facts)).not.toThrow();
      expect(saved(valid.facts, pages, 'earnings', true).facts).toEqual(valid.facts);
    }
  );
  it.each(['財政状態', '経営成績', '業績予想'])(
    '節内明示を生成・保存で同じく受理する: %s',
    (heading) => {
      const { pages, facts } = localReport(heading);
      const r = reviewCandidates(candidateResponse(facts, pages), 'other', pages);
      expect(r.unverified).toEqual([]);
      expect(r.facts).toHaveLength(3);
      expect(saved(r.facts, pages).facts).toEqual(r.facts);
      expect(renderFacts(saved(r.facts, pages))).toContain('個別、IFRS');
      const input = JSON.parse(serializeCandidateSource(pages));
      expect(
        input.contextTemplates.some(
          (t: { meaningOptions: { scope: string[]; basis: string[] } }) =>
            t.meaningOptions.scope.join() === '個別' && t.meaningOptions.basis.join() === 'IFRS'
        )
      ).toBe(true);
    }
  );
  it.each(['', '範囲 個別\n会計基準 IFRS'])(
    '同じ報告属性の決算必須を満たし、局所属性を付け直さない: %s',
    (fields) => {
      const { pages, facts } = localReport('経営成績', fields, true);
      const r = reviewCandidates(candidateResponse(facts, pages, 'earnings'), 'earnings', pages);
      expect(r.unverified).toEqual([]);
      expect(() => verifyCoverage('earnings', pages, r.facts)).not.toThrow();
      expect(saved(r.facts, pages, 'earnings', true).facts).toEqual(r.facts);
      expect(() => verifyCoverage('earnings', pages, r.facts.slice(1))).toThrow('revenue');
    }
  );
  it.each(['scope', 'basis'] as const)(
    '局所属性の欠落・表紙への改変・ID再計算を拒否する: %s',
    (role) => {
      const { pages, facts } = localReport('経営成績', undefined, true);
      for (const value of [null, role === 'scope' ? '連結' : '日本基準']) {
        const f = structuredClone(facts[0]);
        f.semantics[role] = value;
        expect(reviewCandidates(candidateResponse([f], pages), 'other', pages).facts).toEqual([]);
        f.id = stableFactId(f);
        expect(saved([f], pages).facts).toEqual([]);
        expect(() => verifyCoverage('earnings', pages, [f, ...facts.slice(1)])).toThrow('revenue');
      }
    }
  );
});

describe('主張の意味と報告単位', () => {
  // 語尾の分岐は assertion-semantics.test.ts、ここは意味→候補/保存の接続を確認する。
  it.each(['当社は取得を予定しておりません。', '当社は取得を予定（しておりません）。'])(
    '丁寧な否定を肯定予定として確定・保存しない: %s',
    (body) => {
      const { pages, f } = assertionCandidate(body, 'unspecified', 'negative');
      expect(assertionPolarity(body)).toBe('negative');
      expect(assertionStates(body)).toEqual([]);
      const good = reviewCandidates(candidateResponse([f], pages), 'other', pages);
      expect(good.unverified).toEqual([]);
      expect(good.facts).toHaveLength(1);
      expect(saved(good.facts, pages).facts).toEqual(good.facts);
      const wrong = structuredClone(f);
      wrong.semantics.polarity = 'affirmative';
      wrong.semantics.state = body.includes('予定') ? 'planned' : 'unspecified';
      expect(reviewCandidates(candidateResponse([wrong], pages), 'other', pages).facts).toEqual([]);
      expect(saved([evidence(wrong, pages)], pages).facts).toEqual([]);
    }
  );
  it('行いますの肯定を保持し、行いませんの誤候補を1回修復する', async () => {
    const positive = assertionCandidate(
      '当社は自己株式の取得を行います。',
      'unspecified',
      'affirmative'
    );
    const good = reviewCandidates(
      candidateResponse([positive.f], positive.pages),
      'other',
      positive.pages
    );
    expect(good.unverified).toEqual([]);
    expect(saved(good.facts, positive.pages).facts).toEqual(good.facts);
    const { pages, f } = assertionCandidate(
      '当社は自己株式の取得を行いません。',
      'unspecified',
      'negative'
    );
    const wrong = structuredClone(f);
    wrong.semantics.polarity = 'affirmative';
    vi.mocked(generateText)
      .mockReset()
      .mockResolvedValueOnce(candidateResponse([wrong], pages))
      .mockResolvedValueOnce(candidateResponse([f], pages));
    const result = await generateVerifiedFactSummary(config, 'other', 'source', pages);
    expect(result.repairAttempted).toBe(true);
    expect(generateText).toHaveBeenCalledTimes(2);
    expect(saved(result.facts.facts, pages).facts).toEqual(result.facts.facts);
    expect(renderFacts(result.facts)).toContain(f.quote);
    const forged = structuredClone(result.facts.facts[0]);
    forged.semantics.polarity = 'affirmative';
    forged.id = stableFactId(forged);
    validateSavedFacts({ version: 5, documentType: 'other', facts: [forged], unverified: [] });
    expect(saved([forged], pages).facts).toEqual([]);
  });
  it.each([
    '当社はAの取得を行いませんが別案件を取得しました。',
    '当社はAを取得しましたがBの取得を行いません。',
    '当社はAの取得を行っておらず別案件を取得しました。',
  ])('対比する肯定完了と否定をmixedで照合する: %s', (body) => {
    const { pages, f } = assertionCandidate(body, 'completed', 'mixed');
    expect(assertionPolarity(body)).toBe('mixed');
    expect(assertionStates(body)).toEqual(['completed']);
    const good = reviewCandidates(candidateResponse([f], pages), 'other', pages);
    expect(good.unverified).toEqual([]);
    expect(good.facts).toHaveLength(1);
    expect(saved(good.facts, pages).facts).toEqual(good.facts);
    const wrong = structuredClone(f);
    wrong.semantics.polarity = 'negative';
    expect(reviewCandidates(candidateResponse([wrong], pages), 'other', pages).facts).toEqual([]);
    expect(saved([evidence(wrong, pages)], pages).facts).toEqual([]);
    wrong.semantics.state = 'unspecified';
    expect(reviewCandidates(candidateResponse([wrong], pages), 'other', pages).facts).toEqual([]);
    expect(saved([evidence(wrong, pages)], pages).facts).toEqual([]);
  });
  it.each(['売上 高'])('同義表記へ修復した指標の診断を解消する: %s', async (metric) => {
    const { pages, f } = prose(`${period}の売上高は100百万円の見込みです。`);
    const wrong = structuredClone(f);
    wrong.semantics.scope = '連結';
    const initial = JSON.parse(candidateResponse([wrong], pages));
    initial.candidates[0].source.metric = metric;
    vi.mocked(generateText)
      .mockReset()
      .mockResolvedValueOnce(JSON.stringify(initial))
      .mockResolvedValueOnce(candidateResponse([f], pages));
    const result = await generateVerifiedFactSummary(config, 'other', 'source', pages);
    expect(result.facts.facts).toHaveLength(1);
    expect(result.facts.unverified).toEqual([]);
    expect(saved(result.facts.facts, pages).facts).toEqual(result.facts.facts);
    expect(generateText).toHaveBeenCalledTimes(2);
  });
  it('今後の見通しの予想を必須として受理し、欠落時だけ1回修復する', async () => {
    const report = localReport('経営成績', undefined, true);
    report.pages[0] = textPage(
      `${report.pages[0].text}\n${period}の通期業績予想について説明します。`
    );
    const future = textPage(localReport('今後の見通し').pages[1].text, 3);
    const pages = [...report.pages, future];
    const forecasts = ['売上高', '営業利益', '当期純利益'].map((label) => {
      const f = numberCandidate(future, label, 100, period);
      f.valueKind = f.semantics.state = 'forecast';
      f.semantics.scope = '個別';
      f.semantics.basis = 'IFRS';
      return f;
    });
    const response = candidateResponse([...report.facts, ...forecasts], pages, 'earnings');
    const valid = reviewCandidates(response, 'earnings', pages);
    expect(valid.unverified).toEqual([]);
    expect(valid.facts).toHaveLength(6);
    expect(saved(valid.facts, pages, 'earnings', true).facts).toEqual(valid.facts);
    expect(() =>
      verifyCoverage(
        'earnings',
        pages,
        valid.facts.filter((f) => f.label !== '売上高' || f.valueKind !== 'forecast')
      )
    ).toThrow('通期予想');
    vi.mocked(generateText)
      .mockReset()
      .mockResolvedValueOnce(
        candidateResponse([...report.facts, ...forecasts.slice(1)], pages, 'earnings')
      )
      .mockResolvedValueOnce(candidateResponse([forecasts[0]], pages, 'earnings'));
    const result = await generateVerifiedFactSummary(config, 'earnings', 'source', pages);
    expect(result.facts.facts).toHaveLength(6);
    expect(result.facts.unverified).toEqual([]);
    expect(generateText).toHaveBeenCalledTimes(2);
  });
  it('表紙直下の報告値へ明示属性を適用し、欠落と別節への転用を拒否する', () => {
    const pages = [
      textPage(
        `${period} 決算短信〔日本基準〕（連結）\n上場会社名 株式会社テスト\n${['売上高', '営業利益', '当期純利益'].map((label) => `${period}の${label}は100百万円です。`).join('\n')}`
      ),
    ];
    const facts = ['売上高', '営業利益', '当期純利益'].map((label) =>
      numberCandidate(pages[0], label, 100, period)
    );
    const good = reviewCandidates(candidateResponse(facts, pages, 'earnings'), 'earnings', pages);
    expect(good.unverified).toEqual([]);
    expect(good.facts).toHaveLength(3);
    expect(saved(good.facts, pages, 'earnings', true).facts).toEqual(good.facts);
    const missing = structuredClone(facts);
    missing.forEach((f) => {
      f.semantics.scope = f.semantics.basis = null;
    });
    expect(
      reviewCandidates(candidateResponse(missing, pages, 'earnings'), 'earnings', pages).facts
    ).toEqual([]);
    const missingSaved = structuredClone(good.facts);
    missingSaved.forEach((f) => {
      f.semantics.scope = f.semantics.basis = null;
      const anchor = f.evidence.kind === 'prose' ? f.evidence.blockId : f.evidence.valueId;
      f.evidence.scopeIds = resolveScopeIds(
        bindingFor(buildDocumentContext(pages), anchor),
        f.semantics,
        false
      );
      f.id = stableFactId(f);
    });
    validateSavedFacts({
      version: 5,
      documentType: 'earnings',
      facts: missingSaved,
      unverified: [],
    });
    expect(saved(missingSaved, pages).facts).toEqual([]);
    const business = textPage(`1. 事業説明\n${period}の売上高は200百万円です。`, 2);
    const extra = numberCandidate(business, '売上高', 200, period);
    extra.semantics.scope = extra.semantics.basis = null;
    const valid = reviewCandidates(candidateResponse([extra], [...pages, business]), 'other', [
      ...pages,
      business,
    ]);
    expect(valid.unverified).toEqual([]);
    expect(valid.facts).toHaveLength(1);
  });
});

describe('表紙宣言の出典範囲', () => {
  const metrics = ['売上高', '営業利益', '当期純利益'];
  const values = metrics.map((m) => `${period}の${m}は100百万円です。`).join('\n');
  it.each(['事業概況', '当社の事業について説明します。', '売上構成は以下のとおりです。'])(
    '番号のない本文で表紙の報告範囲を閉じ、再開しない: %s',
    (boundary) => {
      const pages = [
        textPage(
          `${period} 決算短信〔日本基準〕（連結）\n会社名 株式会社テスト\n${values}\n${boundary}\n${period}の売上高は200百万円です。`
        ),
      ];
      const roots = metrics.map((m) => numberCandidate(pages[0], m, 100, period));
      const late = numberCandidate(pages[0], '売上高', 200, period);
      if (late.evidence.kind !== 'prose') throw new Error('expected prose');
      const block = pages[0].blocks.find((b) => b.text === `${period}の売上高は200百万円です。`)!;
      late.evidence.blockId = block.id;
      late.quote = block.text;
      late.semantics.scope = late.semantics.basis = null;
      const good = reviewCandidates(
        candidateResponse([...roots, late], pages, 'earnings'),
        'earnings',
        pages
      );
      expect(good.unverified).toEqual([]);
      expect(good.facts).toHaveLength(4);
      expect(saved(good.facts, pages, 'earnings', true).facts).toEqual(good.facts);
      const withoutRevenue = good.facts.filter((f) => f.label !== '売上高' || f.value === 200);
      expect(() => verifyCoverage('earnings', pages, withoutRevenue)).toThrow('revenue');
      const slots = coverageReport('earnings', pages, withoutRevenue);
      const revenue = slots.find((s) => s.requirement.includes('revenue'))!;
      // Retain the cover prose source; the later business paragraph cannot replace it.
      expect(revenue.status).toBe('absent');
      expect(revenue.sourceIds).not.toContain(block.id);
      const wrong = structuredClone(late);
      wrong.semantics.scope = '連結';
      wrong.semantics.basis = '日本基準';
      expect(reviewCandidates(candidateResponse([wrong], pages), 'other', pages).facts).toEqual([]);
      const forged = structuredClone(good.facts.find((f) => f.value === 200)!);
      forged.semantics.scope = '連結';
      forged.semantics.basis = '日本基準';
      forged.evidence.scopeIds = resolveScopeIds(
        bindingFor(buildDocumentContext(pages), block.id),
        forged.semantics,
        true
      );
      forged.id = stableFactId(forged);
      validateSavedFacts({ version: 5, documentType: 'other', facts: [forged], unverified: [] });
      expect(saved([forged], pages).facts).toEqual([]);
    }
  );
  it('表紙への言及だけでは明示報告の出典にしない', () => {
    const pages = [
      textPage(`会社名 株式会社テスト\n参考: ${period} 決算短信について説明します。\n${values}`),
    ];
    const facts = metrics.map((m) => {
      const f = numberCandidate(pages[0], m, 100, period);
      f.semantics.scope = f.semantics.basis = null;
      return f;
    });
    const good = reviewCandidates(candidateResponse(facts, pages), 'other', pages);
    expect(good.unverified).toEqual([]);
    expect(good.facts).toHaveLength(3);
    expect(() => verifyCoverage('earnings', pages, good.facts)).toThrow('revenue');
  });
});

describe('負号と主張の同一性', () => {
  it.each(['△', '▲', '−', '-'])('表紙直下の負号%sを数量解析と同じ意味で保持する', (sign) => {
    const pages = [
      textPage(
        `${period} 決算短信〔日本基準〕（連結）\n会社名 株式会社テスト\n${period}の売上高は100百万円です。\n${period}の営業損失は${sign}10百万円です。\n${period}の当期純利益は100百万円です。`
      ),
    ];
    const facts = ['売上高', '営業損失', '当期純利益'].map((label) =>
      numberCandidate(pages[0], label, label === '営業損失' ? -10 : 100, period)
    );
    const good = reviewCandidates(candidateResponse(facts, pages, 'earnings'), 'earnings', pages);
    expect(good.unverified).toEqual([]);
    expect(good.facts).toHaveLength(3);
    expect(good.facts[1].quantity?.decimal).toBe('-10');
    expect(saved(good.facts, pages, 'earnings', true).facts).toEqual(good.facts);
    expect(
      renderFacts({ version: 5, documentType: 'earnings', facts: good.facts, unverified: [] })
    ).toContain('営業損失: -10百万円');
  });
  function datedAssertion(kind: 'event' | 'status' = 'event') {
    const source = localReport('経営成績', undefined, true);
    const body =
      kind === 'status'
        ? '当社は2027年3月1日に業績予想未定とすることを決議しました。'
        : '当社は2027年3月1日に決議しました。';
    const pages = [...source.pages, textPage(`1. 事業説明\n${body}`, 3)];
    const event = numberCandidate(pages[2], '当社');
    event.kind = kind;
    event.label = event.statement = event.quote;
    event.value = event.unit = event.valueKind = null;
    event.period = null;
    event.semantics = {
      ...event.semantics,
      scope: null,
      basis: null,
      periodKind: 'none',
      metricKind: 'none',
      state: 'decided',
    };
    const dated = structuredClone(event);
    dated.period = '2027年3月1日';
    dated.semantics.periodKind = 'eventDate';
    return { pages, number: source.facts[0], baseline: source.facts.slice(1), event, dated };
  }
  it.each([
    ['event', false],
    ['event', true],
    ['status', false],
    ['status', true],
  ] as const)(
    '差分修復で同じ%sの期間表記を変更できない（初回日付=%s）',
    async (kind, initialDated) => {
      const { pages, number, baseline, event, dated } = datedAssertion(kind);
      const before = initialDated ? dated : event;
      const after = initialDated ? event : dated;
      for (const f of [before, after]) {
        const good = reviewCandidates(candidateResponse([f], pages), 'other', pages);
        expect(good.unverified).toEqual([]);
        expect(saved(good.facts, pages).facts).toEqual(good.facts);
      }
      vi.mocked(generateText)
        .mockReset()
        .mockResolvedValueOnce(candidateResponse([...baseline, before], pages, 'earnings'))
        .mockResolvedValueOnce(candidateResponse([after, number], pages, 'earnings'));
      await expect(
        generateVerifiedFactSummary(config, 'earnings', 'source', pages)
      ).rejects.toThrow('確定済み原文の意味');
      expect(generateText).toHaveBeenCalledTimes(2);
    }
  );
  it.each(['event', 'status'] as const)(
    '同じ%sの期間別二重候補・保存を拒否し、同一再送は1件に保つ',
    async (kind) => {
      const { pages, number, baseline, event, dated } = datedAssertion(kind);
      const conflicting = reviewCandidates(
        candidateResponse([event, dated], pages),
        'other',
        pages
      );
      expect(conflicting.facts).toHaveLength(1);
      expect(conflicting.unverified.join('\n')).toContain('同一原文単位');
      const complete = [event, dated].map(
        (f) => reviewCandidates(candidateResponse([f], pages), 'other', pages).facts[0]
      );
      validateSavedFacts({ version: 5, documentType: 'other', facts: complete, unverified: [] });
      const rechecked = saved(complete, pages);
      expect(rechecked.facts).toHaveLength(1);
      expect(rechecked.unverified.join('\n')).toContain('同一原文単位');
      vi.mocked(generateText)
        .mockReset()
        .mockResolvedValueOnce(candidateResponse([...baseline, event], pages, 'earnings'))
        .mockResolvedValueOnce(candidateResponse([event, number], pages, 'earnings'));
      const good = await generateVerifiedFactSummary(config, 'earnings', 'source', pages);
      expect(good.facts.facts).toHaveLength(4);
      expect(good.facts.facts.find((f) => f.kind === kind)).toEqual(complete[0]);
      expect(saved(good.facts.facts, pages, 'earnings', true).facts).toEqual(good.facts.facts);
    }
  );
});

describe('局所属性を持つ決算の必須事実と修復', () => {
  function earningsWithBackground() {
    const actual = localReport('経営成績', undefined, true);
    const future = localReport('業績予想').pages[1];
    // A separate physical page keeps the two source periods/states independent.
    const forecastPage = textPage(future.text, 3);
    const bodyPage = textPage(
      '1. 今後の見通し\n範囲 個別\n会計基準 IFRS\n概算額100百万円により当期純損失が見込まれます。\n翌連結会計年度の特別損失に計上する予定です。',
      4
    );
    const pages = [...actual.pages, forecastPage, bodyPage];
    const forecast = ['売上高', '営業利益', '当期純利益'].map((label, i) => {
      const f = numberCandidate(forecastPage, label, 100, period);
      f.id = `f${i + 4}`;
      f.valueKind = f.semantics.state = 'forecast';
      f.semantics.scope = '個別';
      f.semantics.basis = 'IFRS';
      return evidence(f, pages);
    });
    const events = ['概算額', '特別損失'].map((label, i) => {
      const f = numberCandidate(bodyPage, label);
      f.id = `f${i + 7}`;
      f.kind = 'event';
      f.label = f.statement = f.quote;
      f.value = f.unit = f.valueKind = null;
      f.period = i === 0 ? null : '翌連結会計年度';
      f.semantics = {
        ...f.semantics,
        scope: '個別',
        basis: 'IFRS',
        metricKind: 'none',
        periodKind: i === 0 ? 'none' : 'relativeYear',
        state: i === 0 ? 'forecast' : 'planned',
        qualifiers: i === 0 ? ['概算額'] : [],
      };
      return evidence(f, pages);
    });
    return { pages, facts: [...actual.facts, ...forecast, ...events] };
  }
  it('実績・予想・背景・翌期計上予定の必須属性を原文単位へ揃える', () => {
    const { pages, facts } = earningsWithBackground();
    const r = reviewCandidates(candidateResponse(facts, pages, 'earnings'), 'earnings', pages);
    expect(r.unverified).toEqual([]);
    expect(r.facts).toHaveLength(8);
    expect(saved(r.facts, pages, 'earnings', true).facts).toEqual(r.facts);
    for (const index of [3, 6, 7])
      expect(() =>
        verifyCoverage(
          'earnings',
          pages,
          r.facts.filter((_, i) => i !== index)
        )
      ).toThrow('COVERAGE');
  });
  it('局所属性を別の報告範囲へ誤変更した初回を1回修復し保存する', async () => {
    const { pages, facts } = earningsWithBackground();
    const wrong = structuredClone(facts);
    wrong[3].semantics.scope = '連結';
    vi.mocked(generateText)
      .mockReset()
      .mockResolvedValueOnce(candidateResponse(wrong, pages, 'earnings'))
      .mockResolvedValueOnce(candidateResponse([facts[3]], pages, 'earnings'));
    const r = await generateVerifiedFactSummary(
      config,
      'earnings',
      pages.map((p) => p.text).join('\n'),
      pages
    );
    expect(r.repairAttempted).toBe(true);
    expect(generateText).toHaveBeenCalledTimes(2);
    expect(saved(r.facts.facts, pages, 'earnings', true).facts).toEqual(r.facts.facts);
    expect(renderFacts(r.facts)).toContain('個別、IFRS');
  });
  it('不足の差分修復でも未対応の任意候補とモデルの未確認を残す', async () => {
    const { pages, facts } = earningsWithBackground();
    const optionalPage = textPage(
      `1. 事業説明\n${period}の補足指標は200百万円に届かない見込みです。`,
      5
    );
    pages.push(optionalPage);
    const optional = numberCandidate(optionalPage, '補足指標', 200, period);
    optional.semantics.scope = optional.semantics.basis = null;
    optional.valueKind = optional.semantics.state = 'forecast';
    const first = JSON.parse(
      candidateResponse([...facts.filter((_, i) => i !== 3), optional], pages, 'earnings')
    );
    first.unverified = ['OCR図表の内訳は確認できません'];
    const review = reviewCandidates(JSON.stringify(first), 'earnings', pages);
    expect(review.unverified).toHaveLength(2);
    vi.mocked(generateText)
      .mockReset()
      .mockResolvedValueOnce(JSON.stringify(first))
      .mockResolvedValueOnce(candidateResponse([facts[3]], pages, 'earnings'));
    const r = await generateVerifiedFactSummary(config, 'earnings', 'source', pages);
    expect(r.facts.unverified).toEqual(review.unverified);
    expect(renderFacts(r.facts)).toContain('OCR図表の内訳は確認できません');
    expect(saved(r.facts.facts, pages, 'earnings', true).facts).toEqual(r.facts.facts);
    expect(generateText).toHaveBeenCalledTimes(2);
  });
  it('受理した修復元の診断だけを消し、同じ文字列のモデル未確認は維持する', async () => {
    const { pages, facts } = earningsWithBackground();
    const wrong = structuredClone(facts);
    wrong[3].semantics.scope = '連結';
    const initial = JSON.parse(candidateResponse(wrong, pages, 'earnings'));
    const warnings = reviewCandidates(JSON.stringify(initial), 'earnings', pages).unverified;
    expect(warnings).toHaveLength(1);
    initial.unverified = [...warnings, '別の原文の内訳は確認できません'];
    vi.mocked(generateText)
      .mockReset()
      .mockResolvedValueOnce(JSON.stringify(initial))
      .mockResolvedValueOnce(candidateResponse([facts[3]], pages, 'earnings'));
    const r = await generateVerifiedFactSummary(config, 'earnings', 'source', pages);
    expect(r.facts.unverified).toEqual(initial.unverified);
    expect(generateText).toHaveBeenCalledTimes(2);
  });
  it('完結eventでも誤った状態・極性は修復成功にしない', async () => {
    const { pages, f } = prose(`${period}の売上高は100百万円ではなく200百万円を見込んでおります。`);
    const event = {
      ...f,
      kind: 'event' as const,
      label: f.quote,
      statement: f.quote,
      value: null,
      unit: null,
      valueKind: null,
      semantics: {
        ...f.semantics,
        metricKind: 'none' as const,
        state: 'actual' as const,
        polarity: 'affirmative' as const,
      },
    };
    vi.mocked(generateText)
      .mockReset()
      .mockResolvedValueOnce(candidateResponse([f], pages))
      .mockResolvedValueOnce(candidateResponse([event], pages));
    await expect(
      generateVerifiedFactSummary(config, 'other', pages[0].text, pages)
    ).rejects.toThrow('重要事実');
    expect(generateText).toHaveBeenCalledTimes(2);
    expect(saved([evidence(event, pages)], pages).facts).toEqual([]);
  });
});

describe('IFRS表紙と会社名欄', () => {
  function cover(label: string, field = '上場会社名 株式会社テスト') {
    const pages = [
      textPage(
        `${period} 決算短信〔IFRS〕（連結）\n${field}\n${period}の売上高は100百万円です。\n${period}の営業利益は100百万円です。\n${period}の${label}は100百万円です。\n${period}の総資産は200百万円です。`
      ),
    ];
    const facts = ['売上高', '営業利益', label, '総資産'].map((m) => {
      const f = numberCandidate(pages[0], m, m === '総資産' ? 200 : 100, period);
      f.semantics.basis = 'IFRS';
      return f;
    });
    return { pages, facts };
  }
  it.each([
    '親会社の所有者に帰属する四半期利益',
    '親会社の所有者に帰属する当期利益',
    '親会社の所有者に帰属する中間損失',
    '親会社の所有者に帰属する四半期純利益',
  ])('純の有無で報告値と後続値の適用属性・必須判定を変えない: %s', (label) => {
    const { pages, facts } = cover(label);
    const good = reviewCandidates(candidateResponse(facts, pages, 'earnings'), 'earnings', pages);
    expect(good.unverified).toEqual([]);
    expect(good.facts).toHaveLength(4);
    expect(saved(good.facts, pages, 'earnings', true).facts).toEqual(good.facts);
    expect(() =>
      verifyCoverage(
        'earnings',
        pages,
        good.facts.filter((f) => f.label !== label)
      )
    ).toThrow('netProfit');
    const wrong = structuredClone(good.facts.slice(2));
    wrong.forEach((f) => {
      f.semantics.scope = f.semantics.basis = null;
      f.evidence.scopeIds = resolveScopeIds(
        bindingFor(
          buildDocumentContext(pages),
          f.evidence.kind === 'prose' ? f.evidence.blockId : ''
        ),
        f.semantics,
        false
      );
      f.id = stableFactId(f);
    });
    validateSavedFacts({ version: 5, documentType: 'other', facts: wrong, unverified: [] });
    expect(reviewCandidates(candidateResponse(wrong, pages), 'other', pages).facts).toEqual([]);
    expect(saved(wrong, pages).facts).toEqual([]);
    expect(
      renderFacts({ version: 5, documentType: 'earnings', facts: good.facts, unverified: [] })
    ).toContain('連結、IFRS');
  });
  it.each([
    ['上場会社名', ' '],
    ['会社名', ':'],
    ['名称', '：'],
  ])('会社名欄%sの区切り%sを主体へ混入しない', (field, separator) => {
    const { pages, facts } = cover('当期純利益', `${field}${separator}株式会社テスト`);
    const good = reviewCandidates(candidateResponse(facts, pages, 'earnings'), 'earnings', pages);
    expect(good.unverified).toEqual([]);
    expect(good.facts).toHaveLength(4);
    expect(saved(good.facts, pages, 'earnings', true).facts).toEqual(good.facts);
    const offered = buildDocumentContext(pages)
      .bindings.flatMap((b) => b.declarations)
      .filter((d) => d.role === 'subject')
      .map((d) => d.value);
    expect(offered).toContain('株式会社テスト');
    expect(offered).not.toContain(':株式会社テスト');
    const serialized = JSON.parse(serializeCandidateSource(pages, undefined, 'earnings'));
    expect(
      serialized.contextTemplates.flatMap(
        (t: { meaningOptions: { subject: string[] } }) => t.meaningOptions.subject
      )
    ).not.toContain(':株式会社テスト');
    const wrong = structuredClone(good.facts[0]);
    wrong.semantics.subject = ':株式会社テスト';
    wrong.id = stableFactId(wrong);
    validateSavedFacts({ version: 5, documentType: 'other', facts: [wrong], unverified: [] });
    expect(reviewCandidates(candidateResponse([wrong], pages), 'other', pages).facts).toEqual([]);
    expect(saved([wrong], pages).facts).toEqual([]);
    expect(
      renderFacts({ version: 5, documentType: 'earnings', facts: good.facts, unverified: [] })
    ).not.toContain(':株式会社テスト');
  });
  it('IFRS表紙の会社名区切りと利益名を1回修復して表示・保存する', async () => {
    const { pages, facts } = cover(
      '親会社の所有者に帰属する四半期利益',
      '上場会社名：株式会社テスト'
    );
    const wrong = structuredClone(facts);
    wrong[2].semantics.basis = null;
    vi.mocked(generateText)
      .mockReset()
      .mockResolvedValueOnce(candidateResponse(wrong, pages, 'earnings'))
      .mockResolvedValueOnce(candidateResponse([facts[2]], pages, 'earnings'));
    const r = await generateVerifiedFactSummary(config, 'earnings', 'source', pages);
    expect(r.repairAttempted).toBe(true);
    expect(generateText).toHaveBeenCalledTimes(2);
    expect(saved(r.facts.facts, pages, 'earnings', true).facts).toEqual(r.facts.facts);
    expect(renderFacts(r.facts)).toContain('株式会社テスト');
  });
});

describe('指標の明示性と受動形予想', () => {
  function report(label: string, extra = false) {
    const pages = [
      textPage(
        `${period} 決算短信〔IFRS〕（連結）\n会社名 株式会社テスト\n${period}の売上高は100百万円です。\n${period}の営業利益は100百万円です。\n${period}の${label}は5百万円です。`
      ),
    ];
    const facts = ['売上高', '営業利益', label].map((m, i) => {
      const f = numberCandidate(pages[0], m, i === 2 ? 5 : 100, period);
      if (f.evidence.kind !== 'prose') throw new Error('expected prose');
      const block = pages[0].blocks.find((b) => b.text.startsWith(`${period}の${m}は`))!;
      f.evidence.blockId = block.id;
      f.quote = block.text;
      f.semantics.basis = 'IFRS';
      return f;
    });
    if (extra) pages.push(textPage(`1. 経営成績\n${period}の当期利益は100百万円です。`, 2));
    return { pages, facts };
  }
  it.each(['利益', '損失'])('曖昧な%sで表紙属性や必須純利益を証明しない', async (label) => {
    const { pages, facts } = report(label);
    expect(standardMetric(facts[2])).toBeNull();
    const r = reviewCandidates(candidateResponse(facts, pages, 'earnings'), 'earnings', pages);
    expect(r.facts).toHaveLength(2);
    const generic = structuredClone(facts[2]);
    generic.semantics.scope = generic.semantics.basis = null;
    const standalone = reviewCandidates(candidateResponse([generic], pages), 'other', pages);
    expect(standalone.unverified).toEqual([]);
    expect(standalone.facts).toHaveLength(1);
    expect(saved(standalone.facts, pages).facts).toEqual(standalone.facts);
    const forged = structuredClone(standalone.facts[0]);
    forged.semantics.scope = '連結';
    forged.semantics.basis = 'IFRS';
    forged.evidence.scopeIds = resolveScopeIds(
      bindingFor(
        buildDocumentContext(pages),
        forged.evidence.kind === 'prose' ? forged.evidence.blockId : ''
      ),
      forged.semantics,
      true
    );
    forged.id = stableFactId(forged);
    validateSavedFacts({
      version: 5,
      documentType: 'earnings',
      facts: [...r.facts, forged],
      unverified: [],
    });
    expect(saved([forged], pages).facts).toEqual([]);
    expect(() => verifyCoverage('earnings', pages, [...r.facts, standalone.facts[0]])).toThrow(
      'netProfit'
    );
    expect(() => saved([...r.facts, standalone.facts[0]], pages, 'earnings', true)).toThrow(
      'netProfit'
    );
    vi.mocked(generateText)
      .mockReset()
      .mockResolvedValue(candidateResponse(facts, pages, 'earnings'));
    await expect(generateVerifiedFactSummary(config, 'earnings', 'source', pages)).rejects.toThrow(
      'netProfit'
    );
    expect(generateText).not.toHaveBeenCalled();
  });
  it.each(['利益', '損失'])('財務節でも%sだけでは必須純利益を満たさない', (label) => {
    const source = localReport('経営成績', undefined, true);
    const detail = textPage(source.pages[1].text.replace('当期純利益', label), 2);
    const pages = [source.pages[0], detail];
    const facts = ['売上高', '営業利益', label].map((m) => {
      const f = numberCandidate(detail, m, 100, period);
      if (f.evidence.kind !== 'prose') throw new Error('expected prose');
      const block = detail.blocks.find((b) => b.text.startsWith(`${period}の${m}は`))!;
      f.evidence.blockId = block.id;
      f.quote = block.text;
      f.semantics.scope = '個別';
      f.semantics.basis = 'IFRS';
      return f;
    });
    const r = reviewCandidates(candidateResponse(facts, pages, 'earnings'), 'earnings', pages);
    expect(r.unverified).toEqual([]);
    expect(r.facts).toHaveLength(3);
    expect(saved(r.facts, pages).facts).toEqual(r.facts);
    expect(() => verifyCoverage('earnings', pages, r.facts)).toThrow('netProfit');
  });
  it.each([
    '当期利益',
    '四半期損失',
    '中間利益',
    '親会社の所有者に帰属する利益',
    '親会社株主に帰属する純損失',
    '純利益',
    '純損失',
  ])('純損益の明示された正常指標を保持する: %s', (label) => {
    const { pages, facts } = report(label);
    expect(standardMetric(facts[2])).toBe('netProfit');
    const good = reviewCandidates(candidateResponse(facts, pages, 'earnings'), 'earnings', pages);
    expect(good.unverified).toEqual([]);
    expect(good.facts).toHaveLength(3);
    expect(saved(good.facts, pages, 'earnings', true).facts).toEqual(good.facts);
  });
  it('曖昧な利益を除外して明示された別原文の純利益で修復する', async () => {
    const { pages, facts } = report('利益', true);
    const replacement = numberCandidate(pages[1], '当期利益', 100, period);
    replacement.semantics.basis = 'IFRS';
    vi.mocked(generateText)
      .mockReset()
      .mockResolvedValueOnce(candidateResponse(facts, pages, 'earnings'))
      .mockResolvedValueOnce(candidateResponse([replacement], pages, 'earnings'));
    const result = await generateVerifiedFactSummary(config, 'earnings', 'source', pages);
    expect(result.repairAttempted).toBe(true);
    expect(result.facts.facts.map((f) => f.label)).toEqual(['売上高', '営業利益', '当期利益']);
    expect(saved(result.facts.facts, pages, 'earnings', true).facts).toEqual(result.facts.facts);
    expect(result.facts.unverified).toEqual(
      reviewCandidates(candidateResponse(facts, pages, 'earnings'), 'earnings', pages).unverified
    );
  });
  it.each(['と見込まれます。', 'と見込まれる。', 'と見込まれています。'])(
    '受動形の完結した予想を数量・状態・保存で受理する: %s',
    (tail) => {
      const { pages, f } = prose(`${period}の売上高は100百万円${tail}`);
      const r = reviewCandidates(candidateResponse([f], pages), 'other', pages);
      expect(assertionStates(f.quote)).toEqual(['forecast']);
      expect(r.unverified).toEqual([]);
      expect(r.facts).toHaveLength(1);
      expect(saved(r.facts, pages).facts).toEqual(r.facts);
      expect(
        renderFacts({ version: 5, documentType: 'other', facts: r.facts, unverified: [] })
      ).toContain('売上高: 100百万円');
    }
  );
  it.each([
    'と見込まれますが確定していません。',
    'と見込まれます。実際には100百万円に届かない見込みです。',
    'とは見込まれません。',
  ])('受動形でも未検査の否定・撤回・後続を通さない: %s', (tail) => {
    const { pages, f } = prose(`${period}の売上高は100百万円${tail}`);
    expect(reviewCandidates(candidateResponse([f], pages), 'other', pages).facts).toEqual([]);
    // A complete positive saved fact is transplanted into the changed source;
    // its quantity/source IDs and schema stay intact, so meaning must reject it.
    const normal = prose(`${period}の売上高は100百万円と見込んでおります。`);
    const base = reviewCandidates(
      candidateResponse([normal.f], normal.pages),
      'other',
      normal.pages
    ).facts[0];
    base.quote = f.quote;
    base.provenance!.assertion!.end = base.quote.normalize('NFKC').length;
    base.id = stableFactId(base);
    validateSavedFacts({ version: 5, documentType: 'other', facts: [base], unverified: [] });
    expect(saved([base], pages).facts).toEqual([]);
  });
  it.each(['ます'])(
    '必須予想の受動形「見込まれ%s」を差分修復して表示・保存する',
    async (ending) => {
      const actual = localReport('経営成績', undefined, true);
      const future = textPage(
        `1. ${period} 業績予想\n範囲 個別\n会計基準 IFRS\n${['売上高', '営業利益', '当期純利益'].map((m) => `${period}の${m}は100百万円と見込まれ${ending}。`).join('\n')}`,
        3
      );
      const pages = [...actual.pages, future];
      const forecast = ['売上高', '営業利益', '当期純利益'].map((m) => {
        const f = numberCandidate(future, m, 100, period);
        f.valueKind = f.semantics.state = 'forecast';
        f.semantics.scope = '個別';
        f.semantics.basis = 'IFRS';
        return f;
      });
      vi.mocked(generateText)
        .mockReset()
        .mockResolvedValueOnce(
          candidateResponse([...actual.facts, ...forecast.slice(1)], pages, 'earnings')
        )
        .mockResolvedValueOnce(candidateResponse([forecast[0]], pages, 'earnings'));
      const result = await generateVerifiedFactSummary(config, 'earnings', 'source', pages);
      expect(result.repairAttempted).toBe(true);
      expect(result.facts.facts).toHaveLength(6);
      expect(saved(result.facts.facts, pages, 'earnings', true).facts).toEqual(result.facts.facts);
      expect(renderFacts(result.facts)).toContain('個別、IFRS');
    }
  );
});

describe('eventの極性と未完了の状態', () => {
  function check(
    body: string,
    state: VerifiedFact['semantics']['state'],
    polarity: VerifiedFact['semantics']['polarity'],
    wrongState: VerifiedFact['semantics']['state'],
    wrongPolarity: VerifiedFact['semantics']['polarity'],
    kind: 'event' | 'status' = 'event'
  ) {
    const { pages, f } = assertionCandidate(body, state, polarity, kind);
    const good = reviewCandidates(candidateResponse([f], pages), 'other', pages);
    expect(good.unverified).toEqual([]);
    expect(good.facts).toHaveLength(1);
    expect(saved(good.facts, pages).facts).toEqual(good.facts);
    const forged = structuredClone(good.facts[0]);
    forged.semantics.state = wrongState;
    forged.semantics.polarity = wrongPolarity;
    forged.id = stableFactId(forged);
    validateSavedFacts({ version: 5, documentType: 'other', facts: [forged], unverified: [] });
    expect(reviewCandidates(candidateResponse([forged], pages), 'other', pages).facts).toEqual([]);
    expect(saved([forged], pages).facts).toEqual([]);
    expect(
      renderFacts({ version: 5, documentType: 'other', facts: good.facts, unverified: [] })
    ).toContain(body);
    return { pages, f, forged };
  }
  it.each(['とは見込まれません'])(
    '受動形の否定%sをeventでもnegative/forecastで照合する',
    (ending) => {
      const body = `売上高は100百万円${ending}。`;
      expect(assertionPolarity(body)).toBe('negative');
      expect(assertionStates(body)).toEqual(['forecast']);
      check(body, 'forecast', 'negative', 'forecast', 'affirmative');
    }
  );
  it('未定statusでも受動形否定を肯定forecastとして保存しない', () => {
    check(
      '売上高は100百万円とは見込まれません。業績予想は未定です。',
      'forecast',
      'mixed',
      'forecast',
      'affirmative',
      'status'
    );
  });
  it.each([
    '当社はAの取得を行いますが、Bの取得は行いません。',
    '当社はAの取得を行いませんがBの取得を行います。',
  ])('現在形の対比をmixed/unspecifiedとして保持する: %s', (body) => {
    expect(assertionPolarity(body)).toBe('mixed');
    check(body, 'unspecified', 'mixed', 'unspecified', 'negative');
  });
  it('肯定と否定の受動形予想をmixed/forecastとして保持する', () => {
    check(
      '売上高は200百万円と見込まれますが100百万円とは見込まれません。',
      'forecast',
      'mixed',
      'forecast',
      'negative'
    );
  });
  it.each(['売上高は100百万円とは見込まれず200百万円と見込まれます。'])(
    '予想の対比と否定接続でもmixed/forecastを保持する: %s',
    (body) => {
      check(body, 'forecast', 'mixed', 'forecast', 'negative');
    }
  );
  it.each(['当社は来期に新工場を建設することとなりました。'])(
    '未完了の取決めをactualに変換しない: %s',
    (body) => {
      expect(assertionStates(body)).toEqual([]);
      check(body, 'unspecified', 'affirmative', 'actual', 'affirmative');
    }
  );
  it.each([
    ['当社は新工場建設を予定しております。', 'planned'],
    ['当社は新工場建設を決定しました。', 'decided'],
    ['当社は新工場建設を完了しました。', 'completed'],
    ['当社は特別損失を計上しました。', 'actual'],
  ] as const)('明示された状態を保持する: %s', (body, state) => {
    const { pages, f } = assertionCandidate(body, state, 'affirmative');
    const good = reviewCandidates(candidateResponse([f], pages), 'other', pages);
    expect(good.unverified).toEqual([]);
    expect(good.facts).toHaveLength(1);
    expect(saved(good.facts, pages).facts).toEqual(good.facts);
  });
  it('財務実績のとなりましたはnumberの意味検証で維持する', () => {
    const source = localReport('経営成績', undefined, true);
    const detail = textPage(source.pages[1].text.replace(/です。/g, 'となりました。'), 2);
    const pages = [source.pages[0], detail];
    const facts = ['売上高', '営業利益', '当期純利益'].map((m) => {
      const f = numberCandidate(detail, m, 100, period);
      f.semantics.scope = '個別';
      f.semantics.basis = 'IFRS';
      return f;
    });
    const good = reviewCandidates(candidateResponse(facts, pages, 'earnings'), 'earnings', pages);
    expect(good.unverified).toEqual([]);
    expect(good.facts).toHaveLength(3);
    expect(saved(good.facts, pages, 'earnings', true).facts).toEqual(good.facts);
  });
  it.each([
    ['売上高は100百万円とは見込まれません。', 'forecast', 'negative', 'forecast', 'affirmative'],
    [
      '当社はAの取得を行いますがBの取得は行いません。',
      'unspecified',
      'mixed',
      'unspecified',
      'negative',
    ],
    [
      '当社は来期に新工場を建設することとなりました。',
      'unspecified',
      'affirmative',
      'actual',
      'affirmative',
    ],
  ] as const)(
    '誤ったeventの意味を1回修復して保存する: %s',
    async (body, state, polarity, wrongState, wrongPolarity) => {
      const { pages, f } = assertionCandidate(body, state, polarity);
      const wrong = structuredClone(f);
      wrong.semantics.state = wrongState;
      wrong.semantics.polarity = wrongPolarity;
      vi.mocked(generateText)
        .mockReset()
        .mockResolvedValueOnce(candidateResponse([wrong], pages))
        .mockResolvedValueOnce(candidateResponse([f], pages));
      const result = await generateVerifiedFactSummary(config, 'other', 'source', pages);
      expect(result.repairAttempted).toBe(true);
      expect(generateText).toHaveBeenCalledTimes(2);
      expect(saved(result.facts.facts, pages).facts).toEqual(result.facts.facts);
    }
  );
  it('数量否定からeventへの修復にも極性とforecast状態を強制する', async () => {
    const { pages, f } = prose(`${period}の売上高は100百万円とは見込まれません。`);
    const event = structuredClone(f);
    event.kind = 'event';
    event.label = event.statement = event.quote;
    event.value = event.unit = event.valueKind = null;
    event.semantics.metricKind = 'none';
    event.semantics.polarity = 'negative';
    vi.mocked(generateText)
      .mockReset()
      .mockResolvedValueOnce(candidateResponse([f], pages))
      .mockResolvedValueOnce(candidateResponse([event], pages));
    const result = await generateVerifiedFactSummary(config, 'other', 'source', pages);
    expect(result.facts.facts[0]).toMatchObject({
      kind: 'event',
      semantics: { state: 'forecast', polarity: 'negative' },
    });
    expect(saved(result.facts.facts, pages).facts).toEqual(result.facts.facts);
    event.semantics.polarity = 'affirmative';
    vi.mocked(generateText)
      .mockReset()
      .mockResolvedValueOnce(candidateResponse([f], pages))
      .mockResolvedValueOnce(candidateResponse([event], pages));
    await expect(generateVerifiedFactSummary(config, 'other', 'source', pages)).rejects.toThrow(
      '重要事実'
    );
  });
});

describe('本文数量・利益率・見通しの利用経路', () => {
  function persistedNumber(f: VerifiedFact, pages: ReturnType<typeof textPage>[]) {
    evidence(f, pages);
    if (f.evidence.kind !== 'prose') throw Error('expected prose');
    const blockId = f.evidence.blockId;
    const block = pages[0].blocks.find((b) => b.id === blockId)!;
    f.quantity = {
      raw: String(f.value),
      decimal: String(f.value),
      sourceIds: block.spanIds.flatMap((id) => pages[0].spans.find((s) => s.id === id)!.sourceIds!),
    };
    f.dateRoles = [];
    f.provenance = forgedProvenance(f, pages);
    f.id = stableFactId(f);
    validateSavedFacts({ version: 5, documentType: 'other', facts: [f], unverified: [] });
    return f;
  }
  it('空白付き範囲の全断片を1候補として保持する', () => {
    const { pages, f } = prose(`${period}の売上高は 100 ～ 200 百万円の見込みです。`);
    f.kind = 'range';
    f.value = null;
    f.quantity = {
      raw: '100 ～ 200 百万円'.normalize('NFKC'),
      decimal: null,
      lower: '100',
      upper: '200',
      sourceIds: [],
    };
    const checked = reviewCandidates(candidateResponse([f], pages), 'other', pages);
    expect(checked.unverified).toEqual([]);
    expect(checked.facts[0].quantity).toMatchObject({ lower: '100', upper: '200' });
    expect(saved(checked.facts, pages).facts).toEqual(checked.facts);
  });
  it('別の数字を空白除去で連結した数量にしない', () => {
    const { pages, f } = prose(`${period}の売上高は100 200 百万円の見込みです。`, 100200);
    expect(reviewCandidates(candidateResponse([f], pages), 'other', pages).facts).toEqual([]);
    expect(saved([persistedNumber(f, pages)], pages).facts).toEqual([]);
  });
  it.each(['100 百万円', '１００　百万円', '100 百 万 円', '△ 100 百万円'])(
    '数量の空白と原位置を生成・保存で保持する: %s',
    (raw) => {
      const { pages, f } = prose(
        `${period}の売上高は ${raw} の見込みです。`,
        raw.includes('△') ? -100 : 100
      );
      const block = pages[0].blocks.find((b) => b.text.includes('売上高'))!;
      const qs = proseQuantities(block);
      expect(qs).toHaveLength(1);
      expect(qs[0].raw).toBe(raw.normalize('NFKC'));
      expect(qs[0].start).toBe(block.text.normalize('NFKC').indexOf(raw.normalize('NFKC')));
      const checked = reviewCandidates(candidateResponse([f], pages), 'other', pages);
      expect(checked.unverified).toEqual([]);
      expect(checked.facts).toHaveLength(1);
      expect(checked.facts[0].quote).toBe(block.text);
      expect(checked.facts[0].quantity?.decimal).toBe(String(f.value));
      expect(saved(checked.facts, pages, 'other', true).facts).toEqual(checked.facts);
    }
  );
  it.each([
    'ではなく 200 百万円の見込みです。',
    'に満たない見込みです。',
    'に届かない見込みです。',
  ])('空白付き数量でも否定・閾値を確定値にしない: %s', (tail) => {
    const { pages, f } = prose(`${period}の売上高は 100 百万円${tail}`);
    expect(reviewCandidates(candidateResponse([f], pages), 'other', pages).facts).toEqual([]);
    expect(saved([evidence(f, pages)], pages).facts).toEqual([]);
  });
  it('数量の見通し述語も生成・保存で予想として照合する', () => {
    const { pages, f } = prose(`${period}の売上高は100百万円となる見通しです。`);
    const checked = reviewCandidates(candidateResponse([f], pages), 'other', pages);
    expect(checked.unverified).toEqual([]);
    expect(checked.facts).toHaveLength(1);
    expect(saved(checked.facts, pages).facts).toEqual(checked.facts);
  });
  it.each(['となる見通しではありません。', 'となる見通しです。確定していません。'])(
    '見通し数量の否定・追加文を終端検査から逃がさない: %s',
    (tail) => {
      const { pages, f } = prose(`${period}の売上高は100百万円${tail}`);
      expect(reviewCandidates(candidateResponse([f], pages), 'other', pages).facts).toEqual([]);
      expect(saved([evidence(f, pages)], pages).facts).toEqual([]);
    }
  );
  function margin(pages: ReturnType<typeof textPage>[]) {
    const f = numberCandidate(pages[0], '売上高営業利益率', 10, period);
    f.unit = '%';
    f.semantics.metricKind = 'rate';
    return f;
  }
  it('本文利益率を必須として欠落を1回修復し、表示・保存する', async () => {
    const { pages, amounts } = report('売上高営業利益率は10%です。');
    const initial = reviewCandidates(
      candidateResponse(amounts, pages, 'earnings'),
      'earnings',
      pages
    );
    expect(initial.facts).toHaveLength(3);
    expect(() => verifyCoverage('earnings', pages, initial.facts)).toThrow('当年営業利益率');
    const block = pages[0].blocks.find((b) => b.text.includes('売上高営業利益率'))!;
    expect(
      coverageReport('earnings', pages, initial.facts).find((s) =>
        s.requirement.endsWith('当年営業利益率')
      )
    ).toMatchObject({ sourceIds: [block.id], status: 'absent' });
    vi.mocked(generateText)
      .mockReset()
      .mockResolvedValueOnce(candidateResponse(amounts, pages, 'earnings'))
      .mockResolvedValueOnce(candidateResponse([margin(pages)], pages, 'earnings'));
    const result = await generateVerifiedFactSummary(
      config,
      'earnings',
      pages.map((p) => p.text).join('\n'),
      pages
    );
    expect(generateText).toHaveBeenCalledTimes(2);
    expect(result.facts.facts).toHaveLength(4);
    expect(renderFacts(result.facts)).toContain('売上高営業利益率: 10%');
    expect(saved(result.facts.facts, pages, 'earnings', true).facts).toEqual(result.facts.facts);
  });
  it.each([
    '事業概況\n売上高営業利益率は10%です。',
    '売上高営業利益率は10%に届かない見込みです。',
    '売上高営業利益率について説明します。',
    '2026年3月期の売上高営業利益率は10%です。',
  ])('事業・境界・言及・別期間を当年利益率の義務にしない: %s', (extra) => {
    const { pages, amounts } = report(extra);
    const checked = reviewCandidates(
      candidateResponse(amounts, pages, 'earnings'),
      'earnings',
      pages
    );
    expect(checked.facts).toHaveLength(3);
    expect(() => verifyCoverage('earnings', pages, checked.facts)).not.toThrow();
  });
  function outlook(body: string, state: VerifiedFact['semantics']['state']) {
    const { pages, amounts } = report();
    pages.push(textPage(`1. 損失予想の背景\n${body}`, 2));
    const f = numberCandidate(pages[1], '純損失', 100, period);
    f.kind = 'event';
    f.label = f.statement = f.quote;
    f.value = f.unit = f.valueKind = f.period = null;
    f.semantics.periodKind = 'none';
    f.semantics.metricKind = 'none';
    f.semantics.state = state;
    return { pages, amounts, f };
  }
  it.each(['となる見通しです。'])(
    '見通しの有限述語を候補・保存・必須背景で一致させる: %s',
    (ending) => {
      const body = `親会社株主に帰属する当期純損失は概算額100百万円${ending}`;
      const { pages, amounts, f } = outlook(body, 'forecast');
      expect(assertionStates(body)).toEqual(['forecast']);
      const checked = reviewCandidates(
        candidateResponse([...amounts, f], pages, 'earnings'),
        'earnings',
        pages
      );
      expect(checked.unverified).toEqual([]);
      expect(checked.facts).toHaveLength(4);
      expect(saved(checked.facts, pages, 'earnings', true).facts).toEqual(checked.facts);
      const wrong = structuredClone(checked.facts[3]);
      wrong.semantics.state = 'unspecified';
      wrong.id = stableFactId(wrong);
      expect(() =>
        validateSavedFacts({ version: 5, documentType: 'other', facts: [wrong], unverified: [] })
      ).not.toThrow();
      expect(reviewCandidates(candidateResponse([wrong], pages), 'other', pages).facts).toEqual([]);
      expect(saved([wrong], pages).facts).toEqual([]);
      expect(() => verifyCoverage('earnings', pages, checked.facts.slice(0, 3))).toThrow(
        '損失予想の背景'
      );
      expect(
        coverageReport('earnings', pages, checked.facts.slice(0, 3)).find((s) =>
          s.requirement.includes('損失予想の背景')
        )
      ).toMatchObject({
        sourceIds: [f.evidence.kind === 'prose' ? f.evidence.blockId : ''],
        status: 'absent',
      });
    }
  );
  it.each([
    '今後の見通しについて説明します。',
    '見通しは未定です。',
    '見通しという語を使用しました。',
  ])('見通しへの言及だけでは予想状態を証明しない: %s', (body) =>
    expect(assertionStates(body)).toEqual([])
  );
  it('見通しであるの対比でも肯定予想と別の否定を混同しない', () => {
    const body =
      '親会社株主に帰属する当期純損失は概算額100百万円となる見通しであるが追加投資は予定しておりません。';
    const { pages, amounts, f } = outlook(body, 'forecast');
    f.semantics.polarity = 'mixed';
    expect(assertionPolarity(body)).toBe('mixed');
    expect(assertionStates(body)).toEqual(['forecast']);
    const checked = reviewCandidates(
      candidateResponse([...amounts, f], pages, 'earnings'),
      'earnings',
      pages
    );
    expect(checked.unverified).toEqual([]);
    expect(saved(checked.facts, pages, 'earnings', true).facts).toEqual(checked.facts);
  });
  it('見通し背景の欠落を通常の意味照合で1回修復する', async () => {
    const { pages, amounts, f } = outlook(
      '親会社株主に帰属する当期純損失は概算額100百万円となる見通しです。',
      'forecast'
    );
    vi.mocked(generateText)
      .mockReset()
      .mockResolvedValueOnce(candidateResponse(amounts, pages, 'earnings'))
      .mockResolvedValueOnce(candidateResponse([f], pages, 'earnings'));
    const result = await generateVerifiedFactSummary(
      config,
      'earnings',
      pages.map((p) => p.text).join('\n'),
      pages
    );
    expect(generateText).toHaveBeenCalledTimes(2);
    expect(result.facts.facts).toHaveLength(4);
    expect(saved(result.facts.facts, pages, 'earnings', true).facts).toEqual(result.facts.facts);
  });
});

describe('継承期・見通し否定・万円', () => {
  it.each(['ではありません', 'はなく'])(
    '否定された見通しのnegative/forecastを候補・保存で維持する: %s',
    (ending) => {
      const { pages, f } = prose(`売上高は100百万円となる見通し${ending}。`);
      const e = event(f);
      e.semantics.polarity = 'negative';
      expect(assertionStates(e.quote)).toEqual(['forecast']);
      expect(reviewCandidates(candidateResponse([f], pages), 'other', pages).facts).toEqual([]);
      const good = reviewCandidates(candidateResponse([e], pages), 'other', pages);
      expect(good.unverified).toEqual([]);
      expect(good.facts).toHaveLength(1);
      expect(saved(good.facts, pages).facts).toEqual(good.facts);
      const wrong = structuredClone(good.facts[0]);
      wrong.semantics.state = 'unspecified';
      wrong.id = stableFactId(wrong);
      validateSavedFacts({ version: 5, documentType: 'other', facts: [wrong], unverified: [] });
      expect(saved([wrong], pages).facts).toEqual([]);
      expect(reviewCandidates(candidateResponse([wrong], pages), 'other', pages).facts).toEqual([]);
    }
  );
  it('見通しの否定置換はmixed/forecastで原文全体を保持する', () => {
    const { pages, f } = prose('売上高は100百万円となる見通しではなく50百万円となる見通しです。');
    const e = event(f);
    e.semantics.polarity = 'mixed';
    expect(assertionPolarity(e.quote)).toBe('mixed');
    expect(assertionStates(e.quote)).toEqual(['forecast']);
    const good = reviewCandidates(candidateResponse([e], pages), 'other', pages);
    expect(good.unverified).toEqual([]);
    expect(saved(good.facts, pages).facts).toEqual(good.facts);
    expect(good.facts[0].statement).toBe(e.quote);
  });
  function backgroundReport(extra: string, heading = '1. 損失予想の背景') {
    const r = report();
    r.pages.push(textPage(`${heading}\n${extra}`, 2));
    return r;
  }
  it('否定された損失見通しの背景欠落を1回修復し、誤状態の修復は最終拒否する', async () => {
    const { pages, amounts } = backgroundReport(
      '親会社株主に帰属する当期純損失は概算額100百万円となる見通しではありません。'
    );
    const e = event(numberCandidate(pages[1], '純損失', 100, period));
    e.semantics.state = 'forecast';
    e.semantics.polarity = 'negative';
    const good = reviewCandidates(
      candidateResponse([...amounts, e], pages, 'earnings'),
      'earnings',
      pages
    );
    expect(good.unverified).toEqual([]);
    expect(good.facts).toHaveLength(4);
    const initial = good.facts.slice(0, 3);
    expect(() => verifyCoverage('earnings', pages, initial)).toThrow('損失予想の背景');
    expect(
      coverageReport('earnings', pages, initial).find((s) =>
        s.requirement.includes('損失予想の背景')
      )?.sourceIds
    ).toEqual([pages[1].blocks[1].id]);
    vi.mocked(generateText)
      .mockReset()
      .mockResolvedValueOnce(candidateResponse(amounts, pages, 'earnings'))
      .mockResolvedValueOnce(candidateResponse([e], pages, 'earnings'));
    const result = await generateVerifiedFactSummary(config, 'earnings', 'source', pages);
    expect(generateText).toHaveBeenCalledTimes(2);
    expect(saved(result.facts.facts, pages, 'earnings', true).facts).toEqual(result.facts.facts);
    e.semantics.state = 'unspecified';
    vi.mocked(generateText)
      .mockReset()
      .mockResolvedValueOnce(candidateResponse(amounts, pages, 'earnings'))
      .mockResolvedValueOnce(candidateResponse([e], pages, 'earnings'));
    await expect(generateVerifiedFactSummary(config, 'earnings', 'source', pages)).rejects.toThrow(
      '損失予想の背景'
    );
    expect(generateText).toHaveBeenCalledTimes(2);
  });
  it.each(['2026年3月期', '2027年3月期'])(
    '本文利益率の継承期を当年義務・修復・保存で一致させる: %s',
    async (inherited) => {
      const { pages, amounts } = backgroundReport(
        '売上高営業利益率は10%です。',
        `1. ${inherited} 経営成績`
      );
      const rate = numberCandidate(pages[1], '売上高営業利益率', 10, inherited);
      rate.unit = '%';
      rate.semantics.metricKind = 'rate';
      const good = reviewCandidates(
        candidateResponse([...amounts, rate], pages, 'earnings'),
        'earnings',
        pages
      );
      expect(good.unverified).toEqual([]);
      expect(good.facts).toHaveLength(4);
      expect(saved(good.facts, pages, 'earnings', true).facts).toEqual(good.facts);
      const initial = good.facts.slice(0, 3);
      const slot = coverageReport('earnings', pages, initial).find((s) =>
        s.requirement.endsWith('当年営業利益率')
      );
      if (inherited === period) {
        expect(() => verifyCoverage('earnings', pages, initial)).toThrow('当年営業利益率');
        expect(slot).toMatchObject({ sourceIds: [pages[1].blocks[1].id], status: 'absent' });
      } else {
        expect(() => verifyCoverage('earnings', pages, initial)).not.toThrow();
        expect(slot).toBeUndefined();
        const wrong = structuredClone(good.facts[3]);
        wrong.period = period;
        wrong.id = stableFactId(wrong);
        validateSavedFacts({ version: 5, documentType: 'other', facts: [wrong], unverified: [] });
        expect(saved([wrong], pages).facts).toEqual([]);
        expect(reviewCandidates(candidateResponse([wrong], pages), 'other', pages).facts).toEqual(
          []
        );
      }
      vi.mocked(generateText)
        .mockReset()
        .mockResolvedValueOnce(candidateResponse(amounts, pages, 'earnings'))
        .mockResolvedValueOnce(candidateResponse([rate], pages, 'earnings'));
      const result = await generateVerifiedFactSummary(config, 'earnings', 'source', pages);
      expect(generateText).toHaveBeenCalledTimes(inherited === period ? 2 : 1);
      expect(saved(result.facts.facts, pages, 'earnings', true).facts).toEqual(result.facts.facts);
    }
  );
  function yen(raw: string) {
    const pages = [
      textPage(`会社名 株式会社テスト\n1. ${period} 取引概要\n取得価額の総額は${raw}です。`),
    ];
    const f = numberCandidate(pages[0], '取得価額の総額', 100, period);
    f.unit = '万円';
    f.semantics.scope = f.semantics.basis = null;
    return { pages, f };
  }
  it.each(['100万円', '100 万 円'])(
    '既存の万円単位を値・原位置を変えず候補化し保存する: %s',
    (raw) => {
      const { pages, f } = yen(raw);
      const q = proseQuantities(pages[0].blocks[2]);
      expect(q).toHaveLength(1);
      expect(q[0].raw).toBe(raw);
      const good = reviewCandidates(candidateResponse([f], pages), 'other', pages);
      expect(good.unverified).toEqual([]);
      expect(good.facts).toHaveLength(1);
      expect(good.facts[0]).toMatchObject({ value: 100, unit: '万円' });
      expect(saved(good.facts, pages).facts).toEqual(good.facts);
    }
  );
  it('万円範囲の全断片を保持する', () => {
    const { pages, f } = yen('100 ～ 200 万円');
    f.kind = 'range';
    f.value = null;
    f.quantity = {
      raw: '100 ～ 200 万円'.normalize('NFKC'),
      decimal: null,
      lower: '100',
      upper: '200',
      sourceIds: [],
    };
    const good = reviewCandidates(candidateResponse([f], pages), 'other', pages);
    expect(good.unverified).toEqual([]);
    expect(good.facts[0].quantity).toMatchObject({ lower: '100', upper: '200' });
    expect(saved(good.facts, pages).facts).toEqual(good.facts);
  });
  it('唯一の重要額の誤数量参照を1回修復して万円を表示する', async () => {
    const { pages, f } = yen('100万円');
    const wrong = JSON.parse(candidateResponse([f], pages));
    wrong.candidates[0].source.quantityId = 'missing';
    vi.mocked(generateText)
      .mockReset()
      .mockResolvedValueOnce(JSON.stringify(wrong))
      .mockResolvedValueOnce(candidateResponse([f], pages));
    const result = await generateVerifiedFactSummary(config, 'other', 'source', pages);
    expect(generateText).toHaveBeenCalledTimes(2);
    expect(renderFacts(result.facts)).toContain('取得価額の総額: 100万円');
    expect(saved(result.facts.facts, pages).facts).toEqual(result.facts.facts);
  });
});
