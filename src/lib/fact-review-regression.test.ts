import { describe, expect, it, vi } from 'vitest';
import { textPage, layoutPage, numberCandidate } from './fixtures/v4-test-source';
import { candidateResponse } from './fixtures/candidate-test-source';
import { buildDocumentContext, bindingFor, resolveScopeIds } from './document-context';
import { reviewCandidates, serializeCandidateSource } from './fact-candidates';
import { generateVerifiedFactSummary, parseFactSummary, renderFacts } from './fact-summary';
import { verifyCoverage, coverageReport } from './fact-coverage';
import { stableFactId, type VerifiedFact } from './fact-contract';
import { validateSavedFacts } from './fact-cache';
import { generateText } from './llm-client';
import { buildSummaryHtml } from '../content/utils/summaryHtmlBuilder';
import { assertionPolarity } from './assertion-semantics';
vi.mock('./llm-client', () => ({ generateText: vi.fn() }));
const config = { provider: 'openai', model: 'fixture', apiKey: 'fixture' };
const period = '2027年3月期';
function prose(body: string, value = 100) {
  const pages = [textPage(`会社名 株式会社テスト\n${period} 業績予想\n${body}`)];
  const f = numberCandidate(pages[0], '売上高', value, period);
  f.semantics.scope = f.semantics.basis = null;
  f.valueKind = f.semantics.state = 'forecast';
  return { pages, f };
}
function evidence(f: VerifiedFact, pages: ReturnType<typeof textPage>[]) {
  const binding = bindingFor(
    buildDocumentContext(pages),
    f.evidence.kind === 'prose' ? f.evidence.blockId : f.evidence.valueId
  );
  f.evidence.contextIds = binding.contextIds;
  f.evidence.scopeIds = resolveScopeIds(binding, f.semantics, true);
  return f;
}
function saved(
  facts: VerifiedFact[],
  pages: ReturnType<typeof textPage>[],
  type: 'other' | 'earnings' = 'other',
  coverage = false
) {
  return parseFactSummary(
    JSON.stringify({ version: 4, documentType: type, facts, unverified: [] }),
    type,
    pages,
    coverage
  );
}
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
describe('追加セルフレビューの本文数量', () => {
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
    f.id = stableFactId(f);
    validateSavedFacts({ version: 4, documentType: 'other', facts: [f], unverified: [] });
    expect(saved([f], pages).facts).toEqual([]);
    expect(
      renderFacts({ version: 4, documentType: 'other', facts: r.facts, unverified: r.unverified })
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
      expect(saved(r.facts.facts, pages, 'other', true)).toEqual(r.facts);
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
function localReport(heading: string, fields = '範囲 個別\n会計基準 IFRS') {
  const forecast = heading.includes('予想');
  const pages = [
    textPage('2027年3月期 決算短信〔日本基準〕（連結）\n上場会社名 株式会社テスト'),
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
describe('追加セルフレビューの属性適用', () => {
  it('事業節の予想値で通期予想を代替せず、正しい報告節の候補へ修復する', async () => {
    const report = localReport('経営成績');
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
      const report = localReport('経営成績');
      const page = textPage(`${heading}\n${period}の売上高は200百万円です。`, 3);
      const pages = [...report.pages, page];
      const extra = numberCandidate(page, '売上高', 200, period);
      const financial = heading.includes('経営成績');
      extra.semantics.scope = financial ? '連結' : null;
      extra.semantics.basis = financial ? '日本基準' : null;
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
    '決算必須は適用属性を使い表紙へ付け直さない: %s',
    (fields) => {
      const { pages, facts } = localReport('経営成績', fields);
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
      const { pages, facts } = localReport('経営成績');
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

describe('局所属性を持つ決算の必須事実と修復', () => {
  function earningsWithBackground() {
    const actual = localReport('経営成績');
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
  it('局所属性を表紙へ誤変更した初回を1回修復し保存する', async () => {
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
