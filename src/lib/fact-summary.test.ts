import { describe, expect, it, vi } from 'vitest';
import { generateText } from './llm-client';
import { generateVerifiedFactSummary, parseFactSummary, renderFacts } from './fact-summary';

vi.mock('./llm-client', () => ({ generateText: vi.fn() }));

const pages = [
  { pageNumber: 1, text: '2026年通期\n単位: 百万円\n営業利益 100 1150\n前回予想 今回予想' },
];
const fact = {
  id: 'f1',
  importance: 'key',
  kind: 'number',
  label: '営業利益',
  value: 1150,
  unit: '百万円',
  period: '2026年通期',
  valueKind: 'forecastAfter',
  column: '今回予想',
  statement: null,
  page: 1,
  quote: '営業利益 100 1150\n前回予想 今回予想',
};
const raw = (item: unknown) =>
  JSON.stringify({ version: 2, documentType: 'other', facts: [item], unverified: [] });

describe('事実要約の原文照合', () => {
  it('数値・単位・期間・物理ページと連続引用を確認して表示する', () => {
    const checked = parseFactSummary(raw(fact), 'other', pages);
    expect(renderFacts(checked)).toContain('1150百万円（2026年通期');
    expect(renderFacts(checked)).toContain('PDF p.1');
  });
  it('離れた行の擬似引用を拒否する', () => {
    expect(() =>
      parseFactSummary(raw({ ...fact, quote: '2026年通期\n営業利益 100 1150' }), 'other', pages)
    ).toThrow('連続引用');
  });
  it('誤った数値、単位、期間、ページ、列を拒否する', () => {
    for (const change of [
      { value: 1200 },
      { unit: '億円' },
      { period: '2027年通期' },
      { page: 2 },
      { column: '修正後' },
    ]) {
      expect(() => parseFactSummary(raw({ ...fact, ...change }), 'other', pages)).toThrow();
    }
  });
  it('決算短信では年度のない対象期間を採用しない', () => {
    const source = [
      {
        pageNumber: 1,
        text: '2026年9月期通期\n単位: 百万円\n営業利益 100 1150\n前回予想 今回予想',
      },
    ];
    const candidate = {
      ...fact,
      valueKind: 'forecast',
      period: '通期',
    };
    const result = parseFactSummary(
      JSON.stringify({ version: 2, documentType: 'earnings', facts: [candidate], unverified: [] }),
      'earnings',
      source,
      false
    );
    expect(result.facts).toHaveLength(0);
    expect(result.unverified.join('')).toContain('対象年度と決算月');
  });
  it('同じ表にある別列の値を営業利益として採用しない', () => {
    expect(() => parseFactSummary(raw({ ...fact, value: 100 }), 'other', pages)).toThrow(
      '重要事実'
    );
  });
  it('複数の指標が続く説明文は指標名と数値と単位の直接対応を確認する', () => {
    const narrative = [{ pageNumber: 1, text: '2026年通期\n売上高3,393千円、営業利益634千円' }];
    const item = {
      ...fact,
      value: 634,
      unit: '千円',
      column: null,
      quote: narrative[0].text.split('\n')[1],
    };
    expect(parseFactSummary(raw(item), 'other', narrative).facts).toHaveLength(1);
    expect(() => parseFactSummary(raw({ ...item, value: 3393 }), 'other', narrative)).toThrow(
      '重要事実'
    );
  });
  it('未知項目を拒否する', () => {
    expect(() => parseFactSummary(raw({ ...fact, rating: 5 }), 'other', pages)).toThrow('形式');
  });
  it('修復時は検証済み事実を保持し、不足した決定事項だけを補う', async () => {
    const source = [
      {
        pageNumber: 1,
        text: '2026年通期\n単位: 百万円\n営業利益 100 1150\n前回予想 今回予想\n基本合意書を締結',
      },
    ];
    const event = {
      id: 'f2',
      importance: 'key',
      kind: 'event',
      label: '基本合意',
      value: null,
      unit: null,
      period: null,
      valueKind: null,
      column: null,
      statement: '基本合意書を締結',
      page: 1,
      quote: '基本合意書を締結',
    };
    const reply = (items: unknown[]) =>
      JSON.stringify({ version: 2, documentType: 'ma', facts: items, unverified: [] });
    vi.mocked(generateText)
      .mockResolvedValueOnce(reply([fact, { ...event, quote: '存在しない引用' }]))
      .mockResolvedValueOnce(reply([{ ...fact, period: '通期' }, event]));
    const result = await generateVerifiedFactSummary(
      { provider: 'openai', model: 'test', apiKey: 'test' },
      'ma',
      source[0].text,
      source
    );
    expect(result.repairAttempted).toBe(true);
    expect(result.facts.facts.map((item) => item.id)).toEqual(['f1', 'f2']);
    expect(result.facts.facts[0].period).toBe('2026年通期');
  });
});
