import { beforeAll, describe, expect, it, vi } from 'vitest';
import { extractPageLayout } from './pdf-layout';
import { canonicalJSON, hashText } from './fact-contract';
import { generateText } from './llm-client';
import { textPage, layoutPage, numberCandidate } from './fixtures/v4-test-source';
import { reviewCandidates } from './fact-candidates';
import { candidateResponse } from './fixtures/candidate-test-source';
import {
  buildPresentation,
  revalidatePresentation,
  validatePresentation,
  type SummaryPresentation,
} from './summary-presentation';
import { generateVerifiedFactSummary, generateVerifiedFacts, renderFacts } from './fact-summary';
import {
  organizationClaims,
  organizationHash,
  explanationSources,
  supportedExplanations,
  unresolvedExplanationSources,
  unresolvedTableSources,
  emptyOrganization,
  ORGANIZATION_LIMITS,
  generateSummaryOrganization,
} from './summary-organization';
import { validateSavedFacts } from './fact-cache';
import {
  bindLiteralQuantities,
  quantitySourceClosure,
  checkText,
  parseNarrativeResponse,
  explicitTableRowUnit,
} from './summary-narrative';
import { buildAnalysisInput } from './analysis-input';
import { buildSummaryHtml } from '../content/utils/summaryHtmlBuilder';
import type { SummaryAttempt } from './summary-trace';
import { literalValue, quantityChange, renderNarrativeText } from './summary-narrative-renderer';
import {
  checkObservation,
  reconcileObservations,
  type DisclosureContext,
  type DisclosureObservation,
} from './disclosure-observation';

vi.mock('./llm-client', () => ({ generateText: vi.fn() }));
const config = { provider: 'openrouter', model: 'deepseek/deepseek-v4.1-flash', apiKey: 'fixture' };
const page = textPage(
  '会社名 株式会社テスト | 会計基準 日本基準 | 範囲 連結\n2026年3月期 連結経営成績\n営業利益は100百万円です。\n前年同期比20.0%。\n1. 事業別業績\n製品事業の当期売上は120百万円、前年売上は100百万円。当期利益は20百万円、前年利益は10百万円。価格転嫁で増益。\nサービス事業の当期損益は△15百万円、前年損益は△10百万円。先行投資で赤字が拡大。\n2. 受注の状況\n当期受注高は90百万円、前年同期受注高は100百万円。大型案件の反動。\n当期末受注残高は150百万円、前期末受注残高は100百万円。新規案件が積み上がったが納期が長期化。\n3. キャッシュ・フロー\n当期営業CFは△20百万円、前年同期営業CFは△30百万円。在庫増で営業CFは支出。\n当期投資CFは△60百万円。設備投資が主因。\n当期財務CFは50百万円。借入で資金を確保。\n期首現金同等物は100百万円、期末現金同等物は70百万円。'
);
const facts = {
  version: 6,
  documentType: 'other' as const,
  facts: reviewCandidates(candidateResponse([numberCandidate(page)], [page]), 'other', [page])
    .facts,
  unverified: [],
};
const draft = buildPresentation(facts, [page]);
const sources = draft.excerpts.map((e) => e.id);
const q = (amount: string, includes: string) =>
  draft.values.find(
    (v) =>
      v.decimal === amount &&
      v.sourceIds.some((id) => draft.excerpts.find((e) => e.id === id)!.text.includes(includes))
  )!.id;

function wire() {
  const context = (
    id: string,
    topic: DisclosureContext['topic'],
    entity: string | null,
    period: string | null,
    state: DisclosureContext['state'] = 'actual'
  ) => ({
    id,
    topic,
    entity,
    period,
    state,
    scope: null,
    basis: null,
    conditions: [],
    sourceIds: sources,
  });
  const observation = (
    contextId: string,
    metric: string,
    measure: DisclosureObservation['measure'],
    source: string,
    current: string,
    previous: string,
    comparisonContextId: string,
    axis: 'yearOnYear' | 'periodEnd' = 'yearOnYear'
  ) => ({
    contextId,
    metric,
    measure,
    valueId: q(current, source),
    sourceIds: sources,
    comparison: {
      axis,
      contextId: comparisonContextId,
      valueId: q(previous, source),
      rateId: null,
    },
  });
  return {
    version: 6,
    contexts: [
      context('product', 'business', '製品事業', '本中間期'),
      context('product-prior', 'business', '製品事業', '前年上半期'),
      context('service', 'business', 'サービス事業', '本中間期'),
      context('service-prior', 'business', 'サービス事業', '前年上半期'),
      context('orders', 'orders', null, '本中間期'),
      context('orders-prior', 'orders', null, '前年上半期'),
      context('orders-end', 'orders', null, '前期末'),
      context('cash', 'cash', null, '本中間期'),
      context('cash-prior', 'cash', null, '前年上半期'),
      context('business-note', 'business', null, null, 'unspecified'),
      context('orders-note', 'orders', null, null, 'unspecified'),
    ],
    observations: [
      observation(
        'product',
        '顧客向け販売額',
        'revenue',
        '製品事業',
        '120',
        '100',
        'product-prior'
      ),
      observation('product', '部門損益', 'profit', '製品事業', '20', '10', 'product-prior'),
      observation('service', '部門損益', 'profit', 'サービス事業', '-15', '-10', 'service-prior'),
      observation('orders', '新規契約の受注額', 'stock', '当期受注高', '90', '100', 'orders-prior'),
      observation(
        'orders',
        '未消化の案件残高',
        'stock',
        '当期末受注残高',
        '150',
        '100',
        'orders-end',
        'periodEnd'
      ),
      observation('cash', '本業の資金収支', 'flow', '当期営業CF', '-20', '-30', 'cash-prior'),
    ],
    claims: [
      {
        contextId: 'business-note',
        text: '価格転嫁が製品事業の増益に寄与。サービス事業は先行投資で赤字拡大。',
        sourceIds: sources,
      },
      {
        contextId: 'orders-note',
        text: '受注残増加により来期の増収が確定した。',
        sourceIds: sources,
      },
    ],
  };
}
function review(input = wire()) {
  return {
    version: 2,
    claims: [
      ...input.observations.map((_, i) => ({ id: `observation-${i}`, reason: null })),
      ...input.claims.map((_, i) => ({
        id: `explanation-${i}`,
        reason: i === 1 ? '来期増収確定の根拠がない' : null,
      })),
    ],
    sources: explanationSources(draft.excerpts).map((e) => ({
      id: e.id,
      reason: e.text.includes('受注残高') ? '納期長期化の条件が未要約' : null,
    })),
  };
}
const first = candidateResponse([numberCandidate(page)], [page], 'other');
async function generate(input = wire(), verdict = review(input)) {
  vi.mocked(generateText)
    .mockReset()
    .mockResolvedValueOnce(first)
    .mockResolvedValueOnce(JSON.stringify(input))
    .mockResolvedValueOnce(JSON.stringify(verdict));
  const attempts: SummaryAttempt[] = [];
  const result = await generateVerifiedFactSummary(config, 'other', 'source', [page], (a) => {
    attempts.push(a);
  });
  return { ...result, attempts };
}
function visible(result: Pick<Awaited<ReturnType<typeof generate>>, 'facts' | 'presentation'>) {
  return buildSummaryHtml(renderFacts(result.facts, result.presentation), null, {
    companyName: 'テスト',
    title: '開示',
  }).replace(/<details\b[\s\S]*?<\/details>/g, '');
}
async function organize(raw = JSON.stringify(wire()), verdict = review()) {
  vi.mocked(generateText)
    .mockReset()
    .mockResolvedValueOnce(raw)
    .mockResolvedValueOnce(JSON.stringify(verdict));
  return generateSummaryOrganization(config, facts, draft.values, draft.excerpts, [page]);
}
function financialTable(current: string, previous: string, splitUnit = false) {
  const amount = (text: string, x: number) =>
    splitUnit
      ? [
          { text: text.replace(/百万円$/, ''), x, width: 20 },
          { text: '百万円', x: x + 23, width: 30 },
        ]
      : [{ text, x, width: 60 }];
  return layoutPage([
    { id: 'p1s1', text: '（単位：百万円）', x: 0, y: 100, width: 90, height: 10 },
    { id: 'p1s2', text: '営業利益', x: 0, y: 124, width: 50, height: 10 },
    ...[...amount(current, 100), ...amount(previous, 200)].map((span, i) => ({
      ...span,
      id: `p1s${i + 3}`,
      y: 124,
      height: 10,
    })),
  ]);
}

function ruledQuantities(amounts: string[], label = '営業利益') {
  return extractPageLayout(
    [label, ...amounts].map((str, i) => ({
      str,
      dir: 'ltr',
      transform: [10, 0, 0, 10, i * 100, -124],
      width: 60,
      height: 10,
      hasEOL: false,
      fontName: 'test',
    })),
    1,
    [label, ...amounts].map((_, i) => ({
      index: i,
      fn: 'constructPath',
      // Closed cells have a real gap; buildBlocks must retain its hard separator.
      args: [
        'stroke',
        [
          [
            0,
            i * 100 - 5,
            -114,
            1,
            i * 100 + 85,
            -114,
            1,
            i * 100 + 85,
            -134,
            1,
            i * 100 - 5,
            -134,
            4,
          ],
        ],
        null,
      ],
    }))
  );
}

describe('構造化を主とする表示と未整理部分の保持', () => {
  it('任意の補足生成に失敗しても確定済みの出来事と別注記の条件を通常表示・保存復元する', async () => {
    const statement = '株式を取得する予定です。';
    const condition = '（注）取得は当局の承認を条件とします。';
    const source = textPage(`1. 株式取得\n${statement}\n${condition}`);
    const event = {
      ...facts.facts[0],
      kind: 'event' as const,
      label: statement,
      value: null,
      unit: null,
      period: null,
      valueKind: null,
      statement,
      quote: statement,
      evidence: {
        kind: 'prose' as const,
        blockId: source.blocks[1].id,
        assertionId: `${source.blocks[1].id}:a1`,
        quantityId: null,
        contextIds: [],
        scopeIds: [],
        qualifierIds: [],
      },
      semantics: {
        subject: null,
        scope: null,
        basis: null,
        periodKind: 'none' as const,
        metricKind: 'none' as const,
        state: 'planned' as const,
        polarity: 'affirmative' as const,
        qualifiers: [],
        conditions: [],
      },
      quantity: null,
      provenance: null,
      dateRoles: null,
    };
    vi.mocked(generateText)
      .mockReset()
      .mockResolvedValueOnce(candidateResponse([event], [source]))
      .mockRejectedValueOnce(new Error('補足生成のタイムアウト'));
    const result = await generateVerifiedFactSummary(config, 'other', statement, [source]);
    expect(result.facts.facts).toHaveLength(1);
    expect(result.presentation.organization.status).toBe('unavailable');
    const reading = visible(result);
    expect(reading).toContain('確認済み事項（原文）');
    expect(reading).toContain(statement);
    expect(result.facts.facts[0].semantics.conditions).toContain(condition);
    expect(reading).toContain('当局の承認を条件とします');
    expect(reading).toContain('一部の補足説明・数値は要約に反映できていません');
    expect(reading).not.toContain('補足要約の未整理部分');
    const savedFacts: unknown = JSON.parse(JSON.stringify(result.facts));
    validateSavedFacts(savedFacts);
    const restored = revalidatePresentation(
      JSON.parse(JSON.stringify(result.presentation)),
      savedFacts,
      [source]
    );
    expect(renderFacts(result.facts, restored)).toBe(
      renderFacts(result.facts, result.presentation)
    );
    expect(vi.mocked(generateText)).toHaveBeenCalledTimes(2);
  });
  it.each(['unruled', 'split-unit', 'closed-cells'])(
    '同額セルを別々に追跡し、位置で証明した別名だけをまとめる: %s',
    (layout) => {
      const source =
        layout === 'closed-cells'
          ? ruledQuantities(['100百万円', '100百万円'])
          : financialTable('100百万円', '100百万円', layout === 'split-unit');
      const display = buildPresentation({ ...facts, facts: [] }, [source]);
      const row = display.excerpts.find((e) => e.kind === 'row' && e.text.includes('営業利益'))!;
      const [current, previous] = display.values.filter((v) => row.spanIds.includes(v.id));
      expect(current.decimal).toBe(previous.decimal);
      expect(display.values.some((v) => v.id.startsWith(`${row.blockId}:q`))).toBe(false);
      const confirmed = {
        ...facts.facts[0],
        evidence: {
          kind: 'table' as const,
          valueId: current.id,
          metricIds: [],
          periodIds: [],
          unitIds: [],
          contextIds: [],
          scopeIds: [],
          qualifierIds: [],
        },
      };
      const summary = { ...facts, facts: [confirmed] };
      const values = [...display.values, { ...current, id: confirmed.id }];
      expect(() =>
        checkText(
          `{{change:${confirmed.id}|${current.id}|profit}}`,
          [row.id],
          values,
          display.excerpts,
          summary
        )
      ).toThrow('NARRATIVE_COMPARISON');
      expect(() =>
        checkText(
          `{{change:${confirmed.id}|${previous.id}|profit}}`,
          [row.id],
          values,
          display.excerpts,
          summary
        )
      ).not.toThrow();
      const organization = emptyOrganization();
      expect(unresolvedTableSources(organization, summary, values, display.excerpts)).toEqual([
        row,
      ]);
      expect(
        unresolvedTableSources(
          organization,
          summary,
          values.filter((v) => v.id !== previous.id),
          display.excerpts
        )
      ).toEqual([]);
      expect(
        unresolvedTableSources(
          organization,
          {
            ...summary,
            facts: [
              ...summary.facts,
              {
                ...confirmed,
                id: 'previous',
                evidence: { ...confirmed.evidence, valueId: previous.id },
              },
            ],
          },
          values,
          display.excerpts
        )
      ).toEqual([]);
    }
  );
  it('段落に分類されたセルも原文位置で同一性を保ち、独立した本文数量は残す', () => {
    const source = ruledQuantities(['100百万円'], '営業利益は');
    const prose = textPage('営業利益は100百万円です。', 2);
    const summary = { ...facts, facts: [] };
    const display = buildPresentation(summary, [source, prose]);
    expect(source.blocks[0]).toMatchObject({
      kind: 'paragraph',
      text: '営業利益は ││ 100百万円',
    });
    expect(display.values.map((value) => value.id)).toEqual(['p1s2', 'p2b1:q1']);
    expect(display.values.every((value) => value.decimal === '100')).toBe(true);
  });

  it('離れた同額セルの比較を保存復元し、旧行内別名による自己比較は復元しない', () => {
    const source = ruledQuantities(['100百万円', '100百万円']);
    const summary = { ...facts, facts: [] };
    const display = buildPresentation(summary, [source]);
    const [current, previous] = display.values;
    const row = display.excerpts[0];
    expect(row.text).toBe('営業利益 ││ 100百万円 ││ 100百万円');
    const token = `{{change:${current.id}|${previous.id}|profit}}`;
    expect(() =>
      checkText(token, [row.id], display.values, display.excerpts, summary)
    ).not.toThrow();
    expect(renderNarrativeText(token, display.values)).toBe('→横ばい 約0.0%');
    const observation: DisclosureObservation = {
      id: 'observation-0',
      topic: 'business',
      entity: null,
      scope: null,
      basis: null,
      metric: '営業利益',
      measure: 'profit',
      period: '当期',
      state: 'actual',
      conditions: [],
      sourceIds: [row.id],
      valueId: current.id,
      comparison: {
        axis: 'yearOnYear',
        period: '前年同期',
        state: 'actual',
        valueId: previous.id,
        rateId: null,
      },
    };
    expect(() =>
      checkObservation(observation, display.values, display.excerpts, summary)
    ).not.toThrow();
    display.organization = {
      ...emptyOrganization(),
      status: 'ready',
      observations: [observation],
    };
    const review = () => {
      display.organization.review = {
        contentHash: organizationHash(
          display.organization,
          summary,
          display.values,
          display.excerpts
        ),
        claims: { 'observation-0': null },
        sources: {},
      };
    };
    review();
    expect(revalidatePresentation(JSON.parse(JSON.stringify(display)), summary, [source])).toEqual(
      display
    );
    // A cache produced before the alias fix could contain both IDs for one cell.
    const alias = { ...current, id: `${row.blockId}:q1` };
    display.values.push(alias);
    observation.comparison!.valueId = alias.id;
    display.sourceHash = hashText(
      canonicalJSON({
        excerpts: display.excerpts,
        values: display.values,
        ledgerHash: display.sourceLedger?.sourceHash,
      })
    );
    display.organization.status = 'partial';
    review();
    expect(() => validatePresentation(display, summary)).not.toThrow();
    expect(() =>
      revalidatePresentation(JSON.parse(JSON.stringify(display)), summary, [source])
    ).toThrow('原文引用とPDF');
  });

  it('事業別・受注・負のCFを表示し、説明を個別採否して同じ段落の未要約条件を残す', async () => {
    const input = wire();
    input.observations.reverse();
    input.observations[5].metric = '販売による収入';
    input.contexts.find((c) => c.id === 'product')!.period = '2026年度 上半期';
    const verdict = review(input);
    verdict.claims.reverse();
    verdict.sources.reverse();
    const result = await generate(input, verdict);
    expect(result.presentation.version).toBe(7);
    expect(result.presentation.organization.status).toBe('partial');
    expect(supportedExplanations(result.presentation.organization)).toHaveLength(1);
    const reading = visible(result);
    for (const expected of [
      '営業利益',
      '100百万円',
      '↑増収 約+20.0%',
      '↑増益 約+100.0%',
      '↓赤字拡大 約+50.0%',
      '↓減少 約−10.0%',
      '↑増加 約+50.0%',
      '↑増加（+10百万円）',
      '価格転嫁',
      '一部の補足説明・数値は要約に反映できていません',
    ])
      expect(reading).toContain(expected);
    expect(reading).not.toContain('来期の増収が確定');
    const html = buildSummaryHtml(renderFacts(result.facts, result.presentation), null, {
      companyName: 'テスト',
      title: '開示',
    });
    expect(html).toContain('納期が長期化');
    expect(html).toContain('先行投資で赤字が拡大');
    const restored = revalidatePresentation(
      JSON.parse(JSON.stringify(result.presentation)),
      result.facts,
      [page]
    );
    expect(renderFacts(result.facts, restored)).toBe(
      renderFacts(result.facts, result.presentation)
    );
    expect(result.attempts.map((a) => a.phase)).toEqual(['first', 'summary', 'summaryReview']);
    const calls = vi.mocked(generateText).mock.calls;
    expect(
      calls.slice(1).every(([c]) => c.reasoningEnabled === false && c.maxOutputTokens === 8192)
    ).toBe(true);
    const request = JSON.parse(calls[1][1][1].content);
    expect(request.layout[0].rows.length).toBeGreaterThan(0);
    expect(request.excerpts).toEqual(draft.excerpts);
    // A source reference and one number do not prove every assertion in its paragraph.
    expect(
      result.presentation.organization.review!.sources[
        explanationSources(draft.excerpts).find((e) => e.text.includes('受注残高'))!.id
      ]
    ).toContain('未要約');
    expect(reading).toContain('販売による収入');
    expect(renderFacts(result.facts, result.presentation).match(/### 事業別業績/g)).toHaveLength(1);
    for (const label of ['前期末', '対象期', '2026年度 上半期']) expect(reading).toContain(label);
    expect(input.contexts.length).toBeLessThan(input.observations.length * 2);
    expect(organizationClaims(result.presentation.organization)).toHaveLength(8);
    expect(
      organizationHash(result.presentation.organization, result.facts, draft.values, draft.excerpts)
    ).toBe(result.presentation.organization.review!.contentHash);
  });
  it('説明点検の失敗でも確定済みの数値を表示し、失敗理由を記録する', async () => {
    vi.mocked(generateText)
      .mockReset()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(JSON.stringify(wire()))
      .mockRejectedValueOnce(new Error('説明点検の期限'));
    const attempts: SummaryAttempt[] = [];
    const result = await generateVerifiedFactSummary(config, 'other', 'source', [page], (a) => {
      attempts.push(a);
    });
    expect(result.presentation.organization.status).toBe('unavailable');
    expect(result.presentation.organization.claims).toEqual([]);
    expect(result.presentation.organization.observations).toEqual([]);
    expect(renderFacts(result.facts, result.presentation)).toContain('100百万円');
    expect(renderFacts(result.facts, result.presentation)).toContain('補足要約の未整理部分');
    expect(attempts[attempts.length - 1]?.error).toBe('説明点検の期限');
    expect(vi.mocked(generateText)).toHaveBeenCalledTimes(3);
  });
  it('原文の対応が不足する項目は修復で補わず、未確認状態を保存復元する', async () => {
    const source = textPage(
      '会社名 株式会社テスト | 会計基準 日本基準 | 範囲 連結\n2026年3月期 連結経営成績\n営業利益は100百万円です。'
    );
    const candidate = candidateResponse([numberCandidate(source)], [source], 'earnings');
    vi.mocked(generateText).mockReset().mockResolvedValueOnce(candidate);
    const incomplete = await generateVerifiedFacts(
      config,
      'earnings',
      'source',
      [source],
      undefined,
      true
    );
    expect(incomplete.facts.facts.some((f) => f.value === 100)).toBe(true);
    expect(incomplete.facts.unverified.length).toBeGreaterThan(0);
    expect(renderFacts(incomplete.facts, incomplete.presentation)).toContain('100百万円');
    expect(incomplete.facts.facts.some((f) => f.label === '売上高')).toBe(false);
    const empty = { ...incomplete.facts, facts: [] };
    validateSavedFacts(empty);
    const emptyDisplay = buildPresentation(empty, [source]);
    const restoredEmpty = revalidatePresentation(JSON.parse(JSON.stringify(emptyDisplay)), empty, [
      source,
    ]);
    expect(renderFacts(empty, restoredEmpty)).toContain('数値・条件を確定できていません');
    expect(() => validateSavedFacts({ ...empty, unverified: [] })).toThrow('形式');
    expect(incomplete.repairAttempted).toBe(false);
    expect(vi.mocked(generateText)).toHaveBeenCalledTimes(1);
  });
});

describe('説明候補と独立点検の契約', () => {
  it('長い資料でも点検対象段落を制限し、採用した説明と指標を保って対象外は未整理で保存する', async () => {
    const notes = textPage(
      Array.from(
        { length: ORGANIZATION_LIMITS.reviewSources * 3 },
        () => '販売方針には継続して検討すべき条件があります。'
      ).join('\n'),
      2
    );
    const pages = [page, notes];
    const display = buildPresentation(facts, pages);
    const prose = explanationSources(display.excerpts);
    const noteIds = prose.filter((e) => e.page === 2).map((e) => e.id);
    const lastNote = noteIds[noteIds.length - 1];
    const input = wire();
    input.claims = [input.claims[0]];
    input.contexts.find((c) => c.id === 'business-note')!.sourceIds = [lastNote];
    input.claims[0].sourceIds = [
      ...sources,
      ...noteIds.slice(0, ORGANIZATION_LIMITS.reviewSources),
    ];
    // A referenced final paragraph precedes unrelated earlier prose; relevant overflow
    // must also remain unresolved rather than expanding the output obligation.
    const reviewedIds = [
      lastNote,
      ...explanationSources(draft.excerpts).map((e) => e.id),
      ...noteIds,
    ].slice(0, ORGANIZATION_LIMITS.reviewSources);
    const verdict = {
      ...review(input),
      sources: reviewedIds.map((id) => ({ id, reason: null })),
    };
    vi.mocked(generateText)
      .mockReset()
      .mockResolvedValueOnce(JSON.stringify(input))
      .mockResolvedValueOnce(JSON.stringify(verdict));
    const organization = await generateSummaryOrganization(
      config,
      facts,
      display.values,
      display.excerpts,
      pages
    );
    expect(vi.mocked(generateText)).toHaveBeenCalledTimes(2);
    const [request, messages] = vi.mocked(generateText).mock.calls[1];
    expect(JSON.parse(messages[1].content.split('\n対象段落: ')[1])).toEqual(reviewedIds);
    expect(request.responseFormat).toMatchObject({
      type: 'json_schema',
      json_schema: {
        schema: {
          properties: {
            claims: { minItems: verdict.claims.length, maxItems: verdict.claims.length },
            sources: {
              minItems: ORGANIZATION_LIMITS.reviewSources,
              maxItems: ORGANIZATION_LIMITS.reviewSources,
              items: { properties: { id: { enum: reviewedIds } } },
            },
          },
        },
      },
    });
    expect(organization.status).toBe('partial');
    expect(supportedExplanations(organization)).toHaveLength(1);
    expect(organization.review!.claims).toEqual(
      Object.fromEntries(verdict.claims.map(({ id }) => [id, null]))
    );
    expect(Object.keys(organization.review!.sources)).toEqual(prose.map((e) => e.id));
    const omitted = prose.filter((e) => !reviewedIds.includes(e.id));
    expect(omitted.length).toBeGreaterThan(0);
    for (const source of omitted)
      expect(organization.review!.sources[source.id]).toContain('点検対象外');
    expect(unresolvedExplanationSources(organization, display.excerpts)).toEqual(omitted);
    const restored = revalidatePresentation(
      JSON.parse(JSON.stringify({ ...display, organization })),
      facts,
      pages
    );
    expect(restored.organization).toEqual(organization);
    expect(renderFacts(facts, restored)).toContain('価格転嫁');
    expect(renderFacts(facts, restored)).toContain('100百万円');
    delete restored.organization.review!.sources[omitted[0].id];
    expect(() => validatePresentation(restored, facts)).toThrow('点検範囲');
  });

  it('生成時だけ既知の重複参照を正規化し、保存済みの重複は受け入れない', async () => {
    const input = wire();
    for (const item of [...input.contexts, ...input.observations, ...input.claims])
      item.sourceIds = [...item.sourceIds, item.sourceIds[0]];
    const result = await organize(JSON.stringify(input));
    expect(result.observations).toHaveLength(input.observations.length);
    expect(result.claims).toHaveLength(input.claims.length);
    expect(result.issues).toEqual([]);
    expect(vi.mocked(generateText)).toHaveBeenCalledTimes(2);
    const restored = revalidatePresentation(
      JSON.parse(JSON.stringify({ ...draft, organization: result })),
      facts,
      [page]
    );
    expect(restored.organization).toEqual(result);
    restored.organization.observations[0].sourceIds.push(
      restored.organization.observations[0].sourceIds[0]
    );
    expect(() => validatePresentation(restored, facts)).toThrow('保存形式');
  });

  it('不正な未使用文脈で点検済みの説明範囲を未整理へ戻さない', async () => {
    const baseline = await organize();
    const input = wire();
    input.contexts.push({ ...input.contexts[0], id: 'unused-invalid', sourceIds: [] });
    const result = await organize(JSON.stringify(input));
    expect(result.issues).toHaveLength(1);
    expect(result.status).toBe('partial');
    expect(supportedExplanations(result)).toEqual(supportedExplanations(baseline));
    expect(unresolvedExplanationSources(result, draft.excerpts)).toEqual(
      unresolvedExplanationSources(baseline, draft.excerpts)
    );
    expect(
      buildAnalysisInput(facts, { ...draft, organization: result }).coverage.unresolvedSources
    ).toBe(
      buildAnalysisInput(facts, { ...draft, organization: baseline }).coverage.unresolvedSources
    );
  });

  it.each<[string, (input: ReturnType<typeof wire>) => void, string[], string]>([
    [
      '存在しない文脈ID',
      (v) => (v.observations[0].contextId = 'absent-context'),
      ['observation-0'],
      'OBSERVATION_CONTEXT',
    ],
    [
      '重複する文脈ID',
      (v) => v.contexts.push({ ...v.contexts[0] }),
      ['observation-0', 'observation-1'],
      'OBSERVATION_CONTEXT',
    ],
    [
      '未知の根拠ID',
      (v) => (v.observations[0].sourceIds = [...sources, 'unknown-source']),
      ['observation-0'],
      'EXPLANATION_SCHEMA',
    ],
    [
      '空の根拠',
      (v) => (v.observations[0].sourceIds = []),
      ['observation-0'],
      'EXPLANATION_SCHEMA',
    ],
    [
      '文字列以外の根拠',
      (v) => Object.assign(v.observations[0], { sourceIds: [null] }),
      ['observation-0'],
      'EXPLANATION_SCHEMA',
    ],
    [
      '未知の数量',
      (v) => (v.observations[0].valueId = 'unknown-quantity'),
      ['observation-0'],
      'REFERENCE',
    ],
    [
      '壊れた説明',
      (v) => Object.assign(v.claims[0], { text: null }),
      ['explanation-0'],
      'EXPLANATION_SCHEMA',
    ],
  ])('%sだけを除き、独立点検した残りを保存する', async (_, change, rejected, error) => {
    const input = wire();
    change(input);
    const verdict = review();
    verdict.claims = verdict.claims.filter((c) => !rejected.includes(c.id));
    const result = await organize(JSON.stringify(input), verdict);
    expect(result.status).toBe('partial');
    expect(organizationClaims(result).map((c) => c.id)).toEqual(
      expect.arrayContaining(verdict.claims.map((c) => c.id))
    );
    expect(organizationClaims(result)).toHaveLength(verdict.claims.length);
    expect(result.issues.some((issue) => issue.reason.includes(error))).toBe(true);
    expect(vi.mocked(generateText)).toHaveBeenCalledTimes(2);
    expect(
      revalidatePresentation(
        JSON.parse(JSON.stringify({ ...draft, organization: result })),
        facts,
        [page]
      ).organization
    ).toEqual(result);
  });

  it.each<[string, (input: ReturnType<typeof wire>) => void, string]>([
    [
      '指標数の上限超過',
      (v) => {
        v.observations = Array.from({ length: ORGANIZATION_LIMITS.observations + 1 }, () => ({
          ...v.observations[0],
        }));
      },
      'OBSERVATION_SCHEMA',
    ],
    ['旧候補形式', (v) => Object.assign(v, { version: 3, tables: [] }), 'OBSERVATION_SCHEMA'],
  ])('%sは点検へ進めず未整理として残す', async (_, change, error) => {
    const input = wire();
    change(input);
    const result = await organize(JSON.stringify(input));
    expect(result.status).toBe('unavailable');
    expect(result.observations).toEqual([]);
    expect(result.issues[0].reason).toContain(error);
    expect(vi.mocked(generateText)).toHaveBeenCalledTimes(1);
  });

  it('JSONの同名キーを最後の値で上書きしない', () => {
    expect(() =>
      parseNarrativeResponse(
        '{"version":6,"contexts":[],"observations":[],"claims":[],"claims":[]}'
      )
    ).toThrow('重複');
  });

  it.each<[string, (verdict: ReturnType<typeof review>) => void]>([
    ['判定IDの重複', (v) => (v.claims[1] = { ...v.claims[0] })],
    ['対象段落の欠落', (v) => v.sources.pop()],
    ['未知の判定ID', (v) => (v.claims[0].id = 'unknown-observation')],
    ['理由の文字数超過', (v) => (v.sources[0].reason = '長'.repeat(81))],
    ['旧点検形式', (v) => (v.version = 1)],
  ])('%sの点検では指標も説明も採用しない', async (_, change) => {
    const verdict = review();
    change(verdict);
    const result = await organize(JSON.stringify(wire()), verdict);
    expect(result.status).toBe('unavailable');
    expect(result.observations).toEqual([]);
    expect(result.claims).toEqual([]);
    expect(result.issues[0].reason).toContain('EXPLANATION_REVIEW');
    expect(vi.mocked(generateText)).toHaveBeenCalledTimes(2);
  });
});

describe('保存された説明・比較の検証', () => {
  let presentation: SummaryPresentation;
  beforeAll(async () => {
    presentation = { ...draft, organization: await organize() };
  });

  it.each<[string, (value: SummaryPresentation) => void, string]>([
    [
      '未知の数量ID',
      (v) => (v.organization.observations[0].valueId = 'unknown-quantity'),
      'REFERENCE',
    ],
    ['旧表示形式', (v) => Object.assign(v, { version: 6 }), '不正'],
    ['余分な保存項目', (v) => Object.assign(v, { unknown: true }), '不正'],
    [
      '前年中間期末を前期末とする比較',
      (v) => {
        const observation = v.organization.observations[0];
        observation.period = '2027年２月期中間期';
        observation.comparison!.period = '2026年2月期第２四半期';
        observation.comparison!.axis = 'periodEnd';
      },
      'OBSERVATION_PERIOD',
    ],
    [
      '確定事実IDと同じ原文数量IDの自己比較',
      (v) => {
        const fact = facts.facts[0];
        if (fact.evidence.kind !== 'prose') throw new Error('prose fixture expected');
        const observation = v.organization.observations[0];
        observation.valueId = fact.id;
        observation.comparison!.valueId = fact.evidence.quantityId!;
        v.organization.review!.contentHash = organizationHash(
          v.organization,
          facts,
          v.values,
          v.excerpts
        );
      },
      'OBSERVATION_QUANTITY',
    ],
    ['判定IDの欠落', (v) => delete v.organization.review!.claims['observation-0'], '点検範囲'],
  ])('%sは復元しない', (_, change, error) => {
    const saved = structuredClone(presentation);
    change(saved);
    expect(() => validatePresentation(saved, facts)).toThrow(error);
  });

  it('独立点検で不支持の指標を表示しない', () => {
    const unsupported = structuredClone(presentation);
    unsupported.organization.review!.claims['observation-0'] = '期間対応が未確認';
    expect(visible({ facts, presentation: unsupported })).not.toContain('↑増収 約+20.0%');
  });
});

describe('原文数量の符号・単位・所有セル', () => {
  it.each(['100百万円', '100 百万円'])(
    '本文数量%sも物理セルの同一性を保存し、比較と補足統合で共有する',
    (raw) => {
      const source = layoutPage([
        {
          id: 'p1s1',
          text: '会社名 株式会社テスト | 会計基準 日本基準 | 範囲 連結',
          x: 0,
          y: 20,
          width: 400,
          height: 10,
        },
        { id: 'p1s2', text: '2026年3月期 連結経営成績', x: 0, y: 50, width: 250, height: 10 },
        { id: 'p1s3', text: '営業利益は', x: 0, y: 124, width: 60, height: 10 },
        { id: 'p1s4', text: raw, x: 100, y: 124, width: 65, height: 10 },
        { id: 'p1s5', text: 'です。', x: 190, y: 124, width: 30, height: 10 },
      ]);
      const reviewed = reviewCandidates(
        candidateResponse([numberCandidate(source)], [source]),
        'other',
        [source]
      );
      expect(reviewed.unverified).toEqual([]);
      expect(reviewed.facts).toHaveLength(1);
      const summary = { ...facts, facts: reviewed.facts };
      const fact = summary.facts[0];
      expect(fact.evidence).toMatchObject({ kind: 'prose', quantityId: 'p1b3:q1' });
      const display = buildPresentation(summary, [source]);
      const native = display.values.find((value) => value.id === 'p1s4')!;
      expect(display.values.find((value) => value.id === fact.id)?.sourceQuantityId).toBe(
        native.id
      );
      expect(display.values.some((value) => value.id === 'p1b3:q1')).toBe(false);
      const observation: DisclosureObservation = {
        id: 'observation-0',
        topic: 'performance',
        entity: '株式会社テスト',
        scope: '連結',
        basis: '日本基準',
        metric: '営業利益',
        measure: 'profit',
        period: '2026年3月期',
        state: 'actual',
        conditions: [],
        sourceIds: display.excerpts.map((excerpt) => excerpt.id),
        valueId: native.id,
        comparison: null,
      };
      const restored = revalidatePresentation(JSON.parse(JSON.stringify(display)), summary, [
        source,
      ]);
      expect(
        reconcileObservations(
          summary,
          [observation],
          restored.excerpts,
          restored.values
        ).merged.get(observation.id)
      ).toBe(fact.id);
      expect(() =>
        checkText(
          `{{change:${fact.id}|${native.id}|profit}}`,
          observation.sourceIds,
          restored.values,
          restored.excerpts,
          summary
        )
      ).toThrow('NARRATIVE_COMPARISON');
      expect(() =>
        checkObservation(
          {
            ...observation,
            valueId: fact.id,
            comparison: {
              axis: 'yearOnYear',
              period: '2025年3月期',
              state: 'actual',
              valueId: native.id,
              rateId: null,
            },
          },
          restored.values,
          restored.excerpts,
          summary
        )
      ).toThrow('OBSERVATION_QUANTITY');
      for (const originalId of [undefined, fact.id, 'p1s999']) {
        const altered = structuredClone(restored);
        const value = altered.values.find((value) => value.id === fact.id)!;
        if (originalId === undefined) delete value.sourceQuantityId;
        else value.sourceQuantityId = originalId;
        expect(() => validatePresentation(altered, summary)).toThrow('保存された表示数量が不正');
      }
      const stale = structuredClone(restored);
      stale.values.find((value) => value.id === fact.id)!.sourceQuantityId = 'p1b3:q1';
      stale.sourceHash = hashText(
        canonicalJSON({
          excerpts: stale.excerpts,
          values: stale.values,
          ledgerHash: stale.sourceLedger?.sourceHash,
        })
      );
      expect(() => revalidatePresentation(stale, summary, [source])).toThrow('原文引用とPDF');
    }
  );

  it('確定済み本文数量の別名を比較に使わず、同額の別原文は比較できる', () => {
    const source = textPage(
      '会社名 株式会社テスト | 会計基準 日本基準 | 範囲 連結\n2026年3月期 連結経営成績\n営業利益は100 百万円です。\n製品事業の利益は100百万円です。'
    );
    const reviewed = reviewCandidates(
      candidateResponse([numberCandidate(source)], [source]),
      'other',
      [source]
    );
    expect(reviewed.unverified).toEqual([]);
    const summary = { ...facts, facts: reviewed.facts };
    const fact = summary.facts[0];
    if (fact.evidence.kind !== 'prose') throw new Error('prose fixture expected');
    const quantityId = fact.evidence.quantityId;
    const display = buildPresentation(summary, [source]);
    expect(
      display.values.filter((value) => value.id.startsWith('p1b3:q')).map((value) => value.id)
    ).toEqual([quantityId]);
    const restored = revalidatePresentation(JSON.parse(JSON.stringify(display)), summary, [source]);
    const sourceIds = restored.excerpts.map((excerpt) => excerpt.id);
    expect(() =>
      checkText(
        `{{change:${fact.id}|${quantityId}|profit}}`,
        sourceIds,
        restored.values,
        restored.excerpts,
        summary
      )
    ).toThrow('NARRATIVE_COMPARISON');
    expect(() =>
      checkText(
        `{{change:${fact.id}|p1b4:q1|profit}}`,
        sourceIds,
        restored.values,
        restored.excerpts,
        summary
      )
    ).not.toThrow();
  });

  it('除外した管理欄の数値を表示値に混ぜず、有効な事実を表示・保存復元する', () => {
    const administrative = layoutPage(
      [
        { id: 'p2s1', text: 'コード番号', x: 0, y: 20, width: 60, height: 10 },
        { id: 'p2s2', text: '1234', x: 100, y: 20, width: 40, height: 10 },
      ],
      2
    );
    const pages = [page, administrative];
    const display = buildPresentation(facts, pages);
    expect(display.excerpts.some((e) => e.text.includes('コード番号'))).toBe(false);
    expect(display.values.some((v) => v.raw === '1234')).toBe(false);
    expect(display.values.every((v) => v.sourceIds.length > 0)).toBe(true);
    const rendered = renderFacts(facts, display);
    expect(rendered).toContain('100百万円');
    const restored = revalidatePresentation(JSON.parse(JSON.stringify(display)), facts, pages);
    expect(renderFacts(facts, restored)).toBe(rendered);
  });

  it('損失という説明でも正の量へ変えず、原文の符号と複合単位を保持する', () => {
    expect(() =>
      bindLiteralQuantities('15百万円の赤字', sources, draft.values, draft.excerpts)
    ).toThrow('QUANTITY');
    expect(bindLiteralQuantities('△15百万円', sources, draft.values, draft.excerpts)).toContain(
      '{{value:'
    );
    expect(
      literalValue({ id: 'q', raw: '1億27百万円', decimal: null, unit: '円', sourceIds: sources })
    ).toBe('1億27百万円');
  });

  it.each([
    ['-10', '↑黒字転換'],
    ['0', '↑増益（率算出不可：比較値ゼロ）'],
  ])('比較値%sからの損益変化を表示する', (previous, expected) => {
    const quantity = (decimal: string) => ({
      id: decimal,
      raw: decimal + '百万円',
      decimal,
      unit: '百万円',
      sourceIds: sources,
    });
    expect(quantityChange(quantity('10'), quantity(previous), 'profit')).toBe(expected);
  });

  it('表の単位注記を数量根拠へ加えるが、数量の所有行を省略できない', () => {
    const display = buildPresentation({ ...facts, facts: [] }, [financialTable('120', '100')]);
    const value = display.values.find((v) => v.raw === '120')!;
    const owner = display.excerpts.find((e) => e.spanIds.includes(value.id))!;
    expect(value.unit).toBe('百万円');
    expect(value.sourceIds.length).toBeGreaterThan(1);
    const token = `{{value:${value.id}}}`;
    const closure = quantitySourceClosure(token, [owner.id], display.values, display.excerpts, {
      ...facts,
      facts: [],
    });
    expect(closure).toEqual(expect.arrayContaining(value.sourceIds));
    checkText(token, closure, display.values, display.excerpts, facts, true);
    expect(() =>
      quantitySourceClosure(
        token,
        value.sourceIds.filter((id) => id !== owner.id),
        display.values,
        display.excerpts,
        facts
      )
    ).toThrow('原文');
  });

  it('分割された単位を全原文位置で保持し、途中の単位を表示・保存しない', () => {
    const summary = { ...facts, facts: [], unverified: ['未確認'] };
    const split = (first: string, suffix: string, other: string, gap = 3) =>
      layoutPage([
        { id: 'p1s1', text: '数量', x: 0, y: 20, width: 30, height: 10 },
        { id: 'p1s2', text: first, x: 100, y: 20, width: 30, height: 10 },
        { id: 'p1s3', text: suffix, x: 130 + gap, y: 20, width: 20, height: 10 },
        { id: 'p1s4', text: other, x: 200, y: 20, width: 60, height: 10 },
      ]);
    for (const [first, suffix, unit] of [
      ['120百', '万円', '百万円'],
      ['120k', 'Wh', 'kWh'],
      ['120kW', 'h', 'kWh'],
      ['120m', '2', 'm2'],
    ]) {
      const display = buildPresentation(summary, [split(first, suffix, `150${unit}`)]);
      expect(display.values).toHaveLength(2);
      expect(display.values[0]).toMatchObject({
        id: 'p1s2',
        raw: first + suffix,
        decimal: '120',
        unit,
      });
      expect(literalValue(display.values[0])).toBe(`120${unit}`);
    }
    for (const source of [
      split('120百', '万円※', '150百万円'),
      split('120m2', 'h', '150m2'),
      split('120百', '万円', '150百万円', 7),
    ]) {
      const display = buildPresentation(summary, [source]);
      expect(display.values.some((v) => v.id === 'p1s2')).toBe(false);
    }
    const source = split('120百', '万円', '150百万円');
    const display = buildPresentation(summary, [source]);
    const organization: SummaryPresentation['organization'] = {
      ...emptyOrganization(),
      status: 'ready',
      observations: display.values.map((v, i) => ({
        id: `observation-${i}`,
        topic: 'other',
        entity: null,
        scope: null,
        basis: null,
        metric: '数量',
        measure: 'other',
        period: null,
        state: 'actual',
        conditions: [],
        sourceIds: display.excerpts.map((e) => e.id),
        valueId: v.id,
        comparison: null,
      })),
    };
    organization.review = {
      contentHash: organizationHash(organization, summary, display.values, display.excerpts),
      claims: Object.fromEntries(organization.observations.map((o) => [o.id, null])),
      sources: {},
    };
    display.organization = organization;
    const restored = revalidatePresentation(JSON.parse(JSON.stringify(display)), summary, [source]);
    expect(restored.organization.status).toBe('ready');
    expect(restored.values[0].raw).toBe('120百万円');
    expect(unresolvedTableSources(organization, summary, display.values, display.excerpts)).toEqual(
      []
    );
  });

  it('CF表の負の収支を説明文の正の支出額で置き換えない', () => {
    const signedPage = layoutPage([
      { id: 'p1s1', text: '（単位：千円）', x: 0, y: 100, width: 90, height: 10 },
      { id: 'p1s2', text: '財務活動によるキャッシュ・フロー', x: 0, y: 124, width: 90, height: 10 },
      { id: 'p1s3', text: '△265,834', x: 250, y: 124, width: 60, height: 10 },
      { id: 'p1s5', text: '△164,705', x: 150, y: 124, width: 60, height: 10 },
      { id: 'p1s4', text: '使用した資金は265,834千円です。', x: 0, y: 160, width: 240, height: 10 },
    ]);
    const signed = buildPresentation({ ...facts, facts: [] }, [signedPage]);
    const magnitude = signed.values.find((v) => v.decimal === '265834')!;
    const cash = {
      id: 'observation-0',
      topic: 'cash' as const,
      state: 'actual' as const,
      entity: null,
      scope: null,
      basis: null,
      metric: '財務活動によるキャッシュ・フロー',
      measure: 'flow' as const,
      period: null,
      valueId: magnitude.id,
      comparison: null,
      conditions: [],
      sourceIds: signed.excerpts.map((e) => e.id),
    };
    expect(() =>
      checkObservation(cash, signed.values, signed.excerpts, { ...facts, facts: [] }, true)
    ).toThrow('符号付き収支');
    cash.valueId = signed.values.find((v) => v.decimal === '-265834')!.id;
    expect(() =>
      checkObservation(cash, signed.values, signed.excerpts, { ...facts, facts: [] }, true)
    ).not.toThrow();
  });
});

describe('source quantity boundaries', () => {
  const empty = { ...facts, facts: [] };
  it('keeps spaced compound amounts whole with exact text, sign and source ownership', () => {
    const raw = '△1,184億 4百万円';
    const source = textPage(`売上収益 ${raw} (前年同期比 △0.7％)`);
    const presentation = buildPresentation(empty, [source]);
    const quantity = presentation.values.find((value) => value.raw === raw)!;
    expect(quantity).toMatchObject({ raw, decimal: null, unit: '円' });
    expect(presentation.values.some((value) => ['4', '1184'].includes(value.decimal!))).toBe(false);
    expect(literalValue(quantity)).toBe(raw.replace(/\s/g, ''));
    expect(
      revalidatePresentation(JSON.parse(JSON.stringify(presentation)), empty, [source]).values
    ).toContainEqual(quantity);
    const separated = buildPresentation(empty, [textPage('売上収益 1,184億 ││ 4百万円')]);
    expect(
      separated.values.some((value) => value.raw.includes('億') && value.raw.includes('4百万'))
    ).toBe(false);
  });

  function revisionTable(caption = '増減率（％）') {
    const rows = [
      ['項目', '売上収益', '営業利益', 'EPS'],
      ['', '百万円', '百万円', '円'],
      ['前回予想（Ａ）', '100', '20', '10.00'],
      ['今回修正予想（Ｂ）', '110', '19', '11.00'],
      ['増減額', '10', '△1', '1.00'],
      [caption, '10.0', '△5.0', '10.0'],
    ];
    return layoutPage([
      { id: 'title', text: '2027年2月期 連結業績予想', x: 0, y: -24, width: 200, height: 10 },
      ...rows.flatMap((row, y) =>
        row.flatMap((text, x) =>
          text
            ? [
                {
                  id: `p1s${y * 4 + x + 1}`,
                  text,
                  x: x * 100,
                  y: y * 24,
                  width: x === 0 ? 80 : 60,
                  height: 10,
                },
              ]
            : []
        )
      ),
    ]);
  }
  it('row-declared units override monetary and EPS columns but not amounts in other rows', () => {
    const source = revisionTable();
    const presentation = buildPresentation(empty, [source]);
    const rateIds = source.spans
      .filter((span) => span.y === 120 && span.x > 0)
      .map((span) => span.id);
    expect(rateIds).toHaveLength(3);
    const rates = presentation.values.filter((value) => rateIds.includes(value.id));
    expect(rates.map((value) => value.unit)).toEqual(['%', '%', '%']);
    const amountIds = source.spans
      .filter((span) => span.y === 96 && span.x > 0)
      .map((span) => span.id);
    expect(
      presentation.values.filter((value) => amountIds.includes(value.id)).map((value) => value.unit)
    ).toEqual(['百万円', '百万円', '円']);
    const owner = presentation.excerpts.find((excerpt) => excerpt.text.includes('増減率'))!;
    expect(rates.every((value) => value.sourceIds.includes(owner.id))).toBe(true);
    expect(
      revalidatePresentation(JSON.parse(JSON.stringify(presentation)), empty, [source]).values
    ).toEqual(presentation.values);
  });
  it('does not infer row units from a metric name or borrow a caption from another table', () => {
    const source = revisionTable('増減率');
    const quantity = source.quantities.find((q) => q.y === 120)!;
    expect(explicitTableRowUnit(source, quantity.id)).toBeNull();
    const captioned = revisionTable();
    const rate = captioned.quantities.find((q) => q.y === 120)!;
    captioned.tableRegions.forEach((table) => {
      table.spanIds = table.spanIds.filter(
        (id) => !captioned.spans.some((span) => span.id === id && span.text.includes('増減率'))
      );
    });
    expect(explicitTableRowUnit(captioned, rate.id)).toBeNull();
  });
});
