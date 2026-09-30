import { describe, expect, it } from 'vitest';
import { parseFactSummary, type VerifiedFact } from './fact-summary';
import { validateScoreInput, type ScoreDocument } from './score-extraction';
import { serializePagesForAnalysis } from './page-text';
import type { ExtractedPage } from '@/types/summaryMetadata';
import type { PdfSpan } from './pdf-layout';
import type { ScoreSource } from './scoring';

const span = (id: string, text: string, x: number, y: number, width = 40): PdfSpan => ({
  id,
  text,
  x,
  y,
  width,
  height: 10,
});
const url = 'https://issuer.example/report.pdf';
const document = (page: ExtractedPage): ScoreDocument => ({
  url,
  text: serializePagesForAnalysis([page]),
  pages: [page],
  publishedDate: '2026-07-14',
  issuer: '会社',
  code: '1234',
});
const source = (period: string, periodKind: ScoreSource['periodKind']): ScoreSource => ({
  url,
  page: 1,
  quote: '',
  period,
  periodKind,
  fiscalYear: 2026,
  valueKind: 'actual',
  metric: '営業利益',
  basis: '日本基準',
  scope: '連結',
  evidence: {
    valueId: 'value',
    metricIds: ['metric'],
    periodIds: ['period'],
    unitIds: ['unit'],
    contextIds: ['context'],
  },
});
const input = (source: ScoreSource, value = 200, unit = '百万円') =>
  JSON.stringify({
    claims: [
      {
        category: 'kpi',
        label: source.metric,
        current: { value, unit, source },
        previous: null,
        earlier: null,
        relatedValue: null,
        companyExplanation: null,
      },
    ],
    unverified: [],
  });
const quarterlyPage = (quarter: 2 | 3, scope = '累計'): ExtractedPage => ({
  pageNumber: 1,
  text: `会社 日本基準 連結\n2026年3月期 第${quarter}四半期連結${scope}期間\n売上高 営業利益\n百万円 百万円\n2026年3月期第${quarter}四半期 100 200`,
  spans: [
    span('context', `2026年3月期 第${quarter}四半期連結${scope}期間`, 0, 0, 400),
    span('revenue', '売上高', 200, 20),
    span('metric', '営業利益', 300, 20),
    span('revenueUnit', '百万円', 200, 40),
    span('unit', '百万円', 300, 40),
    span('period', `2026年3月期第${quarter}四半期`, 0, 60, 150),
    span('revenueValue', '100', 205, 60, 30),
    span('value', '200', 305, 60, 30),
  ],
});

describe('表の根拠に基づく採点期間', () => {
  it.each([2, 3] as const)('第%d四半期の累計区分を参照済み見出しから確認する', (quarter) => {
    const rawSource = source(`2026年3月期第${quarter}四半期`, `cumulativeQ${quarter}`);
    const result = validateScoreInput(input(rawSource), [document(quarterlyPage(quarter))], '');
    expect(result.unverified).toEqual([]);
    expect(result.claims).toHaveLength(1);
    expect(result.claims[0].current.source.period).toBe(rawSource.period);
    expect(result.claims[0].current.source.quote).toContain('連結累計期間');
  });
  it('参照していない累計見出しでは採点期間を補えない', () => {
    const rawSource = source('2026年3月期第2四半期', 'cumulativeQ2');
    rawSource.evidence!.contextIds = [];
    expect(
      validateScoreInput(input(rawSource), [document(quarterlyPage(2))], '').claims
    ).toHaveLength(0);
  });
  it('単独期間と四半期の取り違えを拒否する', () => {
    const rawSource = source('2026年3月期第2四半期', 'cumulativeQ2');
    expect(
      validateScoreInput(input(rawSource), [document(quarterlyPage(2, '単独'))], '').claims
    ).toHaveLength(0);
    expect(
      validateScoreInput(input(rawSource), [document(quarterlyPage(3))], '').claims
    ).toHaveLength(0);
  });
  it('累計の根拠が欠けていればperiodの累計表記だけでも通さない', () => {
    const rawSource = source('2026年3月期第2四半期累計', 'cumulativeQ2');
    rawSource.evidence!.contextIds = [];
    expect(
      validateScoreInput(input(rawSource), [document(quarterlyPage(2))], '').claims
    ).toHaveLength(0);
  });
});

it.each(['inline', 'column'] as const)('単一数量表の%s単位を要約と採点で共有する', (unitKind) => {
  const page: ExtractedPage = {
    pageNumber: 1,
    text: '会社 普通株式\n2026年7月14日\n取得上限株式数 100株',
    spans: [
      span('period', '2026年7月14日', 180, 0, 80),
      span('metric', '取得上限株式数', 0, 40, 100),
      span('value', unitKind === 'inline' ? '100株' : '100', 205, 40, 40),
      ...(unitKind === 'inline' ? [] : [span('unit', '株', 205, 20)]),
    ],
  };
  const rawSource = {
    ...source('2026年7月14日', 'eventDate'),
    metric: '取得上限株式数',
    basis: '非財務',
    scope: '普通株式',
    evidence: {
      valueId: 'value',
      metricIds: ['metric'],
      periodIds: ['period'],
      unitIds: [unitKind === 'inline' ? 'value' : 'unit'],
      contextIds: [],
    },
  };
  const fact: VerifiedFact = {
    id: 'f1',
    importance: 'key',
    kind: 'number',
    label: rawSource.metric,
    value: 100,
    unit: '株',
    period: rawSource.period,
    valueKind: 'actual',
    column: null,
    statement: null,
    page: 1,
    quote: '',
    evidence: rawSource.evidence,
  };
  const facts = parseFactSummary(
    JSON.stringify({
      version: 3,
      documentType: 'shareRepurchase',
      facts: [fact],
      unverified: [],
    }),
    'shareRepurchase',
    [page]
  );
  const score = validateScoreInput(input(rawSource, 100, '株'), [document(page)], '');
  expect(facts.unverified).toEqual([]);
  expect(facts.facts).toHaveLength(1);
  expect(score.unverified).toEqual([]);
  expect(score.claims).toHaveLength(1);
  expect(score.claims[0].current.source.evidence).toEqual(facts.facts[0].evidence);
});
