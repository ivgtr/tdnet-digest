import { describe, expect, it } from 'vitest';
import {
  verifyTableEvidence,
  verifyPeriodAndKind,
  verifyProseEvidence,
  type NumericClaim,
  type TableEvidence,
} from './numeric-evidence';
import { extractPageLayout } from './pdf-layout';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';
import type { PdfSpan } from './pdf-layout';
import type { ExtractedPage as FullPage } from '@/types/summaryMetadata';
type ExtractedPage = Pick<FullPage, 'pageNumber' | 'text' | 'spans'>;

const span = (id: string, text: string, x: number, y: number, width = 40): PdfSpan => ({
  id,
  text,
  x,
  y,
  width,
  height: 10,
});

const spans = [
  span('context', '2027年5月期 業績予想', 0, 0, 280),
  span('m1', '独自KPI', 200, 20),
  span('m2', '営業利益', 300, 20),
  span('u1', '百万円', 200, 40),
  span('u2', '百万円', 300, 40),
  span('r1', '通期', 0, 60),
  span('v1', '100', 205, 60, 30),
  span('v2', '200', 305, 60, 30),
  span('r2', '第2四半期', 0, 80, 80),
  span('v3', '50', 210, 80, 20),
  span('v4', '100', 305, 80, 30),
];
const page: ExtractedPage = { pageNumber: 1, text: '', spans };
const evidence: TableEvidence = {
  valueId: 'v2',
  metricIds: ['m2'],
  periodIds: ['r1'],
  unitIds: ['u2'],
  contextIds: ['context'],
};
const claim: NumericClaim = {
  label: '営業利益',
  value: 200,
  unit: '百万円',
  period: '2027年5月期通期',
  valueKind: 'forecast',
};

describe('本文の指標と数量の対応', () => {
  const proseClaim = { ...claim, label: '取得価額の総額', value: 10, unit: '億円' };
  it.each([
    '',
    'は',
    'は、',
    'が',
    '：',
    '（',
    'については',
    'に関しては',
    'に対しては',
    'においては',
    'として',
    'としては',
    'については、',
  ])('指標と数量の間の「%s」を照合する', (bridge) => {
    const quote = `取得価額の総額${bridge}10億円です。`;
    expect(verifyProseEvidence({ pageNumber: 1, text: quote, spans: [] }, quote, proseClaim)).toBe(
      0
    );
  });
  it.each([
    '取得価額の総額は営業利益が10億円です。',
    '取得価額の総額は5億円、営業利益は10億円です。',
    '取得価額の総額。10億円です。',
    '取得価額の総額ははははははは10億円です。',
    '取得価額の総額は110億円です。',
    '取得価額の総額は10.1億円です。',
    '取得価額の総額は10百万円です。',
    '取得価額の総額については、（10億円です。',
    '取得価額の総額については営業利益が10億円です。',
    '取得価額の総額については5億円、営業利益は10億円です。',
    '取得価額の総額ではなく10億円です。',
    '取得価額の総額については約10億円です。',
    '取得価額の総額としては最大10億円です。',
  ])('別指標・別数値・非連続な対応を拒否する: %s', (quote) => {
    expect(() =>
      verifyProseEvidence({ pageNumber: 1, text: quote, spans: [] }, quote, proseClaim)
    ).toThrow();
  });
});

describe('非財務単位を持つ表', () => {
  it.each([
    ['店舗', 120],
    ['人', 500],
    ['件', 30],
    ['kWh', 50],
    ['千kWh', 50],
    ['百万kWh', 50],
    ['千トン', 50],
    ['㎡', 120],
  ] as const)('%s単位を値と一体でも列見出しでも照合する', (unit, value) => {
    for (const inline of [true, false]) {
      const source = {
        ...page,
        spans: spans.map((s) =>
          s.id === 'u2'
            ? { ...s, text: unit }
            : s.id === 'v2'
              ? { ...s, text: `${value}${inline ? unit : ''}` }
              : s
        ),
      };
      const refs = { ...evidence, unitIds: [inline ? 'v2' : 'u2'] };
      expect(verifyTableEvidence(source, refs, { ...claim, value, unit }).evidence.valueId).toBe(
        'v2'
      );
      expect(() => verifyTableEvidence(source, refs, { ...claim, value, unit: '株' })).toThrow(
        '単位'
      );
      expect(() => verifyTableEvidence(source, refs, { ...claim, value: value + 1, unit })).toThrow(
        '値'
      );
    }
  });
  it('隣接した数値と語のPDFアイテムを別IDで保持し、円銭だけを数量として結合する', () => {
    const item = (str: string, x: number, width: number): TextItem => ({
      str,
      dir: 'ltr',
      transform: [10, 0, 0, 10, x, 100],
      width,
      height: 10,
      fontName: 'test',
      hasEOL: false,
    });
    const result = extractPageLayout(
      [item('120', 0, 20), item('店舗', 23, 20), item('合計', 46, 20)],
      1
    );
    expect(result.spans.map((s) => s.text)).toEqual(['120', '店舗', '合計']);
    for (const gap of [0, 1, 3, 6]) {
      for (const label of ['合計', '営 業利益', '(合計)', '1店舗当たり売上', '対象事業']) {
        const split = extractPageLayout([item('120', 0, 20), item(label, 20 + gap, 40)], 1);
        expect(split.spans.map((s) => s.text)).toEqual(['120', label]);
        expect(new Set(split.spans.map((s) => s.id)).size).toBe(2);
      }
    }
    expect(
      extractPageLayout([item('15円00', 0, 30), item('銭', 33, 10)], 1).spans.map((s) => s.text)
    ).toEqual(['15円00銭']);
  });
  it.each(['店舗', '人', '件', 'kWh', '㎡'])('別IDの隣接%s単位を照合する', (unit) => {
    const source = {
      ...page,
      spans: spans
        .filter((s) => s.id !== 'u2')
        .map((s) => (s.id === 'v2' ? { ...s, text: '120' } : s))
        .concat(span('adjacentUnit', unit, 338, 60, 20)),
    };
    const refs = { ...evidence, unitIds: ['adjacentUnit'] };
    expect(
      verifyTableEvidence(source, refs, { ...claim, value: 120, unit }).evidence.unitIds
    ).toEqual(['adjacentUnit']);
    for (const change of [{ x: 350 }, { y: 80 }]) {
      const invalid = {
        ...source,
        spans: source.spans.map((s) => (s.id === 'adjacentUnit' ? { ...s, ...change } : s)),
      };
      expect(() => verifyTableEvidence(invalid, refs, { ...claim, value: 120, unit })).toThrow();
    }
  });
  it('複数IDの隣接単位を照合し、参照間の別セルを跨がない', () => {
    const source = {
      ...page,
      spans: spans
        .filter((s) => s.id !== 'u2')
        .concat(span('unit1', '百', 338, 60, 10), span('unit2', '万円', 351, 60, 20)),
    };
    const refs = { ...evidence, unitIds: ['unit1', 'unit2'] };
    expect(verifyTableEvidence(source, refs, claim).evidence.unitIds).toEqual(['unit1', 'unit2']);
    const invalid = { ...source, spans: source.spans.concat(span('other', '注', 349, 60, 1)) };
    expect(() => verifyTableEvidence(invalid, refs, claim)).toThrow();
  });
  it.each([
    ['百', '万円', '百万円'],
    ['k', 'Wh', 'kWh'],
    ['m', '2', '㎡'],
  ] as const)('値セル内の%sと隣接%sを単位として照合する', (prefix, suffix, unit) => {
    const source = {
      ...page,
      spans: spans
        .filter((s) => s.id !== 'u2')
        .map((s) => (s.id === 'v2' ? { ...s, text: `120${prefix}` } : s))
        .concat(span('unitSuffix', suffix, 338, 60, 20)),
    };
    const refs = { ...evidence, unitIds: ['unitSuffix', 'v2'] };
    const candidate = { ...claim, value: 120, unit };
    expect(verifyTableEvidence(source, refs, candidate).evidence.unitIds).toEqual([
      'unitSuffix',
      'v2',
    ]);
    for (const unitIds of [['v2'], ['unitSuffix']]) {
      expect(() => verifyTableEvidence(source, { ...refs, unitIds }, candidate)).toThrow('単位');
    }
    for (const change of [{ x: 350 }, { x: 300 }, { y: 80 }, { y: 40 }]) {
      const invalid = {
        ...source,
        spans: source.spans.map((s) => (s.id === 'unitSuffix' ? { ...s, ...change } : s)),
      };
      expect(() => verifyTableEvidence(invalid, refs, candidate)).toThrow();
    }
    const otherNumber = {
      ...source,
      spans: source.spans.map((s) => (s.id === 'unitSuffix' ? { ...s, text: '500人' } : s)),
    };
    expect(() =>
      verifyTableEvidence(otherNumber, refs, { ...candidate, unit: `${prefix}500人` })
    ).toThrow('単位');
    expect(() =>
      verifyTableEvidence(
        { ...source, spans: source.spans.concat(span('other', '注', 336, 60, 1)) },
        refs,
        candidate
      )
    ).toThrow();
  });
  it('値セル内の単位と複数の隣接断片を原文順に照合する', () => {
    const source = {
      ...page,
      spans: spans
        .filter((s) => s.id !== 'u2')
        .map((s) => (s.id === 'v2' ? { ...s, text: '200百' } : s))
        .concat(span('unit1', '万', 338, 60, 10), span('unit2', '円', 351, 60, 10)),
    };
    const refs = { ...evidence, unitIds: ['unit2', 'v2', 'unit1'] };
    expect(verifyTableEvidence(source, refs, claim).evidence.unitIds).toEqual([
      'unit1',
      'unit2',
      'v2',
    ]);
    expect(() => verifyTableEvidence(source, { ...refs, unitIds: ['v2', 'unit1'] }, claim)).toThrow(
      '単位'
    );
    expect(() => verifyTableEvidence(source, { ...refs, unitIds: ['u1'] }, claim)).toThrow('単位');
  });
  it.each(['百', '百万円'])('値セル内の%s単位を列見出しだけで代用できない', (unit) => {
    const source = {
      ...page,
      spans: spans
        .map((s) =>
          s.id === 'u2' ? { ...s, text: unit } : s.id === 'v2' ? { ...s, text: `200${unit}` } : s
        )
        .concat(...(unit === '百' ? [span('suffix', '万円', 338, 60, 20)] : [])),
    };
    expect(() => verifyTableEvidence(source, evidence, { ...claim, unit })).toThrow('単位');
  });
  // 配置は正常断片/注記付き断片の2対、その他の語彙は片方の配置で確認する。
  it.each(
    [
      ['百', '万円', '百万円'],
      ['百', '万円※', '百万円'],
    ]
      .flatMap(([prefix, suffix, unit]) =>
        ['inline', 'adjacent'].map((kind) => ({ kind, prefix, suffix, unit })),
      )
      .concat(
        [
          ['百', '万円(注1)', '百万円'],
          ['百', '万円*1', '百万円'],
          ['百', '万円¹', '百万円'],
          ['百', '万円注1', '百万円'],
          ['百', '注', '百万円'],
          ['百', '注1万円', '百万円'],
          ['百', '注1.5', '百万円'],
          ['百', '注1...', '百万円'],
          ['百', '注1%', '百万円'],
          ['百', '注1/', '百万円'],
          ['百', '注1·', '百万円'],
          ['m', '2※', 'm2'],
        ].map(([prefix, suffix, unit], i) => ({
          kind: i % 2 ? 'adjacent' : 'inline',
          prefix,
          suffix,
          unit,
        })),
      )
  )('$kind単位$prefixの未参照の続き$suffixを省けない', ({ kind, prefix, suffix, unit }) => {
    const source = {
      ...page,
      spans: spans
        .filter((s) => s.id !== 'u2')
        .map((s) =>
          s.id === 'v2' ? { ...s, text: kind === 'inline' ? `200${prefix}` : '200' } : s
        )
        .concat(
          ...(kind === 'adjacent' ? [span('prefix', prefix, 338, 60, 10)] : []),
          span('suffix', suffix, kind === 'inline' ? 338 : 351, 60, 20)
        ),
    };
    const refs = { ...evidence, unitIds: [kind === 'inline' ? 'v2' : 'prefix'] };
    expect(() => verifyTableEvidence(source, refs, { ...claim, unit: prefix })).toThrow('未参照');
    const fullRefs = { ...refs, unitIds: [...refs.unitIds, 'suffix'] };
    if (suffix === '万円') {
      expect(verifyTableEvidence(source, fullRefs, { ...claim, unit }).evidence.unitIds).toContain(
        'suffix'
      );
    } else {
      expect(() => verifyTableEvidence(source, fullRefs, { ...claim, unit })).toThrow('単位');
    }
  });
  it.each(
    [
      { note: '注1', kind: 'inline' },
      { note: '注1', kind: 'adjacent' },
      { note: '注12', kind: 'inline' },
      { note: '注１２', kind: 'adjacent' },
      { note: '注1）', kind: 'inline' },
      { note: '注1.', kind: 'adjacent' },
      { note: '注１．', kind: 'inline' },
      { note: '注1）。', kind: 'adjacent' },
      { note: '注1.)', kind: 'inline' },
      { note: '注1’', kind: 'adjacent' },
    ]
  )('$kind単位の後の独立した注記参照$noteを単位に含めない', ({ note, kind }) => {
    for (const unit of ['百万円', 'kWh', 'm2']) {
      const source = {
        ...page,
        spans: spans
          .filter((s) => s.id !== 'u2')
          .map((s) =>
            s.id === 'v2' ? { ...s, text: kind === 'inline' ? `200${unit}` : '200' } : s
          )
          .concat(
            ...(kind === 'adjacent' ? [span('unit', unit, 338, 60, 10)] : []),
            span('note', note, kind === 'inline' ? 338 : 351, 60, 20)
          ),
      };
      const refs = { ...evidence, unitIds: [kind === 'inline' ? 'v2' : 'unit'] };
      expect(verifyTableEvidence(source, refs, { ...claim, unit }).evidence.unitIds).toEqual(
        refs.unitIds
      );
      expect(() =>
        verifyTableEvidence(
          source,
          { ...refs, unitIds: [...refs.unitIds, 'note'] },
          { ...claim, unit }
        )
      ).toThrow('単位');
    }
  });
  it('注記だけのセルや別行・離れたセルを単位の続きとみなさない', () => {
    for (const [suffix, x, y] of [
      ['※', 338, 60],
      ['(注1)', 338, 60],
      ['*1', 338, 60],
      ['万円※', 345, 60],
      ['万円※', 338, 80],
    ] as const) {
      const source = {
        ...page,
        spans: spans
          .filter((s) => s.id !== 'u2')
          .map((s) => (s.id === 'v2' ? { ...s, text: '200百万円' } : s))
          .concat(span('suffix', suffix, x, y, 20)),
      };
      expect(
        verifyTableEvidence(source, { ...evidence, unitIds: ['v2'] }, { ...claim, unit: '百万円' })
          .evidence.valueId
      ).toBe('v2');
    }
  });
  it('単位にも見出しにも読める未参照の隣接語を推測しない', () => {
    const source = {
      ...page,
      spans: spans
        .filter((s) => s.id !== 'u2')
        .map((s) => (s.id === 'v2' ? { ...s, text: '200店舗' } : s))
        .concat(span('label', '合計', 338, 60, 20)),
    };
    const refs = { ...evidence, unitIds: ['v2'] };
    expect(() => verifyTableEvidence(source, refs, { ...claim, unit: '店舗' })).toThrow('未参照');
    const separated = {
      ...source,
      spans: source.spans.map((s) => (s.id === 'label' ? { ...s, x: 345 } : s)),
    };
    expect(verifyTableEvidence(separated, refs, { ...claim, unit: '店舗' }).evidence.valueId).toBe(
      'v2'
    );
  });
  it('複数の数量を含む文字列や欠損を数値として採用しない', () => {
    for (const text of ['120店舗500人', '－', '不明']) {
      const source = { ...page, spans: spans.map((s) => (s.id === 'v2' ? { ...s, text } : s)) };
      expect(() =>
        verifyTableEvidence(
          source,
          { ...evidence, unitIds: ['v2'] },
          { ...claim, value: 120, unit: '店舗' }
        )
      ).toThrow('値');
    }
  });
  it('数字で始まる指標見出しを表の数値行と誤認して限定語を落とせない', () => {
    const source = {
      ...page,
      spans: spans
        .map((s) =>
          s.id === 'm1'
            ? { ...s, text: '1人当たり件数' }
            : s.id === 'm2'
              ? { ...s, text: '1店舗当たり売上' }
              : s
        )
        .concat(span('qualifier', '全事業', 300, 10)),
    };
    expect(() =>
      verifyTableEvidence(source, evidence, { ...claim, label: '1店舗当たり売上' })
    ).toThrow('未参照');
    expect(
      verifyTableEvidence(
        source,
        { ...evidence, metricIds: ['qualifier', 'm2'] },
        { ...claim, label: '全事業1店舗当たり売上' }
      ).evidence.valueId
    ).toBe('v2');
  });
});
describe('指標名と列順序に依存しない根拠検証', () => {
  it('未知の指標名でも根拠の対応を検証する', () => {
    expect(
      verifyTableEvidence(
        page,
        { ...evidence, valueId: 'v1', metricIds: ['m1'], unitIds: ['u1'] },
        { ...claim, label: '独自KPI', value: 100 }
      ).quote
    ).toContain('独自KPI');
  });
  it('列を入れ替えても同じ事実を得る', () => {
    const swapped = {
      ...page,
      spans: spans.map((s) => ({ ...s, x: s.x >= 300 ? s.x - 100 : s.x >= 200 ? s.x + 100 : s.x })),
    };
    expect(verifyTableEvidence(swapped, evidence, claim).quote).toBe(
      verifyTableEvidence(page, evidence, claim).quote
    );
  });
  it('新しい列を追加しても既存の指標を取り違えない', () => {
    const source = {
      ...page,
      spans: spans.concat(
        span('m3', '任意の指標', 400, 20),
        span('u3', '百万円', 400, 40),
        span('v5', '999', 405, 60, 30)
      ),
    };
    expect(verifyTableEvidence(source, evidence, claim).quote).toBe(
      verifyTableEvidence(page, evidence, claim).quote
    );
  });
  it('期間と分かれた予想表記を落として実績と判断できない', () => {
    const source = { ...page, spans: spans.concat(span('kind', '(予想)', 60, 60)) };
    expect(() => verifyTableEvidence(source, evidence, { ...claim, valueKind: 'actual' })).toThrow(
      '一部が未参照'
    );
  });
  it('見出しの改行を参照群から復元する', () => {
    const split = {
      ...page,
      spans: spans
        .filter((s) => s.id !== 'm2')
        .concat(span('m2a', '営業', 310, 20, 20), span('m2b', '利益', 310, 30, 20)),
    };
    expect(
      verifyTableEvidence(split, { ...evidence, metricIds: ['m2b', 'm2a'] }, claim).quote
    ).toContain('営業\n利益');
    expect(() =>
      verifyTableEvidence(split, { ...evidence, metricIds: ['m2b'] }, { ...claim, label: '利益' })
    ).toThrow('一部が未参照');
  });
  it('同額でも指標・期間の異なるセルを拒否する', () => {
    expect(() =>
      verifyTableEvidence(page, { ...evidence, valueId: 'v1' }, { ...claim, value: 100 })
    ).toThrow('単位の列');
    expect(() =>
      verifyTableEvidence(page, { ...evidence, valueId: 'v4' }, { ...claim, value: 100 })
    ).toThrow('期間');
  });
  it('空欄と欠損はゼロにせず、他列の照合を維持する', () => {
    for (const missing of ['', '－']) {
      const source = {
        ...page,
        spans: spans.map((s) => (s.id === 'v1' ? { ...s, text: missing } : s)),
      };
      expect(verifyTableEvidence(source, evidence, claim).evidence.valueId).toBe('v2');
      expect(() =>
        verifyTableEvidence(
          source,
          { ...evidence, valueId: 'v1', metricIds: ['m1'], unitIds: ['u1'] },
          { ...claim, label: '独自KPI', value: 0 }
        )
      ).toThrow('値・符号');
    }
  });
  it('指標が行、期間が列にある表を同じ形式で照合する', () => {
    const source: ExtractedPage = {
      pageNumber: 1,
      text: '',
      spans: [
        span('p1', '2027年5月期', 180, 0, 80),
        span('p2', '2026年5月期', 280, 0, 80),
        span('u1', '百万円', 200, 20),
        span('u2', '百万円', 300, 20),
        span('metric', '営業利益', 0, 40, 80),
        span('v1', '200', 205, 40, 30),
        span('v2', '100', 305, 40, 30),
      ],
    };
    const refs = {
      valueId: 'v1',
      metricIds: ['metric'],
      periodIds: ['p1'],
      unitIds: ['u1'],
      contextIds: [],
    };
    expect(
      verifyTableEvidence(source, refs, { ...claim, period: '2027年5月期', valueKind: 'actual' })
        .quote
    ).toContain('200');
    expect(() =>
      verifyTableEvidence(
        source,
        { ...refs, periodIds: ['p2'] },
        { ...claim, period: '2026年5月期', valueKind: 'actual' }
      )
    ).toThrow('期間');
  });
  it('単位・対象年度・通常予想と修正後予想の混同を拒否する', () => {
    for (const change of [
      { unit: '億円' },
      { period: '2026年5月期通期' },
      { valueKind: 'forecastAfter' },
    ]) {
      expect(() => verifyTableEvidence(page, evidence, { ...claim, ...change })).toThrow();
    }
  });
});

describe('数量が1つだけの表', () => {
  const singlePage = (unit: 'inline' | 'column' | 'shared'): ExtractedPage => ({
    pageNumber: 1,
    text: '',
    spans: [
      span('period', '2026年7月14日', 180, 0, 80),
      span('metric', '任意の数量', 0, 40, 100),
      span('value', unit === 'inline' ? '100株' : '100', 205, 40, 40),
      ...(unit === 'inline'
        ? []
        : [span('unit', unit === 'column' ? '株' : '(単位:株)', 205, 20, 40)]),
    ],
  });
  const singleEvidence = (unit: 'inline' | 'column' | 'shared'): TableEvidence => ({
    valueId: 'value',
    metricIds: ['metric'],
    periodIds: ['period'],
    unitIds: [unit === 'inline' ? 'value' : 'unit'],
    contextIds: [],
  });
  const singleClaim: NumericClaim = {
    label: '任意の数量',
    value: 100,
    unit: '株',
    period: '2026年7月14日',
    valueKind: 'actual',
  };
  it.each(['inline', 'column', 'shared'] as const)(
    '%s単位で、指標が同じ行にあり期間が値の上にある表を照合する',
    (unit) => {
      expect(
        verifyTableEvidence(singlePage(unit), singleEvidence(unit), singleClaim).evidence
      ).toEqual(singleEvidence(unit));
    }
  );
  it('期間が別の列にある根拠を拒否する', () => {
    const source = singlePage('inline');
    source.spans.find((s) => s.id === 'period')!.x = 300;
    expect(() => verifyTableEvidence(source, singleEvidence('inline'), singleClaim)).toThrow(
      '期間の行・列'
    );
  });
  it('単位が値の列から離れている根拠を拒否する', () => {
    const source = singlePage('column');
    source.spans.find((s) => s.id === 'unit')!.x = 300;
    expect(() => verifyTableEvidence(source, singleEvidence('column'), singleClaim)).toThrow(
      '単位の列'
    );
  });
  it('指標が値と同じ行にない曖昧な単一数量表を拒否する', () => {
    const source = singlePage('inline');
    source.spans.find((s) => s.id === 'metric')!.y = 20;
    expect(() => verifyTableEvidence(source, singleEvidence('inline'), singleClaim)).toThrow(
      '表の行構造が曖昧'
    );
  });
});

const interval = '2026年4月1日～2026年4月30日';
it.each([interval, interval.replace('～', 'から') + 'まで', interval.replace('～', '-')])(
  '日付区間の両端を明示軸から証明する: %s',
  (axis) => {
    expect(() =>
      verifyPeriodAndKind(
        { ...claim, period: interval, valueKind: 'actual' },
        axis,
        '2027年3月期 経営成績',
        ''
      )
    ).not.toThrow();
  }
);
it.each(['2026年4月1日', '2026年4月1日～2026年5月30日', '2026年4月30日～2026年4月1日'])(
  '日付区間の省略・置換・逆転を拒否する: %s',
  (period) => {
    expect(() =>
      verifyPeriodAndKind({ ...claim, period, valueKind: 'actual' }, interval, period, '')
    ).toThrow();
  }
);
it('非連続の二つの日付を区間と推測しない', () => {
  expect(() =>
    verifyPeriodAndKind(
      { ...claim, period: interval, valueKind: 'actual' },
      '2026年4月1日及び2026年4月30日',
      interval,
      ''
    )
  ).toThrow();
});

it.each(['以内', '未達', '強', '弱'])(
  '境界表現を値セル・裸の列単位・明示宣言へ吸収しない: %s',
  (tail) => {
    const unit = `百万円${tail}`;
    for (const placement of ['inline', 'column', 'declaration']) {
      const source = {
        ...page,
        spans: spans.map((s) =>
          placement === 'inline' && s.id === 'v2'
            ? { ...s, text: `200${unit}` }
            : placement !== 'inline' && s.id === 'u2'
              ? { ...s, text: placement === 'declaration' ? `(単位:${unit})` : unit }
              : s
        ),
      };
      expect(() =>
        verifyTableEvidence(
          source,
          { ...evidence, unitIds: [placement === 'inline' ? 'v2' : 'u2'] },
          { ...claim, unit }
        )
      ).toThrow('単位');
    }
  }
);
it('単位宣言でも未知の名称を推測で数量単位にしない', () => {
  for (const unit of ['独自量', '(単位:独自量)']) {
    const source = { ...page, spans: spans.map((s) => (s.id === 'u2' ? { ...s, text: unit } : s)) };
    expect(() => verifyTableEvidence(source, evidence, { ...claim, unit: '独自量' })).toThrow(
      '単位'
    );
  }
  const source = {
    ...page,
    spans: spans.map((s) => (s.id === 'u2' ? { ...s, text: '(単位:百万円)' } : s)),
  };
  expect(verifyTableEvidence(source, evidence, claim).evidence.unitIds).toEqual(['u2']);
});
it('片側だけの日付を区間として扱わない', () => {
  expect(() =>
    verifyPeriodAndKind(
      { ...claim, period: '2026年4月1日～', valueKind: 'actual' },
      '2026年4月1日',
      '',
      ''
    )
  ).toThrow();
});

it.each([
  ['売上高は100百万円です。営業利益は10百万円です。', true],
  ['売上高は100百万円、営業利益については10百万円です。', true],
  ['売上高は100百万円、EPSは1株当たり42円です。', true],
  ['売上高は100百万円、営業利益は10～20百万円と見込んでおります。', true],
  ['売上高は100百万円、調整後営業利益は10百万円です。', false],
  ['売上高は100百万円、営業利益は10百万円ではありません。', false],
  ['売上高は100百万円、営業利益は10百万円です。売上高の予想は撤回しました。', false],
  ['売上高は100百万円、営業利益は10百万円、売上高は120百万円です。', false],
  ['売上高は100百万円（営業利益は10百万円）です。', false],
] as const)('直接財務数量の列挙だけを照合し否定・限定・再指定を拒否する: %s', (quote, valid) => {
  const verify = () =>
    verifyProseEvidence({ pageNumber: 1, text: quote, spans: [] }, quote, {
      ...claim,
      label: '売上高',
      value: 100,
      unit: '百万円',
    });
  if (valid) expect(verify()).toBe(0);
  else expect(verify).toThrow();
});

it.each([
  ['EPS', '基本的1株当たり当期利益', '円', false],
  ['EPS', 'eps', '円', false],
  ['希薄化後EPS', '潜在株式調整後1株当たり当期利益', '円', false],
  ['売上高', '売上収益', '百万円', false],
  ['経常利益', '経常損失', '百万円', false],
  ['当期純利益', '親会社株主に帰属する当期純利益', '百万円', false],
  ['EPS', '希薄化後EPS', '円', true],
  ['1株当たり四半期利益', '1株当たり当期利益', '円', true],
] as const)('本文の指標再指定を表記でなく区分で照合する: %s / %s', (first, second, unit, valid) => {
  const quote = `株式会社テストの${first}は42${unit}、${second}は43${unit}です。`;
  for (const [label, value] of [
    [first, 42],
    [second, 43],
  ] as const) {
    const verify = () =>
      verifyProseEvidence({ pageNumber: 1, text: quote, spans: [] }, quote, {
        ...claim,
        label,
        value,
        unit,
        subject: '株式会社テスト',
      });
    if (valid) expect(verify()).toBe(0);
    else expect(verify).toThrow();
  }
});
