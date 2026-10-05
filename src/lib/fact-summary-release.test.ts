import { describe, it, expect } from 'vitest';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';
import corpus from './fixtures/pdf-layout-corpus.json';
import semanticCorpus from './fixtures/ir-semantic-corpus.json';
import { extractPageLayout } from './pdf-layout';
import { parseFactSummary, renderFacts } from './fact-summary';
import { buildSummaryHtml } from '../content/utils/summaryHtmlBuilder';
import type { FactSemantics, VerifiedFact, FactEvidence } from './fact-contract';
const extract = (entry: { pages: { pageNumber: number; items: unknown }[] }) =>
  entry.pages.map((p) => extractPageLayout(p.items as TextItem[], p.pageNumber));
const pages = extract(corpus[0]);
const refs = (p: number, ns: number[]) => ns.map((n) => `p${p}s${n}`);
function table(
  p: number,
  valueId: number,
  label: string,
  value: number,
  period: string,
  valueKind: VerifiedFact['valueKind'],
  metricIds: number[],
  periodIds: number[],
  unitIds: number[],
  contextIds: number[],
  scopeIds: string[],
  semantics: Partial<FactSemantics> = {}
): VerifiedFact {
  return {
    id: 'f1',
    importance: 'key',
    kind: 'number',
    label,
    value,
    unit: '百万円',
    period,
    valueKind,
    column: null,
    statement: null,
    page: p,
    quote: '',
    evidence: {
      kind: 'table',
      valueId: `p${p}s${valueId}`,
      metricIds: refs(p, metricIds),
      periodIds: refs(p, periodIds),
      unitIds: refs(p, unitIds),
      contextIds: refs(p, contextIds),
      scopeIds,
      qualifierIds: [],
    },
    semantics: {
      subject: 'フィードフォースグループ株式会社',
      scope: '連結',
      basis: '日本基準',
      periodKind: 'fullYear',
      metricKind: 'amount',
      qualifiers: [],
      state: valueKind ?? 'unspecified',
      polarity: 'affirmative',
      conditions: [],
      ...semantics,
      ...(/配当/.test(label) ? { scope: null, basis: null } : {}),
    },
    quantity: null,
    dateRoles: null,
    provenance: null,
  };
}
const parse = (facts: VerifiedFact[], source = pages, coverage = false) =>
  parseFactSummary(
    JSON.stringify({
      version: 5,
      documentType: 'earnings',
      facts: facts.map((f, i) => ({ ...f, id: `f${i + 1}` })),
      unverified: [],
    }),
    'earnings',
    source,
    coverage
  );
const actualMetrics = [[31], [32], [33], [34], [30, 35]],
  forecastMetrics = [[5], [6], [7], [8], [3, 9]];
const labels = ['売上高', 'EBITDA', '営業利益', '経常利益', '親会社株主に帰属する四半期純利益'];
const financial = [
  ...actualMetrics.map((m, i) =>
    table(
      1,
      47 + i * 2,
      labels[i],
      [1306, 589, 536, 533, 316][i],
      '2027年5月期第1四半期',
      'actual',
      m,
      [46],
      [36 + i * 2],
      [27, 28],
      ['p1b1', 'p1b3'],
      { periodKind: 'cumulativeQ1' }
    )
  ),
  ...forecastMetrics.map((m, i) =>
    table(
      2,
      35 + i * 2,
      ['売上高', 'EBITDA', '営業利益', '経常利益', '親会社株主に帰属する当期純利益'][i],
      [5741, 2576, 2362, 2328, 1529][i],
      '2027年5月期通期',
      'forecast',
      m,
      [34],
      [11 + i * 2],
      [1],
      ['p1b1', 'p1b3']
    )
  ),
];
const dividend = {
  ...table(
    1,
    137,
    '年間配当金',
    20,
    '2027年5月期',
    'forecast',
    [114, 119],
    [133],
    [124],
    [113],
    ['p1b3']
  ),
  unit: '円',
  semantics: {
    ...financial[0].semantics,
    periodKind: 'fullYear' as const,
    metricKind: 'perShare' as const,
    state: 'forecast' as const,
    scope: null,
    basis: null,
  },
};
describe('既存の実PDF形式のv4回帰', () => {
  it('EBITDAを含む実績・予想・配当を原文から照合する', () => {
    // Values are asserted independently below; these are human-reviewed reported quantities.
    const eps = [
      {
        ...table(
          1,
          85,
          '１株当たり四半期純利益',
          13.23,
          '2027年5月期第1四半期',
          'actual',
          [78, 80],
          [84],
          [82],
          [28],
          ['p1b1', 'p1b3'],
          { periodKind: 'cumulativeQ1', metricKind: 'perShare' }
        ),
        unit: '円',
      },
      {
        ...table(
          2,
          45,
          '１株当たり当期純利益',
          63.86,
          '2027年5月期通期',
          'forecast',
          [4, 10],
          [34],
          [21],
          [1],
          ['p1b1', 'p1b3'],
          { metricKind: 'perShare' }
        ),
        unit: '円',
      },
    ];
    const notes = [
      ['p1b37', 1, null, null],
      ['p2b9', 2, '連結', '日本基準'],
    ].map(([blockId, page, scope, basis]) => {
      const b = pages[Number(page) - 1].blocks.find((b) => b.id === blockId)!;
      return {
        ...financial[0],
        kind: 'event' as const,
        label: b.text,
        statement: b.text,
        quote: b.text,
        value: null,
        unit: null,
        valueKind: null,
        period: null,
        page: Number(page),
        evidence: {
          kind: 'prose' as const,
          blockId: b.id,
          assertionId: `${b.id}:a1`,
          quantityId: null,
          contextIds: page === 1 ? ['p1b30'] : ['p2b1'],
          scopeIds: scope === null ? ['p1b3'] : ['p1b1', 'p1b3'],
          qualifierIds: [],
        },
        semantics: {
          ...financial[0].semantics,
          scope: scope as string | null,
          basis: basis as string | null,
          periodKind: 'none' as const,
          metricKind: 'none' as const,
          state: 'unspecified' as const,
          polarity: 'negative' as const,
        },
      };
    });
    const r = parse([...financial, dividend, ...eps, ...notes], pages, true);
    expect(r.unverified).toEqual([]);
    expect(r.facts).toHaveLength(15);
    expect(renderFacts(r)).toContain('実績');
    expect(buildSummaryHtml(renderFacts(r), null, { companyName: 'FF', title: '決算' })).toContain(
      'AI要約'
    );
  });
  it('同額でも別指標・前年・増減率の対応を拒否する', () => {
    for (const [index, id, value] of [
      [2, 'p1s49', 589],
      [2, 'p1s52', 11.1],
      [2, 'p1s62', 483],
      [4, 'p1s53', 533],
      [7, 'p2s27', 1046],
    ] as const) {
      const f = financial[index];
      expect(
        parse([{ ...f, value, evidence: { ...f.evidence, valueId: id } as FactEvidence }]).facts
      ).toHaveLength(0);
    }
  });
  it.each([
    {
      index: 1,
      period: '2027年2月期第1四半期',
      context: [42, 43, 44, 45],
      row: [67, 68],
      subject: '株式会社クリエイト・レストランツ・ホールディングス',
      basis: 'IFRS',
      scope: '連結',
      periodKind: 'cumulativeQ1',
      cases: [
        { value: 69, metric: [48], unit: 55, label: '売上収益', expected: 43277 },
        { value: 73, metric: [49], unit: 57, label: '営業利益', expected: 3378 },
        {
          value: 85,
          metric: [46, 52, 54],
          unit: 63,
          label: '親会社の所有者に帰属する四半期利益',
          expected: 2217,
        },
      ],
    },
    {
      index: 2,
      period: '2026年5月期',
      context: [32, 33],
      row: [47],
      subject: '株式会社ギークリー',
      basis: '日本基準',
      scope: '非連結',
      periodKind: 'fullYear',
      cases: [
        { value: 48, metric: [35], unit: 39, label: '売上高', expected: 9783 },
        { value: 50, metric: [36], unit: 41, label: '営業利益', expected: 2156 },
        { value: 54, metric: [38], unit: 45, label: '当期純利益', expected: 1516 },
      ],
    },
    {
      index: 3,
      period: '2026年11月期中間期',
      context: [32, 33],
      row: [48],
      subject: '株式会社CaSy',
      basis: '日本基準',
      scope: '連結',
      periodKind: 'cumulativeQ2',
      cases: [
        { value: 49, metric: [36], unit: 40, label: '売上高', expected: 1033 },
        { value: 51, metric: [37], unit: 42, label: '営業利益', expected: -6 },
        {
          value: 55,
          metric: [35, 39],
          unit: 46,
          label: '親会社株主に帰属する中間純利益',
          expected: -5,
        },
      ],
    },
  ])('日本基準/IFRS/赤字: $subject', (entry) => {
    const source = extract(corpus[entry.index]);
    const facts = entry.cases.map((c) =>
      table(
        1,
        c.value,
        c.label,
        c.expected,
        entry.period,
        'actual',
        c.metric,
        entry.row,
        [c.unit],
        entry.context,
        ['p1b1', 'p1b3'],
        {
          subject: entry.subject,
          scope: entry.scope,
          basis: entry.basis,
          periodKind: entry.periodKind as FactSemantics['periodKind'],
        }
      )
    );
    const result = parse(facts, source);
    expect(result.unverified).toEqual([]);
    expect(result.facts.map((f) => f.value)).toEqual(entry.cases.map((c) => c.expected));
  });
});
const blue = extract(semanticCorpus[0]);
const blueProfit = table(
  1,
  294,
  '親会社株主に帰属する当期純利益',
  -400,
  '2027年3月期通期',
  'forecast',
  [265, 271],
  [282, 283],
  [279],
  [262, 263],
  ['p1b1', 'p1b3'],
  { subject: '株式会社BlueMeme' }
);
const blueRate = {
  ...table(
    1,
    120,
    '売上高営業利益率',
    1.4,
    '2026年3月期',
    'actual',
    [97, 103],
    [110, 111],
    [109],
    [],
    ['p1b1', 'p1b3', 'p1b9'],
    { subject: '株式会社BlueMeme', metricKind: 'rate' }
  ),
  unit: '%',
};
describe('BlueMemeの正しい採用と誤対応の拒否', () => {
  it('EPS見出しが隣接していても−400を採用する', () => {
    const r = parse([blueProfit], blue);
    expect(r.unverified).toEqual([]);
    expect(r.facts[0].value).toBe(-400);
  });
  it('数量の小数を全断片から確認し1%を拒否する', () => {
    const r = parse([blueRate], blue);
    expect(r.unverified).toEqual([]);
    expect(r.facts[0].quantity?.decimal).toBe('1.4');
    expect(parse([{ ...blueRate, value: 1 }], blue).facts).toHaveLength(0);
  });
  it('EPSの見出し参照を純利益の指標に混ぜない', () =>
    expect(
      parse(
        [
          {
            ...blueProfit,
            evidence: {
              ...blueProfit.evidence,
              metricIds: refs(1, [265, 266, 271]),
            } as FactEvidence,
          },
        ],
        blue
      ).facts
    ).toHaveLength(0));
});
