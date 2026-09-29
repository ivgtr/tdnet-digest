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
  it('IFRS決算の親会社所有者帰属利益を必須の利益項目として認識する', () => {
    const source = [
      {
        pageNumber: 1,
        text: '2026年3月期 決算短信〔IFRS〕\n売上収益100百万円\n営業利益20百万円\n親会社の所有者に帰属する当期利益10百万円',
      },
    ];
    const items = [
      ['売上収益', 100],
      ['営業利益', 20],
      ['親会社の所有者に帰属する当期利益', 10],
    ].map(([label, value], index) => ({
      id: `f${index + 1}`,
      importance: 'key',
      kind: 'number',
      label,
      value,
      unit: '百万円',
      period: '2026年3月期',
      valueKind: 'actual',
      column: null,
      statement: null,
      page: 1,
      quote: `${label}${value}百万円`,
    }));
    const result = parseFactSummary(
      JSON.stringify({ version: 2, documentType: 'earnings', facts: items, unverified: [] }),
      'earnings',
      source
    );
    expect(result.facts).toHaveLength(3);
  });
  it('業績予想が未定なら実績の要約を通し、数値予想があれば必須項目を確認する', () => {
    const actual = [
      ['売上高', 100],
      ['営業利益', 20],
      ['親会社株主に帰属する当期純利益', 10],
    ].map(([label, value], index) => ({
      ...fact,
      id: `f${index + 1}`,
      label,
      value,
      period: '2026年3月期',
      valueKind: 'actual',
      column: null,
      quote: `${label}${value}百万円`,
    }));
    const actualText =
      '2026年3月期 決算短信\n売上高100百万円\n営業利益20百万円\n親会社株主に帰属する当期純利益10百万円';
    const raw = JSON.stringify({
      version: 2,
      documentType: 'earnings',
      facts: actual,
      unverified: [],
    });
    expect(
      parseFactSummary(raw, 'earnings', [
        { pageNumber: 1, text: `${actualText}\n業績予想については未定です` },
      ]).facts
    ).toHaveLength(3);
    expect(() =>
      parseFactSummary(raw, 'earnings', [
        {
          pageNumber: 1,
          text: `${actualText}\n業績予想\n売上高 営業利益 親会社株主に帰属する当期純利益\n百万円 百万円 百万円\n通期 110 25 15`,
        },
      ])
    ).toThrow('通期予想の重要指標');
    expect(() =>
      parseFactSummary(raw, 'earnings', [
        {
          pageNumber: 1,
          text: `${actualText}\n業績予想は売上高110百万円、営業利益25百万円、親会社株主に帰属する当期純利益15百万円です`,
        },
      ])
    ).toThrow('通期予想の重要指標');
  });
  it('IFRSの表では当期利益の次の親会社帰属利益列を照合する', () => {
    const source = [
      {
        pageNumber: 1,
        text: '2027年2月期第1四半期 決算短信〔IFRS〕\n親会社の所有者\n売上収益 営業利益 税引前利益 四半期利益 に帰属する 四半期包括利益\n四半期利益\n百万円 ％ 百万円 ％ 百万円 ％ 百万円 ％ 百万円 ％ 百万円 ％\n2027年2月期 第1四半期 43,277 3.5 3,378 10.8 3,221 7.7 2,359 4.2 2,217 6.2 2,603 34.4',
      },
    ];
    const quote = source[0].text.split('\n').slice(1).join('\n');
    const candidate = {
      ...fact,
      label: '親会社の所有者に帰属する四半期利益',
      value: 2217,
      period: '2027年2月期第1四半期',
      valueKind: 'actual',
      column: '親会社の所有者に帰属する四半期利益',
      quote,
    };
    const parse = (value: number) =>
      parseFactSummary(
        JSON.stringify({
          version: 2,
          documentType: 'earnings',
          facts: [{ ...candidate, value }],
          unverified: [],
        }),
        'earnings',
        source,
        false
      );
    expect(parse(2217).facts.map((item) => item.value)).toEqual([2217]);
    expect(parse(2359).facts).toHaveLength(0);
    const withoutStandalone = [
      {
        pageNumber: 1,
        text: '2027年2月期第1四半期 決算短信〔IFRS〕\n売上収益 営業利益 税引前利益 親会社の所有者に帰属する四半期利益\n百万円 ％ 百万円 ％ 百万円 ％ 百万円 ％\n2027年2月期第1四半期 43,277 3.5 3,378 10.8 3,221 7.7 2,217 6.2',
      },
    ];
    const noExtra = parseFactSummary(
      JSON.stringify({
        version: 2,
        documentType: 'earnings',
        facts: [{ ...candidate, quote: withoutStandalone[0].text.split('\n').slice(1).join('\n') }],
        unverified: [],
      }),
      'earnings',
      withoutStandalone,
      false
    );
    expect(noExtra.facts.map((item) => item.value)).toEqual([2217]);
  });
  it('△と▲で表した損失を負数として照合する', () => {
    for (const sign of ['△', '▲', '△ ', '▲ ']) {
      const source = [{ pageNumber: 1, text: `2026年3月期 決算短信\n営業利益 ${sign}2,000百万円` }];
      const parse = (value: number) =>
        parseFactSummary(
          JSON.stringify({
            version: 2,
            documentType: 'earnings',
            facts: [
              {
                ...fact,
                value,
                period: '2026年3月期',
                valueKind: 'actual',
                column: null,
                quote: `営業利益 ${sign}2,000百万円`,
              },
            ],
            unverified: [],
          }),
          'earnings',
          source,
          false
        );
      expect(parse(-2000).facts.map((item) => item.value)).toEqual([-2000]);
      expect(parse(2000).facts).toHaveLength(0);
    }
  });
  it('通期決算表の年度を数値列と取り違えない', () => {
    const source = [
      {
        pageNumber: 1,
        text: '2026年5月期 決算短信\n売上高 営業利益 経常利益 当期純利益\n百万円 ％ 百万円 ％ 百万円 ％ 百万円 ％\n2026年5月期 9,783 36.9 2,156 206.4 2,130 202.3 1,516 207.2',
      },
    ];
    const quoted = source[0].text.split('\n').slice(1).join('\n');
    const candidate = {
      ...fact,
      value: 2156,
      valueKind: 'actual',
      period: '2026年5月期',
      column: '営業利益',
      quote: quoted,
    };
    const result = parseFactSummary(
      JSON.stringify({ version: 2, documentType: 'earnings', facts: [candidate], unverified: [] }),
      'earnings',
      source,
      false
    );
    expect(result.facts.map((item) => item.value)).toEqual([2156]);
    const wrong = parseFactSummary(
      JSON.stringify({
        version: 2,
        documentType: 'earnings',
        facts: [{ ...candidate, value: 9783 }],
        unverified: [],
      }),
      'earnings',
      source,
      false
    );
    expect(wrong.facts).toHaveLength(0);
  });
  it('増減率のない通期予想表では純利益と1株利益を別の列として照合する', () => {
    const source = [
      {
        pageNumber: 1,
        text: '2027年5月期 業績予想\n売上高 営業利益 経常利益 親会社株主に帰属する当期純利益 1株当たり当期純利益\n百万円 百万円 百万円 百万円 円\n2027年5月期(予想) 11,000 2,300 2,200 1,600 10.5',
      },
    ];
    const quote = source[0].text.split('\n').slice(1).join('\n');
    const candidate = {
      ...fact,
      label: '親会社株主に帰属する当期純利益',
      value: 1600,
      period: '2027年5月期',
      valueKind: 'forecast',
      column: '親会社株主に帰属する当期純利益',
      quote,
    };
    const parse = (value: number) =>
      parseFactSummary(
        JSON.stringify({
          version: 2,
          documentType: 'earnings',
          facts: [{ ...candidate, value }],
          unverified: [],
        }),
        'earnings',
        source,
        false
      );
    expect(parse(1600).facts.map((item) => item.value)).toEqual([1600]);
    expect(parse(10.5).facts).toHaveLength(0);
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
