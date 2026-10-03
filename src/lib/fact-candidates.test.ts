import { describe, it, expect, vi } from 'vitest';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';
import corpus from './fixtures/ir-semantic-corpus.json';
import expectations from './fixtures/ir-semantic-expectations.json';
import { extractPageLayout } from './pdf-layout';
import { textPage, numberCandidate } from './fixtures/v4-test-source';
import { candidateFixture, candidateResponse } from './fixtures/candidate-test-source';
import { reviewCandidates, serializeCandidateSource, type Candidate } from './fact-candidates';
import { generateVerifiedFactSummary, parseFactSummary, renderFacts } from './fact-summary';
import { generateText } from './llm-client';
import { verifyCoverage, coverageReport } from './fact-coverage';
import { buildDocumentContext, bindingFor, applicableDeclarations } from './document-context';
import { assertionStates, verifyAssertionState } from './assertion-semantics';
import { stableFactId } from './fact-contract';
import type { VerifiedFact } from './fact-contract';
vi.mock('./llm-client', () => ({ generateText: vi.fn() }));
const pages = corpus[0].pages.map((p) => extractPageLayout(p.items as TextItem[], p.pageNumber));
const fixture = expectations[0].facts as unknown as VerifiedFact[];
const candidates = fixture.map((f, i) => candidateFixture(f, pages, `c${i + 1}`));
const raw = (cs: Candidate[], extra: object = {}) =>
  JSON.stringify({
    candidateVersion: 3,
    documentType: 'earnings',
    candidates: cs,
    unverified: [],
    ...extra,
  });
const review = (cs: Candidate[]) => reviewCandidates(raw(cs), 'earnings', pages);
const config = { provider: 'openai', model: 'fixture', apiKey: 'fixture' };
const qReportingCases = [
  ['2026年3月期 1Q決算短信〔日本基準〕（連結）', '2026年3月期', '連結', '日本基準'],
  ['2026年8月期 2Q決算短信〔日本基準〕（連結）', '2026年8月期', '連結', '日本基準'],
  ['2026年12月期 3Q決算短信〔IFRS〕（連結）', '2026年12月期', '連結', 'IFRS'],
  ['2026年3月期 4Q決算短信〔日本基準〕（非連結）', '2026年3月期', '非連結', '日本基準'],
  ['２Ｑ決算短信〔IFRS〕（個別）', '2026年3月期', '個別', 'IFRS'],
  ['2026年8月期 2q決算短信〔日本基準〕（連結）', '2026年8月期', '連結', '日本基準'],
  ['３ｑ決算短信〔IFRS〕（個別）', '2026年3月期', '個別', 'IFRS'],
  ['2026年3月期 第3四半期決算短信〔日本基準〕（単体）', '2026年3月期', '単体', '日本基準'],
  ['第3四半期決算短信〔日本基準〕（単体）', '2026年3月期', '単体', '日本基準'],
  [
    '2026年12月期 第2四半期決算短信〔国際会計基準〕（連結）',
    '2026年12月期',
    '連結',
    '国際会計基準',
  ],
  ['2026年12月期 第3四半期決算短信〔米国基準〕（連結）', '2026年12月期', '連結', '米国基準'],
  ['第2四半期（中間期）決算短信[国際会計基準]（単体）', '2026年3月期', '単体', '国際会計基準'],
  ['4q決算短信[ifrs]（単体）', '2026年3月期', '単体', 'ifrs'],
] as const;
function qReportingFixture(testCase: readonly [string, string, string | null, string | null]) {
  const [caption, period, scope, basis] = testCase;
  const source = [
    textPage(`${caption}\n会社名 株式会社テスト`),
    textPage(`1. ${period} 財政状態\n${period}の総資産は100百万円となる見込みです。`, 2),
  ];
  const fact = numberCandidate(source[1], '総資産', 100, period);
  fact.semantics = {
    ...fact.semantics,
    scope,
    basis,
    state: 'forecast',
  };
  fact.valueKind = 'forecast';
  return { source, fact };
}
describe('生成専用候補と原文文脈の契約', () => {
  it.each([
    { title: '2026年3月期 中間決算短信〔日本基準〕（個別）' },
    { title: '2026年3月期 決算短信〔IFRS〕（連結）' },
    { title: '四半期決算短信の補足説明資料' },
    { title: '2026年3月期 決算短信の一部訂正について' },
  ])('中間期・通期・省略・訂正の報告属性を原文で確定・保存再照合する: $title', ({ title }) => {
    const period = title.match(/20\d{2}年\d{1,2}月期/)?.[0] ?? '2026年3月期';
    const scope = title.match(/（(非連結|個別|単体|連結)）/)?.[1] ?? null;
    const basis = title.match(/〔([^〕]+)〕/)?.[1] ?? null;
    const { source, fact } = qReportingFixture([title, period, scope, basis]);
    const result = reviewCandidates(candidateResponse([fact], source), 'other', source);
    expect(result.unverified).toEqual([]);
    expect(result.facts).toHaveLength(1);
    expect(result.facts[0].semantics).toEqual(fact.semantics);
    expect(
      parseFactSummary(
        JSON.stringify({
          version: 5,
          documentType: 'other',
          facts: result.facts,
          unverified: [],
        }),
        'other',
        source
      ).facts
    ).toEqual(result.facts);
  });
  it.each([
    ['単体', '国際会計基準'],
    ['非連結', '米国基準'],
    ['単体', 'ifrs'],
  ])('独立した属性欄でも原文の範囲・基準を保持する: %s / %s', (scope, basis) => {
    const { source, fact } = qReportingFixture(['決算短信', '2026年3月期', scope, basis]);
    source[1] = textPage(
      `1. 2026年3月期 財政状態\n（${scope}）\n${basis}\n2026年3月期の総資産は100百万円となる見込みです。`,
      2
    );
    const candidate = numberCandidate(source[1], '総資産');
    candidate.semantics = fact.semantics;
    candidate.valueKind = fact.valueKind;
    const result = reviewCandidates(candidateResponse([candidate], source), 'other', source);
    expect(result.unverified).toEqual([]);
    expect(result.facts).toHaveLength(1);
    expect(result.facts[0].semantics).toEqual(fact.semantics);
    const wrong = { ...candidate, semantics: { ...candidate.semantics, scope: null, basis: null } };
    expect(reviewCandidates(candidateResponse([wrong], source), 'other', source).facts).toEqual([]);
  });
  it('表紙に複数の範囲・基準がある場合は最初の値へ補完せず曖昧として拒否する', () => {
    const { source, fact } = qReportingFixture([
      '2026年3月期 2q決算短信〔日本基準〕〔米国基準〕（連結）（単体）',
      '2026年3月期',
      '連結',
      '日本基準',
    ]);
    const result = reviewCandidates(candidateResponse([fact], source), 'other', source);
    expect(result.facts).toEqual([]);
    for (const role of ['scope', 'basis'])
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({
          check: `scope.${role}`,
          status: 'blocked',
          message: expect.stringContaining('曖昧'),
        })
      );
  });
  it.each(qReportingCases)('Q表記の表紙属性を別ページの通期予想へ保持する: %s', (...testCase) => {
    const { source, fact } = qReportingFixture(testCase);
    const result = reviewCandidates(candidateResponse([fact], source), 'other', source);
    expect(result.unverified).toEqual([]);
    expect(result.facts).toHaveLength(1);
    expect(result.facts[0].semantics).toEqual(fact.semantics);
    expect(
      parseFactSummary(
        JSON.stringify({ version: 5, documentType: 'other', facts: result.facts, unverified: [] }),
        'other',
        source
      ).facts
    ).toEqual(result.facts);
  });
  // 表記別の属性解決は上の正常matrix。属性の改変はその共通の照合経路で確認する。
  it.each([qReportingCases[4]])(
    'Q表記の明示属性を省略・変更した候補と保存事実を拒否する: %s',
    (...testCase) => {
      const { source, fact } = qReportingFixture(testCase);
      for (const attributes of [
        { scope: null, basis: null },
        { scope: fact.semantics.scope, basis: null },
        { scope: null, basis: fact.semantics.basis },
        { scope: fact.semantics.scope === '個別' ? '連結' : '個別', basis: fact.semantics.basis },
        {
          scope: fact.semantics.scope,
          basis: fact.semantics.basis === 'IFRS' ? '日本基準' : 'IFRS',
        },
      ]) {
        const wrong = { ...fact, semantics: { ...fact.semantics, ...attributes } };
        expect(reviewCandidates(candidateResponse([wrong], source), 'other', source).facts).toEqual(
          []
        );
        const altered = {
          ...reviewCandidates(candidateResponse([fact], source), 'other', source).facts[0],
          semantics: wrong.semantics,
        };
        altered.id = stableFactId(altered);
        expect(
          parseFactSummary(
            JSON.stringify({ version: 5, documentType: 'other', facts: [altered], unverified: [] }),
            'other',
            source,
            false
          ).facts
        ).toEqual([]);
      }
    }
  );
  it.each(['0Q決算短信', '5Q決算短信', '2Q個別契約の締結', '3QのIFRS対応の方針'])(
    '未知の四半期・通常表題をQ決算表紙へ読み替えない: %s',
    (caption) => {
      const source = [
        textPage(
          `${caption}〔日本基準〕（連結）\n会社名 株式会社テスト\n当社は契約を締結しました。`
        ),
      ];
      const graph = buildDocumentContext(source);
      expect(
        bindingFor(graph, source[0].blocks[2].id).declarations.filter(
          (d) => d.origin === 'document' && d.role !== 'subject'
        )
      ).toEqual([]);
    }
  );
  it('Q表紙の属性は非財務事実と別会社に適用せず、同じ節の明示欄を優先する', () => {
    const { source } = qReportingFixture(qReportingCases[1]);
    source.push(
      textPage('1. 契約の締結\n当社は契約を締結しました。', 3),
      textPage(
        '会社名 株式会社別会社\n1. 2026年8月期 財政状態\n2026年8月期の総資産は200百万円です。',
        4
      ),
      textPage(
        '1. 2026年8月期 財政状態\n範囲 個別\n会計基準 IFRS\n2026年8月期の総資産は300百万円です。',
        5
      )
    );
    const graph = buildDocumentContext(source);
    for (const [page, financial] of [
      [source[2], false],
      [source[3], true],
    ] as const) {
      const binding = bindingFor(graph, page.blocks[page.blocks.length - 1].id);
      expect(applicableDeclarations(binding, 'scope', financial)).toEqual([]);
      expect(applicableDeclarations(binding, 'basis', financial)).toEqual([]);
    }
    const local = bindingFor(graph, source[4].blocks[source[4].blocks.length - 1].id);
    expect(applicableDeclarations(local, 'scope', true).map((d) => d.value)).toEqual(['個別']);
    expect(applicableDeclarations(local, 'basis', true).map((d) => d.value)).toEqual(['IFRS']);
  });
  it.each([qReportingCases[1], qReportingCases[12]])(
    '表紙の属性省略を1回修復し、原文表記の予想を表示・保存再照合する: %s',
    async (...testCase) => {
      const { source, fact } = qReportingFixture(testCase);
      const wrong = { ...fact, semantics: { ...fact.semantics, scope: null, basis: null } };
      vi.mocked(generateText)
        .mockReset()
        .mockResolvedValueOnce(candidateResponse([wrong], source))
        .mockResolvedValueOnce(candidateResponse([fact], source));
      const result = await generateVerifiedFactSummary(config, 'other', 'source', source);
      expect(result.repairAttempted).toBe(true);
      expect(vi.mocked(generateText)).toHaveBeenCalledTimes(2);
      expect(result.facts.facts).toHaveLength(1);
      expect(result.facts.facts[0].semantics).toEqual(fact.semantics);
      expect(renderFacts(result.facts)).toContain(
        `${fact.semantics.scope}、${fact.semantics.basis}、予想`
      );
      expect(parseFactSummary(JSON.stringify(result.facts), 'other', source).facts).toEqual(
        result.facts.facts
      );
    }
  );
  it.each([0, 1, 2, 3, 4, 5])('原文構造から資料%iの完全な表対応を構成し確定v4を再照合する', (i) => {
    const source = corpus[i].pages.map((p) =>
      extractPageLayout(p.items as TextItem[], p.pageNumber)
    );
    const type = (
      ['earnings', 'shareRepurchase', 'businessUpdate', 'ma', 'earningsRevision', 'ma'] as const
    )[i];
    const r = reviewCandidates(
      candidateResponse(expectations[i].facts as unknown as VerifiedFact[], source, type),
      type,
      source
    );
    expect(r.unverified).toEqual([]);
    expect(r.facts).toHaveLength(expectations[i].facts.length);
    expect(
      parseFactSummary(
        JSON.stringify({ version: 5, documentType: type, facts: r.facts, unverified: [] }),
        type,
        source
      )
    ).toEqual({ version: 5, documentType: type, facts: r.facts, unverified: [] });
    for (const f of r.facts.filter((f) => f.kind === 'number')) {
      expect(f.quantity?.sourceIds.length).toBeGreaterThan(0);
      expect(
        f.quantity?.sourceIds.every((id) =>
          source.some((p) => p.sourceItems.some((s) => s.id === id))
        )
      ).toBe(true);
    }
  });
  it('表対応の親指標・期間・単位をコードが誤って結びつけても原文検証で拒否する', () => {
    for (const role of ['metricIds', 'periodIds', 'unitIds'] as const) {
      const graph = buildDocumentContext(pages);
      const mapping = graph.tableMappings.find((h) => h.valueId === 'p1s120')!;
      const other = graph.tableMappings.find((h) => h.valueId === 'p1s66')!;
      mapping[role] = role === 'metricIds' ? mapping.metricIds.slice(1) : other[role];
      expect(reviewCandidates(raw([candidates[6]]), 'earnings', pages, graph).facts).toHaveLength(
        0
      );
    }
  });
  it('未知・複数の表対応を推測せずblockedとし旧候補の参照配列も拒否する', () => {
    const graph = buildDocumentContext(pages);
    const mapping = graph.tableMappings.find(
      (h) =>
        h.valueId === (candidates[0].source.kind === 'table' ? candidates[0].source.valueId : '')
    )!;
    graph.tableMappings.push({ ...mapping, periodIds: ['p1s78', 'p1s79'] });
    let r = reviewCandidates(raw([candidates[0]]), 'earnings', pages, graph);
    expect(r.facts).toEqual([]);
    expect(r.diagnostics).toEqual([
      expect.objectContaining({ check: 'STRUCTURE', status: 'blocked' }),
    ]);
    graph.tableMappings = [];
    expect(reviewCandidates(raw([candidates[0]]), 'earnings', pages, graph).facts).toEqual([]);
    const old = structuredClone(candidates[0]);
    Object.assign(old.source, { metricIds: ['p1s54'], periodIds: ['p1s69'], unitIds: ['p1s63'] });
    r = reviewCandidates(raw([old]), 'earnings', pages);
    expect(r.diagnostics).toEqual([
      expect.objectContaining({ check: 'SCHEMA', status: 'blocked' }),
    ]);
    expect(
      reviewCandidates(raw(candidates, { candidateVersion: 1 }), 'earnings', pages).envelopeValid
    ).toBe(false);
  });
  it('別断片の親指標でも営業利益率の必須欠落を検出する', () => {
    const r = review(candidates.filter((c) => c.candidateId !== 'c7'));
    expect(() => verifyCoverage('earnings', pages, r.facts)).toThrow('営業利益率');
    expect(
      coverageReport('earnings', pages, r.facts).find((s) => s.requirement.includes('営業利益率'))
    ).toMatchObject({ status: 'absent', sourceIds: expect.arrayContaining(['p1s120']) });
  });
  it.each([
    ['2025年3月期の営業利益は100百万円、2026年3月期の営業利益は200百万円です。', '2026年3月期'],
    ['2026年3月期の営業利益は100百万円です。', '2025年3月期'],
    ['2026年3月期の営業利益は100百万円増加しました。', '2026年3月期'],
    ['2026年3月期の調整後営業利益は100百万円です。', '2026年3月期'],
    ['2026年3月期の営業利益は100百万円以上です。', '2026年3月期'],
    ['2026年3月期の営業利益は100百万円（以上）です。', '2026年3月期'],
    ['2026年3月期の営業利益は100百万円「未満」です。', '2026年3月期'],
  ])('本文数量の期間・変化量・指標限定を省いた対応を拒否する: %s', (body, period) => {
    const p = textPage(
      `会社名 株式会社テスト | 会計基準 日本基準 | 範囲 連結\n2025年3月期 連結経営成績\n${body}`
    );
    const result = reviewCandidates(
      candidateResponse([numberCandidate(p, '営業利益', 100, period)], [p]),
      'other',
      [p]
    );
    expect(result.facts).toEqual([]);
    expect(result.diagnostics.some((d) => d.status !== 'valid')).toBe(true);
  });
  it('本文の一意な当年数量と完全な調整後指標を保持し、複数年度・反復指標は未確認とする', () => {
    const p = textPage(
      '会社名 株式会社テスト | 会計基準 日本基準 | 範囲 連結\n2025年3月期 連結経営成績\n2026年3月期の調整後営業利益は100百万円です。'
    );
    const f = numberCandidate(p, '調整後営業利益', 100, '2026年3月期');
    const result = reviewCandidates(candidateResponse([f], [p]), 'other', [p]);
    expect(result.facts).toHaveLength(1);
    expect(result.facts[0]).toMatchObject({
      label: '調整後営業利益',
      period: '2026年3月期',
      value: 100,
    });
    expect(
      parseFactSummary(
        JSON.stringify({ version: 5, documentType: 'other', facts: result.facts, unverified: [] }),
        'other',
        [p]
      ).facts
    ).toEqual(result.facts);
    for (const change of [{ label: '営業利益' }, { period: '2025年3月期' }]) {
      const altered = { ...result.facts[0], ...change };
      altered.id = stableFactId(altered);
      expect(
        parseFactSummary(
          JSON.stringify({ version: 5, documentType: 'other', facts: [altered], unverified: [] }),
          'other',
          [p],
          false
        ).facts
      ).toEqual([]);
    }
    const ambiguous = textPage(
      '会社名 株式会社テスト | 会計基準 日本基準 | 範囲 連結\n2026年3月期 連結経営成績\n2025年3月期の営業利益は100百万円、2026年3月期の営業利益は200百万円です。'
    );
    const r = reviewCandidates(
      candidateResponse([numberCandidate(ambiguous, '営業利益', 200, '2026年3月期')], [ambiguous]),
      'other',
      [ambiguous]
    );
    expect(r.facts).toEqual([]);
    expect(r.diagnostics).toContainEqual(expect.objectContaining({ status: 'blocked' }));
  });
  it('省略ページだけの営業利益率を選択ページの必須へ混入しない', () => {
    const selected = textPage(
      '2026年3月期 決算短信〔日本基準〕（連結）\n上場会社名 株式会社BlueMeme | 会計基準 日本基準 | 範囲 連結\n' +
        '2026年3月期の売上高は100百万円です。\n' +
        '2026年3月期の営業利益は20百万円です。\n' +
        '2026年3月期の当期純利益は10百万円です。'
    );
    const omitted = {
      ...extractPageLayout(corpus[0].pages[0].items as TextItem[], 2),
      selection: 'omitted' as const,
    };
    const source = [selected, omitted];
    const expected = [
      ['売上高', 100],
      ['営業利益', 20],
      ['当期純利益', 10],
    ].map(([label, value]) => {
      const f = numberCandidate(selected, String(label), Number(value));
      f.semantics.subject = '株式会社BlueMeme';
      return f;
    });
    const r = reviewCandidates(candidateResponse(expected, source, 'earnings'), 'earnings', source);
    expect(r.unverified).toEqual([]);
    expect(r.facts).toHaveLength(3);
    expect(() => verifyCoverage('earnings', source, r.facts)).not.toThrow();
    expect(
      coverageReport('earnings', source, r.facts).find((s) => s.requirement.includes('営業利益率'))
    ).toMatchObject({ status: 'outsideSelection' });
    const wrong = candidateFixture(fixture[6], pages);
    if (wrong.source.kind !== 'table') throw new Error('table fixture expected');
    wrong.source.valueId = wrong.source.valueId.replace('p1', 'p2');
    wrong.source.contextBindingId = `ctx:${wrong.source.valueId}`;
    expect(reviewCandidates(raw([wrong]), 'earnings', source).unverified.join(' ')).toContain(
      '未選択ページ'
    );
  });
  const buybackSource = (countLabel = '取得する株式の総数') => [
    textPage(
      '会社名 株式会社テスト\n１．経営成績\n2026年3月期 実績\n' +
        Array.from({ length: 19 }, (_, i) => `科目${i + 1}は${100 + i}百万円です。`).join('\n')
    ),
    textPage(
      `１．取得する株式\n2026年7月15日取得予定\n取得対象株式の種類 普通株式\n${countLabel}は200,000株（上限）です。`,
      2
    ),
    textPage(
      '２．取得する株式\n2026年7月15日取得予定\n取得対象株式の種類 普通株式\n株式の取得価額の総額は206,200,000円（上限）です。',
      3
    ),
  ];
  const buybackFacts = (
    source: ReturnType<typeof buybackSource>,
    countLabel = '取得する株式の総数'
  ) =>
    [
      [source[1], countLabel, 200000, '株', 'count'],
      [source[2], '株式の取得価額の総額', 206200000, '円', 'amount'],
    ].map(([page, label, value, unit, metric]) => {
      const f = numberCandidate(
        page as (typeof source)[number],
        String(label),
        Number(value),
        '2026年7月15日'
      );
      f.unit = String(unit);
      f.valueKind = null;
      Object.assign(f.semantics, {
        scope: '普通株式',
        basis: null,
        state: 'planned',
        metricKind: metric,
        periodKind: 'eventDate',
        qualifiers: ['上限'],
      });
      return f;
    });
  it.each(['detail', 'key'] as const)(
    '上限20件の補足が%sでも必須のdetailを保持し修復する',
    async (importance) => {
      const source = buybackSource();
      const initial = Array.from({ length: 19 }, (_, i) => {
        const f = numberCandidate(source[0], `科目${i + 1}`, 100 + i);
        f.importance = i === 0 ? 'key' : importance;
        f.semantics.scope = f.semantics.basis = null;
        return f;
      });
      const [count, amount] = buybackFacts(source);
      count.importance = 'detail';
      initial.push(count);
      const first = reviewCandidates(
        candidateResponse(initial, source, 'shareRepurchase'),
        'shareRepurchase',
        source
      );
      expect(first.facts).toHaveLength(20);
      const countId = first.facts.find((f) => f.semantics.metricKind === 'count')!.id;
      vi.mocked(generateText)
        .mockReset()
        .mockResolvedValueOnce(candidateResponse(initial, source, 'shareRepurchase'))
        .mockResolvedValueOnce(candidateResponse([amount], source, 'shareRepurchase'));
      const attempts: Array<{
        slots?: ReturnType<typeof coverageReport>;
        confirmedIds?: string[];
      }> = [];
      const result = await generateVerifiedFactSummary(
        config,
        'shareRepurchase',
        'source',
        source,
        (a) => {
          attempts.push(a);
        }
      );
      expect(result.facts.facts).toHaveLength(20);
      expect(result.facts.facts.some((f) => f.id === countId)).toBe(true);
      expect(attempts[0].confirmedIds).toContain(countId);
      expect(attempts[0].slots?.find((s) => s.requirement.endsWith('count'))?.status).toBe(
        'satisfied'
      );
      expect(attempts[1].slots?.every((s) => s.status === 'satisfied')).toBe(true);
      expect(vi.mocked(generateText)).toHaveBeenCalledTimes(2);
    }
  );
  it('根拠未解決の必須があればモデルを呼ばず上流の不足を報告する', async () => {
    const countLabel = '取得株数';
    const source = buybackSource(countLabel);
    const initial = numberCandidate(source[0], '科目1', 100);
    initial.semantics.scope = initial.semantics.basis = null;
    // Originally omitted pages must stay omitted even when narrowing is disabled.
    source.push({
      ...textPage('会社名 株式会社テスト\n営業利益は999百万円です。', 4),
      selection: 'omitted',
    });
    const slots = coverageReport('shareRepurchase', source, []);
    expect(slots.find((s) => s.requirement.endsWith('count'))).toMatchObject({
      status: 'unknown',
      sourceIds: [],
    });
    expect(slots.find((s) => s.requirement.endsWith('amount'))?.sourceIds.length).toBeGreaterThan(
      0
    );
    vi.mocked(generateText)
      .mockReset()
      .mockResolvedValueOnce(candidateResponse([initial], source, 'shareRepurchase'))
      .mockResolvedValueOnce(
        candidateResponse(buybackFacts(source, countLabel), source, 'shareRepurchase')
      );
    await expect(
      generateVerifiedFactSummary(config, 'shareRepurchase', 'source', source)
    ).rejects.toThrow('SOURCE_PREFLIGHT:');
    expect(vi.mocked(generateText)).not.toHaveBeenCalled();
  });
  it('未知の述語の状態と構造証明不能を意味の誤りと誤診断しない', () => {
    const p = textPage('会社名 株式会社テスト\n当社は新たな枠組みを策定しました。');
    const f = {
      ...fixture[9],
      quote: p.blocks[1].text,
      statement: p.blocks[1].text,
      evidence: {
        kind: 'prose' as const,
        blockId: p.blocks[1].id,
        assertionId: `${p.blocks[1].id}:a1`,
        quantityId: null,
        contextIds: [],
        scopeIds: [],
        qualifierIds: [],
      },
      semantics: {
        ...fixture[9].semantics,
        subject: '株式会社テスト',
        scope: null,
        basis: null,
        state: 'actual' as const,
      },
    };
    const r = reviewCandidates(candidateResponse([f], [p]), 'other', [p]);
    expect(r.facts).toEqual([]);
    expect(r.diagnostics.find((d) => d.check === 'state')).toMatchObject({ status: 'blocked' });
  });
  it('修復に提示していない別ページの正しい新規候補を勝手に採用しない', async () => {
    const source = [
      textPage('会社名 株式会社テスト\n2026年3月期の営業利益は100百万円です。'),
      textPage('会社名 株式会社テスト\n2026年3月期の営業利益は200百万円です。', 2),
    ];
    const facts = source.map((p, i) => {
      const f = numberCandidate(p, '営業利益', 100 + i * 100);
      f.semantics.scope = f.semantics.basis = null;
      return f;
    });
    const initial = candidateFixture(facts[0], source);
    initial.meaning.subject = '別会社';
    expect(
      reviewCandidates(candidateResponse([facts[1]], source), 'other', source).facts
    ).toHaveLength(1);
    vi.mocked(generateText)
      .mockReset()
      .mockResolvedValueOnce(
        JSON.stringify({
          candidateVersion: 3,
          documentType: 'other',
          candidates: [initial],
          unverified: [],
        })
      )
      .mockResolvedValueOnce(candidateResponse([facts[1]], source));
    await expect(generateVerifiedFactSummary(config, 'other', 'source', source)).rejects.toThrow(
      '未選択ページ'
    );
  });
  it('必須制約の未指定をnullと混同せず予定数量に取得予定日の原文役割を提示する', () => {
    const ps = corpus[1].pages.map((p) => extractPageLayout(p.items as TextItem[], p.pageNumber));
    const input = JSON.parse(serializeCandidateSource(ps, undefined, 'shareRepurchase'));
    const slots = input.obligations.filter(
      (s: { expected: { kind?: string } }) => s.expected.kind === 'number'
    );
    expect(slots).toHaveLength(2);
    for (const slot of slots)
      expect(slot.expected).toMatchObject({
        period: '2026年7月15日',
        periodKind: 'eventDate',
        state: 'planned',
      });
    for (const slot of input.obligations) expect(Object.values(slot.expected)).not.toContain(null);
    const template = input.contextTemplates.find(
      (t: { id: string }) => t.id === input.unitContexts['p1b15']
    );
    expect(template.dateOptions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ date: '2026年7月15日', state: 'planned', sourceId: 'p1b13' }),
        expect.objectContaining({ date: '2026年7月14日', state: 'reference', sourceId: 'p1b13' }),
      ])
    );
    const c = candidateFixture(expectations[1].facts[0] as unknown as VerifiedFact, ps);
    for (const period of [null, '2026年7月14日']) {
      c.meaning.period = period;
      c.meaning.periodKind = period === null ? 'none' : 'eventDate';
      expect(
        reviewCandidates(
          JSON.stringify({
            candidateVersion: 3,
            documentType: 'shareRepurchase',
            candidates: [c],
            unverified: [],
          }),
          'shareRepurchase',
          ps
        ).facts
      ).toEqual([]);
    }
  });
  it('複数の予定日が同じ数量に適用し得る場合に一方を確定しない', () => {
    const ps = [
      textPage(
        '会社名 株式会社テスト\n2026年7月15日取得予定 2026年7月16日取得予定\n株式の取得価額の総額は100百万円です。'
      ),
    ];
    const f = numberCandidate(ps[0], '株式の取得価額の総額', 100, '2026年7月15日');
    f.valueKind = null;
    Object.assign(f.semantics, {
      scope: null,
      basis: null,
      state: 'planned',
      periodKind: 'eventDate',
    });
    const r = reviewCandidates(candidateResponse([f], ps), 'other', ps);
    expect(r.facts).toEqual([]);
    expect(r.unverified.join(' ')).toContain('予定日が曖昧');
  });
  it('別の予定を含む文でも既に計上した主張を予定へ変えない', () => {
    const text = '当社は特別損失に計上しておりますが、翌期に増資する予定です。';
    expect(assertionStates(text)).toEqual(expect.arrayContaining(['actual', 'planned']));
    expect(() => verifyAssertionState('planned', text)).toThrow('複数');
  });
  it('モデル入力の宣言参照とslot型が実際に解決し、配当へ財務範囲を提示しない', () => {
    const input = JSON.parse(serializeCandidateSource(pages, undefined, 'earnings'));
    for (const template of input.contextTemplates)
      for (const id of template.declarationIds)
        expect(input.declarations.some((d: { id: string }) => d.id === id)).toBe(true);
    const dividend = input.contextTemplates.find(
      (t: { id: string }) => t.id === input.unitContexts['p1s259']
    );
    expect(dividend.meaningOptions).toEqual({
      subject: ['株式会社BlueMeme'],
      scope: [],
      basis: [],
    });
    expect(
      input.obligations.find((s: { sourceIds: string[] }) => s.sourceIds.includes('p5b20')).expected
    ).toMatchObject({ kind: 'event', state: 'forecast', periodKind: 'none' });
  });
  it('参照群や全文をモデルに再記述させずBlueMemeの11事実を確定する', () => {
    const r = review(candidates);
    expect(r.unverified).toEqual([]);
    expect(r.facts).toHaveLength(14);
    const background = r.facts.find(
      (f) => f.evidence.kind === 'prose' && f.evidence.blockId === 'p5b20'
    )!;
    expect(background.evidence.contextIds).toEqual(['p5b17']);
    expect(background.semantics).toMatchObject({
      scope: '連結',
      state: 'forecast',
      basis: '日本基準',
    });
    const final = {
      version: 5,
      documentType: 'earnings' as const,
      facts: r.facts,
      unverified: r.unverified,
    };
    expect(parseFactSummary(JSON.stringify(final), 'earnings', pages)).toEqual(final);
    expect(renderFacts(final)).toContain('-400百万円');
    expect(renderFacts(final)).toContain('394百万円');
  });
  it.each([
    { meaning: { state: 'actual' } },
    { meaning: { subject: '別会社' } },
    { meaning: { scope: '個別' } },
    { meaning: { basis: null } },
    { meaning: { polarity: 'negative' } },
    { source: { contextBindingId: 'ctx:p1b1' } },
  ])('損失背景の誤対応 %j を拒否する', (change) => {
    const c = structuredClone(candidates[9]);
    if (change.meaning) Object.assign(c.meaning, change.meaning);
    if (change.source) Object.assign(c.source, change.source);
    expect(review([c]).facts).toHaveLength(0);
  });
  it('独立した主体・範囲・状態・否定の誤りを一度に診断し、参照不能では意味を評価しない', () => {
    const c = structuredClone(candidates[9]);
    Object.assign(c.meaning, {
      subject: '別会社',
      scope: '個別',
      state: 'actual',
      polarity: 'negative',
    });
    expect(
      review([c])
        .diagnostics.filter((d) => d.status === 'invalid')
        .map((d) => d.check)
    ).toEqual(expect.arrayContaining(['scope.subject', 'scope.scope', 'state', 'polarity']));
    c.source.contextBindingId = 'ctx:missing';
    const r = review([c]);
    expect(r.diagnostics).toHaveLength(1);
    expect(r.diagnostics[0].status).toBe('blocked');
  });
  it('保存された事実でもIDを再計算した自由な出来事labelを意味の証明にしない', () => {
    const r = review(candidates);
    const f = structuredClone(r.facts[9]);
    f.label = '純損失によって調査費用が生じる';
    f.id = stableFactId(f);
    expect(
      parseFactSummary(
        JSON.stringify({ version: 5, documentType: 'earnings', facts: [f], unverified: [] }),
        'earnings',
        pages,
        false
      ).facts
    ).toHaveLength(0);
  });
  it('旧生成応答・未知項目・不正unverifiedは根全体を拒否する', () => {
    for (const text of [
      JSON.stringify({ version: 5, documentType: 'earnings', facts: fixture, unverified: [] }),
      raw(candidates, { extra: true }),
      raw(candidates, { unverified: [{}] }),
    ]) {
      const r = reviewCandidates(text, 'earnings', pages);
      expect(r.envelopeValid).toBe(false);
      expect(r.facts).toEqual([]);
    }
  });
  it('兄弟節の連結や他社を借用せず、本文の単なる個別言及で範囲を変えない', () => {
    const p = textPage(
      '会社名 株式会社テスト\n１．連結経営成績\n2026年3月期 連結経営成績\n営業利益は100百万円です。\n２．個別経営成績\n2026年3月期 個別経営成績\n営業利益は200百万円です。'
    );
    const graph = buildDocumentContext([p]);
    const block = p.blocks[p.blocks.length - 1];
    const b = bindingFor(graph, block.id);
    expect(
      b.declarations.filter((d) => d.origin === 'local' && d.role === 'scope').map((d) => d.value)
    ).toContain('個別');
    const f = {
      ...numberCandidate(p),
      value: 200,
      quote: block.text,
      evidence: {
        kind: 'prose' as const,
        blockId: block.id,
        assertionId: `${block.id}:a1`,
        quantityId: null,
        contextIds: [],
        scopeIds: [],
        qualifierIds: [],
      },
    };
    const c = candidateFixture(f, [p]);
    const result = reviewCandidates(candidateResponse([f], [p]), 'other', [p]);
    expect(result.facts).toHaveLength(0);
    c.meaning.scope = '個別';
    c.meaning.basis = null;
    const r = reviewCandidates(
      JSON.stringify({
        candidateVersion: 3,
        documentType: 'other',
        candidates: [c],
        unverified: [],
      }),
      'other',
      [p]
    );
    expect(r.facts).toHaveLength(1);
    const body = textPage(
      '会社名 株式会社テスト\n１．連結経営成績\n子会社の個別財務諸表を参考資料に掲載しています。\n2026年3月期 連結経営成績\n営業利益は100百万円です。'
    );
    expect(
      bindingFor(buildDocumentContext([body]), body.blocks[4].id)
        .declarations.filter((d) => d.role === 'scope')
        .every((d) => d.value === '連結')
    ).toBe(true);
  });
  it.each([
    ['1. 連結子会社の異動', 'scope', '連結'],
    ['1. 個別契約の締結', 'scope', '個別'],
    ['1. IFRS対応の方針', 'basis', 'IFRS'],
    ['1. 単体契約の締結', 'scope', '単体'],
    ['1. 国際会計基準への移行', 'basis', '国際会計基準'],
    ['1. 米国基準への対応', 'basis', '米国基準'],
  ] as const)('報告欄ではない見出しから属性を作らない: %s', (heading, role, fabricated) => {
    const source = [textPage(`会社名 株式会社テスト\n${heading}\n当社は契約を締結しました。`)];
    const block = source[0].blocks[2];
    const fact: VerifiedFact = {
      ...fixture[9],
      page: 1,
      quote: block.text,
      label: block.text,
      statement: block.text,
      evidence: {
        kind: 'prose',
        blockId: block.id,
        assertionId: `${block.id}:a1`,
        quantityId: null,
        contextIds: [],
        scopeIds: [],
        qualifierIds: [],
      },
      semantics: {
        ...fixture[9].semantics,
        subject: '株式会社テスト',
        scope: null,
        basis: null,
        state: 'contracted',
        qualifiers: [],
      },
    };
    const correct = reviewCandidates(candidateResponse([fact], source), 'other', source);
    expect(correct.unverified).toEqual([]);
    expect(correct.facts).toHaveLength(1);
    expect(correct.facts[0].semantics).toMatchObject({ scope: null, basis: null });
    expect(
      parseFactSummary(
        JSON.stringify({ version: 5, documentType: 'other', facts: correct.facts, unverified: [] }),
        'other',
        source
      ).facts
    ).toEqual(correct.facts);
    const wrong = reviewCandidates(
      candidateResponse(
        [{ ...fact, semantics: { ...fact.semantics, [role]: fabricated } }],
        source
      ),
      'other',
      source
    );
    expect(wrong.facts).toEqual([]);
    expect(wrong.diagnostics).toContainEqual(
      expect.objectContaining({ check: `scope.${role}`, status: 'invalid' })
    );
    const altered = {
      ...correct.facts[0],
      semantics: { ...correct.facts[0].semantics, [role]: fabricated },
    };
    altered.id = stableFactId(altered);
    expect(
      parseFactSummary(
        JSON.stringify({ version: 5, documentType: 'other', facts: [altered], unverified: [] }),
        'other',
        source,
        false
      ).facts
    ).toEqual([]);
  });
  it.each([
    '2027年3月期の「売上高は100百万円」を上回る見込みです。',
    '（2027年3月期の売上高は100百万円）を下回る見込みです。',
    '2027年3月期の「売上高は100百万円」以上となる見込みです。',
  ])('閉じ記号を挟んでも閾値を確定額へ変換しない: %s', (body) => {
    const source = [textPage(`会社名 株式会社テスト\n2027年3月期 業績予想\n${body}`)];
    const fact = numberCandidate(source[0], '売上高', 100, '2027年3月期');
    fact.semantics.scope = fact.semantics.basis = null;
    fact.valueKind = fact.semantics.state = 'forecast';
    const result = reviewCandidates(candidateResponse([fact], source), 'other', source);
    expect(result.facts).toEqual([]);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ status: 'blocked', message: expect.stringContaining('境界') })
    );
    expect(
      parseFactSummary(
        JSON.stringify({ version: 5, documentType: 'other', facts: [fact], unverified: [] }),
        'other',
        source,
        false
      ).facts
    ).toEqual([]);
  });
  it('閾値ではない引用符付きの確定数量は受理して保存再照合できる', () => {
    const source = [
      textPage(
        '会社名 株式会社テスト\n2027年3月期 業績予想\n2027年3月期の「売上高は100百万円」の見込みです。'
      ),
    ];
    const fact = numberCandidate(source[0], '売上高', 100, '2027年3月期');
    fact.semantics.scope = fact.semantics.basis = null;
    fact.valueKind = fact.semantics.state = 'forecast';
    const result = reviewCandidates(candidateResponse([fact], source), 'other', source);
    expect(result.unverified).toEqual([]);
    expect(result.facts).toHaveLength(1);
    expect(
      parseFactSummary(
        JSON.stringify({ version: 5, documentType: 'other', facts: result.facts, unverified: [] }),
        'other',
        source
      ).facts
    ).toEqual(result.facts);
  });
  it.each([
    [
      '2026年3月期 決算短信〔日本基準〕（連結）\n会社名 株式会社テスト\n2026年3月期 経営成績',
      '連結',
      '日本基準',
    ],
    ['会社名 株式会社テスト | 会計基準 IFRS | 範囲 個別\n2026年3月期 経営成績', '個別', 'IFRS'],
    [
      '会社名 株式会社テスト\n2026年3月期 経営成績\n会計基準：日本基準\n範囲：非連結',
      '非連結',
      '日本基準',
    ],
    [
      '会社名 株式会社テスト\n2026年3月期 経営成績\n会計基準 日本基準\n範囲 連結子会社',
      '連結子会社',
      '日本基準',
    ],
  ])('実際の報告表題・明示欄の範囲と基準は保持する: %s', (header, scope, basis) => {
    const source = [textPage(`${header}\n2026年3月期の営業利益は100百万円です。`)];
    const fact = numberCandidate(source[0]);
    fact.semantics.scope = scope;
    fact.semantics.basis = basis;
    const result = reviewCandidates(candidateResponse([fact], source), 'other', source);
    expect(result.unverified).toEqual([]);
    expect(result.facts).toHaveLength(1);
    expect(result.facts[0].semantics).toMatchObject({ scope, basis });
    for (const missing of [null, ...['連結', '個別'].filter((v) => v !== scope)]) {
      const wrong = { ...fact, semantics: { ...fact.semantics, scope: missing } };
      expect(reviewCandidates(candidateResponse([wrong], source), 'other', source).facts).toEqual(
        []
      );
    }
  });
  it('誤った個別範囲を1回修復し、元本文を範囲の付け直しなしで表示する', async () => {
    const source = [
      textPage('会社名 株式会社テスト\n1. 個別契約の締結\n当社は契約を締結しました。'),
    ];
    const block = source[0].blocks[2];
    const fact: VerifiedFact = {
      ...fixture[9],
      page: 1,
      quote: block.text,
      label: block.text,
      statement: block.text,
      evidence: {
        kind: 'prose',
        blockId: block.id,
        assertionId: `${block.id}:a1`,
        quantityId: null,
        contextIds: [],
        scopeIds: [],
        qualifierIds: [],
      },
      semantics: {
        ...fixture[9].semantics,
        subject: '株式会社テスト',
        scope: null,
        basis: null,
        state: 'contracted',
        qualifiers: [],
      },
    };
    const wrong = { ...fact, semantics: { ...fact.semantics, scope: '個別' } };
    vi.mocked(generateText)
      .mockReset()
      .mockResolvedValueOnce(candidateResponse([wrong], source))
      .mockResolvedValueOnce(candidateResponse([fact], source));
    const result = await generateVerifiedFactSummary(config, 'other', 'source', source);
    expect(result.repairAttempted).toBe(true);
    expect(vi.mocked(generateText)).toHaveBeenCalledTimes(2);
    expect(result.facts.facts).toHaveLength(1);
    expect(result.facts.facts[0].semantics.scope).toBeNull();
    expect(renderFacts(result.facts)).toContain(block.text);
    expect(renderFacts(result.facts)).not.toContain('範囲=個別');
  });
  it('閾値の誤った確定額を1回修復し、比較を含む原文をそのまま表示する', async () => {
    const body = '2027年3月期の「売上高は100百万円」を上回る見込みです。';
    const source = [textPage(`会社名 株式会社テスト\n2027年3月期 業績予想\n${body}`)];
    const amount = numberCandidate(source[0], '売上高', 100, '2027年3月期');
    amount.semantics.scope = amount.semantics.basis = null;
    amount.valueKind = amount.semantics.state = 'forecast';
    const statement: VerifiedFact = {
      ...amount,
      kind: 'event',
      value: null,
      unit: null,
      valueKind: null,
      label: body,
      statement: body,
      semantics: { ...amount.semantics, metricKind: 'none' },
    };
    vi.mocked(generateText)
      .mockReset()
      .mockResolvedValueOnce(candidateResponse([amount], source))
      .mockResolvedValueOnce(candidateResponse([statement], source));
    const result = await generateVerifiedFactSummary(config, 'other', 'source', source);
    expect(result.repairAttempted).toBe(true);
    expect(vi.mocked(generateText)).toHaveBeenCalledTimes(2);
    expect(result.facts.facts).toHaveLength(1);
    expect(result.facts.facts[0]).toMatchObject({ kind: 'event', value: null, statement: body });
    expect(renderFacts(result.facts)).toContain(body);
  });
  it.each(['当社は契約を締結していない。', '当社は契約を締結する予定です。'])(
    '契約の否定/予定を契約済みへ変換しない: %s',
    (text) => {
      const p = textPage(`会社名 株式会社テスト\n${text}`);
      const f: VerifiedFact = {
        ...fixture[9],
        page: 1,
        quote: text,
        statement: text,
        evidence: {
          kind: 'prose',
          blockId: p.blocks[1].id,
          assertionId: `${p.blocks[1].id}:a1`,
          quantityId: null,
          contextIds: [],
          scopeIds: [],
          qualifierIds: [],
        },
        semantics: {
          ...fixture[9].semantics,
          subject: '株式会社テスト',
          scope: null,
          basis: null,
          state: 'contracted',
          polarity: text.includes('いない') ? 'negative' : 'affirmative',
        },
      };
      expect(reviewCandidates(candidateResponse([f], [p]), 'other', [p]).facts).toHaveLength(0);
    }
  );
  it('別ページ参照で節検査を飛ばさず、離れた本文の予定で義務を作らない', () => {
    const f = structuredClone(fixture[9]);
    f.evidence.contextIds = ['p1b1'];
    expect(
      parseFactSummary(
        JSON.stringify({ version: 5, documentType: 'earnings', facts: [f], unverified: [] }),
        'earnings',
        pages,
        false
      ).facts
    ).toHaveLength(0);
    const selected = pages.map((p) => ({
      ...p,
      selection: p.pageNumber === 18 ? ('omitted' as const) : ('selected' as const),
    }));
    const r = reviewCandidates(
      raw(candidates.filter((c) => c.candidateId !== 'c11')),
      'earnings',
      selected
    );
    expect(
      coverageReport('earnings', selected, r.facts).filter(
        (s) => s.status !== 'satisfied' && s.status !== 'outsideSelection'
      )
    ).toEqual([]);
    expect(
      coverageReport('earnings', selected, r.facts).some(
        (s) => s.status === 'outsideSelection' && s.requirement.includes('計上予定')
      )
    ).toBe(true);
  });
  it('生の不正根からはcompleteで全件再生成する', async () => {
    vi.mocked(generateText)
      .mockReset()
      .mockResolvedValueOnce(raw(candidates, { unverified: [{}] }))
      .mockResolvedValueOnce(raw(candidates));
    const result = await generateVerifiedFactSummary(config, 'earnings', 'source', pages);
    expect(result.repairAttempted).toBe(true);
    expect(result.facts.facts).toHaveLength(14);
    expect(vi.mocked(generateText).mock.calls[1][1][1].content).toContain('修復方式=complete');
  });
  it('修復で確定事実を消さず、ID付け替えによる重複も作らない', async () => {
    const initial = candidates.filter((_, i) => i !== 10);
    const before = review(initial).facts;
    const changed = structuredClone(candidates[9]);
    changed.candidateId = 'c15';
    changed.meaning.basis = null;
    vi.mocked(generateText)
      .mockReset()
      .mockResolvedValueOnce(raw(initial))
      .mockResolvedValueOnce(
        raw([changed, { ...candidates[0], candidateId: 'c16' }, candidates[10]])
      );
    const result = await generateVerifiedFactSummary(config, 'earnings', 'source', pages);
    expect(result.facts.facts).toHaveLength(14);
    expect(result.facts.facts.filter((f) => before.some((b) => b.id === f.id))).toHaveLength(13);
    const attempts = vi.mocked(generateText).mock.calls;
    expect(attempts).toHaveLength(2);
    expect(attempts[1][1][1].content).toContain('修復方式=delta');
  });
  it.each(['detail', 'key'] as const)(
    '20件を埋めた初回の %s と必須修復の容量を明示する',
    async (importance) => {
      const source = textPage(
        '会社名 株式会社テスト\n１．経営成績\n2026年3月期 実績\n' +
          Array.from({ length: 20 }, (_, i) => `科目${i + 1}は${100 + i}百万円です。`).join('\n') +
          '\n２．取得の内容\n2026年7月15日取得予定\n取得対象株式の種類 普通株式\n取得する株式の総数は200,000株（上限）です。\n株式の取得価額の総額は206,200,000円（上限）です。'
      );
      const initial = Array.from({ length: 20 }, (_, i) => {
        const f = numberCandidate(source, `科目${i + 1}`, 100 + i);
        f.importance = i === 0 ? 'key' : importance;
        f.semantics.scope = f.semantics.basis = null;
        return f;
      });
      const repair = [
        ['取得する株式の総数', 200000, '株', 'count'],
        ['株式の取得価額の総額', 206200000, '円', 'amount'],
      ].map(([label, value, unit, metric]) => {
        const f = numberCandidate(source, String(label), Number(value), '2026年7月15日');
        f.unit = String(unit);
        f.valueKind = null;
        Object.assign(f.semantics, {
          scope: '普通株式',
          basis: null,
          state: 'planned',
          metricKind: metric,
          periodKind: 'eventDate',
          qualifiers: ['上限'],
        });
        return f;
      });
      vi.mocked(generateText)
        .mockReset()
        .mockResolvedValueOnce(candidateResponse(initial, [source], 'shareRepurchase'))
        .mockResolvedValueOnce(candidateResponse(repair, [source], 'shareRepurchase'));
      const run = generateVerifiedFactSummary(config, 'shareRepurchase', source.text, [source]);
      const result = await run;
      expect(result.facts.facts).toHaveLength(20);
      expect(result.facts.unverified.join(' ')).toContain('CAPACITY');
      expect(vi.mocked(generateText)).toHaveBeenCalledTimes(2);
    }
  );
});
