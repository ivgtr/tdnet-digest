import { describe, expect, it } from 'vitest';
import { buildAnalysisCalculations } from './analysis-calculations';
import type { FactSummary, VerifiedFact } from './fact-contract';
import type { DisclosureObservation } from './disclosure-observation';
import type { NarrativeValue } from './summary-narrative';
import type { SummaryPresentation } from './summary-presentation';

// Component contracts own arithmetic and unsafe-pair boundaries. Source verification,
// model review and UI persistence retain their existing representative integration tests.
function fact(id: string, decimal: string, changes: Partial<VerifiedFact> = {}): VerifiedFact {
  return {
    id,
    importance: 'key',
    kind: 'number',
    label: '営業利益',
    value: Number(decimal),
    unit: '百万円',
    period: '2026年3月期第3四半期',
    valueKind: 'actual',
    column: null,
    statement: null,
    page: 1,
    quote: '検証済みの原文',
    evidence: {
      kind: 'table',
      valueId: `cell-${id}`,
      metricIds: ['metric'],
      periodIds: ['period'],
      unitIds: ['unit'],
      contextIds: ['context'],
      scopeIds: ['scope'],
      qualifierIds: [],
    },
    semantics: {
      subject: '株式会社テスト',
      scope: '連結',
      basis: '日本基準',
      periodKind: 'cumulativeQ3',
      metricKind: 'amount',
      qualifiers: [],
      state: 'actual',
      polarity: 'affirmative',
      conditions: [],
    },
    quantity: { raw: decimal, decimal, sourceIds: [`cell-${id}`] },
    dateRoles: null,
    provenance: {
      tableId: 'table',
      assertion: null,
      quantityRange: null,
      denominator: null,
      adjustments: [],
    },
    ...changes,
  };
}
function forecast(decimal = '7800', id = 'forecast'): VerifiedFact {
  const value = fact(id, decimal);
  return {
    ...value,
    period: '2026年3月期',
    valueKind: 'forecast' as const,
    semantics: { ...value.semantics, periodKind: 'fullYear' as const, state: 'forecast' as const },
  };
}
function value(id: string, decimal: string, unit = '百万円'): NarrativeValue {
  return { id, raw: decimal + unit, decimal, unit, sourceIds: [`source:${id}`] };
}
function observation(
  id: string,
  changes: Partial<DisclosureObservation> = {}
): DisclosureObservation {
  return {
    id,
    topic: 'performance',
    entity: '株式会社テスト',
    scope: '連結',
    basis: '日本基準',
    metric: '営業利益',
    measure: 'profit',
    period: '2026年3月期第3四半期累計',
    state: 'actual',
    valueId: `value:${id}`,
    comparison: null,
    conditions: [],
    sourceIds: [`source:${id}`],
    ...changes,
  };
}
function inputs(
  facts: VerifiedFact[] = [],
  observations: DisclosureObservation[] = [],
  quantities: NarrativeValue[] = []
) {
  const summary: FactSummary = { version: 6, documentType: 'earnings', facts, unverified: [] };
  const presentation: SummaryPresentation = {
    version: 6,
    sourceHash: 'source',
    overview: [],
    sections: [],
    excerpts: [],
    values: [...facts.map((f) => value(f.id, f.quantity!.decimal!, f.unit!)), ...quantities],
    organization: {
      version: 3,
      status: 'ready',
      claims: [],
      observations,
      review: {
        contentHash: 'review',
        claims: Object.fromEntries(observations.map((o) => [o.id, null])),
        sources: {},
      },
      issues: [],
    },
  };
  return { summary, presentation };
}
function calculate(
  facts: VerifiedFact[] = [],
  observations: DisclosureObservation[] = [],
  quantities: NarrativeValue[] = []
) {
  const { summary, presentation } = inputs(facts, observations, quantities);
  return buildAnalysisCalculations(summary, presentation);
}

describe('checked-source analysis calculations', () => {
  it('labels an over-100% progress residual as arithmetic, with stable operand and source identity', () => {
    const actual = fact('actual', '8168'),
      annual = forecast();
    // Aliases retain one reporting context without rewriting either source operand.
    actual.semantics = { ...actual.semantics, scope: '個別', basis: 'IFRS会計基準' };
    annual.semantics = { ...annual.semantics, scope: '非連結', basis: '国際会計基準' };
    const result = calculate([actual, annual]);
    const remaining = result.find((c) => c.kind === 'remaining')!;
    expect(remaining).toMatchObject({
      value: '-368',
      unit: '百万円',
      sourceFactIds: ['actual', 'forecast'],
      sourceObservationIds: [],
      sourceIds: ['source:actual', 'source:forecast'],
    });
    expect(remaining.id).toMatch(/^calc:remaining:/);
    expect(remaining.formula).toContain('7800百万円 − 累計実績 8168百万円 = -368百万円');
    expect(remaining.caveat).toContain(
      '会社が開示した残り期間の予想や業績予想の修正を意味しません'
    );
    expect(result.find((c) => c.kind === 'progress')).toMatchObject({ value: '104.7', unit: '%' });
    expect(calculate([annual, actual])).toEqual(result);
    expect(calculate([actual, annual], [], [value('unreviewed-cell', '999999')])).toEqual(result);
  });

  it('uses exact decimal arithmetic beyond Number precision and rounds progress half up', () => {
    expect(
      calculate([fact('actual', '0.12'), forecast('9007199254740993.11')]).find(
        (c) => c.kind === 'remaining'
      )?.value
    ).toBe('9007199254740992.99');
    expect(
      calculate([fact('actual', '0.2'), forecast('0.3')]).find((c) => c.kind === 'remaining')?.value
    ).toBe('0.1');
    expect(
      calculate([fact('actual', '0.201'), forecast('2')]).find((c) => c.kind === 'progress')?.value
    ).toBe('10.1');
  });

  it.each([
    ['signed loss', '営業利益', '-80', '-100', '20'],
    ['loss magnitude', '営業損失', '80', '100', '-20'],
    ['zero base', '営業利益', '5', '0', '5'],
  ])(
    'keeps %s year-on-year differences as amounts, not growth rates',
    (_name, label, now, before, expected) => {
      const current = fact('current', now, { label });
      const previous = fact('previous', before, { label, period: '2025年3月期第3四半期' });
      current.semantics.basis = 'IFRS会計基準';
      previous.semantics.basis = 'IFRS';
      const result = calculate([current, previous]);
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ kind: 'difference', value: expected, unit: '百万円' });
      expect(result[0].label).toContain('前年同期差額');
      if (label === '営業損失') expect(result[0].caveat).toContain('損失額');
    }
  );

  it('uses explicit before/after forecast states for revisions, never ordinary forecasts', () => {
    const before = forecast('7000', 'before'),
      after = forecast('7800', 'after');
    before.semantics.state = 'forecastBefore';
    before.valueKind = 'forecastBefore';
    after.semantics.state = 'forecastAfter';
    after.valueKind = 'forecastAfter';
    expect(calculate([before, after])).toMatchObject([{ kind: 'difference', value: '800' }]);
    expect(calculate([before, forecast()])).toEqual([]);
    const withActual = calculate([before, after, fact('actual', '8168')]);
    expect(withActual.find((c) => c.kind === 'remaining')?.value).toBe('-368');
  });

  it.each([
    [
      'entity',
      (f: VerifiedFact) => {
        f.semantics.subject = '別会社';
      },
    ],
    [
      'scope',
      (f: VerifiedFact) => {
        f.semantics.scope = '個別';
      },
    ],
    [
      'basis',
      (f: VerifiedFact) => {
        f.semantics.basis = 'IFRS';
      },
    ],
    [
      'condition',
      (f: VerifiedFact) => {
        f.semantics.conditions = ['組替後'];
      },
    ],
    [
      'qualifier',
      (f: VerifiedFact) => {
        f.semantics.qualifiers = ['調整後'];
      },
    ],
    [
      'unit',
      (f: VerifiedFact) => {
        f.unit = '億円';
      },
    ],
    [
      'year',
      (f: VerifiedFact) => {
        f.period = '2027年3月期';
      },
    ],
    [
      'fiscal month',
      (f: VerifiedFact) => {
        f.period = '2026年12月期';
      },
    ],
    [
      'unknown scope',
      (f: VerifiedFact) => {
        f.semantics.scope = null;
      },
    ],
    [
      'unknown entity',
      (f: VerifiedFact) => {
        f.semantics.subject = null;
      },
    ],
    [
      'unknown basis',
      (f: VerifiedFact) => {
        f.semantics.basis = null;
      },
    ],
    [
      'unknown axis',
      (f: VerifiedFact) => {
        f.period = '今期';
      },
    ],
    [
      'bad month',
      (f: VerifiedFact) => {
        f.period = '2026年13月期';
      },
    ],
    [
      'wrong metric',
      (f: VerifiedFact) => {
        f.label = '経常利益';
      },
    ],
  ])('omits incompatible residuals for %s', (_name, change) => {
    const annual = forecast();
    change(annual);
    expect(calculate([fact('actual', '8168'), annual])).toEqual([]);
  });

  it('requires an unambiguous cumulative period and forecast, retaining profit ownership', () => {
    const actual = fact('actual', '8168');
    expect(calculate([actual, forecast(), forecast('7900', 'second')])).toEqual([]);
    expect(calculate([actual, fact('duplicate-actual', '8168'), forecast()])).toEqual([]);
    actual.semantics.periodKind = 'standaloneQ3';
    expect(calculate([actual, forecast()])).toEqual([]);
    const owned = fact('owned', '100', { label: '親会社株主に帰属する四半期純利益' });
    const annual = forecast('200');
    annual.label = '親会社株主に帰属する当期純利益';
    expect(
      calculate([owned, annual])
        .map((c) => c.kind)
        .sort()
    ).toEqual(['progress', 'remaining']);
    annual.label = '当期純利益';
    expect(calculate([owned, annual])).toEqual([]);
  });

  it.each([
    ['EPS', '1株当たり当期純利益', 'perShare', '円'],
    ['rate', '営業利益率', 'rate', '%'],
    ['stock', '純資産', 'amount', '百万円'],
    ['loss magnitude', '営業損失', 'amount', '百万円'],
    ['marked loss magnitude', '営業損失（△）', 'amount', '百万円'],
  ] as const)(
    'does not infer a full-year residual or progress for %s',
    (_name, label, metricKind, unit) => {
      const actual = fact('actual', '80'),
        annual = forecast('100');
      for (const f of [actual, annual]) {
        f.label = label;
        f.unit = unit;
        f.semantics.metricKind = metricKind;
      }
      expect(calculate([actual, annual])).toEqual([]);
    }
  );

  it.each([
    ['-10', '100'],
    ['80', '-100'],
    ['80', '0'],
  ])(
    'keeps signed arithmetic but omits progress for actual %s and forecast %s',
    (actual, annual) => {
      const result = calculate([fact('actual', actual), forecast(annual)]);
      expect(result.map((c) => c.kind)).toEqual(['remaining']);
    }
  );

  it('does not use missing, ambiguous, ranged, or mismatched presentation scalars', () => {
    const { summary, presentation } = inputs([fact('actual', '8168'), forecast()]);
    const actual = presentation.values[0];
    for (const changed of [
      undefined,
      { ...actual, decimal: null },
      { ...actual, decimal: '1e3' },
      { ...actual, decimal: '9000' },
      { ...actual, sourceIds: [] },
    ]) {
      presentation.values = [presentation.values[1], ...(changed ? [changed] : [])];
      expect(buildAnalysisCalculations(summary, presentation)).toEqual([]);
      presentation.values = [actual, value('forecast', '7800')];
    }
    presentation.values.push(actual);
    expect(buildAnalysisCalculations(summary, presentation)).toEqual([]);
  });

  it('uses only supported observation comparisons and checked quantities, including a self-contained company-wide context', () => {
    const current = observation('observation-1', {
      entity: null,
      comparison: {
        axis: 'yearOnYear',
        period: '2025年3月期第3四半期累計',
        state: 'actual',
        valueId: 'old',
        rateId: null,
      },
    });
    const quantities = [value(current.valueId, '-80.25'), value('old', '-100.50')];
    const { summary, presentation } = inputs([], [current], quantities);
    expect(buildAnalysisCalculations(summary, presentation)).toMatchObject([
      {
        kind: 'difference',
        value: '20.25',
        sourceFactIds: [],
        sourceObservationIds: [current.id],
        sourceIds: ['source:observation-1', 'source:old', 'source:value:observation-1'],
      },
    ]);
    presentation.organization.review!.claims[current.id] = '対象期間を確認できません';
    expect(buildAnalysisCalculations(summary, presentation)).toEqual([]);
    presentation.organization.review = null;
    expect(buildAnalysisCalculations(summary, presentation)).toEqual([]);
  });

  it.each([
    ['unknown period', '前年同期', 'actual', '百万円'],
    ['wrong year', '2024年3月期第3四半期累計', 'actual', '百万円'],
    ['different quarter', '2025年3月期第2四半期累計', 'actual', '百万円'],
    ['standalone', '2025年3月期第3四半期単独', 'actual', '百万円'],
    ['unqualified quarter', '2025年3月期第3四半期', 'actual', '百万円'],
    ['forecast', '2025年3月期第3四半期累計', 'forecast', '百万円'],
    ['different unit', '2025年3月期第3四半期累計', 'actual', '億円'],
  ] as const)('omits a reviewed observation comparison with %s', (_name, period, state, unit) => {
    const current = observation('observation-1', {
      comparison: { axis: 'yearOnYear', period, state, valueId: 'old', rateId: null },
    });
    expect(
      calculate([], [current], [value(current.valueId, '80'), value('old', '100', unit)])
    ).toEqual([]);
  });

  it('can pair an explicit supported forecast observation with a verified actual, without reusing a duplicate native value', () => {
    const annual = observation('observation-1', {
      topic: 'forecast',
      period: '2026年3月期',
      state: 'forecast',
    });
    const actual = fact('actual', '8168');
    const result = calculate([actual], [annual], [value(annual.valueId, '7800')]);
    expect(result.find((c) => c.kind === 'remaining')).toMatchObject({
      value: '-368',
      sourceFactIds: [actual.id],
      sourceObservationIds: [annual.id],
    });
    const duplicate = observation('observation-2', { valueId: 'cell-actual' });
    expect(
      calculate(
        [actual],
        [annual, duplicate],
        [value(annual.valueId, '7800'), value('cell-actual', '8168')]
      )
    ).toEqual(result);
    annual.entity = null;
    expect(calculate([actual], [annual], [value(annual.valueId, '7800')])).toEqual([]);
  });

  it('sums only matched explicit operating and investing cash flows, retaining signs and conditions', () => {
    const operating = observation('observation-1', {
      topic: 'cash',
      metric: '営業活動によるキャッシュ・フロー',
      measure: 'flow',
    });
    const investing = observation('observation-2', {
      topic: 'cash',
      metric: '投資活動によるキャッシュ・フロー',
      measure: 'flow',
    });
    const quantities = [value(operating.valueId, '0.3'), value(investing.valueId, '-0.2')];
    const result = calculate([], [operating, investing], quantities);
    expect(result).toMatchObject([
      {
        kind: 'cashFlowTotal',
        value: '0.1',
        unit: '百万円',
        sourceObservationIds: [operating.id, investing.id],
      },
    ]);
    expect(result[0].caveat).toContain('単純合計');
    investing.period = '2026年3月期第2四半期累計';
    expect(calculate([], [operating, investing], quantities)).toEqual([]);
    investing.period = operating.period;
    investing.conditions = ['組替後'];
    expect(calculate([], [operating, investing], quantities)).toEqual([]);
    investing.conditions = [];
    investing.entity = null;
    expect(calculate([], [operating, investing], quantities)).toEqual([]);
  });

  it.each([
    '上限',
    '下限',
    '100百万円以上',
    '{{value:limit}}以下',
    '未満',
    '約',
    '概算額',
    '速報値',
    '約{{value:estimate}}',
    '100百万円程度',
  ])(
    'omits point arithmetic when both operands share the non-point restriction %s',
    (restriction) => {
      const actual = fact('actual', '100'),
        annual = forecast('200');
      for (const f of [actual, annual]) f.semantics.qualifiers = [restriction];
      expect(calculate([actual, annual])).toEqual([]);
    }
  );

  it('excludes equally bounded operands before differences and cash-flow sums, including reviewed conditions', () => {
    const now = fact('now', '100'),
      before = fact('before', '90', { period: '2025年3月期第3四半期' });
    const operating = fact('operating', '100', { label: '営業CF' });
    const investing = fact('investing', '-20', { label: '投資CF' });
    for (const f of [now, before, operating, investing]) {
      f.semantics.qualifiers = ['上限'];
      f.quote = `${f.label}の表示額は上限です。`;
    }
    expect(calculate([now, before, operating, investing])).toEqual([]);
    const current = observation('observation-1', {
      conditions: ['営業利益の表示額は上限です。'],
      comparison: {
        axis: 'yearOnYear',
        period: '2025年3月期第3四半期累計',
        state: 'actual',
        valueId: 'old',
        rateId: null,
      },
    });
    const annual = observation('observation-2', {
      state: 'forecast',
      period: '2026年3月期',
      conditions: current.conditions,
    });
    const cfo = observation('observation-3', {
      metric: '営業CF',
      measure: 'flow',
      conditions: ['{{value:limit}}以下'],
    });
    const cfi = observation('observation-4', {
      metric: '投資CF',
      measure: 'flow',
      conditions: cfo.conditions,
    });
    expect(
      calculate(
        [],
        [current, annual, cfo, cfi],
        [
          value(current.valueId, '100'),
          value('old', '90'),
          value(annual.valueId, '200'),
          value(cfo.valueId, '100'),
          value(cfi.valueId, '-20'),
        ]
      )
    ).toEqual([]);
  });

  it('does not confuse descriptive conditions or a contract with a quantity bound', () => {
    const actual = fact('actual', '100'),
      annual = forecast('200');
    for (const f of [actual, annual])
      f.semantics.conditions = [
        '以下の条件を適用する',
        '契約済み',
        '2026年3月期は以下の条件を適用する',
      ];
    expect(
      calculate([actual, annual])
        .map((c) => c.kind)
        .sort()
    ).toEqual(['progress', 'remaining']);
  });

  it.each(['fact ID', 'table cell alias', 'prose quantity alias'])(
    'keeps eligibility and verified conditions for observation comparison operands selected by %s',
    (route) => {
      const known = fact('known', '100', { period: '2025年3月期第3四半期' });
      if (route === 'prose quantity alias')
        known.evidence = {
          kind: 'prose',
          blockId: 'block',
          assertionId: 'assertion',
          quantityId: 'quantity-known',
          contextIds: [],
          scopeIds: [],
          qualifierIds: [],
        };
      const selected =
        route === 'fact ID'
          ? known.id
          : route === 'table cell alias'
            ? 'cell-known'
            : 'quantity-known';
      const current = observation('observation-1', {
        comparison: {
          axis: 'yearOnYear',
          period: '2025年3月期第3四半期累計',
          state: 'actual',
          valueId: selected,
          rateId: null,
        },
      });
      const quantities = [
        value(current.valueId, '200'),
        ...(selected !== known.id ? [value(selected, '100')] : []),
      ];
      known.semantics.qualifiers = ['上限'];
      expect(calculate([known], [current], quantities)).toEqual([]);
      known.semantics.qualifiers = [];
      known.semantics.conditions = ['特別損失を含む'];
      expect(calculate([known], [current], quantities)).toEqual([]);
      current.conditions = known.semantics.conditions;
      expect(calculate([known], [current], quantities)).toMatchObject([
        {
          kind: 'difference',
          value: '100',
          sourceFactIds: [known.id],
          sourceObservationIds: [current.id],
        },
      ]);
    }
  );

  it('pairs the documented null-entity whole-company observations without equating them to unknown fact subjects', () => {
    const operating = observation('observation-1', {
      topic: 'cash',
      entity: null,
      metric: '営業CF',
      measure: 'flow',
    });
    const investing = observation('observation-2', {
      topic: 'cash',
      entity: null,
      metric: '投資CF',
      measure: 'flow',
    });
    const quantities = [value(operating.valueId, '100'), value(investing.valueId, '-20')];
    expect(calculate([], [operating, investing], quantities)).toMatchObject([
      { kind: 'cashFlowTotal', value: '80', label: expect.stringContaining('全社') },
    ]);
    const unknown = fact('unknown', '100', { label: '営業CF' });
    unknown.semantics.subject = null;
    expect(calculate([unknown], [investing], [value(investing.valueId, '-20')])).toEqual([]);
    operating.scope = null;
    expect(calculate([], [operating, investing], quantities)).toEqual([]);
  });
});
