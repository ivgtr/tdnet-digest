import { describe, expect, it, vi } from 'vitest';
import { textPage, numberCandidate } from './fixtures/v4-test-source';
import { evidence, saved, report, event, cells, period } from './fixtures/fact-review-source';
import { candidateResponse } from './fixtures/candidate-test-source';
import { buildDocumentContext } from './document-context';
import { proseQuantities, reviewCandidates } from './fact-candidates';
import { generateVerifiedFactSummary, renderFacts } from './fact-summary';
import { verifyCoverage, coverageReport } from './fact-coverage';
import { stableFactId } from './fact-contract';
import { validateSavedFacts } from './fact-cache';
import { verifyTableEvidence } from './numeric-evidence';
import { generateText } from './llm-client';
vi.mock('./llm-client', () => ({ generateText: vi.fn() }));
const config = { provider: 'openai', model: 'fixture', apiKey: 'fixture' };

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
  it.each(['第2四半期', '第3四半期', '中間期'])(
    '累計の期間表記で利益率を欠落・再修復扱いにしない: %s',
    async (quarter) => {
      const target = period + quarter + '累計';
      const pages = [
        textPage(`${period} ${quarter}決算短信〔日本基準〕（連結）\n会社名 株式会社テスト`),
        textPage(
          `1. ${target} 経営成績\n売上高は100百万円です。\n営業利益は100百万円です。\n当期純利益は100百万円です。\n売上高営業利益率は10%です。`,
          2
        ),
      ];
      const fs = ['売上高', '営業利益', '当期純利益', '売上高営業利益率'].map((m) => {
        const f = numberCandidate(pages[1], m, m.includes('率') ? 10 : 100, target);
        f.semantics.periodKind = quarter === '第3四半期' ? 'cumulativeQ3' : 'cumulativeQ2';
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
