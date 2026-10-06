import { describe, expect, it, vi } from 'vitest';
import type { ExtractedPage } from '@/types/summaryMetadata';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';
import corpus from './fixtures/ir-semantic-corpus.json';
import expectations from './fixtures/ir-semantic-expectations.json';
import { extractPageLayout, serializeLayout } from './pdf-layout';
import { parseFactSummary, renderFacts } from './fact-summary';
import { toValue, validateScoreInput } from './score-extraction';
import { assessClaim, inferExperimentalScore, type ScoreClaim } from './scoring';
import { buildScoreHtml } from '../content/utils/summaryHtmlBuilder';
import type { VerifiedFact } from './fact-contract';
import { textPage, numberCandidate } from './fixtures/v4-test-source';
import { validateSavedFacts, validateSavedScore } from './fact-cache';
import { validatePages } from './fact-validation';
import { tableReferenceHints } from './document-structure';
import { verifyCoverage } from './fact-coverage';
const sources = corpus.map((entry) =>
  entry.pages.map((p) => extractPageLayout(p.items as TextItem[], p.pageNumber))
);
function parse(index: number, facts: unknown[], coverage = false) {
  const documentType = (
    ['earnings', 'shareRepurchase', 'businessUpdate', 'ma', 'earningsRevision', 'ma'] as const
  )[index];
  return parseFactSummary(
    JSON.stringify({ version: 6, documentType, facts, unverified: [] }),
    documentType,
    sources[index],
    coverage
  );
}
const fact = (index: number, n = 0) =>
  structuredClone(expectations[index].facts[n]) as VerifiedFact;
describe('実PDFの意味を保った利用経路', () => {
  // 6資料の候補→確定→保存と原数量の全参照は fact-candidates.test.ts に集約する。
  it('BlueMemeの実績・損失予想・率・EPS・概算・翌期計上予定を表示する', () => {
    const text = renderFacts(parse(0, expectations[0].facts, true));
    for (const term of [
      '3298百万円',
      '47百万円',
      '24百万円',
      '2600百万円',
      '30百万円',
      '-400百万円',
      '1.4%',
      '-119.53円',
      '概算額',
      '翌連結会計年度',
      '特別損失',
      '予定',
    ])
      expect(text).toContain(term);
    expect(() =>
      parse(
        0,
        expectations[0].facts.filter((_, i) => i !== 5),
        true
      )
    ).toThrow('netProfit');
    expect(() =>
      parse(
        0,
        expectations[0].facts.filter((_, i) => i !== 9),
        true
      )
    ).toThrow('背景');
    const unscoped = expectations[0].facts.map((f) => structuredClone(f));
    unscoped[9].semantics.scope = null;
    expect(() => parse(0, unscoped, true)).toThrow('背景');
    const missingPeriod = fact(0, 10);
    missingPeriod.period = null;
    missingPeriod.semantics.periodKind = 'none';
    const rejectedPeriod = parse(0, [missingPeriod]);
    expect(rejectedPeriod.facts).toHaveLength(0);
    expect(rejectedPeriod.unverified.join(' ')).toContain('PERIOD:');
    const missingBasis = structuredClone(expectations[0].facts);
    missingBasis[10].semantics.basis = null;
    expect(() => parse(0, missingBasis, true)).toThrow('計上予定');
  });
  it('smartの未選択ページを必須とせず、選択すると損失予定の欠落を拒否する', () => {
    const pages = structuredClone(sources[0]);
    const plan = fact(0, 10);
    const planPage = pages.find((page) => page.pageNumber === plan.page)!;
    planPage.selection = 'omitted';
    const raw = JSON.stringify({
      version: 6,
      documentType: 'earnings',
      facts: expectations[0].facts.filter((f) => f.page !== plan.page),
      unverified: [],
    });
    expect(serializeLayout(pages)).not.toContain(`[PDF_PAGE:${plan.page}]`);
    const summary = parseFactSummary(raw, 'earnings', pages);
    expect(summary.unverified).toEqual([]);
    expect(renderFacts(summary)).toContain('-400百万円');
    expect(renderFacts(summary)).not.toContain('翌連結会計年度');

    planPage.selection = 'selected';
    expect(() => parseFactSummary(raw, 'earnings', pages)).toThrow('計上予定');
    planPage.selection = 'omitted';
    planPage.status = 'failed';
    expect(() => parseFactSummary(raw, 'earnings', pages)).toThrow('抽出失敗');
    planPage.status = 'ok';
    planPage.spans[0].text = '偽の原文';
    expect(() => parseFactSummary(raw, 'earnings', pages)).toThrow('SOURCE:');
  });
  it('構造候補から主要数値の根拠を選べても、意味の照合なしには確定しない', () => {
    const page = sources[0][0],
      hints = tableReferenceHints(page);
    for (const n of [0, 1, 2, 3, 4, 5, 6, 7, 8]) {
      const candidate = fact(0, n);
      if (candidate.evidence.kind !== 'table') throw new Error('table expected');
      const valueId = candidate.evidence.valueId;
      const hint = hints.find((h) => h.valueId === valueId);
      expect(hint).toBeDefined();
      Object.assign(candidate.evidence, hint);
      candidate.label = page.spans
        .filter((s) => hint!.metricIds.includes(s.id))
        .map((s) => s.text)
        .join('');
      expect(parse(0, [candidate]).unverified).toEqual([]);
      expect(parse(0, [candidate]).facts[0]?.value).toBe(candidate.value);
      candidate.value = 999;
      expect(parse(0, [candidate]).facts).toHaveLength(0);
    }
  });
  it('年間配当へ隣接する連結配当率や財務範囲を転用しない', () => {
    const dividend = fact(0, 8);
    dividend.semantics.scope = '連結';
    expect(parse(0, [dividend]).facts).toHaveLength(0);
    dividend.semantics.scope = null;
    dividend.semantics.basis = '日本基準';
    expect(parse(0, [dividend]).facts).toHaveLength(0);
    const count = parse(1, expectations[1].facts, true).facts[0];
    const document = {
      url: corpus[1].url,
      pages: sources[1],
      text: sources[1].map((p) => p.text).join('\n'),
      documentHash: 'a'.repeat(64),
      publishedDate: '2026-07-14',
      issuer: '株式会社丸八倉庫',
      code: '9313',
    };
    expect(toValue(count, document).source.basis).toBeNull();
  });
  it.each([
    { valueId: 'p1s233', period: '2025年3月期' },
    { valueId: 'p1s246', period: '2026年3月期' },
  ])(
    '原文に正しい$period実績配当だけでは2027年3月期予想の必須判定を満たさない',
    ({ valueId, period }) => {
      const dividend = fact(0, 8);
      if (dividend.evidence.kind !== 'table') throw new Error('table expected');
      const hint = tableReferenceHints(sources[0][0]).find((h) => h.valueId === valueId)!;
      Object.assign(dividend.evidence, hint);
      dividend.label = sources[0][0].spans
        .filter((s) => hint.metricIds.includes(s.id))
        .map((s) => s.text)
        .join('');
      dividend.period = period;
      dividend.valueKind = dividend.semantics.state = 'actual';
      expect(parse(0, [dividend]).unverified).toEqual([]);
      const candidates = expectations[0].facts.map((f, index) => (index === 8 ? dividend : f));
      expect(() => parse(0, candidates, true)).toThrow(
        '配当の重要事実 対象期=2027年3月期 区分=forecast'
      );
      expect(parse(0, expectations[0].facts, true).unverified).toEqual([]);
    }
  );
  it('配当の対象会社・状態・指標を必須判定で照合し、EPSを配当の代用にしない', () => {
    const summary = parse(0, expectations[0].facts, true);
    for (const alter of [
      (f: VerifiedFact) => {
        f.semantics.subject = '株式会社テスト';
      },
      (f: VerifiedFact) => {
        f.valueKind = f.semantics.state = 'actual';
      },
      (f: VerifiedFact) => {
        f.label = '期末1株当たり当期純利益';
      },
    ]) {
      const changed = structuredClone(summary.facts);
      alter(changed[8]);
      expect(() => verifyCoverage('earnings', sources[0], changed)).toThrow('配当の重要事実');
    }
  });
  it('原文で確定した範囲nullの配当修正を比較・採点・表示・保存復元へ渡す', async () => {
    const facts = parse(4, expectations[4].facts, true);
    const dividends = facts.facts.filter((f) => /配当/.test(f.label));
    const current = dividends.find((f) => f.valueKind === 'forecastAfter')!;
    const previous = dividends.find((f) => f.valueKind === 'forecastBefore')!;
    const document = {
      url: corpus[4].url,
      pages: sources[4],
      text: sources[4].map((p) => p.text).join('\n'),
      documentHash: 'a'.repeat(64),
      publishedDate: '2026-09-10',
      issuer: current.semantics.subject!,
      code: '4051',
    };
    const raw = JSON.stringify({
      version: 4,
      claims: [
        {
          category: 'shareholderReturn',
          label: '配当予想の修正',
          current: current.id,
          previous: previous.id,
          earlier: null,
          relatedValue: null,
          companyExplanation: null,
        },
      ],
      unverified: [],
    });
    const input = validateScoreInput(raw, [{ document, facts }], '元PDF内');
    expect(input.unverified).toEqual([]);
    expect(input.claims).toHaveLength(1);
    expect(input.claims[0].current).toMatchObject({
      value: 127,
      unit: '円',
      source: { scope: null, basis: null, semantics: current.semantics },
    });
    expect(input.claims[0].previous).toMatchObject({
      value: 125,
      source: { scope: null, basis: null },
    });
    expect(assessClaim(input.claims[0])).toContain('125→127円');
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              finish_reason: 'stop',
              message: {
                content: JSON.stringify({
                  value: 50,
                  factors: [{ index: 0, impact: 'neutral', strength: 'small' }],
                }),
              },
            },
          ],
        }),
        { status: 200 }
      )
    );
    vi.stubGlobal('fetch', fetchMock);
    try {
      const score = await inferExperimentalScore(
        { provider: 'openai', model: 'fixture', apiKey: 'fixture' },
        'dividend',
        input
      );
      expect(score.value).toBe(50);
      expect(buildScoreHtml(score)).toContain('範囲の指定なし');
      expect(buildScoreHtml(score)).toContain('125→127円');
      expect(buildScoreHtml(score)).not.toContain('連結');
      validateSavedScore(
        JSON.parse(JSON.stringify(score)),
        facts,
        document.url,
        document.documentHash
      );
      const altered = structuredClone(score);
      altered.breakdown[0].current.source.scope = '連結';
      altered.breakdown[0].current.source.semantics.scope = '連結';
      expect(() => validateSavedScore(altered, facts, document.url, document.documentHash)).toThrow(
        '不一致'
      );
      const mismatched = structuredClone(score);
      mismatched.breakdown[0].previous!.source.scope = '普通株式';
      mismatched.breakdown[0].previous!.source.semantics.scope = '普通株式';
      expect(assessClaim(mismatched.breakdown[0])).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('配当のnull許容を財務金額・利益率・EPSの範囲欠落へ広げない', () => {
    const facts = parse(0, expectations[0].facts, true);
    const document = {
      url: corpus[0].url,
      pages: sources[0],
      text: '',
      documentHash: 'a'.repeat(64),
      publishedDate: null,
      issuer: '株式会社BlueMeme',
      code: '4069',
    };
    for (const index of [0, 6, 7]) {
      const fact = structuredClone(facts.facts[index]);
      fact.semantics.scope = null;
      expect(() => toValue(fact, document)).toThrow('範囲');
    }
    const dividend = facts.facts[8];
    const before = toValue(dividend, document);
    before.source.valueKind = 'forecastBefore';
    before.source.semantics = { ...before.source.semantics, state: 'forecastBefore' };
    before.source.scope = before.source.semantics.scope = null;
    const after = structuredClone(before);
    after.source.valueKind = 'forecastAfter';
    after.source.semantics.state = 'forecastAfter';
    after.source.metric = before.source.metric = '営業利益';
    after.source.semantics.metricKind = before.source.semantics.metricKind = 'amount';
    expect(
      assessClaim({
        category: 'coreForecast',
        label: '欠損範囲',
        current: after,
        previous: before,
        earlier: null,
        relatedValue: null,
        companyExplanation: null,
      })
    ).toBeNull();
  });
  it('会社名を部分名に切り詰めて会社の必須判定を通せない', () => {
    for (const subject of ['株式会社', '株式会社Blue', 'BlueMeme']) {
      const candidate = fact(0);
      candidate.semantics.subject = subject;
      expect(parse(0, [candidate]).facts).toHaveLength(0);
    }
    const candidate = fact(3, 1);
    candidate.semantics.subject = '株式会社';
    expect(parse(3, [candidate]).facts).toHaveLength(0);
  });
  it('分割した単位見出しを含む修正表の構造候補から配当の前後も照合する', () => {
    for (const original of expectations[4].facts.filter((f) => f.evidence.kind === 'table')) {
      const candidate = structuredClone(original);
      if (!('valueId' in candidate.evidence)) throw new Error('table expected');
      const valueId = candidate.evidence.valueId;
      const page = sources[4].find((p) => p.pageNumber === candidate.page)!;
      const hint = tableReferenceHints(page).find((h) => h.valueId === valueId);
      expect(hint).toBeDefined();
      Object.assign(candidate.evidence, hint);
      expect(parse(4, [candidate]).unverified).toEqual([]);
    }
  });
  it('上限・予定・取得できない条件を数量と一緒に表示し、実績への変更を拒否する', () => {
    const summary = parse(1, expectations[1].facts, true),
      text = renderFacts(summary);
    for (const term of [
      '200000株',
      '206200000円',
      '上限',
      '実施予定',
      '2026年7月15日',
      '一部又は全部',
      '可能性',
    ])
      expect(text).toContain(term);
    for (const change of [{ qualifiers: [] }, { state: 'actual' }, { conditions: [] }]) {
      const candidate = fact(1);
      Object.assign(candidate.semantics, change);
      expect(parse(1, [candidate]).facts).toHaveLength(0);
    }
  });
  it('月次の他月・他年度・増減率・グラフ丸め値・速報の欠落を拒否する', () => {
    for (const changes of [
      { period: '2026年7月' },
      { period: '2025年6月' },
      { value: 18 },
      { value: 338 },
      { semantics: { ...fact(2).semantics, qualifiers: [] } },
    ]) {
      expect(parse(2, [{ ...fact(2), ...changes }]).facts).toHaveLength(0);
    }
    const candidate = fact(2);
    candidate.evidence.qualifierIds = [];
    expect(parse(2, [candidate]).facts).toHaveLength(0);
    const text = renderFacts(parse(2, expectations[2].facts, true));
    for (const term of ['2026年6月', 'NJSS', '338214千円', '速報値', '修正する可能性'])
      expect(text).toContain(term);
  });
  it('M&Aの対象会社の継続表と、非開示・複数の日付役割を保持する', () => {
    const text = renderFacts(parse(3, expectations[3].facts, true))
      .normalize('NFKC')
      .replace(/\s/g, '');
    for (const term of [
      '株式会社富士設計',
      '592019千円',
      '非開示',
      '決議',
      '契約',
      '13',
      '30',
      '予定',
    ])
      expect(text).toContain(term);
    const candidate = fact(3);
    candidate.semantics.subject = 'ＩＺＵＭＩグループ株式会社';
    candidate.evidence.scopeIds.push('p1b3');
    expect(parse(3, [candidate]).facts).toHaveLength(0);
    const wrongYear = fact(3);
    if (wrongYear.evidence.kind === 'table') wrongYear.evidence.periodIds = ['p1s102'];
    expect(parse(3, [wrongYear]).facts).toHaveLength(0);
  });
  it('EPS・率を営業利益額や必須利益額の代用にしない', () => {
    const summary = parse(0, expectations[0].facts, true),
      doc = {
        url: corpus[0].url,
        pages: sources[0],
        text: sources[0].map((p) => p.text).join('\n'),
        documentHash: 'a'.repeat(64),
        publishedDate: '2026-09-30',
        issuer: '株式会社BlueMeme',
        code: '4069',
      };
    for (const n of [6, 7]) {
      const raw = JSON.stringify({
        version: 4,
        claims: [
          {
            category: 'operatingProfit',
            label: '営業利益',
            current: summary.facts[n].id,
            previous: null,
            earlier: null,
            relatedValue: null,
            companyExplanation: null,
          },
        ],
        unverified: [],
      });
      expect(validateScoreInput(raw, [{ document: doc, facts: summary }], '').claims).toHaveLength(
        0
      );
    }
  });
  it('修正表の上下にずれた行区分と期間キャプションを区別し、他行・未知基準を拒否する', () => {
    const summary = parse(4, expectations[4].facts, true);
    expect(summary.facts.filter((f) => f.kind === 'number').map((f) => f.value)).toEqual([
      19730, 2800, 22000, 2900, 125, 127, 1870, 226.5, 1903, 230.5,
    ]);
    expect(() => parse(4, expectations[4].facts.slice(0, 4), true)).toThrow('配当予想修正');
    const bareProfit = fact(4, 6);
    const p = sources[4][0];
    const bareSource = tableReferenceHints(p).find(
      (h) => p.quantities.find((q) => q.id === h.valueId)?.text === '1,874'
    )!;
    Object.assign(bareProfit.evidence, bareSource);
    bareProfit.label = '当期利益';
    bareProfit.value = 1874;
    const bare = parse(4, [bareProfit]);
    expect(bare.unverified).toEqual([]);
    expect(() =>
      verifyCoverage('earningsRevision', sources[4], [
        ...summary.facts.filter((f) => f.value !== 1870),
        ...bare.facts,
      ])
    ).toThrow('forecastBefore/netProfit');
    const caption = fact(4, 2);
    if (caption.evidence.kind !== 'table') throw new Error('table expected');
    caption.evidence.periodIds.push('p1s46', 'p1s47');
    caption.evidence.contextIds = ['p1s80'];
    // The fiscal caption belongs to context, not the axis for a different row.
    expect(parse(4, [caption]).facts).toHaveLength(0);
    expect(parse(4, [fact(4, 2)]).unverified).toEqual([]);
    const wrong = fact(4);
    if (wrong.evidence.kind !== 'table') throw new Error('table expected');
    wrong.evidence.periodIds = ['p1s80'];
    expect(parse(4, [wrong]).facts).toHaveLength(0);
    const invented = fact(4, 2);
    invented.semantics.basis = 'IFRS';
    expect(parse(4, [invented]).facts).toHaveLength(0);
  });
  it('提携の契約と展開・検討予定を出来事の全原文で区別する', () => {
    const summary = parse(5, expectations[5].facts, true);
    expect(summary.facts.map((f) => f.semantics.state)).toEqual([
      'contracted',
      'planned',
      'planned',
    ]);
    expect(renderFacts(summary)).toContain('検討を進めてまいります');
    const completed = structuredClone(expectations[5].facts[2]);
    completed.semantics.state = 'completed';
    expect(parse(5, [completed]).facts).toHaveLength(0);
  });
  it('範囲の予想を端点へ変換せず保存・表示し、点への改変を拒否する', () => {
    const page = textPage(
      '会社名 株式会社テスト | 会計基準 日本基準 | 範囲 連結\n2027年3月期 通期 業績予想\n営業利益は100.5～200.75百万円'
    );
    const candidate = numberCandidate(page, '営業利益', 100, '2027年3月期');
    candidate.kind = 'range';
    candidate.value = null;
    candidate.valueKind = 'forecast';
    candidate.semantics.state = 'forecast';
    const summary = parseFactSummary(
      JSON.stringify({ version: 6, documentType: 'other', facts: [candidate], unverified: [] }),
      'other',
      [page]
    );
    expect(summary.facts[0].quantity).toMatchObject({
      decimal: null,
      lower: '100.5',
      upper: '200.75',
    });
    expect(renderFacts(summary)).toContain('100.5～200.75百万円');
    validateSavedFacts(summary);
    expect(
      parseFactSummary(
        JSON.stringify({ ...summary, facts: [{ ...candidate, kind: 'number', value: 100.5 }] }),
        'other',
        [page],
        false
      ).facts
    ).toHaveLength(0);
  });
  it('日付役割を保持し、予定日を決議日や保存時の偽値へ変更しない', () => {
    const summary = parse(3, expectations[3].facts, true),
      schedule = summary.facts.find(
        (f) => f.evidence.kind === 'prose' && f.evidence.blockId === 'p2b32'
      )!;
    expect(schedule.dateRoles).toEqual([
      { date: '2026年7月13日', state: 'decided', sourceId: 'p2b32' },
      { date: '2026年7月13日', state: 'contracted', sourceId: 'p2b32' },
      { date: '2026年7月30日', state: 'planned', sourceId: 'p2b32' },
    ]);
    const altered = structuredClone(schedule);
    altered.dateRoles![2].state = 'completed';
    expect(parse(3, [altered]).facts).toHaveLength(0);
    const candidate = fact(1);
    candidate.period = '2026年7月14日';
    expect(parse(1, [candidate]).facts).toHaveLength(0);
  });
  it('原文欠損・派生セルの改変・抽出失敗をsmartの選択状態に関係なく拒否する', () => {
    for (const change of [
      (p: ExtractedPage) => (p.status = 'failed'),
      (p: ExtractedPage) => (p.spans[0].text = '偽値'),
      (p: ExtractedPage) => (p.spans[0].x += 1),
      (p: ExtractedPage) => (p.sourceItems[0].transform = []),
    ]) {
      const pages = structuredClone(sources[0]);
      pages[1].selection = 'omitted';
      change(pages[1]);
      expect(() => validatePages(pages)).toThrow('SOURCE:');
    }
    const summary = parse(0, expectations[0].facts, true);
    validateSavedFacts(summary);
    const reordered = JSON.parse(
      JSON.stringify(summary, (_key, value) =>
        value && typeof value === 'object' && !Array.isArray(value)
          ? Object.fromEntries(
              Object.keys(value)
                .sort()
                .map((k) => [k, value[k]])
            )
          : value
      )
    );
    validateSavedFacts(reordered);
    expect(parse(0, reordered.facts, true)).toEqual(summary);
    const changed = structuredClone(summary);
    changed.facts[0].semantics.scope = '個別';
    expect(() => validateSavedFacts(changed)).toThrow('不一致');
  });
  it('文字アイテムの順序・平行移動・倍率の変化でも原文の意味を保つ', () => {
    for (const index of [0, 1, 2, 3]) {
      const pages = corpus[index].pages.map((p) =>
        extractPageLayout(
          [...p.items].reverse().map((item) => ({
            ...item,
            transform: item.transform.map((v, i) => (i >= 4 ? v * 2 + (i === 4 ? 10 : 20) : v * 2)),
            width: item.width * 2,
            height: item.height * 2,
          })) as TextItem[],
          p.pageNumber
        )
      );
      const type =
        index === 0
          ? 'earnings'
          : index === 1
            ? 'shareRepurchase'
            : index === 2
              ? 'businessUpdate'
              : 'ma';
      const summary = parseFactSummary(
        JSON.stringify({
          version: 6,
          documentType: type,
          facts: expectations[index].facts,
          unverified: [],
        }),
        type,
        pages,
        true
      );
      expect(summary.facts.map((f) => [f.label, f.value, f.period, f.semantics])).toEqual(
        parse(index, expectations[index].facts, true).facts.map((f) => [
          f.label,
          f.value,
          f.period,
          f.semantics,
        ])
      );
    }
  });

  it('保存された採点も元の確定事実と一致させ、値や状態の改変を拒否する', () => {
    const facts = parse(0, expectations[0].facts, true),
      url = corpus[0].url;
    const current = toValue(facts.facts[0], {
      url,
      text: '',
      pages: [],
      documentHash: 'a'.repeat(64),
      publishedDate: null,
      issuer: '',
      code: '',
    });
    const previous = structuredClone(current);
    previous.value = 3000;
    previous.source.fiscalYear = 2025;
    previous.source.period = '2025年3月期';
    previous.source.factId = 'fact-1234567890123456';
    const claim: ScoreClaim = {
      category: 'revenue',
      label: '売上高',
      current,
      previous,
      earlier: null,
      relatedValue: null,
      companyExplanation: null,
    };
    const score = {
      value: 70,
      verdict: '好材料',
      positives: ['売上増'],
      negatives: [],
      unverified: [],
      searchStatus: '固定試験',
      breakdown: [
        {
          ...claim,
          impact: 'positive',
          strength: 'small',
          comparison: '前年比 9.9%（加速・鈍化は未確認）',
        },
      ],
    };
    validateSavedScore(score, facts, url, current.source.documentHash);
    const changed = structuredClone(score);
    changed.breakdown[0].current.value = 1;
    expect(() => validateSavedScore(changed, facts, url, current.source.documentHash)).toThrow(
      '不一致'
    );
    const changedHash = structuredClone(score);
    changedHash.breakdown[0].current.source.documentHash = 'b'.repeat(64);
    expect(() => validateSavedScore(changedHash, facts, url, current.source.documentHash)).toThrow(
      '不一致'
    );
    const reordered = JSON.parse(
      JSON.stringify(score, (_key, value) =>
        value && typeof value === 'object' && !Array.isArray(value)
          ? Object.fromEntries(
              Object.keys(value)
                .sort()
                .map((k) => [k, value[k]])
            )
          : value
      )
    );
    validateSavedScore(reordered, facts, url, current.source.documentHash);
  });
});
