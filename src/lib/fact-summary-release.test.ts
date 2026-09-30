import { describe, expect, it, vi } from 'vitest';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';
import corpus from './fixtures/pdf-layout-corpus.json';
import { extractPageLayout } from './pdf-layout';
import {
  parseFactSummary,
  generateVerifiedFactSummary,
  renderFacts,
  type VerifiedFact,
} from './fact-summary';

import { generateText } from './llm-client';
import { serializePagesForAnalysis } from './page-text';
import { extractScoreInput } from './score-extraction';
import { inferExperimentalScore } from './scoring';
import { buildSummaryHtml } from '../content/utils/summaryHtmlBuilder';
vi.mock('./llm-client', () => ({ generateText: vi.fn() }));

const pages = corpus[0].pages.map((p) => extractPageLayout(p.items as TextItem[], p.pageNumber));
const ids = (page: number, numbers: number[]) => numbers.map((n) => `p${page}s${n}`);
const actualMetrics = [[31], [32], [33], [34], [30, 35]];
const forecastMetrics = [[5], [6], [7], [8], [3, 9]];
const make = (
  page: number,
  value: number,
  metric: number[],
  period: number[],
  unit: number[],
  context: number[]
): VerifiedFact => {
  const spans = pages[page - 1].spans;
  const get = (ns: number[]) =>
    ns.map((n) => spans.find((s) => s.id === `p${page}s${n}`)!.text).join('');
  return {
    id: 'f1',
    importance: 'key',
    kind: 'number',
    label: get(metric),
    value: Number(get([value]).replace(/,/g, '')),
    unit: get(unit),
    period: page === 1 ? '2027年5月期第1四半期' : '2027年5月期通期',
    valueKind: page === 1 ? 'actual' : 'forecast',
    column: null,
    statement: null,
    page,
    quote: '',
    evidence: {
      valueId: `p${page}s${value}`,
      metricIds: ids(page, metric),
      periodIds: ids(page, period),
      unitIds: ids(page, unit),
      contextIds: ids(page, context),
    },
  };
};
const financial = [
  ...actualMetrics.map((m, i) => make(1, 47 + i * 2, m, [46], [36 + i * 2], [27, 28])),
  ...forecastMetrics.map((m, i) => make(2, 35 + i * 2, m, [34], [11 + i * 2], [1])),
].map((f, i) => ({ ...f, id: `f${i + 1}` }));
const dividend = {
  ...make(1, 137, [114, 119], [133], [124], [113]),
  id: 'f11',
  label: '年間配当金',
  period: '2027年5月期',
  valueKind: 'forecast' as const,
};
const parse = (facts: VerifiedFact[], coverage = false, source = pages) =>
  parseFactSummary(
    JSON.stringify({ version: 3, documentType: 'earnings', facts, unverified: [] }),
    'earnings',
    source,
    coverage
  );

describe('位置情報を保持した報告PDFの照合', () => {
  it('EBITDAを含む実績・通期予想を指標別の列番号なしで照合する', () => {
    const result = parse([...financial, dividend], true);
    expect(result.unverified).toEqual([]);
    expect(result.facts).toHaveLength(11);
    expect(parse(result.facts).facts).toEqual(result.facts);
  });
  it('PDFの指標名に文字間の空白があっても必須項目として扱う', () => {
    const facts = [...financial, dividend].map((fact) => ({
      ...fact,
      label: [...fact.label].join(' '),
    }));
    expect(parse(facts, true).facts).toHaveLength(11);
  });
  it('同じ表の別指標・前年・中間予想・増減率を拒否する', () => {
    for (const [index, id, value] of [
      [2, 'p1s49', 589],
      [2, 'p1s52', 11.1],
      [2, 'p1s62', 483],
      [4, 'p1s53', 533],
      [7, 'p2s27', 1046],
    ] as const) {
      const fact = financial[index];
      const result = parse([{ ...fact, value, evidence: { ...fact.evidence!, valueId: id } }]);
      expect(result.facts, id).toHaveLength(0);
    }
  });
  it('参照欠落、未知項目、旧スキーマを拒否する', () => {
    expect(
      parse([{ ...financial[0], evidence: { ...financial[0].evidence!, valueId: 'unknown' } }])
        .facts
    ).toHaveLength(0);
    expect(() =>
      parseFactSummary(
        JSON.stringify({ version: 2, documentType: 'earnings', facts: financial, unverified: [] }),
        'earnings',
        pages
      )
    ).toThrow('形式');
    expect(
      parse([
        { ...financial[0], evidence: { ...financial[0].evidence!, extra: 'unknown' } as never },
      ]).facts
    ).toHaveLength(0);
  });
});

it.each([
  {
    index: 1,
    period: '2027年2月期第1四半期',
    context: [42, 43, 44],
    row: [67, 68],
    cases: [
      { value: 69, metric: [48], unit: 55, expected: 43277 },
      { value: 72, metric: [49], unit: 57, expected: 3378 },
      { value: 81, metric: [46, 52, 54], unit: 63, expected: 2217 },
    ],
  },
  {
    index: 2,
    period: '2026年5月期',
    context: [32, 33],
    row: [47],
    cases: [
      { value: 48, metric: [35], unit: 39, expected: 9783 },
      { value: 50, metric: [36], unit: 41, expected: 2156 },
      { value: 54, metric: [38], unit: 45, expected: 1516 },
    ],
  },
  {
    index: 3,
    period: '2026年11月期中間期',
    context: [32, 33],
    row: [48],
    cases: [
      { value: 49, metric: [36], unit: 40, expected: 1033 },
      { value: 51, metric: [37], unit: 42, expected: -6 },
      { value: 55, metric: [35, 39], unit: 46, expected: -5 },
    ],
  },
])('他社PDF $index の実績を同じ検証器で確認する', ({ index, period, context, row, cases }) => {
  const source = corpus[index].pages.map((p) =>
    extractPageLayout(p.items as TextItem[], p.pageNumber)
  );
  const facts = cases.map(
    (c, i): VerifiedFact => ({
      ...financial[0],
      id: `f${i + 1}`,
      label: c.metric.map((n) => source[0].spans.find((s) => s.id === `p1s${n}`)!.text).join(''),
      value: c.expected,
      period,
      evidence: {
        valueId: `p1s${c.value}`,
        metricIds: ids(1, c.metric),
        unitIds: ids(1, [c.unit]),
        periodIds: ids(1, row),
        contextIds: ids(1, context),
      },
    })
  );
  const result = parse(facts, false, source);
  expect(result.unverified).toEqual([]);
  expect(result.facts.map((f) => f.value)).toEqual(cases.map((c) => c.expected));
  for (const fact of facts) {
    expect(parse([{ ...fact, period: '2025年5月期' }], false, source).facts).toHaveLength(0);
    expect(parse([{ ...fact, valueKind: 'forecast' }], false, source).facts).toHaveLength(0);
  }
});

it('構造化応答の検証から要約表示・前年値の採点まで根拠を引き継ぐ', async () => {
  const config = { provider: 'openai', model: 'test', apiKey: 'test' };
  vi.mocked(generateText).mockResolvedValueOnce(
    JSON.stringify({
      version: 3,
      documentType: 'earnings',
      facts: [...financial, dividend],
      unverified: [],
    })
  );
  const summary = await generateVerifiedFactSummary(
    config,
    'earnings',
    serializePagesForAnalysis(pages),
    pages
  );
  expect(summary.repairAttempted).toBe(false);
  const current = summary.facts.facts.find((f) => f.id === 'f3')!;
  const url = 'https://www.release.tdnet.info/inbs/140120260929541758.pdf';
  const source = {
    url,
    page: 1,
    quote: '',
    period: current.period!,
    fiscalYear: 2027,
    periodKind: 'cumulativeQ1',
    valueKind: 'actual',
    metric: current.label,
    basis: '日本基準',
    scope: '連結',
    evidence: current.evidence,
  };
  const scoreReply = {
    claims: [
      {
        category: 'operatingProfit',
        label: '営業利益',
        current: { value: 536, unit: '百万円', source },
        previous: {
          value: 483,
          unit: '百万円',
          source: {
            ...source,
            period: '2026年5月期第1四半期',
            fiscalYear: 2026,
            evidence: { ...source.evidence!, valueId: 'p1s62', periodIds: ['p1s57'] },
          },
        },
        earlier: null,
        relatedValue: null,
        companyExplanation: null,
      },
    ],
    unverified: [],
  };
  const document = {
    url,
    text: serializePagesForAnalysis(pages),
    pages,
    issuer: 'フィードフォースグループ株式会社',
    code: '7068',
    publishedDate: '2026-09-29',
  };
  vi.mocked(generateText).mockResolvedValueOnce(JSON.stringify(scoreReply));
  const input = await extractScoreInput(
    config,
    'earnings',
    [document],
    '元PDF内を確認',
    summary.facts
  );
  expect(input.unverified).toEqual([]);
  expect(input.claims).toHaveLength(1);
  expect(input.claims[0].current.source.evidence).toEqual(current.evidence);
  vi.mocked(generateText).mockResolvedValueOnce(
    JSON.stringify({ value: 65, factors: [{ index: 0, impact: 'positive', strength: 'small' }] })
  );
  const score = await inferExperimentalScore(config, 'earnings', input);
  const html = buildSummaryHtml(
    renderFacts(summary.facts),
    null,
    { companyName: document.issuer, title: '決算短信' },
    { loading: false, data: score, error: null }
  );
  expect(html).toContain('536百万円');
  expect(html).toContain('材料スコア:');
  expect(html.indexOf('材料スコア:')).toBeGreaterThan(html.indexOf('536百万円'));
  const prompt = vi.mocked(generateText).mock.calls[0][1][1].content;
  expect(prompt).toContain('p1s51');
  // 同額の別指標を要約済みとして扱えない。
  const mismatched = {
    ...summary.facts,
    facts: summary.facts.facts.map((f) => (f.id === 'f3' ? { ...f, label: 'EBITDA' } : f)),
  };
  vi.mocked(generateText).mockResolvedValueOnce(JSON.stringify(scoreReply));
  expect(
    (await extractScoreInput(config, 'earnings', [document], '元PDF内を確認', mismatched)).claims
  ).toHaveLength(0);
});
