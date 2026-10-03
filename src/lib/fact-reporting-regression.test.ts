import { describe, expect, it, vi } from 'vitest';
import { textPage, numberCandidate } from './fixtures/v4-test-source';
import { evidence, saved, report, event, cells, period } from './fixtures/fact-review-source';
import { candidateResponse } from './fixtures/candidate-test-source';
import { buildDocumentContext } from './document-context';
import { proseQuantities, reviewCandidates } from './fact-candidates';
import { generateVerifiedFactSummary, renderFacts, parseFactSummary } from './fact-summary';
import { verifyCoverage, coverageReport } from './fact-coverage';
import { stableFactId, type VerifiedFact } from './fact-contract';
import { validateSavedFacts } from './fact-cache';
import { datedStates } from './fact-validation';
import { verifyTableEvidence } from './numeric-evidence';
import { forecastReportingTitle } from './document-structure';
import { generateText } from './llm-client';
import semanticCorpus from './fixtures/ir-semantic-corpus.json';
import semanticExpectations from './fixtures/ir-semantic-expectations.json';
import { extractPageLayout } from './pdf-layout';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';
vi.mock('./llm-client', () => ({ generateText: vi.fn() }));
const config = { provider: 'openai', model: 'fixture', apiKey: 'fixture' };
function assertion(
  page: ReturnType<typeof textPage>,
  label: string,
  state: VerifiedFact['semantics']['state']
) {
  const f = event(numberCandidate(page, label));
  f.semantics.scope = f.semantics.basis = null;
  f.semantics.state = state;
  return f;
}

describe('義務の原文所有者と充足・修復先の一致', () => {
  it.each(['上限', '条件'] as const)('他社だけの自己株取得%sは発行者の義務を作らない', (kind) => {
    const body =
      kind === '上限'
        ? '取得する株式の総数は100株（上限）です。'
        : '市場動向によっては取得を行わない可能性があります。';
    const pages = [
      textPage('会社名 株式会社テスト\n1. 取得方針\n当社は株式を取得する予定です。'),
      textPage(`会社名 株式会社B\n1. 取得内容\n${body}`, 2),
    ];
    const good = reviewCandidates(
      candidateResponse([assertion(pages[0], '当社', 'planned')], pages, 'shareRepurchase'),
      'shareRepurchase',
      pages
    );
    expect(good.unverified).toEqual([]);
    expect(
      parseFactSummary(
        JSON.stringify({
          version: 4,
          documentType: 'shareRepurchase',
          facts: good.facts,
          unverified: [],
        }),
        'shareRepurchase',
        pages
      ).facts
    ).toEqual(good.facts);
    expect(coverageReport('shareRepurchase', pages, good.facts)).toEqual([]);
    // Move that source to the issuer: the same disclosed obligation must return.
    const own = [
      ...pages.slice(0, 1),
      textPage(pages[1].text.replace('株式会社B', '株式会社テスト'), 2),
    ];
    expect(() => verifyCoverage('shareRepurchase', own, good.facts)).toThrow('COVERAGE');
  });

  it.each([
    '概算額100百万円による当期純損失となる見通しです。',
    '翌連結会計年度に特別損失に計上する予定です。',
  ])('他社の損失主張は発行者の必須背景・予定を作らない: %s', (body) => {
    const { pages, amounts } = report();
    pages.push(textPage(`会社名 株式会社B\n1. 損失の説明\n${body}`, 2));
    const r = reviewCandidates(candidateResponse(amounts, pages, 'earnings'), 'earnings', pages);
    expect(r.unverified).toEqual([]);
    expect(saved(r.facts, pages, 'earnings', true).facts).toEqual(r.facts);
    expect(coverageReport('earnings', pages, r.facts).some((s) => /損失/.test(s.requirement))).toBe(
      false
    );
    const own = [
      ...pages.slice(0, 1),
      textPage(pages[1].text.replace('株式会社B', '株式会社テスト'), 2),
    ];
    expect(() => verifyCoverage('earnings', own, r.facts)).toThrow('損失');
  });

  it.each([
    ['当社は株式取得を決議しました。', 'decided', 'event', '取得の決議'],
    ['取得価額は非開示です。', 'unspecified', 'status', '取得価額の非開示'],
    ['株式譲渡実行日 2027年1月1日（予定）', 'planned', 'event', '譲渡の実行'],
    ['当社は基本合意書を締結しました。', 'contracted', 'event', '提携の決定'],
  ] as const)('M&Aの%sは同じ発行者原文で充足し修復する', (body, state, kind, requirement) => {
    const pages = [
      textPage(`会社名 株式会社テスト\n1. 株式取得\n当社は株式を取得する予定です。\n${body}`),
      textPage(`会社名 株式会社B\n1. 株式取得\n${body}`, 2),
    ];
    const fs = pages.map((p, i) => {
      const f = assertion(p, body, state);
      f.kind = kind;
      f.semantics.subject = i ? '株式会社B' : '株式会社テスト';
      return f;
    });
    const r = reviewCandidates(candidateResponse(fs, pages, 'ma'), 'ma', pages);
    expect(r.unverified).toEqual([]);
    expect(r.facts).toHaveLength(2);
    expect(() => verifyCoverage('ma', pages, r.facts.slice(1))).toThrow(requirement);
    expect(
      parseFactSummary(
        JSON.stringify({ version: 4, documentType: 'ma', facts: r.facts, unverified: [] }),
        'ma',
        pages
      )
    ).toMatchObject({ facts: r.facts });
    const slot = coverageReport('ma', pages, r.facts.slice(1)).find((s) =>
      s.requirement.includes(requirement)
    )!;
    expect(slot.status).toBe('absent');
    expect(slot.sourceIds).toEqual([fs[0].evidence.kind === 'prose' ? fs[0].evidence.blockId : '']);
  });

  it.each(['', '1. 経営成績\n'])(
    '表紙の別欄の範囲・基準を必須対象へ揃える: %s',
    async (section) => {
      const pages = [
        textPage(
          `${period} 決算短信\n会社名 株式会社テスト\n範囲 連結\n会計基準 IFRS\n${section}${['売上高', '営業利益', '当期純利益'].map((m) => `${period}の${m}は100百万円です。`).join('\n')}`
        ),
      ];
      const fs = ['売上高', '営業利益', '当期純利益'].map((m) => {
        const f = numberCandidate(pages[0], m, 100, period);
        f.semantics.basis = 'IFRS';
        return f;
      });
      vi.mocked(generateText)
        .mockReset()
        .mockResolvedValueOnce(candidateResponse(fs, pages, 'earnings'));
      const r = await generateVerifiedFactSummary(config, 'earnings', 'source', pages);
      expect(r.repairAttempted).toBe(false);
      expect(saved(r.facts.facts, pages, 'earnings', true).facts).toEqual(r.facts.facts);
      const slot = coverageReport('earnings', pages, []).find((s) =>
        s.requirement.endsWith('revenue')
      )!;
      expect(slot.expected).toMatchObject({ scope: '連結', basis: 'IFRS' });
    }
  );

  it.each(['他社', '発行者の別原文'] as const)('月次KPIを%sの同月同名値で代替しない', (source) => {
    const pages = semanticCorpus[2].pages.map((p) =>
      extractPageLayout(p.items as TextItem[], p.pageNumber)
    );
    const base = semanticExpectations[2].facts as unknown as VerifiedFact[];
    const own = source === '他社' ? '株式会社B' : '株式会社うるる';
    const extra = textPage(`会社名 ${own}\n1. 2026年6月月次実績\n2026年6月のMRRは100千円です。`, 6);
    pages.push(extra);
    const f = numberCandidate(extra, 'MRR', 100, '2026年6月');
    f.unit = '千円';
    Object.assign(f.semantics, { subject: own, scope: null, basis: null, periodKind: 'month' });
    const r = reviewCandidates(
      candidateResponse([f], pages, 'businessUpdate'),
      'businessUpdate',
      pages
    );
    expect(r.unverified).toEqual([]);
    expect(() => verifyCoverage('businessUpdate', pages, r.facts)).toThrow('主要KPI');
    const slot = coverageReport('businessUpdate', pages, r.facts).find((s) =>
      s.requirement.includes('主要KPI')
    )!;
    expect(slot.sourceIds.length).toBeGreaterThan(0);
    expect(slot.sourceIds.some((id) => id.startsWith('p6'))).toBe(false);
    const correct = reviewCandidates(
      candidateResponse([...base, f], pages, 'businessUpdate'),
      'businessUpdate',
      pages
    );
    expect(correct.unverified).toEqual([]);
    expect(
      parseFactSummary(
        JSON.stringify({
          version: 4,
          documentType: 'businessUpdate',
          facts: correct.facts,
          unverified: [],
        }),
        'businessUpdate',
        pages
      ).facts
    ).toEqual(correct.facts);
  });
});

describe('数量の単位証明と報告対象の必須判定', () => {
  it.each(['以内', '未達', '強', '弱'])('境界・近似を本文単位へ吸収しない: %s', (tail) => {
    const pages = [
      textPage(`会社名 株式会社テスト\n1. ${period} 取引概要\n取得価額は100百万円${tail}です。`),
    ];
    const f = numberCandidate(pages[0], '取得価額', 100, period);
    f.unit = `百万円${tail}`;
    f.semantics.scope = f.semantics.basis = null;
    const r = reviewCandidates(candidateResponse([f], pages), 'other', pages);
    expect(r.facts).toEqual([]);
    evidence(f, pages);
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
  });
  it('境界付き額を完結eventへ通常の意味照合で修復する', async () => {
    const pages = [
      textPage(`会社名 株式会社テスト\n1. ${period} 取引概要\n取得価額は100百万円以内です。`),
    ];
    const f = numberCandidate(pages[0], '取得価額', 100, period);
    f.semantics.scope = f.semantics.basis = null;
    const e = event(f);
    e.semantics.state = 'unspecified';
    vi.mocked(generateText)
      .mockReset()
      .mockResolvedValueOnce(candidateResponse([f], pages))
      .mockResolvedValueOnce(candidateResponse([e], pages));
    const result = await generateVerifiedFactSummary(config, 'other', 'source', pages);
    expect(generateText).toHaveBeenCalledTimes(2);
    expect(result.facts.facts[0]).toMatchObject({ kind: 'event', statement: e.quote, value: null });
    expect(saved(result.facts.facts, pages).facts).toEqual(result.facts.facts);
    expect(renderFacts(result.facts)).toContain(e.quote);
  });
  it.each(['～', '-'])(
    '日付区間(%s)を生成・保存で同じ意味で受理し、両端の改変を拒否する',
    (separator) => {
      const target = `2026年4月1日${separator}2026年4月30日`;
      const pages = [
        report().pages[0],
        cells(
          [
            ['1. 経営成績', 0, 20, 100],
            ['販売件数', 320, 50, 80],
            ['人数', 540, 50, 60],
            ['件', 350, 80, 20],
            ['人', 560, 80, 20],
            [target, 0, 110, 280],
            ['100', 350, 110, 30],
            ['20', 560, 110, 20],
          ],
          2
        ),
      ];
      const hint = buildDocumentContext(pages).tableMappings.find((h) =>
        h.metricIds.some((id) => pages[1].spans.find((s) => s.id === id)?.text === '販売件数')
      )!;
      expect(hint).toBeDefined();
      const f = numberCandidate(
        textPage(`会社名 株式会社テスト\n取引概要\n販売件数は100件です。`),
        '販売件数',
        100,
        target
      );
      f.page = 2;
      f.unit = '件';
      f.semantics.metricKind = 'count';
      f.semantics.periodKind = 'interval';
      f.evidence = { kind: 'table', ...hint, scopeIds: [], qualifierIds: [] };
      const good = reviewCandidates(candidateResponse([f], pages), 'other', pages);
      expect(good.unverified).toEqual([]);
      expect(good.facts).toHaveLength(1);
      expect(saved(good.facts, pages).facts).toEqual(good.facts);
      for (const period of [
        '2026年4月1日',
        '2026年4月1日～2026年5月30日',
        '2026年4月30日～2026年4月1日',
      ]) {
        const wrong = structuredClone(good.facts[0]);
        wrong.period = period;
        wrong.semantics.periodKind = period.includes('～') ? 'interval' : 'eventDate';
        wrong.id = stableFactId(wrong);
        validateSavedFacts({ version: 4, documentType: 'other', facts: [wrong], unverified: [] });
        expect(saved([wrong], pages).facts).toEqual([]);
        expect(reviewCandidates(candidateResponse([wrong], pages), 'other', pages).facts).toEqual(
          []
        );
      }
    }
  );
  it.each(['第2四半期', '第3四半期', '中間期', '1Q', '2Q', '3Q'])(
    '累計の期間表記で利益率を欠落・再修復扱いにしない: %s',
    async (quarter) => {
      const canonical = /^([1-3])Q$/.test(quarter) ? '第' + quarter[0] + '四半期' : quarter;
      const target = period + canonical + '累計';
      const pages = [
        textPage(`${period} ${quarter}決算短信〔日本基準〕（連結）\n会社名 株式会社テスト`),
        textPage(
          `1. ${target} 経営成績\n売上高は100百万円です。\n営業利益は100百万円です。\n当期純利益は100百万円です。\n売上高営業利益率は10%です。`,
          2
        ),
      ];
      const fs = ['売上高', '営業利益', '当期純利益', '売上高営業利益率'].map((m) => {
        const f = numberCandidate(pages[1], m, m.includes('率') ? 10 : 100, target);
        f.semantics.periodKind =
          canonical === '第3四半期'
            ? 'cumulativeQ3'
            : canonical === '第1四半期'
              ? 'cumulativeQ1'
              : 'cumulativeQ2';
        if (m.includes('率')) {
          f.unit = '%';
          f.semantics.metricKind = 'rate';
        }
        return f;
      });
      const r = reviewCandidates(candidateResponse(fs, pages, 'earnings'), 'earnings', pages);
      expect(r.unverified).toEqual([]);
      expect(r.facts).toHaveLength(4);
      expect(() => verifyCoverage('earnings', pages, r.facts)).not.toThrow();
      expect(saved(r.facts, pages, 'earnings', true).facts).toEqual(r.facts);
      vi.mocked(generateText)
        .mockReset()
        .mockResolvedValueOnce(candidateResponse(fs, pages, 'earnings'));
      const result = await generateVerifiedFactSummary(config, 'earnings', 'source', pages);
      expect(result.repairAttempted).toBe(false);
      expect(generateText).toHaveBeenCalledTimes(1);
    }
  );
  it.each(['2Q（中間期）', '中間期（2Q）', '第2四半期（中間期）'])(
    '同義四半期を重ねた表紙の本文も通常生成と保存で受理する: %s',
    async (title) => {
      const target = period + '第2四半期';
      const pages = [
        textPage(
          `${period} ${title}決算短信〔日本基準〕（連結）\n会社名 株式会社テスト\n${['売上高', '営業利益', '当期純利益'].map((m) => `${m}は100百万円です。`).join('\n')}`
        ),
      ];
      const fs = ['売上高', '営業利益', '当期純利益'].map((m) => {
        const f = numberCandidate(pages[0], m, 100, target);
        f.semantics.periodKind = 'cumulativeQ2';
        return f;
      });
      const r = reviewCandidates(candidateResponse(fs, pages, 'earnings'), 'earnings', pages);
      expect(r.unverified).toEqual([]);
      expect(saved(r.facts, pages, 'earnings', true).facts).toEqual(r.facts);
      vi.mocked(generateText)
        .mockReset()
        .mockResolvedValueOnce(candidateResponse(fs, pages, 'earnings'));
      expect(
        (await generateVerifiedFactSummary(config, 'earnings', 'source', pages)).repairAttempted
      ).toBe(false);
      const ambiguous = [textPage(pages[0].text.replace('中間期', '第3四半期'))];
      expect(
        reviewCandidates(candidateResponse(fs, ambiguous, 'earnings'), 'earnings', ambiguous).facts
      ).toEqual([]);
    }
  );
  it.each(['配当の状況（予想）', '配当の状況'])(
    '配当の状態を軸と明示文脈から共通判定する: %s',
    async (title) => {
      const { pages, amounts } = report();
      const forecast = title.includes('予想');
      pages.push(
        cells(
          [
            [`1. ${title}`, 0, 20, 200],
            ['年間配当金', 270, 50, 100],
            ['期末配当金', 480, 50, 100],
            ['円', 300, 80, 20],
            ['円', 510, 80, 20],
            [period, 0, 110, 170],
            ['12', 300, 110, 20],
            ['12', 510, 110, 20],
          ],
          2
        )
      );
      // A subsidiary forecast cannot replace the issuer's actual dividend target.
      if (!forecast) pages.push(cells([
        ['会社名 株式会社B', 0, 20, 200],
        ['1. 配当の状況（予想）', 0, 50, 250],
        ['年間配当金', 270, 80, 100],
        ['期末配当金', 480, 80, 100],
        ['円', 300, 110, 20], ['円', 510, 110, 20],
        [period, 0, 140, 170], ['20', 300, 140, 20], ['20', 510, 140, 20],
      ], 3));
      const hint = buildDocumentContext(pages).tableMappings.find((h) =>
        h.metricIds.some((id) => pages[1].spans.find((s) => s.id === id)?.text === '年間配当金')
      )!;
      const dividend = numberCandidate(pages[0], '売上高', 12, period);
      dividend.page = 2;
      dividend.label = '年間配当金';
      dividend.unit = '円';
      dividend.valueKind = dividend.semantics.state = forecast ? 'forecast' : 'actual';
      dividend.semantics.metricKind = 'perShare';
      dividend.semantics.scope = dividend.semantics.basis = null;
      dividend.evidence = { kind: 'table', ...hint, scopeIds: [], qualifierIds: [] };
      const all = reviewCandidates(
        candidateResponse([...amounts, dividend], pages, 'earnings'),
        'earnings',
        pages
      );
      expect(all.unverified).toEqual([]);
      expect(all.facts).toHaveLength(4);
      expect(() => verifyCoverage('earnings', pages, all.facts)).not.toThrow();
      expect(saved(all.facts, pages, 'earnings', true).facts).toEqual(all.facts);
      const slot = coverageReport('earnings', pages, all.facts.slice(0, 3)).find((s) =>
        s.requirement.includes('配当の重要事実')
      );
      expect(slot).toMatchObject({
        status: 'absent',
        expected: { period, state: dividend.valueKind },
        sourceIds: expect.arrayContaining([hint.valueId]),
      });
      expect(slot?.sourceIds.every(id => !id.startsWith('p3:'))).toBe(true);
      vi.mocked(generateText)
        .mockReset()
        .mockResolvedValueOnce(candidateResponse(amounts, pages, 'earnings'))
        .mockResolvedValueOnce(candidateResponse([dividend], pages, 'earnings'));
      const repaired = await generateVerifiedFactSummary(config, 'earnings', 'source', pages);
      expect(generateText).toHaveBeenCalledTimes(2);
      expect(saved(repaired.facts.facts, pages, 'earnings', true).facts).toEqual(
        repaired.facts.facts
      );
      const wrong = structuredClone(all.facts[3]);
      wrong.valueKind = wrong.semantics.state = forecast ? 'actual' : 'forecast';
      wrong.id = stableFactId(wrong);
      validateSavedFacts({ version: 4, documentType: 'other', facts: [wrong], unverified: [] });
      expect(saved([wrong], pages).facts).toEqual([]);
    }
  );
  it.each(['台', '件/月', '千kWh'])('証明済み単位を候補・保存・表示で共有する: %s', (unit) => {
    const pages = [
      textPage(`会社名 株式会社テスト\n1. ${period} 販売状況\n販売数量は100 ${unit}です。`),
    ];
    const f = numberCandidate(pages[0], '販売数量', 100, period);
    f.unit = unit;
    f.semantics.scope = f.semantics.basis = null;
    f.semantics.metricKind = ['口', '台', 'kg', 'm2', '人日', 'か月', '件/月', '千kWh'].includes(
      unit
    )
      ? 'other'
      : 'count';
    const qs = proseQuantities(pages[0].blocks[2]);
    expect(qs).toEqual([{ id: `${pages[0].blocks[2].id}:q1`, raw: `100 ${unit}`, start: 5 }]);
    const good = reviewCandidates(candidateResponse([f], pages), 'other', pages);
    expect(good.unverified).toEqual([]);
    expect(good.facts).toHaveLength(1);
    expect(saved(good.facts, pages).facts).toEqual(good.facts);
    expect(
      renderFacts({ version: 4, documentType: 'other', facts: good.facts, unverified: [] })
    ).toContain(`100${unit}`);
    const wrong = structuredClone(good.facts[0]);
    wrong.unit = unit === '件/月' ? '件' : `${unit}です`;
    wrong.id = stableFactId(wrong);
    validateSavedFacts({ version: 4, documentType: 'other', facts: [wrong], unverified: [] });
    expect(saved([wrong], pages).facts).toEqual([]);
  });
  it.each([
    'ではありません',
    'と仮定した試算です',
    'に満たない',
    'の説明です',
    '以上です',
    '未満です',
    '程度です',
    '増加しました',
    '見込みです',
  ])('述語を偽の単位へ取り込んで確定しない: %s', (tail) => {
    const pages = [
      textPage(`会社名 株式会社テスト\n1. ${period} 販売状況\n販売数量は100台${tail}。`),
    ];
    const f = numberCandidate(pages[0], '販売数量', 100, period);
    f.unit = `台${tail}`;
    f.semantics.metricKind = 'other';
    f.semantics.scope = f.semantics.basis = null;
    expect(reviewCandidates(candidateResponse([f], pages), 'other', pages).facts).toEqual([]);
  });
  it.each(['2026年3月期', '2027年3月期', '2027年3月期(予想)', '2027年3月期第1四半期'])(
    '表利益率の期間・状態を義務と修復slotに揃える: %s',
    async (axis) => {
      const { pages, amounts } = report();
      pages.push(
        cells(
          [
            ['1. 経営成績', 0, 20, 100],
            ['2026年3月期', 200, 50, 140],
            [axis, 420, 50, 170],
            ['売上高営業利益率', 0, 80, 150],
            ['8%', 250, 80, 40],
            ['10%', 480, 80, 40],
          ],
          2
        )
      );
      const good = reviewCandidates(
        candidateResponse(amounts, pages, 'earnings'),
        'earnings',
        pages
      );
      expect(good.unverified).toEqual([]);
      const hints = buildDocumentContext(pages).tableMappings.filter((h) =>
        pages[1].quantities.some((q) => q.id === h.valueId)
      );
      expect(hints).toHaveLength(2);
      const slot = coverageReport('earnings', pages, good.facts).find((s) =>
        s.requirement.endsWith('当年営業利益率')
      );
      if (axis === period) {
        expect(slot).toMatchObject({ status: 'absent', sourceIds: [hints[1].valueId] });
        const rate = numberCandidate(pages[0], '売上高', 10, period);
        rate.page = 2;
        rate.label = '売上高営業利益率';
        rate.unit = '%';
        rate.semantics.metricKind = 'rate';
        rate.evidence = { kind: 'table', ...hints[1], scopeIds: [], qualifierIds: [] };
        const all = reviewCandidates(
          candidateResponse([...amounts, rate], pages, 'earnings'),
          'earnings',
          pages
        );
        expect(all.unverified).toEqual([]);
        expect(all.facts).toHaveLength(4);
        expect(saved(all.facts, pages, 'earnings', true).facts).toEqual(all.facts);
        vi.mocked(generateText)
          .mockReset()
          .mockResolvedValueOnce(candidateResponse(amounts, pages, 'earnings'))
          .mockResolvedValueOnce(candidateResponse([rate], pages, 'earnings'));
        const result = await generateVerifiedFactSummary(config, 'earnings', 'source', pages);
        expect(generateText).toHaveBeenCalledTimes(2);
        expect(result.facts.facts).toHaveLength(4);
      } else {
        expect(slot).toBeUndefined();
        expect(() => verifyCoverage('earnings', pages, good.facts)).not.toThrow();
      }
    }
  );
  it('配当と無関係な継続表の他ページ参照で必須判定を落とさない', async () => {
    const { pages, amounts } = report();
    pages.push(
      cells(
        [
          ['(1) 株式会社他社の概要', 0, 20, 180],
          ['経営成績', 0, 50, 100],
          ['2026年3月期', 200, 80, 140],
          ['2027年3月期', 420, 80, 140],
          ['売上高', 0, 110, 100],
          ['100百万円', 250, 110, 70],
          ['200百万円', 470, 110, 70],
        ],
        2
      )
    );
    pages.push(
      cells(
        [
          ['営業利益', 0, 20, 100],
          ['10百万円', 250, 20, 70],
          ['20百万円', 470, 20, 70],
          ['当期純利益', 0, 50, 100],
          ['8百万円', 250, 50, 70],
          ['16百万円', 470, 50, 70],
        ],
        3
      )
    );
    pages.push(
      cells(
        [
          ['2. 配当の状況', 0, 20, 100],
          ['年間配当金', 270, 50, 100],
          ['期末配当金', 480, 50, 100],
          ['円', 300, 80, 20],
          ['円', 510, 80, 20],
          ['2027年3月期(予想)', 0, 110, 170],
          ['12', 300, 110, 20],
          ['12', 510, 110, 20],
        ],
        4
      )
    );
    const context = buildDocumentContext(pages);
    expect(
      context.tableMappings.some(
        (h) =>
          pages[2].quantities.some((q) => q.id === h.valueId) &&
          h.contextIds.some((id) => pages[1].spans.some((s) => s.id === id))
      )
    ).toBe(true);
    const good = reviewCandidates(candidateResponse(amounts, pages, 'earnings'), 'earnings', pages);
    expect(good.unverified).toEqual([]);
    expect(() => verifyCoverage('earnings', pages, good.facts, context)).toThrow('配当の重要事実');
    const slots = coverageReport('earnings', pages, good.facts, [], context);
    expect(slots.find((s) => s.requirement.includes('配当の重要事実'))).toMatchObject({
      status: 'absent',
      expected: { period, state: 'forecast' },
    });
    const hint = context.tableMappings.find((h) =>
      h.metricIds.some((id) => pages[3].spans.find((s) => s.id === id)?.text === '年間配当金')
    )!;
    const dividend = numberCandidate(pages[0], '売上高', 12, period);
    dividend.page = 4;
    dividend.label = '年間配当金';
    dividend.unit = '円';
    dividend.valueKind = dividend.semantics.state = 'forecast';
    dividend.semantics.metricKind = 'perShare';
    dividend.semantics.scope = dividend.semantics.basis = null;
    dividend.evidence = { kind: 'table', ...hint, scopeIds: [], qualifierIds: [] };
    const complete = reviewCandidates(
      candidateResponse([...amounts, dividend], pages, 'earnings'),
      'earnings',
      pages
    );
    expect(complete.unverified).toEqual([]);
    expect(complete.facts).toHaveLength(4);
    expect(saved(complete.facts, pages, 'earnings', true).facts).toEqual(complete.facts);
    expect(() => verifyCoverage('earnings', pages, complete.facts, context)).not.toThrow();
    const wrong = structuredClone(complete.facts[3]);
    wrong.valueKind = wrong.semantics.state = 'actual';
    wrong.id = stableFactId(wrong);
    validateSavedFacts({ version: 4, documentType: 'other', facts: [wrong], unverified: [] });
    expect(saved([wrong], pages).facts).toEqual([]);
    vi.mocked(generateText)
      .mockReset()
      .mockResolvedValueOnce(candidateResponse(amounts, pages, 'earnings'))
      .mockResolvedValueOnce(candidateResponse([dividend], pages, 'earnings'));
    const repaired = await generateVerifiedFactSummary(config, 'earnings', 'source', pages);
    expect(generateText).toHaveBeenCalledTimes(2);
    expect(saved(repaired.facts.facts, pages, 'earnings', true).facts).toEqual(
      repaired.facts.facts
    );
    const selected = pages.map((p) => ({
      ...p,
      selection: p.pageNumber === 2 ? ('omitted' as const) : p.selection,
    }));
    expect(() => verifyCoverage('earnings', selected, good.facts, context)).toThrow(
      '配当の重要事実'
    );
  });
  it('表の明示期間を本文見出しの当年期間で上書きしない', () => {
    const { pages, amounts } = report();
    pages.push(
      cells(
        [
          [`1. ${period} 経営成績`, 0, 20, 230],
          ['2025年3月期', 200, 50, 140],
          ['2026年3月期', 420, 50, 170],
          ['売上高営業利益率', 0, 80, 150],
          ['8%', 250, 80, 40],
          ['10%', 480, 80, 40],
        ],
        2
      )
    );
    const hint = buildDocumentContext(pages).tableMappings.filter((h) =>
      pages[1].quantities.some((q) => q.id === h.valueId)
    )[1];
    const rate = numberCandidate(pages[0], '売上高', 10, '2026年3月期');
    rate.page = 2;
    rate.label = '売上高営業利益率';
    rate.unit = '%';
    rate.semantics.metricKind = 'rate';
    rate.evidence = { kind: 'table', ...hint, scopeIds: [], qualifierIds: [] };
    const good = reviewCandidates(
      candidateResponse([...amounts, rate], pages, 'earnings'),
      'earnings',
      pages
    );
    expect(good.unverified).toEqual([]);
    expect(good.facts).toHaveLength(4);
    expect(() => verifyCoverage('earnings', pages, good.facts.slice(0, 3))).not.toThrow();
    const wrong = structuredClone(good.facts[3]);
    wrong.period = period;
    wrong.id = stableFactId(wrong);
    validateSavedFacts({ version: 4, documentType: 'other', facts: [wrong], unverified: [] });
    expect(saved([wrong], pages).facts).toEqual([]);
    expect(reviewCandidates(candidateResponse([wrong], pages), 'other', pages).facts).toEqual([]);
  });
  it.each(['2027年3月期', '2027年3月期第1四半期'])(
    '四半期報告の利益率義務も期間形状で区別する: %s',
    (axis) => {
      const current = period + '第1四半期';
      const pages = [
        textPage(
          `${period} 第1四半期決算短信〔日本基準〕（連結）\n会社名 株式会社テスト\n${['売上高', '営業利益', '当期純利益'].map((m) => `${current}の${m}は100百万円です。`).join('\n')}`
        ),
      ];
      const amounts = ['売上高', '営業利益', '当期純利益'].map((m) => {
        const f = numberCandidate(pages[0], m, 100, current);
        f.semantics.periodKind = 'cumulativeQ1';
        return f;
      });
      pages.push(
        cells(
          [
            ['1. 経営成績', 0, 20, 100],
            ['2026年3月期第1四半期', 190, 50, 190],
            [axis, 420, 50, 190],
            ['売上高営業利益率', 0, 80, 150],
            ['8%', 250, 80, 40],
            ['10%', 480, 80, 40],
          ],
          2
        )
      );
      const good = reviewCandidates(
        candidateResponse(amounts, pages, 'earnings'),
        'earnings',
        pages
      );
      expect(good.unverified).toEqual([]);
      expect(good.facts).toHaveLength(3);
      const slot = coverageReport('earnings', pages, good.facts).find((s) =>
        s.requirement.endsWith('当年営業利益率')
      );
      if (axis === current) expect(slot).toMatchObject({ status: 'absent' });
      else expect(slot).toBeUndefined();
    }
  );
});

describe('原数量・期間・主張と保存根拠の同一性', () => {
  // 見出し語彙は部品で網羅し、表・必須判定・保存の結合は単独修正/配当併記の2例。
  it.each([
    'の修正について',
    'の修正に関するお知らせ',
    'の概要について',
    '及び配当予想の修正について',
    'の修正及び配当予想の修正について',
    'および配当予想の修正に関するお知らせ',
  ])('予想修正の完結見出しを認識する: %s', (suffix) => {
    expect(forecastReportingTitle(`1. 2028年3月期連結業績予想${suffix}`)).toEqual({
      period: '2028年3月期',
    });
  });
  it.each([
    '当社は取得予定を中止しました。',
    '当社は取得予定を撤回しました。',
    '当社は取得予定の中止を決定しました。',
    '当社は取得を予定していますが、取得を中止することとしました。',
    '当社は取得予定を取り消しています。',
    '当社は取得を予定していますが、取得予定を取り消しました。',
    '当社は株式の取得価額を公表しました。',
  ])('予定・取得価額という名詞をactiveな予定に変えない: %s', (body) => {
    const pages = [textPage(`会社名 株式会社テスト\n1. 取引概要\n${body}`)];
    const f = assertion(
      pages[0],
      '当社',
      body.includes('決定しました') ? 'decided' : 'unspecified'
    );
    const good = reviewCandidates(candidateResponse([f], pages), 'other', pages);
    expect(good.unverified).toEqual([]);
    expect(good.facts).toHaveLength(1);
    expect(saved(good.facts, pages).facts).toEqual(good.facts);
    const wrong = structuredClone(good.facts[0]);
    wrong.semantics.state = 'planned';
    wrong.id = stableFactId(wrong);
    expect(reviewCandidates(candidateResponse([wrong], pages), 'other', pages).facts).toEqual([]);
    expect(saved([wrong], pages).facts).toEqual([]);
  });
  it.each([
    '当社は取得を予定しています。',
    '2026年7月15日取得予定',
    '株式譲渡実行日 2026年7月15日（予定）',
    '2026年7月15日12時（予定）',
    '当社は取得を予定していますが、中止する可能性があります。',
  ])('実行予定の述語・日程欄は候補と保存で保持する: %s', (body) => {
    const pages = [textPage(`会社名 株式会社テスト\n1. 取引概要\n${body}`)];
    const f = assertion(pages[0], body, 'planned');
    const good = reviewCandidates(candidateResponse([f], pages), 'other', pages);
    expect(good.unverified).toEqual([]);
    expect(saved(good.facts, pages).facts).toEqual(good.facts);
    if (body.includes('2026')) {
      expect(datedStates(body)).toEqual([{ date: '2026年7月15日', state: 'planned' }]);
      expect(datedStates(body + '。取得予定を取り消しました。')).toEqual([
        { date: '2026年7月15日', state: 'unspecified' },
      ]);
    }
  });
  it.each(['会社名 株式会社他社', '上場会社名 株式会社他社', '株式会社他社'])(
    '同じ物理ページの局所会社を表紙発行者にしない: %s',
    async (field) => {
      const pages = [
        textPage(
          `上場会社名 株式会社テスト\n1. 株式取得\n当社は株式取得を決議しました。\n2. 対象会社の概要\n${field}\n売上高は100百万円です。`
        ),
      ];
      const decision = assertion(pages[0], '当社', 'decided');
      const target = numberCandidate(pages[0], '売上高');
      target.period = null;
      target.semantics.periodKind = 'none';
      target.semantics.subject = '株式会社他社';
      target.semantics.scope = target.semantics.basis = null;
      // A local metric without a declared period is retained as complete prose.
      const overview = event(target);
      overview.semantics.state = 'unspecified';
      const raw = candidateResponse([decision, overview], pages, 'ma');
      const good = reviewCandidates(raw, 'ma', pages);
      expect(good.unverified).toEqual([]);
      expect(good.facts.map((f) => f.semantics.subject)).toEqual([
        '株式会社テスト',
        '株式会社他社',
      ]);
      expect(
        parseFactSummary(
          JSON.stringify({ version: 4, documentType: 'ma', facts: good.facts, unverified: [] }),
          'ma',
          pages
        ).facts
      ).toEqual(good.facts);
      vi.mocked(generateText).mockReset().mockResolvedValueOnce(raw);
      expect(
        (await generateVerifiedFactSummary(config, 'ma', 'source', pages)).repairAttempted
      ).toBe(false);
      const changed = structuredClone(good.facts[0]);
      changed.semantics.subject = '株式会社他社';
      changed.id = stableFactId(changed);
      expect(saved([changed], pages).facts).toEqual([]);
    }
  );
  it.each([false, true])(
    '同じ段落の決議eventと非開示statusを順序%sでも保持する',
    async (reverse) => {
      const body = '当社は株式取得を決議しましたが、取得価額は非開示です。';
      const pages = [textPage(`会社名 株式会社テスト\n1. 株式取得\n${body}`)];
      const e = assertion(pages[0], '当社', 'decided');
      const status = structuredClone(e);
      status.kind = 'status';
      const fs = reverse ? [status, e] : [e, status];
      const good = reviewCandidates(candidateResponse([...fs, e], pages, 'ma'), 'ma', pages);
      expect(good.unverified).toEqual([]);
      expect(good.facts).toHaveLength(2);
      expect(new Set(good.facts.map((f) => f.id)).size).toBe(2);
      expect(
        parseFactSummary(
          JSON.stringify({ version: 4, documentType: 'ma', facts: good.facts, unverified: [] }),
          'ma',
          pages
        ).facts
      ).toEqual(good.facts);
      expect(
        renderFacts({ version: 4, documentType: 'ma', facts: good.facts, unverified: [] }).split(
          body
        )
      ).toHaveLength(2);
      // A delta adds the other kind without changing the confirmed assertion.
      vi.mocked(generateText)
        .mockReset()
        .mockResolvedValueOnce(candidateResponse([fs[0]], pages, 'ma'))
        .mockResolvedValueOnce(candidateResponse([fs[1]], pages, 'ma'));
      const result = await generateVerifiedFactSummary(config, 'ma', 'source', pages);
      expect(generateText).toHaveBeenCalledTimes(2);
      expect(result.facts.facts).toHaveLength(2);
      expect(result.facts.facts.some((f) => f.id === good.facts[0].id)).toBe(true);
    }
  );
  it.each(['の修正について', 'の修正及び配当予想の修正について'])('完全な予想修正見出しで前後の表候補・必須・保存を一致させる: %s', async (suffix) => {
    const target = '2028年3月期';
    const pages = [
      cells(
        [
          ['会社名 株式会社テスト', 0, 0, 210],
          [`1. ${target}連結業績予想${suffix}`, 0, 30, 600],
          ['売上高', 300, 60, 80],
          ['営業利益', 500, 60, 80],
          ['百万円', 310, 90, 60],
          ['百万円', 510, 90, 60],
          ['前回予想', 0, 120, 100],
          ['100', 310, 120, 30],
          ['10', 510, 120, 30],
          ['今回予想', 0, 150, 100],
          ['200', 310, 150, 30],
          ['20', 510, 150, 30],
        ],
        1
      ),
    ];
    if (suffix.includes('配当')) {
      pages.push(
        cells(
          [
            [`2. ${target} 配当予想の修正`, 0, 20, 450],
            ['年間配当金', 300, 50, 100],
            ['期末配当金', 500, 50, 100],
            ['円', 330, 80, 20],
            ['円', 530, 80, 20],
            ['前回予想', 0, 110, 100],
            ['2', 330, 110, 20],
            ['2', 530, 110, 20],
            ['今回予想', 0, 140, 100],
            ['3', 330, 140, 20],
            ['3', 530, 140, 20],
          ],
          2
        )
      );
    }
    const context = buildDocumentContext(pages);
    expect(context.tableMappings).toHaveLength(suffix.includes('配当') ? 8 : 4);
    const fs = context.tableMappings
      .filter(
        (h) =>
          !h.metricIds.some(
            (id) => pages.flatMap((p) => p.spans).find((s) => s.id === id)?.text === '期末配当金'
          )
      )
      .map((h) => {
        const sourcePage = pages.find((p) => p.quantities.some((q) => q.id === h.valueId))!;
        const f = numberCandidate(pages[0], '売上高');
        f.page = sourcePage.pageNumber;
        f.label = h.metricIds.map((id) => sourcePage.spans.find((s) => s.id === id)!.text).join('');
        f.value = Number(sourcePage.quantities.find((q) => q.id === h.valueId)!.text);
        if (f.label === '年間配当金') {
          f.unit = '円';
          f.semantics.metricKind = 'perShare';
          f.semantics.scope = null;
        }
        f.period = target;
        f.semantics.basis = null;
        f.valueKind = f.semantics.state = h.periodIds.some((id) =>
          sourcePage.spans.find((s) => s.id === id)!.text.includes('前回')
        )
          ? 'forecastBefore'
          : 'forecastAfter';
        f.evidence = { kind: 'table', ...h, scopeIds: [], qualifierIds: [] };
        return f;
      });
    const raw = candidateResponse(fs, pages, 'earningsRevision');
    const good = reviewCandidates(raw, 'earningsRevision', pages);
    expect(good.unverified).toEqual([]);
    expect(good.facts).toHaveLength(suffix.includes('配当') ? 6 : 4);
    expect(
      parseFactSummary(
        JSON.stringify({
          version: 4,
          documentType: 'earningsRevision',
          facts: good.facts,
          unverified: [],
        }),
        'earningsRevision',
        pages
      ).facts
    ).toEqual(good.facts);
    vi.mocked(generateText).mockReset().mockResolvedValueOnce(raw);
    expect(
      (await generateVerifiedFactSummary(config, 'earningsRevision', 'source', pages))
        .repairAttempted
    ).toBe(false);
  });
  it('同じ段落のstatus修復で誤eventの診断を消さない', async () => {
    const pages = [textPage('会社名 株式会社テスト\n1. 取引概要\n取得価額は非開示です。')];
    const wrong = assertion(pages[0], '取得価額', 'planned');
    const status = structuredClone(wrong);
    status.kind = 'status';
    status.semantics.state = 'unspecified';
    vi.mocked(generateText)
      .mockReset()
      .mockResolvedValueOnce(candidateResponse([wrong], pages))
      .mockResolvedValueOnce(candidateResponse([status], pages));
    const result = await generateVerifiedFactSummary(config, 'other', 'source', pages);
    expect(result.facts.facts).toHaveLength(1);
    expect(result.facts.facts[0].kind).toBe('status');
    expect(result.facts.unverified.join(' ')).toContain('STATE:');
    expect(saved(result.facts.facts, pages).facts).toEqual(result.facts.facts);
  });
  it.each([
    ['第2四半期', '第3四半期累計'],
    ['第2四半期', '第2四半期累計'],
    ['第3四半期', '第2四半期単独'],
  ])('局所の%sへ継承%sの限定を貸さない', (local, inherited) => {
    const pages = [
      textPage(
        `会社名 株式会社テスト\n1. ${period}${inherited} 経営成績\n${period}${local}の売上高は100百万円です。`
      ),
    ];
    const f = numberCandidate(pages[0], '売上高', 100, period + local);
    f.semantics.scope = f.semantics.basis = null;
    f.semantics.periodKind = local.includes('2') ? 'cumulativeQ2' : 'standaloneQ3';
    expect(reviewCandidates(candidateResponse([f], pages), 'other', pages).facts).toEqual([]);
    evidence(f, pages);
    f.id = stableFactId(f);
    expect(saved([f], pages).facts).toEqual([]);
    // When the quarter itself is inherited, its qualifier travels with it.
    const normal = [textPage(pages[0].text.replace(`${period}${local}の売上高`, '売上高'))];
    f.period = period + inherited;
    f.semantics.periodKind = inherited.includes('単独')
      ? 'standaloneQ2'
      : inherited.includes('3')
        ? 'cumulativeQ3'
        : 'cumulativeQ2';
    const r = reviewCandidates(candidateResponse([f], normal), 'other', normal);
    expect(r.unverified).toEqual([]);
    expect(r.facts).toHaveLength(1);
    expect(saved(r.facts, normal).facts).toEqual(r.facts);
    const localKind = local.includes('2') ? 'cumulativeQ2' : 'standaloneQ3';
    const qualifier = localKind === 'cumulativeQ2' ? '累計' : '単独';
    const explicit = [
      textPage(pages[0].text.replace(`${local}の売上高`, `${local}${qualifier}の売上高`)),
    ];
    f.period = period + local;
    f.semantics.periodKind = localKind;
    const proved = reviewCandidates(candidateResponse([f], explicit), 'other', explicit);
    expect(proved.unverified).toEqual([]);
    expect(proved.facts).toHaveLength(1);
    expect(saved(proved.facts, explicit).facts).toEqual(proved.facts);
  });
  it.each(['を踏まえた特別損失について', 'を参照した損失の背景', 'についての検討状況'])(
    '番号付き予想参照は必須3予想を作らず、予想自体の見出しは作る: %s',
    async (suffix) => {
      const { pages, amounts } = report(
        `1. 2028年3月期業績予想${suffix}\n当社は本施策を実施しました。`
      );
      const r = reviewCandidates(candidateResponse(amounts, pages, 'earnings'), 'earnings', pages);
      expect(() => verifyCoverage('earnings', pages, r.facts)).not.toThrow();
      expect(saved(r.facts, pages, 'earnings', true).facts).toEqual(r.facts);
      vi.mocked(generateText)
        .mockReset()
        .mockResolvedValueOnce(candidateResponse(amounts, pages, 'earnings'));
      expect(
        (await generateVerifiedFactSummary(config, 'earnings', 'source', pages)).repairAttempted
      ).toBe(false);
      const normal = report(
        '1. 2028年3月期の通期連結業績予想について\n当社は本施策を実施しました。'
      );
      const checked = reviewCandidates(
        candidateResponse(normal.amounts, normal.pages, 'earnings'),
        'earnings',
        normal.pages
      );
      expect(() => verifyCoverage('earnings', normal.pages, checked.facts)).toThrow(
        '通期予想の重要指標'
      );
    }
  );
  it.each([2, 3])('単独Q%sは有効な補足だが累計の必須3指標を充足しない', (q) => {
    const current = period + `第${q}四半期`;
    const pages = [
      textPage(
        `${period} 第${q}四半期決算短信〔日本基準〕（連結）\n会社名 株式会社テスト\n1. ${current}単独 経営成績\n${['売上高', '営業利益', '当期純利益'].map((m) => `${m}は100百万円です。`).join('\n')}`
      ),
    ];
    const fs = ['売上高', '営業利益', '当期純利益'].map((m) => {
      const f = numberCandidate(pages[0], m, 100, current);
      f.semantics.periodKind = `standaloneQ${q}` as typeof f.semantics.periodKind;
      return f;
    });
    const r = reviewCandidates(candidateResponse(fs, pages, 'earnings'), 'earnings', pages);
    expect(r.unverified).toEqual([]);
    expect(r.facts).toHaveLength(3);
    expect(saved(r.facts, pages).facts).toEqual(r.facts);
    expect(() => verifyCoverage('earnings', pages, r.facts)).toThrow('当年決算実績');
    const cumulativePages = [textPage(pages[0].text.replace('単独', '累計'))];
    const cumulative = fs.map((f) => ({
      ...f,
      semantics: { ...f.semantics, periodKind: `cumulativeQ${q}` as typeof f.semantics.periodKind },
    }));
    const good = reviewCandidates(
      candidateResponse(cumulative, cumulativePages, 'earnings'),
      'earnings',
      cumulativePages
    );
    expect(good.unverified).toEqual([]);
    expect(saved(good.facts, cumulativePages, 'earnings', true).facts).toEqual(good.facts);
  });
  it.each(['累計', '単独'])('Q3%s利益率の原文義務も報告対象に合わせる', (shape) => {
    const current = period + '第3四半期';
    const pages = [
      textPage(
        `${period} 第3四半期決算短信〔日本基準〕（連結）\n会社名 株式会社テスト\n1. ${current}累計 経営成績\n${['売上高', '営業利益', '当期純利益'].map((m) => `${m}は100百万円です。`).join('\n')}\n2. ${current}${shape} 経営成績\n売上高営業利益率は10%です。`
      ),
    ];
    const fs = ['売上高', '営業利益', '当期純利益'].map((m) => {
      const f = numberCandidate(pages[0], m, 100, current);
      f.semantics.periodKind = 'cumulativeQ3';
      return f;
    });
    const r = reviewCandidates(candidateResponse(fs, pages, 'earnings'), 'earnings', pages);
    expect(r.unverified).toEqual([]);
    const slot = coverageReport('earnings', pages, r.facts).find((s) =>
      s.requirement.endsWith('当年営業利益率')
    );
    if (shape === '累計') expect(slot).toMatchObject({ status: 'absent' });
    else expect(slot).toBeUndefined();
  });
  it.each(['累計', '単独'])('明示Q3%s期間の本文数量を検証する', (shape) => {
    const current = period + '第3四半期';
    const pages = [
      textPage(
        `会社名 株式会社テスト\n1. 経営成績\n${current}${shape}期間の売上高は100百万円です。`
      ),
    ];
    const f = numberCandidate(pages[0], '売上高', 100, current);
    f.semantics.scope = f.semantics.basis = null;
    f.semantics.periodKind = shape === '累計' ? 'cumulativeQ3' : 'standaloneQ3';
    const r = reviewCandidates(candidateResponse([f], pages), 'other', pages);
    expect(r.unverified).toEqual([]);
    expect(r.facts).toHaveLength(1);
    expect(saved(r.facts, pages).facts).toEqual(r.facts);
    const wrong = structuredClone(r.facts[0]);
    wrong.semantics.periodKind = shape === '累計' ? 'standaloneQ3' : 'cumulativeQ3';
    wrong.id = stableFactId(wrong);
    expect(saved([wrong], pages).facts).toEqual([]);
  });
  it('中間期とQ2の別名を生成・修復・保存・表示で二重化しない', async () => {
    const pages = [
      textPage(
        `会社名 株式会社テスト\n${period} 中間期決算短信\n1. ${period}中間期 経営成績\n売上高は100百万円です。\n営業利益は20百万円です。\n当期純利益は10百万円です。`
      ),
    ];
    const f = numberCandidate(pages[0], '売上高', 100, period + '中間期');
    f.semantics.scope = f.semantics.basis = null;
    f.semantics.periodKind = 'cumulativeQ2';
    const alias = structuredClone(f);
    alias.period = period + '第2四半期';
    const profit = structuredClone(f);
    Object.assign(profit, numberCandidate(pages[0], '営業利益', 20, f.period!));
    profit.semantics = { ...f.semantics };
    const a = reviewCandidates(candidateResponse([f], pages), 'other', pages).facts[0];
    const b = reviewCandidates(candidateResponse([alias], pages), 'other', pages).facts[0];
    const together = reviewCandidates(candidateResponse([f, alias, profit], pages), 'other', pages);
    expect(together.facts).toHaveLength(2);
    expect(saved([a, b], pages).facts).toHaveLength(1);
    const net = numberCandidate(pages[0], '当期純利益', 10, f.period!);
    net.semantics = { ...f.semantics };
    vi.mocked(generateText)
      .mockReset()
      .mockResolvedValueOnce(candidateResponse([f], pages, 'earnings'))
      .mockResolvedValueOnce(candidateResponse([alias, profit, net], pages, 'earnings'));
    const result = await generateVerifiedFactSummary(config, 'earnings', 'source', pages);
    expect(generateText).toHaveBeenCalledTimes(2);
    expect(result.facts.facts).toHaveLength(3);
    expect(renderFacts(result.facts).match(/売上高:/g)).toHaveLength(1);
  });
  it.each([
    ['当社は本施策を実施しない。', 'negative', 'unspecified'],
    ['当社は本施策を実施しないことを決定しました。', 'negative', 'decided'],
    ['当社は本施策を実施しない方針を決議しました。', 'negative', 'decided'],
    ['当社は自己株式を取得できないことを決定しました。', 'negative', 'decided'],
    ['当社は本施策を実施しないことを予定しています。', 'negative', 'planned'],
    ['当社は本施策を実施しないことを決定しません。', 'negative', 'unspecified'],
    ['当社はAを実施しないが、Bを取得しました。', 'mixed', 'completed'],
    ['当社は自己株式を取得できません。', 'negative', 'unspecified'],
    ['当社はAを取得できないが、Bを取得しました。', 'mixed', 'completed'],
    ['当社はAを取得できませんが、Bを取得しました。', 'mixed', 'completed'],
    ['当社は自己株式を取得しました。', 'affirmative', 'completed'],
  ] as const)('不可能の否定と対比を候補・保存で照合する: %s', (body, polarity, state) => {
    const pages = [textPage(`会社名 株式会社テスト\n1. 取引概要\n${body}`)];
    const e = event(numberCandidate(pages[0], '当社'));
    e.semantics.scope = e.semantics.basis = null;
    e.semantics.polarity = polarity;
    e.semantics.state = state;
    const r = reviewCandidates(candidateResponse([e], pages), 'other', pages);
    expect(r.unverified).toEqual([]);
    expect(r.facts).toHaveLength(1);
    expect(saved(r.facts, pages).facts).toEqual(r.facts);
    const wrong = structuredClone(r.facts[0]);
    wrong.semantics.polarity = polarity === 'affirmative' ? 'negative' : 'affirmative';
    wrong.id = stableFactId(wrong);
    validateSavedFacts({ version: 4, documentType: 'other', facts: [wrong], unverified: [] });
    expect(saved([wrong], pages).facts).toEqual([]);
    expect(reviewCandidates(candidateResponse([wrong], pages), 'other', pages).facts).toEqual([]);
    if (state !== 'unspecified') {
      const wrongState = structuredClone(r.facts[0]);
      wrongState.semantics.state = 'unspecified';
      wrongState.id = stableFactId(wrongState);
      expect(saved([wrongState], pages).facts).toEqual([]);
    }
  });
  it('円銭を完全な配当額として候補・保存・表示へ渡す', () => {
    const pages = [
      textPage(`会社名 株式会社テスト\n1. ${period} 配当の状況\n年間配当金は10円50銭です。`),
    ];
    const f = numberCandidate(pages[0], '年間配当金', 10.5, period);
    f.unit = '円';
    f.semantics.metricKind = 'perShare';
    f.semantics.scope = f.semantics.basis = null;
    const r = reviewCandidates(candidateResponse([f], pages), 'other', pages);
    expect(r.unverified).toEqual([]);
    expect(r.facts).toHaveLength(1);
    expect(r.facts[0].quantity).toMatchObject({ raw: '10円50銭', decimal: '10.50' });
    expect(saved(r.facts, pages).facts).toEqual(r.facts);
    expect(
      renderFacts({ version: 4, documentType: 'other', facts: r.facts, unverified: [] })
    ).toContain('10.50円');
    const wrong = structuredClone(r.facts[0]);
    wrong.value = 10;
    wrong.quantity = { ...wrong.quantity!, raw: '10', decimal: '10' };
    wrong.id = stableFactId(wrong);
    validateSavedFacts({ version: 4, documentType: 'other', facts: [wrong], unverified: [] });
    expect(saved([wrong], pages).facts).toEqual([]);
  });
  it('複数断片の見出しを保存根拠から一部分だけ落として受理しない', () => {
    const pages = [
      cells(
        [
          ['会社名 株式会社テスト', 0, 0, 200],
          ['1. ', 0, 30, 20],
          [period, 35, 30, 130],
          ['業績予想', 180, 30, 80],
          ['2026年3月期', 200, 60, 140],
          [period, 420, 60, 140],
          ['売上高', 0, 90, 80],
          ['80百万円', 240, 90, 80],
          ['100百万円', 460, 90, 80],
        ],
        1
      ),
    ];
    const hint = buildDocumentContext(pages).tableMappings.find(
      (h) => pages[0].quantities.find((q) => q.id === h.valueId)?.text === '100百万円'
    )!;
    const f = numberCandidate(pages[0], '売上高', 100, period);
    f.evidence = { kind: 'table', ...hint, scopeIds: [], qualifierIds: [] };
    f.valueKind = f.semantics.state = 'forecast';
    f.semantics.scope = f.semantics.basis = null;
    const r = reviewCandidates(candidateResponse([f], pages), 'other', pages);
    expect(r.unverified).toEqual([]);
    expect(r.facts).toHaveLength(1);
    const good = r.facts[0];
    expect(good.evidence.contextIds.length).toBeGreaterThan(1);
    expect(saved([good], pages).facts).toEqual([good]);
    const wrong = structuredClone(good);
    wrong.evidence.contextIds = [good.evidence.contextIds[good.evidence.contextIds.length - 1]];
    if (wrong.evidence.kind !== 'table') throw new Error('expected table');
    const { valueId, metricIds, periodIds, unitIds, contextIds } = wrong.evidence;
    wrong.quote = verifyTableEvidence(
      pages[0],
      { valueId, metricIds, periodIds, unitIds, contextIds },
      {
        label: wrong.label,
        value: wrong.value,
        unit: wrong.unit!,
        period: wrong.period!,
        valueKind: wrong.valueKind!,
      },
      false
    ).quote;
    wrong.id = stableFactId(wrong);
    validateSavedFacts({ version: 4, documentType: 'other', facts: [wrong], unverified: [] });
    expect(saved([wrong], pages).facts).toEqual([]);
  });
});

describe('報告節の責務と原文期間からの修復制約', () => {
  it.each(
    [
      ['単体', ''],
      ['非連結', 'の'],
      ['単体', '累計期間'],
      ['非連結', '累計期間の'],
    ] as const
  )('%s%s業績も局所属性を保持して必須実績を満たす', async (scope, qualifier) => {
    const pages = [
      textPage(
        `${period} 決算短信〔IFRS〕（${scope}）\n会社名 株式会社テスト\n1. ${scope}${qualifier}業績\n会計基準 IFRS\n${['売上高', '営業利益', '当期純利益'].map((m) => `${period}の${m}は100百万円です。`).join('\n')}`
      ),
    ];
    const fs = ['売上高', '営業利益', '当期純利益'].map((m) => {
      const f = numberCandidate(pages[0], m, 100, period);
      f.semantics.scope = scope;
      f.semantics.basis = 'IFRS';
      return f;
    });
    pages.push(
      cells(
        [
          [`1. ${scope}${qualifier}業績`, 0, 20, 140],
          ['会計基準 IFRS', 0, 40, 140],
          ['2026年3月期', 200, 60, 140],
          [period, 420, 60, 140],
          ['売上高営業利益率', 0, 90, 150],
          ['8%', 250, 90, 40],
          ['10%', 480, 90, 40],
        ],
        2
      )
    );
    const hint = buildDocumentContext(pages).tableMappings.find(
      (h) => pages[1].quantities.find((q) => q.id === h.valueId)?.text === '10%'
    )!;
    expect(hint).toBeDefined();
    const rate = numberCandidate(pages[0], '売上高', 10, period);
    rate.page = 2;
    rate.label = '売上高営業利益率';
    rate.unit = '%';
    rate.semantics.metricKind = 'rate';
    rate.semantics.scope = scope;
    rate.semantics.basis = 'IFRS';
    rate.evidence = { kind: 'table', ...hint, scopeIds: [], qualifierIds: [] };
    fs.push(rate);
    const r = reviewCandidates(candidateResponse(fs, pages, 'earnings'), 'earnings', pages);
    expect(r.unverified).toEqual([]);
    expect(saved(r.facts, pages, 'earnings', true).facts).toEqual(r.facts);
    vi.mocked(generateText)
      .mockReset()
      .mockResolvedValueOnce(candidateResponse(fs, pages, 'earnings'));
    expect(
      (await generateVerifiedFactSummary(config, 'earnings', 'source', pages)).repairAttempted
    ).toBe(false);
    expect(generateText).toHaveBeenCalledTimes(1);
  });
  it.each(['2028年3月期通期', '2028年3月期'])(
    '明示通期の数量を四半期表紙で上書きしない: %s',
    (target) => {
      const pages = [
        textPage(
          `${period} 第3四半期決算短信〔日本基準〕（連結）\n会社名 株式会社テスト\n1. ${period}第3四半期 経営成績\n${target}の売上高は100百万円を見込んでおります。`
        ),
      ];
      const f = numberCandidate(pages[0], '売上高', 100, target);
      f.valueKind = f.semantics.state = 'forecast';
      const r = reviewCandidates(candidateResponse([f], pages), 'other', pages);
      expect(r.unverified).toEqual([]);
      expect(r.facts).toHaveLength(1);
      expect(saved(r.facts, pages).facts).toEqual(r.facts);
      const wrong = structuredClone(r.facts[0]);
      wrong.period = period + '第3四半期';
      wrong.semantics.periodKind = 'cumulativeQ3';
      wrong.id = stableFactId(wrong);
      expect(saved([wrong], pages).facts).toEqual([]);
    }
  );
  it.each([
    ['翌連結会計年度', 'relativeYear', ''],
    ['2028年3月期', 'fullYear', ''],
    ['2028年3月31日', 'eventDate', ''],
    ['翌連結会計年度', 'relativeYear', '2028年3月期の業績予想を参照しましたが、'],
    ['2028年3月期', 'fullYear', '', '当社は当該額を'],
    ['2028年3月期', 'fullYear', '', '当社が当該費用を'],
    ['2028年3月1日～2028年3月31日', 'interval', '', '当社は当該額を'],
    ['2028年3月1日から2028年3月31日', 'interval', '', ''],
    ['2028年3月1日から2028年3月31日まで', 'interval', '', '当社は'],
    ['2028年3月1日-2028年3月31日', 'interval', '', '当社は'],
  ] as const)(
    '計上予定の修復区分を原文期間から作る: %s',
    async (target, kind, prefix, subject = '') => {
      const body = `${prefix}当該額は${target}に${subject}特別損失に計上する予定です。`;
      const { pages, amounts } = report(`1. 今後の予定\n${body}`);
      const e = event(numberCandidate(pages[0], '特別損失', 100, period));
      e.period = target.replace('から', '～').replace(/まで$/, '');
      e.semantics.periodKind = kind;
      e.semantics.state = 'planned';
      const first = reviewCandidates(
        candidateResponse(amounts, pages, 'earnings'),
        'earnings',
        pages
      );
      const slot = coverageReport('earnings', pages, first.facts).find((s) =>
        s.requirement.includes('損失の計上予定')
      )!;
      expect(slot).toMatchObject({
        status: 'absent',
        expected: { kind: 'event', state: 'planned', periodKind: kind },
      });
      vi.mocked(generateText)
        .mockReset()
        .mockResolvedValueOnce(candidateResponse(amounts, pages, 'earnings'))
        .mockResolvedValueOnce(
          candidateResponse(
            [{ ...e, semantics: { ...e.semantics, periodKind: slot.expected.periodKind! } }],
            pages,
            'earnings'
          )
        );
      const r = await generateVerifiedFactSummary(config, 'earnings', 'source', pages);
      expect(generateText).toHaveBeenCalledTimes(2);
      expect(r.facts.facts).toHaveLength(4);
      expect(saved(r.facts.facts, pages, 'earnings', true).facts).toEqual(r.facts.facts);
      expect(renderFacts(r.facts)).toContain(body);
      if (kind === 'interval')
        expect(r.facts.facts[3].dateRoles?.map((d) => d.state)).toEqual([
          'periodStart',
          'periodEnd',
        ]);
      for (const omitted of kind === 'interval'
        ? [null, '2028年3月1日', '2028年3月31日', '2028年3月31日～2028年3月1日']
        : [null]) {
        const wrong = structuredClone(r.facts.facts[3]);
        wrong.period = omitted;
        wrong.semantics.periodKind =
          omitted === null ? 'none' : omitted.includes('～') ? 'interval' : 'eventDate';
        wrong.id = stableFactId(wrong);
        expect(saved([wrong], pages).facts).toEqual([]);
        expect(
          reviewCandidates(candidateResponse([wrong], pages), 'earnings', pages).facts
        ).toEqual([]);
      }
    }
  );
  it.each([
    '2028年3月期の業績予想を参照しましたが、当該額は特別損失に計上する予定です。',
    '2028年3月期の業績予想を参照し、当該額は特別損失に計上する予定です。',
    '翌連結会計年度の業績予想を参照しましたが、当該額は特別損失に計上する予定です。',
    '2028年3月1日～2028年3月31日の業績予想を参照しましたが、当該額は特別損失に計上する予定です。',
    '当該額は2028年3月31日までに特別損失に計上する予定です。',
  ])('参照した別主張の年度を計上予定へ貸さない: %s', async (body) => {
    const { pages, amounts } = report(`1. 今後の予定\n${body}`);
    const e = event(numberCandidate(pages[0], '特別損失', 100, period));
    e.semantics.state = 'planned';
    const first = reviewCandidates(
      candidateResponse(amounts, pages, 'earnings'),
      'earnings',
      pages
    );
    const slot = coverageReport('earnings', pages, first.facts).find((s) =>
      s.requirement.includes('損失の計上予定')
    )!;
    expect(slot.expected).not.toHaveProperty('periodKind');
    const all = reviewCandidates(
      candidateResponse([...amounts, e], pages, 'earnings'),
      'earnings',
      pages
    );
    expect(all.unverified).toEqual([]);
    expect(all.facts).toHaveLength(4);
    expect(saved(all.facts, pages, 'earnings', true).facts).toEqual(all.facts);
    const wrong = structuredClone(all.facts[3]);
    wrong.period = body.startsWith('翌')
      ? '翌連結会計年度'
      : body.includes('2028年3月31日')
        ? '2028年3月31日'
        : '2028年3月期';
    wrong.semantics.periodKind = body.startsWith('翌')
      ? 'relativeYear'
      : body.includes('2028年3月31日')
        ? 'eventDate'
        : 'fullYear';
    wrong.id = stableFactId(wrong);
    expect(saved([wrong], pages).facts).toEqual([]);
    expect(
      reviewCandidates(candidateResponse([wrong], pages, 'earnings'), 'earnings', pages).facts
    ).toEqual([]);
    vi.mocked(generateText)
      .mockReset()
      .mockResolvedValueOnce(candidateResponse(amounts, pages, 'earnings'))
      .mockResolvedValueOnce(candidateResponse([e], pages, 'earnings'));
    const r = await generateVerifiedFactSummary(config, 'earnings', 'source', pages);
    expect(generateText).toHaveBeenCalledTimes(2);
    expect(r.facts.facts[3].period).toBeNull();
    expect(renderFacts(r.facts)).toContain(body);
  });
  it('複数の計上予定で一方の年度を他方の修復制約にしない', async () => {
    const { pages, amounts } = report(
      '1. 今後の予定\n当該額は2028年3月期に特別損失に計上する予定です。'
    );
    pages.push(
      textPage(
        '1. 今後の予定\n2029年3月期の業績予想を参照しましたが、当該額は特別損失に計上する予定です。',
        2
      )
    );
    const attached = event(numberCandidate(pages[0], '特別損失'));
    attached.period = '2028年3月期';
    attached.semantics.state = 'planned';
    attached.semantics.periodKind = 'fullYear';
    const incidental = event(numberCandidate(pages[1], '特別損失'));
    incidental.semantics.state = 'planned';
    const first = reviewCandidates(
      candidateResponse(amounts, pages, 'earnings'),
      'earnings',
      pages
    );
    const slot = coverageReport('earnings', pages, first.facts).find((s) =>
      s.requirement.includes('損失の計上予定')
    )!;
    expect(slot.sourceIds).toHaveLength(2);
    expect(slot.expected).not.toHaveProperty('periodKind');
    vi.mocked(generateText)
      .mockReset()
      .mockResolvedValueOnce(candidateResponse(amounts, pages, 'earnings'))
      .mockResolvedValueOnce(candidateResponse([attached, incidental], pages, 'earnings'));
    const r = await generateVerifiedFactSummary(config, 'earnings', 'source', pages);
    expect(r.facts.facts).toHaveLength(5);
    expect(saved(r.facts.facts, pages, 'earnings', true).facts).toEqual(r.facts.facts);
  });
});

describe('役割と必須対象の対応', () => {
  it.each([
    '譲渡実行日: 2027年1月1日',
    '株式譲渡実行日 2027年1月1日（予定）',
    '譲渡実行日: 2027年1月1日。譲渡予定を中止しました。',
  ])('実行日欄をM&Aの生成・必須・保存で共有する: %s', async (schedule) => {
    const pages = [
      textPage(
        `会社名 株式会社テスト\n1. 株式取得\n当社は株式取得を決議しました。\n2. 日程\n${schedule}`
      ),
    ];
    const decision = assertion(pages[0], '当社', 'decided');
    const state = schedule.includes('中止') ? 'unspecified' : 'planned';
    const date = assertion(pages[0], schedule, state);
    const raw = candidateResponse([decision, date], pages, 'ma');
    const good = reviewCandidates(raw, 'ma', pages);
    expect(good.unverified).toEqual([]);
    expect(good.facts[1].dateRoles).toEqual([
      {
        date: '2027年1月1日',
        state,
        sourceId: date.evidence.kind === 'prose' ? date.evidence.blockId : '',
      },
    ]);
    expect(
      parseFactSummary(
        JSON.stringify({ version: 4, documentType: 'ma', facts: good.facts, unverified: [] }),
        'ma',
        pages
      ).facts
    ).toEqual(good.facts);
    vi.mocked(generateText).mockReset().mockResolvedValueOnce(raw);
    expect((await generateVerifiedFactSummary(config, 'ma', 'source', pages)).repairAttempted).toBe(
      false
    );
  });
  it.each([
    '2027年3月期（2026年4月1日～2027年3月31日）',
    '2026年4月（2026年4月1日から2027年3月31日）',
  ])('FY/月のラベルを日付区間の端点へ数えない: %s', (axis) => {
    const target = '2026年4月1日～2027年3月31日';
    const pages = [
      report().pages[0],
      cells(
        [
          ['1. 経営成績', 0, 20, 100],
          ['販売件数', 340, 50, 80],
          ['人数', 550, 50, 60],
          ['件', 360, 80, 20],
          ['人', 570, 80, 20],
          [axis, 0, 110, 320],
          ['100', 360, 110, 30],
          ['20', 570, 110, 20],
        ],
        2
      ),
    ];
    const hint = buildDocumentContext(pages).tableMappings.find((h) =>
      h.metricIds.some((id) => pages[1].spans.find((s) => s.id === id)?.text === '販売件数')
    )!;
    expect(hint).toBeDefined();
    const f = numberCandidate(pages[0], '売上高', 100, target);
    f.label = '販売件数';
    f.page = 2;
    f.unit = '件';
    f.semantics.metricKind = 'count';
    f.semantics.periodKind = 'interval';
    f.evidence = { kind: 'table', ...hint, scopeIds: [], qualifierIds: [] };
    const good = reviewCandidates(candidateResponse([f], pages), 'other', pages);
    expect(good.unverified).toEqual([]);
    expect(saved(good.facts, pages).facts).toEqual(good.facts);
    for (const wrongPeriod of [
      '2027年3月31日',
      '2027年3月31日～2026年4月1日',
      '2026年4月2日～2027年3月31日',
    ]) {
      const wrong = structuredClone(good.facts[0]);
      wrong.period = wrongPeriod;
      wrong.semantics.periodKind = wrongPeriod.includes('～') ? 'interval' : 'eventDate';
      wrong.id = stableFactId(wrong);
      expect(reviewCandidates(candidateResponse([wrong], pages), 'other', pages).facts).toEqual([]);
      expect(saved([wrong], pages).facts).toEqual([]);
    }
  });
  it.each(['見込めません', '見込めず'])(
    '可能形の否定をnegative/forecastとして保持する: %s',
    (predicate) => {
      const pages = [textPage(`会社名 株式会社テスト\n1. 取引概要\n業績への影響は${predicate}。`)];
      const f = assertion(pages[0], '業績への影響', 'forecast');
      f.semantics.polarity = 'negative';
      const good = reviewCandidates(candidateResponse([f], pages), 'other', pages);
      expect(good.unverified).toEqual([]);
      expect(saved(good.facts, pages).facts).toEqual(good.facts);
      const wrong = structuredClone(good.facts[0]);
      wrong.semantics.polarity = 'affirmative';
      wrong.id = stableFactId(wrong);
      expect(reviewCandidates(candidateResponse([wrong], pages), 'other', pages).facts).toEqual([]);
      expect(saved([wrong], pages).facts).toEqual([]);
      const normal = [textPage(pages[0].text.replace(predicate, '見込めます'))];
      f.semantics.polarity = 'affirmative';
      expect(reviewCandidates(candidateResponse([f], normal), 'other', normal).unverified).toEqual(
        []
      );
    }
  );
  it.each(
    [
      ['会社名', 'なし'],
      ['上場会社名', '欄の前'],
      ['名称', '最初の欄の後'],
    ] as const
  )('会社切替を同じ節のrole境界として扱う: %s / %s', (field, heading) => {
    const pages = [
      report().pages[0],
      textPage(
        `${heading === '欄の前' ? '1. 対象会社の概要\n' : ''}${field} 株式会社A\n${heading === '最初の欄の後' ? '1. 対象会社の概要\n' : ''}${period}の売上高は100百万円です。\n${field} 株式会社B\n${period}の営業利益は200百万円です。`,
        2
      ),
    ];
    const fs = [
      ['売上高', 100, '株式会社A'],
      ['営業利益', 200, '株式会社B'],
    ].map(([label, value, subject]) => {
      const f = numberCandidate(pages[1], String(label), Number(value), period);
      f.semantics.scope = f.semantics.basis = null;
      f.semantics.subject = String(subject);
      return f;
    });
    const good = reviewCandidates(candidateResponse(fs, pages), 'other', pages);
    expect(good.unverified).toEqual([]);
    expect(good.facts).toHaveLength(2);
    expect(saved(good.facts, pages).facts).toEqual(good.facts);
    const wrong = structuredClone(good.facts[1]);
    wrong.semantics.subject = '株式会社A';
    wrong.id = stableFactId(wrong);
    expect(saved([wrong], pages).facts).toEqual([]);
  });
  it.each(['会社名'])(
    '表紙発行者の別表記で子会社実績を見出し実績へ使わない: %s',
    (field) => {
      const { pages, amounts } = report();
      pages[0] = textPage(pages[0].text.replace('会社名', field));
      const other = textPage(
        `1. ${period} 経営成績\n会社名 株式会社他社\n売上高は200百万円です。`,
        2
      );
      pages.push(other);
      const f = numberCandidate(other, '売上高', 200, period);
      f.semantics.subject = '株式会社他社';
      f.semantics.scope = f.semantics.basis = null;
      const good = reviewCandidates(
        candidateResponse([...amounts.slice(1), f], pages, 'earnings'),
        'earnings',
        pages
      );
      expect(good.unverified).toEqual([]);
      expect(() => verifyCoverage('earnings', pages, good.facts)).toThrow(
        '当年決算実績の重要指標 revenue'
      );
      const all = reviewCandidates(
        candidateResponse([...amounts, f], pages, 'earnings'),
        'earnings',
        pages
      );
      expect(() => verifyCoverage('earnings', pages, all.facts)).not.toThrow();
    }
  );
  it.each(['subject', 'period', 'source', 'scope', 'negative', 'valid'])(
    '予想未定の例外を発行者・年度・予想出典へ対応させる: %s',
    async (variant) => {
      const { pages, amounts } = report();
      const target = '2028年3月期';
      const year = variant === 'period' ? '2029年3月期' : target;
      pages.push(
        textPage(
          `1. ${target} 連結業績予想\n${['売上高', '営業利益', '当期純利益'].map((m) => `${target}の${m}は100百万円です。`).join('\n')}`,
          2
        )
      );
      pages.push(
        textPage(
          `2. ${year} ${variant === 'source' ? '取引概要' : variant === 'scope' ? '個別業績予想' : '連結業績予想'}\n${variant === 'subject' ? '会社名 株式会社他社\n' : ''}業績予想は未定${variant === 'negative' ? 'ではありません' : 'です'}。`,
          3
        )
      );
      const status = assertion(pages[2], '未定', 'unspecified');
      if (variant === 'negative') status.semantics.polarity = 'negative';
      status.kind = 'status';
      status.semantics.subject = variant === 'subject' ? '株式会社他社' : '株式会社テスト';
      if (variant !== 'source') status.semantics.scope = variant === 'scope' ? '個別' : '連結';
      if (
        variant === 'period' ||
        variant === 'valid' ||
        variant === 'scope' ||
        variant === 'negative'
      )
        status.semantics.basis = '日本基準';
      const raw = candidateResponse([...amounts, status], pages, 'earnings');
      const good = reviewCandidates(raw, 'earnings', pages);
      expect(good.unverified).toEqual([]);
      if (variant === 'valid')
        expect(() => verifyCoverage('earnings', pages, good.facts)).not.toThrow();
      else {
        expect(() => verifyCoverage('earnings', pages, good.facts)).toThrow(
          '通期予想の重要指標 revenue'
        );
        const forecasts = ['売上高', '営業利益', '当期純利益'].map((m) => {
          const f = numberCandidate(pages[1], m, 100, target);
          f.valueKind = f.semantics.state = 'forecast';
          return f;
        });
        vi.mocked(generateText)
          .mockReset()
          .mockResolvedValueOnce(raw)
          .mockResolvedValueOnce(candidateResponse(forecasts, pages, 'earnings'));
        const result = await generateVerifiedFactSummary(config, 'earnings', 'source', pages);
        expect(generateText).toHaveBeenCalledTimes(2);
        expect(saved(result.facts.facts, pages, 'earnings', true).facts).toEqual(
          result.facts.facts
        );
      }
    }
  );
  it.each(['event', 'status'] as const)(
    '数値から%sへの原文保持修復でも数量の未確認を残す',
    async (kind) => {
      const pages = [
        textPage(`会社名 株式会社テスト\n1. ${period} 取引概要\n取得価額は100百万円以内です。`),
      ];
      const f = numberCandidate(pages[0], '取得価額', 100, period);
      f.semantics.scope = f.semantics.basis = null;
      const retained = event(f);
      retained.kind = kind;
      retained.semantics.state = 'unspecified';
      if (kind === 'status') {
        pages[0] = textPage(
          pages[0].text.replace('以内です。', '以内です。取得価額の詳細は非開示です。')
        );
        Object.assign(f, numberCandidate(pages[0], '取得価額', 100, period));
        f.semantics.scope = f.semantics.basis = null;
        Object.assign(retained, event(f));
        retained.kind = 'status';
        retained.semantics.state = 'unspecified';
      }
      const initial = reviewCandidates(candidateResponse([f], pages), 'other', pages);
      vi.mocked(generateText)
        .mockReset()
        .mockResolvedValueOnce(candidateResponse([f], pages))
        .mockResolvedValueOnce(candidateResponse([retained], pages));
      const result = await generateVerifiedFactSummary(config, 'other', 'source', pages);
      expect(result.facts.unverified).toEqual(initial.unverified);
      expect(result.facts.facts[0].kind).toBe(kind);
      expect(saved(result.facts.facts, pages).facts).toEqual(result.facts.facts);
    }
  );
});

it.each([
  ['scope', '範囲', '連結', '個別'],
  ['basis', '会計基準', '日本基準', 'IFRS'],
] as const)('局所%sも同役割の次の宣言まで適用する', (role, label, first, last) => {
  const pages = [
    textPage(
      `会社名 株式会社テスト\n1. ${period} 経営成績\n${label} ${first}\n売上高は100百万円です。\n${label} ${last}\n営業利益は200百万円です。`
    ),
  ];
  const fs = [
    ['売上高', 100, first],
    ['営業利益', 200, last],
  ].map(([metric, value, attribute]) => {
    const f = numberCandidate(pages[0], String(metric), Number(value), period);
    f.semantics.scope = f.semantics.basis = null;
    f.semantics[role] = String(attribute);
    return f;
  });
  const good = reviewCandidates(candidateResponse(fs, pages), 'other', pages);
  expect(good.unverified).toEqual([]);
  expect(saved(good.facts, pages).facts).toEqual(good.facts);
  const wrong = structuredClone(good.facts[1]);
  wrong.semantics[role] = first;
  wrong.id = stableFactId(wrong);
  expect(saved([wrong], pages).facts).toEqual([]);
});

describe('継承・取消・必須単位と修復メタデータの境界', () => {
  it.each([
    ['第3四半期累計', 'cumulativeQ3'],
    ['3Q単独', 'standaloneQ3'],
    ['中間期', 'cumulativeQ2'],
  ] as const)('年度なしの%s見出しから本文・表へ形を継承する', (shape, kind) => {
    const suffix = shape === '3Q単独' ? '第3四半期単独' : shape;
    const target = period + suffix;
    const pages = [
      report().pages[0],
      textPage(`1. ${shape} 経営成績\n${period}の売上高は100百万円です。`, 2),
    ];
    const f = numberCandidate(pages[1], '売上高', 100, target);
    f.semantics.periodKind = kind;
    const good = reviewCandidates(candidateResponse([f], pages), 'other', pages);
    expect(good.unverified).toEqual([]);
    expect(saved(good.facts, pages).facts).toEqual(good.facts);
    const table = cells(
      [
        [`1. ${shape} 経営成績`, 0, 20, 240],
        ['売上高', 350, 50, 80],
        ['営業利益', 540, 50, 80],
        ['百万円', 350, 80, 60],
        ['百万円', 540, 80, 60],
        [period, 0, 110, 220],
        ['100', 350, 110, 30],
        ['20', 540, 110, 30],
      ],
      2
    );
    const tablePages = [pages[0], table];
    const hint = buildDocumentContext(tablePages).tableMappings.find((h) =>
      h.metricIds.some((id) => table.spans.find((s) => s.id === id)?.text === '売上高')
    )!;
    expect(hint).toBeDefined();
    f.evidence = { kind: 'table', ...hint, scopeIds: [], qualifierIds: [] };
    const checked = reviewCandidates(candidateResponse([f], tablePages), 'other', tablePages);
    expect(checked.unverified).toEqual([]);
    expect(saved(checked.facts, tablePages).facts).toEqual(checked.facts);
    const wrong = structuredClone(checked.facts[0]);
    wrong.period = period;
    wrong.semantics.periodKind = 'fullYear';
    wrong.id = stableFactId(wrong);
    expect(saved([wrong], tablePages).facts).toEqual([]);
  });
  it.each(['中止しましたが、', '撤回しました。', '取り消しましたが、'])(
    '取消%sの後の新予定を候補・保存・日付で保持する',
    (cancel) => {
      const body = `当初の取得予定を${cancel}新たに株式を取得する予定です。`;
      const pages = [textPage(`会社名 株式会社テスト\n1. 取引概要\n${body}`)];
      const f = assertion(pages[0], '当初', 'planned');
      const good = reviewCandidates(candidateResponse([f], pages), 'other', pages);
      expect(good.unverified).toEqual([]);
      expect(saved(good.facts, pages).facts).toEqual(good.facts);
      const wrong = structuredClone(good.facts[0]);
      wrong.semantics.state = 'unspecified';
      wrong.id = stableFactId(wrong);
      expect(saved([wrong], pages).facts).toEqual([]);
      const schedule = `譲渡実行日: 2027年1月1日。当初の譲渡予定を${cancel}新たな譲渡実行日: 2027年2月1日`;
      expect(datedStates(schedule)).toEqual([
        { date: '2027年1月1日', state: 'unspecified' },
        { date: '2027年2月1日', state: 'planned' },
      ]);
      const source = [textPage(`会社名 株式会社テスト\n1. 取引概要\n${schedule}`)];
      const e = assertion(source[0], '譲渡実行日', 'planned');
      const r = reviewCandidates(candidateResponse([e], source), 'other', source);
      expect(r.unverified).toEqual([]);
      expect(saved(r.facts, source).facts).toEqual(r.facts);
    }
  );
  it.each(['(1) 経営成績', '(1) 内訳\n① 経営成績'])(
    '親の3局所属性を%sへ保持し、兄弟退出で戻す',
    (child) => {
      const pages = [
        report().pages[0],
        textPage(
          `1. 対象会社の概要\n会社名 株式会社B\n範囲 個別\n会計基準 IFRS\n${child}\n${period}の売上高は200百万円です。\n(2) 経営成績\n${period}の当期純利益は200百万円です。\n2. 経営成績\n${period}の営業利益は100百万円です。`,
          2
        ),
      ];
      const local = numberCandidate(pages[1], '売上高', 200, period);
      Object.assign(local.semantics, { subject: '株式会社B', scope: '個別', basis: 'IFRS' });
      const sibling = numberCandidate(pages[1], '当期純利益', 200, period);
      Object.assign(sibling.semantics, { subject: '株式会社B', scope: '個別', basis: 'IFRS' });
      const issuer = numberCandidate(pages[1], '営業利益', 100, period);
      const good = reviewCandidates(
        candidateResponse([local, sibling, issuer], pages),
        'other',
        pages
      );
      expect(good.unverified).toEqual([]);
      expect(saved(good.facts, pages).facts).toEqual(good.facts);
      const wrong = structuredClone(good.facts[0]);
      Object.assign(wrong.semantics, {
        subject: '株式会社テスト',
        scope: '連結',
        basis: '日本基準',
      });
      wrong.id = stableFactId(wrong);
      expect(saved([wrong], pages).facts).toEqual([]);
    }
  );
  it.each(['subject', 'quarter', 'source'] as const)(
    '予想EPSの%s違いは発行者通期の代替にしない',
    async (variant) => {
      const { pages, amounts } = report('1株当たり当期純利益');
      const target = '2028年3月期';
      pages.push(
        textPage(
          `1. ${target} 業績予想\n${['売上高', '営業利益', '当期純利益'].map((m) => `${target}の${m}は100百万円です。`).join('\n')}\n${target}の1株当たり当期純利益は100円です。`,
          2
        )
      );
      const forecasts = ['売上高', '営業利益', '当期純利益'].map((m) => {
        const f = numberCandidate(pages[1], m, 100, target);
        f.valueKind = f.semantics.state = 'forecast';
        return f;
      });
      const other = textPage(
        `${variant === 'subject' ? '会社名 株式会社他社\n' : ''}2. ${target} ${variant === 'source' ? '販売状況' : '業績予想'}\n${target}${variant === 'quarter' ? '第1四半期' : ''}の1株当たり当期純利益は100円${variant === 'source' ? 'を見込んでおります' : 'です'}。`,
        3
      );
      pages.push(other);
      const eps = numberCandidate(
        other,
        '1株当たり当期純利益',
        100,
        target + (variant === 'quarter' ? '第1四半期' : '')
      );
      eps.unit = '円';
      eps.semantics.metricKind = 'perShare';
      eps.valueKind = eps.semantics.state = 'forecast';
      if (variant === 'quarter') eps.semantics.periodKind = 'cumulativeQ1';
      if (variant === 'subject') {
        eps.semantics.subject = '株式会社他社';
        eps.semantics.scope = eps.semantics.basis = null;
      }
      if (variant === 'source') eps.semantics.scope = eps.semantics.basis = null;
      const raw = candidateResponse([...amounts, ...forecasts, eps], pages, 'earnings');
      const good = reviewCandidates(raw, 'earnings', pages);
      expect(good.unverified).toEqual([]);
      expect(() => verifyCoverage('earnings', pages, good.facts)).toThrow(
        '通期予想の1株当たり利益'
      );
      const correct = numberCandidate(pages[1], '1株当たり当期純利益', 100, target);
      correct.unit = '円';
      correct.semantics.metricKind = 'perShare';
      correct.valueKind = correct.semantics.state = 'forecast';
      vi.mocked(generateText)
        .mockReset()
        .mockResolvedValueOnce(raw)
        .mockResolvedValueOnce(candidateResponse([correct], pages, 'earnings'));
      const result = await generateVerifiedFactSummary(config, 'earnings', 'source', pages);
      expect(result.repairAttempted).toBe(true);
      expect(saved(result.facts.facts, pages, 'earnings', true).facts).toEqual(result.facts.facts);
    }
  );
  it.each(['number', 'event', 'status'] as const)(
    '同じ確定%sのdetail→key修復は意味とIDを維持する',
    async (kind) => {
      const body =
        kind === 'status' ? '取得価額は未定です。' : `${period}の取得価額は100百万円です。`;
      const pages = [textPage(`会社名 株式会社テスト\n1. 取引概要\n${body}`)];
      let f = numberCandidate(pages[0], '取得価額', 100, period);
      f.semantics.scope = f.semantics.basis = null;
      if (kind !== 'number') {
        f = event(f);
        f.kind = kind;
        f.semantics.state = 'unspecified';
      }
      f.importance = 'detail';
      const raw = candidateResponse([f], pages);
      const good = reviewCandidates(raw, 'other', pages);
      expect(good.unverified).toEqual([]);
      const promoted = { ...f, importance: 'key' as const };
      vi.mocked(generateText)
        .mockReset()
        .mockResolvedValueOnce(raw)
        .mockResolvedValueOnce(candidateResponse([promoted], pages));
      const r = await generateVerifiedFactSummary(config, 'other', 'source', pages);
      expect(r.facts.facts).toEqual([{ ...good.facts[0], importance: 'key' }]);
      expect(saved(r.facts.facts, pages, 'other', true).facts).toEqual(r.facts.facts);
      const duplicate = reviewCandidates(candidateResponse([f, promoted], pages), 'other', pages);
      expect(duplicate.facts).toEqual(r.facts.facts);
      expect(
        reviewCandidates(candidateResponse([promoted, f], pages), 'other', pages).facts
      ).toEqual(r.facts.facts);
    }
  );
});

it('子会社利益率は発行者利益率の義務を作らず、代替もできない', () => {
  const { pages, amounts } = report();
  const other = textPage(
    `会社名 株式会社B\n1. ${period} 経営成績\n${period}の売上高営業利益率は10%です。`,
    2
  );
  pages.push(other);
  const f = numberCandidate(other, '売上高営業利益率', 10, period);
  f.unit = '%';
  f.semantics.metricKind = 'rate';
  f.semantics.subject = '株式会社B';
  f.semantics.scope = f.semantics.basis = null;
  let good = reviewCandidates(
    candidateResponse([...amounts, f], pages, 'earnings'),
    'earnings',
    pages
  );
  expect(good.unverified).toEqual([]);
  expect(() => verifyCoverage('earnings', pages, good.facts)).not.toThrow();
  pages.push(textPage(`1. ${period} 経営成績\n${period}の売上高営業利益率は10%です。`, 3));
  good = reviewCandidates(candidateResponse([...amounts, f], pages, 'earnings'), 'earnings', pages);
  expect(() => verifyCoverage('earnings', pages, good.facts)).toThrow('当年営業利益率');
  const own = numberCandidate(pages[2], '売上高営業利益率', 10, period);
  own.unit = '%';
  own.semantics.metricKind = 'rate';
  const complete = reviewCandidates(
    candidateResponse([...amounts, f, own], pages, 'earnings'),
    'earnings',
    pages
  );
  expect(() => verifyCoverage('earnings', pages, complete.facts)).not.toThrow();
  expect(saved(complete.facts, pages, 'earnings', true).facts).toEqual(complete.facts);
});

it.each([
  [
    '2027年1月1日に、吸収分割契約（以下「当該契約」といいます。）について承認を受けました。',
    'unspecified',
  ],
  ['2027年1月1日に契約を締結しました。', 'contracted'],
] as const)('日付状態は契約への言及ではなく対応する述語で証明する: %s', (body, state) => {
  expect(datedStates(body)).toEqual([{ date: '2027年1月1日', state }]);
  const pages = [textPage(`会社名 株式会社テスト\n1. 取引概要\n${body}`)];
  const f = assertion(pages[0], body, state);
  const good = reviewCandidates(candidateResponse([f], pages), 'other', pages);
  expect(good.unverified).toEqual([]);
  expect(saved(good.facts, pages).facts).toEqual(good.facts);
});

describe('報告単位に属する必須項目と修復先', () => {
  it.each(['scope', 'basis'] as const)(
    '同じ発行者の%s違いは実績・率・予想・EPSを代替しない',
    async (role) => {
      const { pages, amounts } = report('1株当たり当期純利益');
      const target = '2028年3月期';
      const metrics = ['売上高', '営業利益', '当期純利益'];
      const body = (fy: string) => metrics.map((m) => `${fy}の${m}は100百万円です。`).join('\n');
      pages.push(textPage(`1. ${period} 経営成績\n${period}の売上高営業利益率は10%です。`, 2));
      pages.push(
        textPage(
          `1. ${target} 業績予想\n${body(target)}\n${target}の1株当たり当期純利益は100円です。`,
          3
        )
      );
      const local = textPage(
        `1. ${period} ${role === 'scope' ? '個別' : '連結'}経営成績\n${role === 'scope' ? '範囲 個別' : '範囲 連結\n会計基準 IFRS'}\n${body(period)}\n${period}の売上高営業利益率は10%です。\n2. ${target} 業績予想\n${role === 'scope' ? '範囲 個別' : '会計基準 IFRS'}\n${body(target)}\n${target}の1株当たり当期純利益は100円です。`,
        4
      );
      pages.push(local);
      const create = (page: typeof local, metric: string, fy: string, forecast = false) => {
        const f = numberCandidate(page, metric, metric.includes('率') ? 10 : 100, fy);
        // The local page contains both FYs; choose the corresponding whole source.
        if (page === local) {
          const block = local.blocks.find((b) => b.text.includes(fy + 'の' + metric))!;
          if (f.evidence.kind === 'prose') f.evidence.blockId = block.id;
          f.quote = block.text;
          f.semantics[role] = role === 'scope' ? '個別' : 'IFRS';
        }
        if (metric.includes('率')) {
          f.unit = '%';
          f.semantics.metricKind = 'rate';
        }
        if (metric.includes('株当たり')) {
          f.unit = '円';
          f.semantics.metricKind = 'perShare';
        }
        if (forecast) f.valueKind = f.semantics.state = 'forecast';
        return f;
      };
      const locals = [
        ...metrics.map((m) => create(local, m, period)),
        create(local, '売上高営業利益率', period),
        ...[...metrics, '1株当たり当期純利益'].map((m) => create(local, m, target, true)),
      ];
      const raw = candidateResponse(locals, pages, 'earnings');
      const reviewed = reviewCandidates(raw, 'earnings', pages);
      expect(reviewed.unverified).toEqual([]);
      expect(reviewed.facts).toHaveLength(8);
      expect(saved(reviewed.facts, pages).facts).toEqual(reviewed.facts);
      const missing = coverageReport('earnings', pages, reviewed.facts).filter(
        (s) => s.status !== 'satisfied'
      );
      expect(missing).toHaveLength(8);
      expect(
        missing.every(
          (s) => s.expected.period && s.expected.scope === '連結' && s.expected.basis === '日本基準'
        )
      ).toBe(true);
      expect(() => saved(reviewed.facts, pages, 'earnings', true)).toThrow('COVERAGE');
      const required = [
        ...amounts,
        create(pages[1], '売上高営業利益率', period),
        ...[...metrics, '1株当たり当期純利益'].map((m) => create(pages[2], m, target, true)),
      ];
      vi.mocked(generateText)
        .mockReset()
        .mockResolvedValueOnce(raw)
        .mockResolvedValueOnce(candidateResponse(required, pages, 'earnings'));
      const result = await generateVerifiedFactSummary(config, 'earnings', 'source', pages);
      expect(result.repairAttempted).toBe(true);
      expect(saved(result.facts.facts, pages, 'earnings', true).facts).toEqual(result.facts.facts);
    }
  );
  it('局所予想欄が宣言する個別・IFRSの義務は表紙連結へ上書きしない', () => {
    const { pages, amounts } = report();
    const target = '2028年3月期';
    pages.push(
      textPage(
        `1. ${target} 業績予想\n範囲 個別\n会計基準 IFRS\n${['売上高', '営業利益', '当期純利益'].map((m) => `${target}の${m}は100百万円です。`).join('\n')}`,
        2
      )
    );
    const forecasts = ['売上高', '営業利益', '当期純利益'].map((m) => {
      const f = numberCandidate(pages[1], m, 100, target);
      Object.assign(f.semantics, { scope: '個別', basis: 'IFRS', state: 'forecast' });
      f.valueKind = 'forecast';
      return f;
    });
    const good = reviewCandidates(
      candidateResponse([...amounts, ...forecasts], pages, 'earnings'),
      'earnings',
      pages
    );
    expect(good.unverified).toEqual([]);
    expect(() => verifyCoverage('earnings', pages, good.facts)).not.toThrow();
    expect(saved(good.facts, pages, 'earnings', true).facts).toEqual(good.facts);
  });
  it.each([false, true])('予想修復先は選択期の表だけを保持する（先行宣言の省略=%s）', (omitted) => {
    const { pages } = report();
    const target = '2028年3月期';
    for (const [i, fy] of [target, '2029年3月期', target + '第1四半期', target].entries()) {
      pages.push(
        cells(
          [
            ...(i === 3
              ? [['会社名 株式会社他社', 0, 0, 220] as [string, number, number, number]]
              : []),
            [`1. ${fy} 業績予想`, 0, 20, 300],
            ['売上高', 350, 50, 80],
            ['営業利益', 540, 50, 80],
            ['百万円', 350, 80, 60],
            ['百万円', 540, 80, 60],
            [fy + '(予想)', 0, 110, 300],
            ['100', 350, 110, 30],
            ['20', 540, 110, 30],
          ],
          i + 2
        )
      );
    }
    if (omitted) pages[1].selection = 'omitted';
    const required = omitted ? '2029年3月期' : target;
    const slots = coverageReport('earnings', pages, []);
    const slot = slots.find((s) => s.requirement === 'COVERAGE:通期予想の重要指標 revenue')!;
    expect(slot.expected).toMatchObject({
      period: required,
      periodKind: 'fullYear',
      subject: '株式会社テスト',
      scope: '連結',
      basis: '日本基準',
    });
    expect(slot.sourceIds).toHaveLength(1);
    expect(slot.sourceIds[0]).toMatch(omitted ? /^p3/ : /^p2/);
  });
  it.each(['百万円', '%'])(
    '句点なし%s本文は見出しや次の原文所有者にしない',
    (unit) => {
      const { pages } = report();
      const target = '2028年3月期';
      pages.push(
        textPage(
          `1. ${target} 業績予想\n${target}の売上高は100${unit}を予想しています\n${target}の営業利益は100百万円です。`,
          2
        )
      );
      const f = numberCandidate(pages[1], '営業利益', 100, target);
      f.valueKind = f.semantics.state = 'forecast';
      const good = reviewCandidates(candidateResponse([f], pages, 'earnings'), 'earnings', pages);
      expect(good.unverified).toEqual([]);
      expect(saved(good.facts, pages).facts).toEqual(good.facts);
      const slot = coverageReport('earnings', pages, good.facts).find((s) =>
        s.requirement.includes('通期予想の重要指標 operatingProfit')
      )!;
      expect(slot.status).toBe('satisfied');
      expect(
        buildDocumentContext(pages).bindings.find(
          (b) => b.anchorId === (f.evidence.kind === 'prose' ? f.evidence.blockId : '')
        )?.sectionIds
      ).toEqual([pages[1].blocks[0].id]);
    }
  );
  it.each([
    '取り消すこととしました',
    '取り消すことを決定しました',
    '取り消すことを決議いたしました',
  ])('辞書形の取消%sは予定・予定日を候補/保存で拒否し、後続の新予定は保持する', (cancel) => {
    const body = `株式を取得する予定です。これを${cancel}。`;
    const pages = [textPage(`会社名 株式会社テスト\n1. 取得概要\n${body}`)];
    const wrong = assertion(pages[0], '株式を', 'planned');
    expect(reviewCandidates(candidateResponse([wrong], pages), 'other', pages).facts).toEqual([]);
    const normal = assertion(
      pages[0],
      '株式を',
      cancel.includes('決定') || cancel.includes('決議') ? 'decided' : 'unspecified'
    );
    const good = reviewCandidates(candidateResponse([normal], pages), 'other', pages);
    expect(good.unverified).toEqual([]);
    const corrupted = structuredClone(good.facts[0]);
    corrupted.semantics.state = 'planned';
    corrupted.id = stableFactId(corrupted);
    expect(saved([corrupted], pages).facts).toEqual([]);
    const restored = [textPage(pages[0].text + '新たに株式を取得する予定です。')];
    const next = assertion(restored[0], '株式を', 'planned');
    // A cancellation decision plus a new plan is multi-state and cannot become one planned fact.
    if (cancel.includes('決定') || cancel.includes('決議'))
      expect(
        reviewCandidates(candidateResponse([next], restored), 'other', restored).facts
      ).toEqual([]);
    else
      expect(
        reviewCandidates(candidateResponse([next], restored), 'other', restored).unverified
      ).toEqual([]);
    expect(
      datedStates(`譲渡実行日: 2027年1月1日。これを${cancel}。新たな譲渡実行日: 2027年2月1日`)
    ).toEqual([
      { date: '2027年1月1日', state: 'unspecified' },
      { date: '2027年2月1日', state: 'planned' },
    ]);
  });
});

it('自己株取得は他社の上限・条件で発行者の不足を隠さない', async () => {
  const body = (amount: boolean) =>
    `1. 取得の内容\n2027年1月1日取得予定\n取得対象株式の種類 普通株式\n${amount ? '株式の取得価額の総額は100円' : '取得する株式の総数は100株'}（上限）です。`;
  const pages = [
    textPage(`会社名 株式会社テスト\n${body(false)}`),
    textPage(body(true), 2),
    textPage(`会社名 株式会社B\n${body(true)}`, 3),
  ];
  const make = (p: (typeof pages)[number], amount: boolean, subject = '株式会社テスト') => {
    const f = numberCandidate(
      p,
      amount ? '株式の取得価額の総額' : '取得する株式の総数',
      100,
      '2027年1月1日'
    );
    f.unit = amount ? '円' : '株';
    f.valueKind = null;
    Object.assign(f.semantics, {
      subject,
      scope: '普通株式',
      basis: null,
      state: 'planned',
      metricKind: amount ? 'amount' : 'count',
      periodKind: 'eventDate',
      qualifiers: ['上限'],
    });
    return f;
  };
  const initial = [make(pages[0], false), make(pages[2], true, '株式会社B')];
  const raw = candidateResponse(initial, pages, 'shareRepurchase');
  const good = reviewCandidates(raw, 'shareRepurchase', pages);
  expect(good.unverified).toEqual([]);
  expect(() => verifyCoverage('shareRepurchase', pages, good.facts)).toThrow('amount');
  const slot = coverageReport('shareRepurchase', pages, good.facts).find((s) =>
    s.requirement.endsWith('amount')
  )!;
  expect(slot.status).toBe('absent');
  expect(slot.sourceIds.every((s) => s.startsWith('p2'))).toBe(true);
  expect(() =>
    parseFactSummary(
      JSON.stringify({
        version: 4,
        documentType: 'shareRepurchase',
        facts: good.facts,
        unverified: [],
      }),
      'shareRepurchase',
      pages,
      true
    )
  ).toThrow('amount');
  vi.mocked(generateText)
    .mockReset()
    .mockResolvedValueOnce(raw)
    .mockResolvedValueOnce(candidateResponse([make(pages[1], true)], pages, 'shareRepurchase'));
  const r = await generateVerifiedFactSummary(config, 'shareRepurchase', 'source', pages);
  expect(r.repairAttempted).toBe(true);
  expect(parseFactSummary(JSON.stringify(r.facts), 'shareRepurchase', pages, true)).toEqual(
    r.facts
  );
});

it.each([
  ['従業員数', '2026年3月期', period],
  ['当期純利益', '2026年3月期', period],
  ['従業員数', '2027年3月期', '2027年12月期'],
  ['従業員数', '2027年3月期通期', '2027年12月期通期'],
] as const)(
  'M&Aの継続表は証明した%s行に応じて義務・修復先を作る',
  async (secondRow, oldPeriod, latestPeriod) => {
    const pages = [
      cells(
        [
          ['会社名 株式会社テスト', 0, 0, 210],
          ['1. 株式取得', 0, 30, 160],
          ['当社は株式を取得する予定です。', 0, 60, 300],
          ['2. 対象会社の概要', 0, 90, 220],
          ['会社名 株式会社B', 0, 110, 210],
          ['(1) 経営成績', 0, 150, 160],
          [oldPeriod, 280, 180, 140],
          [latestPeriod, 480, 180, 140],
          ['売上高', 0, 210, 100],
          ['100千円', 340, 210, 80],
          ['200千円', 540, 210, 80],
        ],
        1
      ),
      cells(
        [
          ['営業利益', 0, 20, 100],
          ['10千円', 340, 20, 80],
          ['20千円', 540, 20, 80],
          [secondRow, 0, 50, 100],
          [secondRow === '従業員数' ? '10人' : '10千円', 340, 50, 80],
          [secondRow === '従業員数' ? '20人' : '20千円', 540, 50, 80],
        ],
        2
      ),
    ];
    const ctx = buildDocumentContext(pages);
    const slots = coverageReport('ma', pages, []);
    const metrics = slots.filter((s) => s.requirement.includes('対象会社の最近'));
    expect(
      metrics.map((s) => s.requirement.match(/revenue|operatingProfit|netProfit/)![0]).sort()
    ).toEqual(
      (secondRow === '従業員数'
        ? ['revenue', 'operatingProfit']
        : ['revenue', 'operatingProfit', 'netProfit']
      ).sort()
    );
    expect(metrics.every((s) => s.sourceIds.length === 1)).toBe(true);
    expect(metrics.every((s) => s.requirement.includes(`対象期=${latestPeriod}`))).toBe(true);
    expect(metrics.every((s) => s.expected.period === latestPeriod)).toBe(true);
    const fs = metrics.flatMap((s) =>
      s.sourceIds.map((id) => {
        const hint = ctx.tableMappings.find((h) => h.valueId === id)!;
        const label = hint.metricIds
          .map((id) => pages.flatMap((p) => p.spans).find((span) => span.id === id)!.text)
          .join('');
        const f = numberCandidate(
          textPage('会社名 株式会社テスト\n1. 経営成績\n売上高は200千円です。'),
          '売上高',
          label === '売上高' ? 200 : 20,
          // Equivalent full-year spelling must keep ordinary source meaning.
          latestPeriod.replace(/通期$/, '')
        );
        f.label = label;
        f.page = Number(id.match(/^p(\d+)/)![1]);
        f.unit = '千円';
        f.semantics.subject = '株式会社B';
        f.semantics.scope = f.semantics.basis = null;
        f.evidence = { kind: 'table', ...hint, scopeIds: [], qualifierIds: [] };
        return f;
      })
    );
    const good = reviewCandidates(candidateResponse(fs, pages, 'ma'), 'ma', pages);
    expect(good.unverified).toEqual([]);
    expect(() => verifyCoverage('ma', pages, good.facts)).not.toThrow();
    expect(
      parseFactSummary(
        JSON.stringify({ version: 4, documentType: 'ma', facts: good.facts, unverified: [] }),
        'ma',
        pages,
        true
      ).facts
    ).toEqual(good.facts);
    expect(() =>
      verifyCoverage(
        'ma',
        pages,
        good.facts.filter((f) => f.label !== '営業利益')
      )
    ).toThrow('operatingProfit');
    vi.mocked(generateText)
      .mockReset()
      .mockResolvedValueOnce(
        candidateResponse(
          fs.filter((f) => f.label !== '営業利益'),
          pages,
          'ma'
        )
      )
      .mockResolvedValueOnce(
        candidateResponse(
          fs.filter((f) => f.label === '営業利益'),
          pages,
          'ma'
        )
      );
    const repaired = await generateVerifiedFactSummary(config, 'ma', 'source', pages);
    expect(repaired.repairAttempted).toBe(true);
    expect(parseFactSummary(JSON.stringify(repaired.facts), 'ma', pages, true)).toEqual(repaired.facts);
  }
);

it('月次の同月他社値は発行者の義務を満たさない', async () => {
  const month = '2027年1月';
  const pages = [
    textPage(`会社名 株式会社テスト\n1. ${month}月次実績\n${month}の売上高は100百万円です。`),
    textPage(
      `会社名 株式会社B\n1. ${month}月次実績\n${month}の売上高は200百万円（速報値）です。`,
      2
    ),
  ];
  const fs = pages.map((p, i) => {
    const f = numberCandidate(p, '売上高', i ? 200 : 100, month);
    Object.assign(f.semantics, {
      subject: i ? '株式会社B' : '株式会社テスト',
      scope: null,
      basis: null,
      periodKind: 'month',
    });
    return f;
  });
  const raw = candidateResponse([fs[1]], pages, 'businessUpdate');
  const r = reviewCandidates(raw, 'businessUpdate', pages);
  expect(r.unverified).toEqual([]);
  expect(() => verifyCoverage('businessUpdate', pages, r.facts)).toThrow('報告対象月');
  expect(
    coverageReport('businessUpdate', pages, r.facts).some((s) => s.requirement.includes('速報値'))
  ).toBe(false);
  vi.mocked(generateText)
    .mockReset()
    .mockResolvedValueOnce(raw)
    .mockResolvedValueOnce(candidateResponse([fs[0]], pages, 'businessUpdate'));
  const repaired = await generateVerifiedFactSummary(config, 'businessUpdate', 'source', pages);
  expect(parseFactSummary(JSON.stringify(repaired.facts), 'businessUpdate', pages, true)).toEqual(
    repaired.facts
  );
});

it.each(['scope', 'basis'] as const)(
  '予想修正の%s違いと他年度を義務/修復先で区別する',
  async (role) => {
    const target = '2028年3月期';
    const table = (n: number, fy: string, local = false) =>
      cells(
        [
          ...(n === 1
            ? [['会社名 株式会社テスト', 0, 0, 220] as [string, number, number, number]]
            : []),
          [`1. ${fy}${local && role === 'scope' ? '個別' : '連結'}業績予想の修正`, 0, 30, 400],
          [`会計基準 ${local && role === 'basis' ? 'IFRS' : '日本基準'}`, 0, 60, 180],
          ['売上高', 300, 90, 80],
          ['営業利益', 500, 90, 80],
          ['百万円', 310, 120, 60],
          ['百万円', 510, 120, 60],
          ['前回予想', 0, 150, 100],
          ['100', 310, 150, 30],
          ['10', 510, 150, 30],
          ['今回予想', 0, 180, 100],
          ['200', 310, 180, 30],
          ['20', 510, 180, 30],
        ],
        n
      );
    const pages = [table(1, target), table(2, target, true), table(3, '2029年3月期')];
    const context = buildDocumentContext(pages);
    const facts = context.tableMappings.map((h) => {
      const p = pages.find((p) => p.quantities.some((q) => q.id === h.valueId))!;
      const text = (ids: string[]) =>
        ids.map((id) => p.spans.find((s) => s.id === id)!.text).join('');
      const f = numberCandidate(
        textPage('会社名 株式会社テスト\n1. 経営成績\n売上高は100百万円です。'),
        '売上高',
        Number(p.quantities.find((q) => q.id === h.valueId)!.text),
        p.pageNumber === 3 ? '2029年3月期' : target
      );
      f.page = p.pageNumber;
      f.label = text(h.metricIds);
      f.evidence = { kind: 'table', ...h, scopeIds: [], qualifierIds: [] };
      f.valueKind = f.semantics.state =
        text(h.periodIds) === '前回予想' ? 'forecastBefore' : 'forecastAfter';
      f.semantics.scope = p.pageNumber === 2 && role === 'scope' ? '個別' : '連結';
      f.semantics.basis = p.pageNumber === 2 && role === 'basis' ? 'IFRS' : '日本基準';
      return f;
    });
    const raw = candidateResponse(
      facts.filter((f) => f.page !== 1),
      pages,
      'earningsRevision'
    );
    const r = reviewCandidates(raw, 'earningsRevision', pages);
    expect(r.unverified).toEqual([]);
    expect(() => verifyCoverage('earningsRevision', pages, r.facts)).toThrow('予想修正の前後');
    const slots = coverageReport('earningsRevision', pages, r.facts);
    expect(slots).toHaveLength(4);
    expect(
      slots.every(
        (s) =>
          s.sourceIds.length === 1 &&
          s.sourceIds[0].startsWith('p1') &&
          s.expected.period === target
      )
    ).toBe(true);
    vi.mocked(generateText)
      .mockReset()
      .mockResolvedValueOnce(raw)
      .mockResolvedValueOnce(
        candidateResponse(
          facts.filter((f) => f.page === 1),
          pages,
          'earningsRevision'
        )
      );
    const fixed = await generateVerifiedFactSummary(config, 'earningsRevision', 'source', pages);
    expect(fixed.repairAttempted).toBe(true);
    expect(parseFactSummary(JSON.stringify(fixed.facts), 'earningsRevision', pages, true)).toEqual(
      fixed.facts
    );
  }
);
