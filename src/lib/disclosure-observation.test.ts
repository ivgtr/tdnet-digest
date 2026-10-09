import { expect, it } from 'vitest';
import { cells, tableAmount } from './fixtures/fact-review-source';
import { textPage, numberCandidate } from './fixtures/v4-test-source';
import { candidateResponse } from './fixtures/candidate-test-source';
import { buildDocumentContext } from './document-context';
import { reviewCandidates } from './fact-candidates';
import type { FactSummary } from './fact-contract';
import {
  factObservation,
  canPair,
  reconcileObservations,
  observationChange,
  type DisclosureObservation,
  type ConfirmedObservation,
} from './disclosure-observation';
import { buildPresentation, revalidatePresentation } from './summary-presentation';
import {
  emptyOrganization,
  explanationSources,
  organizationHash,
  unresolvedExplanationSources,
  unresolvedTableSources,
  supportedObservations,
} from './summary-organization';
import { parseFactSummary, renderFacts } from './fact-summary';
import { buildAnalysisInput } from './analysis-input';
import { buildAnalysisCalculations } from './analysis-calculations';

function reviewable(value: ConfirmedObservation): DisclosureObservation {
  const copy: Partial<ConfirmedObservation> = { ...value };
  delete copy.sourceBasis;
  delete copy.comparisonSourceBasis;
  delete copy.unresolved;
  return copy as DisclosureObservation;
}

function reviewedTable(label = '事業損失', previous = '10', includeRate = false) {
  const columns = [
    { label: '売上高', current: '100', previous: '90', x: 280, rate: includeRate },
    { label, current: '20', previous, x: includeRate ? 740 : 480, rate: false },
    { label: '当期純利益', current: '10', previous: '8', x: includeRate ? 940 : 680, rate: false },
  ];
  const page = cells(
    [
      ['上場会社名 株式会社テスト', 0, 0, 240],
      ['1. 連結経営成績', 0, 30, 280],
      ['2026年3月期', 0, 120, 140],
      ['2025年3月期', 0, 150, 140],
      ...columns.flatMap((column): [string, number, number, number][] => [
        [column.label, column.x, 60, column.rate ? 360 : 140],
        ['百万円', column.x + 60, 90, 80],
        [column.current, column.x + 60, 120, 80],
        [column.previous, column.x + 60, 150, 80],
        ...(column.rate
          ? ([
              ['%', column.x + 180, 90, 80],
              ['11.1', column.x + 180, 120, 80],
              ['5.0', column.x + 180, 150, 80],
            ] as [string, number, number, number][])
          : []),
      ]),
    ],
    1
  );
  const inputs = buildDocumentContext([page]).tableMappings.map((mapping) => {
    const amount = tableAmount([page], mapping, {
      period: page.spans.find((s) => s.id === mapping.periodIds[0])!.text,
      subject: '株式会社テスト',
      scope: '連結',
      basis: null,
      state: 'actual',
    });
    if (amount.unit === '%') amount.semantics.metricKind = 'rate';
    return amount;
  });
  const reviewed = reviewCandidates(candidateResponse(inputs, [page], 'other'), 'other', [page]);
  expect(reviewed.unverified).toEqual([]);
  const facts: FactSummary = {
    version: 6,
    documentType: 'other',
    facts: reviewed.facts,
    unverified: [],
  };
  const display = buildPresentation(facts, [page]);
  const fact = facts.facts.find((f) => f.label === label && f.value === 20)!;
  const base = factObservation(fact, facts, display.excerpts, display.values);
  const observation = reviewable(base);
  const review = (observations: DisclosureObservation[]) => {
    const organization = { ...emptyOrganization(), observations };
    organization.review = {
      contentHash: organizationHash(organization, facts, display.values, display.excerpts),
      claims: Object.fromEntries(observations.map((o) => [o.id, null])),
      sources: Object.fromEntries(explanationSources(display.excerpts).map((e) => [e.id, null])),
    };
    organization.status =
      unresolvedExplanationSources(organization, display.excerpts).length ||
      unresolvedTableSources(organization, facts, display.values, display.excerpts).length
        ? 'partial'
        : 'ready';
    if (!supportedObservations(organization, facts, display.values, display.excerpts).length)
      organization.status = 'unavailable';
    display.organization = organization;
    return display;
  };
  return {
    page,
    facts,
    display,
    fact,
    base,
    observation: { ...observation, id: 'observation-0' },
    review,
  };
}

it.each([
  ['事業損失', '10', 'loss', '↓損失拡大'],
  ['事業利益', '△10', 'profit', '↑黒字転換'],
] as const)(
  '未分類の確定値 %s に同じ数量の点検済み意味を接続し、保存後も保持する',
  (label, previous, measure, expected) => {
    const { facts, fact, page, display, base, observation, review } = reviewedTable(
      label,
      previous
    );
    expect(base.measure).toBe('other');
    const selected = {
      ...observation,
      measure,
      period: `${observation.period}通期`,
      comparison: { ...observation.comparison!, period: `${observation.comparison!.period}通期` },
      valueId: fact.evidence.kind === 'table' ? fact.evidence.valueId : fact.id,
    };
    const merged = reconcileObservations(facts, [selected], display.excerpts, display.values);
    expect(merged.conflicts).toEqual([]);
    expect(merged.supplement).toEqual([]);
    expect(merged.primary.get(fact.id)).toMatchObject({
      measure,
      valueId: fact.id,
      sourceBasis: base.sourceBasis,
    });
    expect(observationChange(merged.primary.get(fact.id)!, display.values).text).toContain(
      expected
    );
    review([selected]);
    const markdown = renderFacts(facts, display);
    const rows = markdown
      .split('\n')
      .filter((line) => line.startsWith('| ') && line.includes(label));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain(expected);
    expect(rows[0]).toContain('20百万円');
    expect(
      renderFacts(facts, revalidatePresentation(JSON.parse(JSON.stringify(display)), facts, [page]))
    ).toBe(markdown);
  }
);

it('点検済みの意味や比較の競合を順序で上書きせず、確定値と未整理の通知を残す', () => {
  const { facts, fact, display, base, observation, review } = reviewedTable();
  expect(renderFacts(facts, display).split('## 開示内容')[0]).toContain('↓損失拡大');
  const loss = { ...observation, measure: 'loss' as const };
  const profit = { ...observation, id: 'observation-1', measure: 'profit' as const };
  const differentAxis = {
    ...loss,
    comparison: { ...loss.comparison!, axis: 'sequential' as const },
  };
  for (const observations of [[loss, profit], [profit, loss], [differentAxis]]) {
    const merged = reconcileObservations(facts, observations, display.excerpts, display.values);
    expect(merged.primary.get(fact.id)).toEqual({ ...base, unresolved: true });
    expect(merged.conflicts).toEqual(observations);
    expect(merged.supplement).toEqual([]);
  }
  const markdown = renderFacts(facts, review([loss, profit]));
  expect(markdown).toContain('補足指標の未整理');
  expect(markdown).toContain('20百万円');
  expect(markdown).not.toContain('↓損失拡大');
  expect(buildAnalysisInput(facts, display).coverage.observations).toBe(0);
  expect(buildAnalysisInput(facts, display).evidence.some((e) => e.kind === 'observation')).toBe(
    false
  );
  expect(
    buildAnalysisCalculations(facts, display).every((c) => c.sourceObservationIds.length === 0)
  ).toBe(true);
});

it.each([false, true])(
  '異なる株式分割基準を比較へ混ぜず各数量の分母・注記を表示する（当期注記 %s）',
  (currentNote) => {
    const page = cells(
      [
        ['会社名 株式会社テスト', 0, 0, 240],
        ['2. 配当の状況', 0, 30, 250],
        ['年間配当金期末', 230, 60, 150],
        ['年間配当金合計', 430, 60, 210],
        ['円', 230, 85, 80],
        ['円', 430, 85, 80],
        ['2026年3月期', 0, 110, 180],
        ['20', 230, 110, 80],
        ['40', 430, 110, 80],
        ['2025年3月期', 0, 140, 180],
        ['10', 230, 140, 80],
        ['20', 430, 140, 80],
        ['2025年3月期の配当金については、株式分割前の金額を記載しています。', 0, 180, 1000],
        ...(currentNote
          ? [
              [
                '2026年3月期の配当金については、株式分割後の金額を記載しています。',
                0,
                210,
                1000,
              ] as [string, number, number, number],
            ]
          : []),
      ],
      1
    );
    const inputs = buildDocumentContext([page]).tableMappings.map((mapping) => {
      const fact = tableAmount([page], mapping, {
        period: page.spans.find((s) => s.id === mapping.periodIds[0])!.text,
        subject: '株式会社テスト',
        scope: null,
        basis: null,
        state: 'actual',
      });
      fact.semantics.metricKind = 'perShare';
      return fact;
    });
    const reviewed = reviewCandidates(candidateResponse(inputs, [page], 'other'), 'other', [page]);
    expect(reviewed.unverified).toEqual([]);
    expect(reviewed.facts).toHaveLength(4);
    const facts: FactSummary = {
      version: 6,
      documentType: 'other',
      facts: reviewed.facts,
      unverified: [],
    };
    const display = buildPresentation(facts, [page]);
    const current = facts.facts.find(
      (f) => f.label === '年間配当金期末' && f.period === '2026年3月期'
    )!;
    const previous = facts.facts.find(
      (f) => f.label === current.label && f.period === '2025年3月期'
    )!;
    const base = reviewable(factObservation(current, facts, display.excerpts, display.values));
    expect(base.comparison).toBeNull();
    const observation: DisclosureObservation = {
      ...base,
      id: 'observation-0',
      comparison: {
        axis: 'yearOnYear',
        period: previous.period!,
        state: 'actual',
        valueId: previous.id,
        rateId: null,
      },
    };
    expect(
      reconcileObservations(facts, [observation], display.excerpts, display.values).conflicts
    ).toEqual([observation]);
    const markdown = renderFacts(facts, display);
    const rows = markdown
      .split('\n')
      .filter((line) => line.startsWith('| ') && line.includes(current.label));
    expect(rows).toHaveLength(2);
    expect(rows.find((line) => line.includes('10円'))).toContain('1株当たり、株式分割前');
    const currentRow = rows.find((line) => line.includes('20円'))!;
    expect(currentRow).toContain('1株当たり');
    expect(currentRow.includes('株式分割後')).toBe(currentNote);
    expect(currentRow).not.toContain('株式分割前');
    expect(markdown.split('\n## 原文\n')[0]).toContain(
      '2025年3月期の配当金については、株式分割前の金額を記載しています。'
    );
    expect(
      renderFacts(facts, revalidatePresentation(JSON.parse(JSON.stringify(display)), facts, [page]))
    ).toBe(markdown);
  }
);

it('原数量を先に照合し、明確な文脈矛盾だけを除き、別名・未知の文脈・別セルは残す', () => {
  const { facts, fact, display, observation } = reviewedTable('営業利益', '20');
  const nativeId = fact.evidence.kind === 'table' ? fact.evidence.valueId : fact.id;
  const selected = { ...observation, valueId: nativeId, comparison: null };
  const classify = (claim: DisclosureObservation, input = facts) =>
    reconcileObservations(input, [claim], display.excerpts, display.values);
  for (const change of [
    { state: 'forecast' as const },
    { scope: '個別' },
    { metric: '売上高' },
    { metric: '営業損失', measure: 'loss' as const },
    { period: '2025年3月期' },
  ]) {
    const claim = { ...selected, ...change };
    expect(classify(claim).conflicts).toEqual([claim]);
    expect(classify(claim).primary.get(fact.id)?.unresolved).toBe(false);
  }
  for (const change of [
    { entity: '当社' },
    { entity: null, scope: null, period: null, state: 'unspecified' as const },
    { scope: 'グループ全体', period: '当期' },
    { period: '２０２６年３月期通期' },
    { period: '2026年03月期' },
  ])
    expect(classify({ ...selected, ...change }).conflicts).toEqual([]);

  const withMeaning = (
    scope: string,
    basis: string,
    period = fact.period!,
    state = fact.semantics.state
  ): FactSummary => ({
    ...facts,
    facts: facts.facts.map((f) =>
      f.id === fact.id ? { ...f, period, semantics: { ...f.semantics, scope, basis, state } } : f
    ),
  });
  const aliases = classify(
    { ...selected, scope: '非連結', basis: '国際会計基準' },
    withMeaning('個別', 'IFRS会計基準')
  );
  expect(aliases.conflicts).toEqual([]);
  expect(aliases.supplement).toEqual([]);
  expect(aliases.primary.get(fact.id)?.valueId).toBe(fact.id);
  expect(
    classify({ ...selected, basis: '日本基準' }, withMeaning('連結', 'IFRS会計基準')).conflicts
  ).toHaveLength(1);
  expect(
    classify(
      { ...selected, state: 'forecast' },
      withMeaning('連結', 'IFRS', fact.period!, 'forecastAfter')
    ).conflicts
  ).toEqual([]);
  expect(
    classify(
      { ...selected, state: 'forecastBefore' },
      withMeaning('連結', 'IFRS', fact.period!, 'forecastAfter')
    ).conflicts
  ).toHaveLength(1);
  expect(
    classify(
      { ...selected, period: '2026年3月期第2四半期' },
      withMeaning('連結', 'IFRS', '2026年3月期第2四半期累計')
    ).conflicts
  ).toEqual([]);

  expect(
    classify(
      { ...selected, period: '2026年3月期第1四半期単独' },
      withMeaning('連結', 'IFRS', '2026年3月期第1四半期累計')
    ).conflicts
  ).toHaveLength(1);

  const other = facts.facts.find((f) => f.id !== fact.id && f.value === 20)!;
  expect(other.evidence).not.toEqual(fact.evidence);
  const distinct = {
    ...selected,
    state: 'forecast' as const,
    valueId: other.evidence.kind === 'table' ? other.evidence.valueId : other.id,
  };
  expect(
    classify(distinct, { ...facts, facts: facts.facts.filter((f) => f.id !== other.id) }).conflicts
  ).toEqual([]);
  const alternate = {
    ...fact,
    id: 'alternate',
    semantics: { ...fact.semantics, state: 'forecast' as const },
  };
  expect(
    classify({ ...selected, state: 'forecast' }, { ...facts, facts: [...facts.facts, alternate] })
      .conflicts
  ).toEqual([]);
});

it('補足側だけの現在値でも比較原数量の文脈を照合し、複数の確定文脈を順序で拒否しない', () => {
  const { facts, fact, display, observation } = reviewedTable('営業利益');
  const nativeCurrent = fact.evidence.kind === 'table' ? fact.evidence.valueId : fact.id;
  const supplemental = {
    ...observation,
    valueId: nativeCurrent,
    comparison: { ...observation.comparison!, state: 'forecast' as const },
  };
  const onlyReference = { ...facts, facts: facts.facts.filter((f) => f.id !== fact.id) };
  expect(
    reconcileObservations(onlyReference, [supplemental], display.excerpts, display.values).conflicts
  ).toEqual([supplemental]);
  const organization = { ...emptyOrganization(), observations: [supplemental] };
  organization.review = {
    contentHash: organizationHash(organization, onlyReference, display.values, display.excerpts),
    claims: { [supplemental.id]: null },
    sources: {},
  };
  expect(
    unresolvedTableSources(organization, onlyReference, display.values, display.excerpts).some(
      (source) => source.spanIds.includes(nativeCurrent)
    )
  ).toBe(true);
  const reference = facts.facts.find((f) => f.id === observation.comparison!.valueId)!;
  const alternate = {
    ...reference,
    id: 'alternate',
    semantics: { ...reference.semantics, scope: '個別' },
  };
  const multiple = { ...facts, facts: [alternate, ...facts.facts] };
  const result = reconcileObservations(multiple, [observation], display.excerpts, display.values);
  expect(result.conflicts).toEqual([]);
  expect(result.primary.get(fact.id)?.comparison).toEqual(observation.comparison);
});

it('決算の確定表と補足表を同じ期間見出しに置き、別の話題は名前で区別して保存する', () => {
  const { facts, fact, page, observation } = reviewedTable('営業利益');
  const summary: FactSummary = {
    ...facts,
    documentType: 'earnings',
    facts: facts.facts.filter((value) => value.id !== fact.id),
  };
  const display = buildPresentation(summary, [page]);
  const supplemental = {
    ...observation,
    valueId: fact.evidence.kind === 'table' ? fact.evidence.valueId : fact.id,
  };
  for (const topic of ['performance', 'business'] as const) {
    const organization = {
      ...emptyOrganization(),
      observations: [{ ...supplemental, topic }],
    };
    organization.review = {
      contentHash: organizationHash(organization, summary, display.values, display.excerpts),
      claims: { [supplemental.id]: null },
      sources: Object.fromEntries(
        explanationSources(display.excerpts).map((source) => [source.id, null])
      ),
    };
    organization.status = 'partial';
    const presentation = { ...display, organization };
    expect(
      supportedObservations(organization, summary, display.values, display.excerpts)
    ).toHaveLength(1);
    const markdown = renderFacts(summary, presentation);
    expect(markdown.match(/^### 2026年3月期 実績／業績と増減要因$/gm)).toHaveLength(1);
    expect(markdown.includes('### 2026年3月期 実績／事業別業績')).toBe(topic === 'business');
    expect(markdown.match(/^\| .*営業利益.*20百万円.*$/gm)).toHaveLength(1);
    const restored = revalidatePresentation(JSON.parse(JSON.stringify(presentation)), summary, [
      page,
    ]);
    expect(renderFacts(summary, restored)).toBe(markdown);
  }
});

it('配当の確定値と補足値が同じ表示話題なら、別期を挟まず一つの期間見出しにまとめる', () => {
  const page = textPage(
    '会社名 株式会社テスト | 会計基準 日本基準 | 範囲 連結\n2026年3月期 配当\n期末配当金は100円です。\n中間配当金は50円です。\n2027年3月期 配当予想\n年間配当金は200円です。'
  );
  const inputs = [
    ['期末配当金', 100, '2026年3月期', 'actual', '2026年3月期 配当'],
    ['年間配当金', 200, '2027年3月期', 'forecast', '2027年3月期 配当予想'],
  ] as const;
  const candidates = inputs.map(([label, value, period, state, heading], index) => {
    const candidate = numberCandidate(page, label, value, period);
    return {
      ...candidate,
      id: `f${index}`,
      unit: '円',
      valueKind: state,
      evidence: {
        ...candidate.evidence,
        contextIds: [page.blocks.find((block) => block.text === heading)!.id],
      },
      semantics: { ...candidate.semantics, state, metricKind: 'perShare' as const },
    };
  });
  const facts = parseFactSummary(
    JSON.stringify({ version: 6, documentType: 'earnings', facts: candidates, unverified: [] }),
    'earnings',
    [page],
    false
  );
  expect(facts.unverified).toEqual([]);
  expect(facts.facts).toHaveLength(2);
  const display = buildPresentation(facts, [page]);
  const value = display.values.find((quantity) => quantity.decimal === '50')!;
  const observation: DisclosureObservation = {
    id: 'observation-0',
    topic: 'dividend',
    entity: '株式会社テスト',
    scope: '連結',
    basis: '日本基準',
    metric: '中間配当金',
    measure: 'other',
    period: '2026年3月期',
    state: 'actual',
    valueId: value.id,
    comparison: null,
    conditions: [],
    sourceIds: value.sourceIds,
  };
  const organization = { ...emptyOrganization(), observations: [observation] };
  organization.review = {
    contentHash: organizationHash(organization, facts, display.values, display.excerpts),
    claims: { [observation.id]: null },
    sources: Object.fromEntries(
      explanationSources(display.excerpts).map((source) => [source.id, null])
    ),
  };
  organization.status = 'partial';
  const presentation = { ...display, organization };
  expect(supportedObservations(organization, facts, display.values, display.excerpts)).toHaveLength(
    1
  );
  const markdown = renderFacts(facts, presentation);
  expect(markdown.match(/^### 2026年3月期 実績／配当$/gm)).toHaveLength(1);
  expect(markdown.match(/^### 2027年3月期 予想／配当$/gm)).toHaveLength(1);
  expect(markdown).not.toContain('／業績予想');
  for (const [label, amount] of [
    ['期末配当金', '100円'],
    ['中間配当金', '50円'],
    ['年間配当金', '200円'],
  ])
    expect(markdown.match(new RegExp(`^\\| .*${label}.*${amount}.*$`, 'gm'))).toHaveLength(1);
  const restored = revalidatePresentation(JSON.parse(JSON.stringify(presentation)), facts, [page]);
  expect(renderFacts(facts, restored)).toBe(markdown);
});

it('意味点検が同一実績セルを予想として誤承認しても、保存復元後の本文・分析・計算へ通さない', () => {
  const { facts, fact, page, display, observation, review } = reviewedTable('営業利益');
  const misapproved = {
    ...observation,
    state: 'forecast' as const,
    comparison: null,
    valueId: fact.evidence.kind === 'table' ? fact.evidence.valueId : fact.id,
  };
  review([misapproved]);
  const restored = revalidatePresentation(JSON.parse(JSON.stringify(display)), facts, [page]);
  const markdown = renderFacts(facts, restored);
  expect(markdown).toContain('補足指標の未整理');
  expect(markdown).toContain('20百万円');
  expect(markdown.split('## 開示内容')[0]).toContain('↑増益');
  expect(markdown).not.toContain('2026年3月期／予想／連結');
  expect(
    supportedObservations(restored.organization!, facts, restored.values, restored.excerpts)
  ).toEqual([]);
  const analysis = buildAnalysisInput(facts, restored);
  expect(analysis.coverage.observations).toBe(0);
  expect(analysis.evidence.some((e) => e.kind === 'observation')).toBe(false);
  expect(
    buildAnalysisCalculations(facts, restored).every((c) => c.sourceObservationIds.length === 0)
  ).toBe(true);
  expect(restored.organization!.observations).toEqual([misapproved]);
});

it('増減率も原数量の所有者と比較軸を照合し、無関係な比率を表示・保存・分析へ通さない', () => {
  const { facts, fact, display, page, observation, review } = reviewedTable('営業利益', '10', true);
  const rate = facts.facts.find(
    (f) => f.label === '売上高' && f.unit === '%' && f.period === fact.period
  )!;
  const revenue = facts.facts.find(
    (f) => f.label === '売上高' && f.unit === '百万円' && f.period === fact.period
  )!;
  expect(observation.comparison?.rateId).toBeNull();
  const aliasAmount = {
    ...revenue,
    semantics: { ...revenue.semantics, scope: '個別', basis: 'IFRS会計基準' },
  };
  for (const [scope, basis, paired] of [
    ['単体', 'IFRS', true],
    ['非連結', '国際会計基準', true],
    ['連結', 'IFRS', false],
    ['個別', '日本基準', false],
  ] as const)
    expect(canPair(aliasAmount, { ...rate, semantics: { ...rate.semantics, scope, basis } })).toBe(
      paired
    );
  const nativeRate = rate.evidence.kind === 'table' ? rate.evidence.valueId : rate.id;
  const classify = (claim: DisclosureObservation, input = facts) =>
    reconcileObservations(input, [claim], display.excerpts, display.values);
  for (const rateId of [rate.id, nativeRate]) {
    const claim = { ...observation, comparison: { ...observation.comparison!, rateId } };
    expect(classify(claim).conflicts).toEqual([claim]);
    // The same guard applies when only the current amount is supplemental.
    expect(
      classify(claim, { ...facts, facts: facts.facts.filter((f) => f.id !== fact.id) }).conflicts
    ).toEqual([claim]);
  }
  const valid = {
    ...reviewable(factObservation(revenue, facts, display.excerpts, display.values)),
    id: 'observation-1',
  };
  expect(valid.comparison?.rateId).toBe(rate.id);
  expect(classify(valid).conflicts).toEqual([]);
  // An unknown entity alias deliberately bypasses the primary merge. The known
  // physical rate still belongs to this amount's year-on-year comparison.
  const wrongAxis = {
    ...valid,
    entity: '当社',
    comparison: { ...valid.comparison!, axis: 'sequential' as const },
  };
  expect(classify(wrongAxis).conflicts).toEqual([wrongAxis]);
  const ambiguousReference = {
    ...valid,
    entity: '当社',
    comparison: {
      ...valid.comparison!,
      period: '前期',
      state: 'unspecified' as const,
    },
  };
  expect(classify(ambiguousReference).conflicts).toEqual([]);
  expect(classify(ambiguousReference).supplement).toEqual([ambiguousReference]);

  const onlyRateOwner = {
    ...facts,
    facts: facts.facts.filter(
      (f) => f.label !== '営業利益' && !(f.label === '売上高' && f.period !== fact.period)
    ),
  };
  const borrowed = {
    ...valid,
    valueId: observation.valueId,
    comparison: { ...valid.comparison!, valueId: observation.comparison!.valueId },
  };
  expect(classify(borrowed, onlyRateOwner).conflicts).toEqual([borrowed]);
  const unowned = { ...facts, facts: facts.facts.filter((f) => f.id !== rate.id) };
  expect(
    classify({ ...valid, comparison: { ...valid.comparison!, rateId: nativeRate } }, unowned)
      .conflicts
  ).toEqual([]);

  const unrelated = {
    ...observation,
    comparison: { ...observation.comparison!, rateId: nativeRate },
  };
  review([unrelated]);
  const restored = revalidatePresentation(JSON.parse(JSON.stringify(display)), facts, [page]);
  expect(
    supportedObservations(restored.organization!, facts, restored.values, restored.excerpts)
  ).toEqual([]);
  const profitRow = renderFacts(facts, restored)
    .split('\n')
    .find((line) => line.startsWith('| ') && line.includes('営業利益'))!;
  expect(profitRow).toContain('約');
  expect(profitRow).not.toContain('原文');
  expect(buildAnalysisInput(facts, restored).coverage.observations).toBe(0);
});

it('既知の指標別名は同じ数量へ統合し、比較値の別名も重複表示しない', () => {
  const { facts, display, review } = reviewedTable();
  const current = facts.facts.find((f) => f.label === '売上高' && f.value === 100)!;
  const base = reviewable(factObservation(current, facts, display.excerpts, display.values));
  const alias = { ...base, id: 'observation-0', metric: '営業収益' };
  const before = {
    ...alias,
    id: 'observation-1',
    valueId: base.comparison!.valueId,
    period: base.comparison!.period,
    state: base.comparison!.state,
    comparison: null,
  };
  const result = reconcileObservations(facts, [alias, before], display.excerpts, display.values);
  expect(result.conflicts).toEqual([]);
  expect(result.supplement).toEqual([]);
  expect(result.primary.get(current.id)?.comparison).toEqual(base.comparison);
  const aliasContext = { ...alias, scope: '非連結', basis: '国際会計基準' };
  const aliasedFacts = {
    ...facts,
    facts: facts.facts.map((f) => ({
      ...f,
      semantics: {
        ...f.semantics,
        scope: f.id === current.id ? '個別' : '単体',
        basis: f.id === current.id ? 'IFRS会計基準' : '国際会計基準',
      },
    })),
  };
  const aligned = reconcileObservations(
    aliasedFacts,
    [aliasContext],
    display.excerpts,
    display.values
  );
  expect(aligned.conflicts).toEqual([]);
  expect(aligned.supplement).toEqual([]);
  expect(aligned.primary.get(current.id)?.comparison).toEqual(base.comparison);
  const noFacts = { ...facts, facts: [] };
  const priorAlias = { ...before, metric: '売上収益' };
  expect(
    reconcileObservations(noFacts, [alias, priorAlias], display.excerpts, display.values).supplement
  ).toEqual([alias]);
  const unknownPeriod = { ...priorAlias, period: '比較期間不明' };
  expect(
    reconcileObservations(noFacts, [alias, unknownPeriod], display.excerpts, display.values)
      .supplement
  ).toEqual([alias, unknownPeriod]);
  const unknownName = { ...alias, metric: 'revenue' };
  expect(
    reconcileObservations(facts, [unknownName], display.excerpts, display.values).supplement
  ).toEqual([unknownName]);
  expect(result.merged.get(alias.id)).toBe(current.id);
  review([alias]);
  const analysis = buildAnalysisInput(facts, display);
  const note = analysis.evidence.find((e) => e.id === `observation:${alias.id}`)!;
  expect(note.text).toContain('売上高: 100百万円（同じ原数量への補足');
  expect(note.text).toContain('区分: revenue');
  expect(note.text).toContain('前年同期 2025年3月期 実績: 90百万円');
  expect(note.text.match(/100百万円/g)).toHaveLength(1);
  expect(note.sourceIds).toContain(current.id);
  expect(analysis.evidence.find((e) => e.id === `fact:${current.id}`)?.text).toContain('100百万円');
});
