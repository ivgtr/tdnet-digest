import { describe, expect, it, vi } from 'vitest';
import { generateText } from './llm-client';
import { textPage, layoutPage, numberCandidate } from './fixtures/v4-test-source';
import { reviewCandidates } from './fact-candidates';
import { candidateResponse } from './fixtures/candidate-test-source';
import {
  buildPresentation,
  revalidatePresentation,
  validatePresentation,
} from './summary-presentation';
import { generateVerifiedFactSummary, generateVerifiedFacts, renderFacts } from './fact-summary';
import {
  organizationClaims,
  organizationHash,
  explanationSources,
  supportedExplanations,
  unresolvedTableSources,
  emptyOrganization,
  ORGANIZATION_LIMITS,
} from './summary-organization';
import { validateSavedFacts } from './fact-cache';
import { bindLiteralQuantities, quantitySourceClosure, checkText } from './summary-narrative';
import { buildSummaryHtml } from '../content/utils/summaryHtmlBuilder';
import type { SummaryAttempt } from './summary-trace';
import { literalValue, quantityChange } from './summary-narrative-renderer';
import { checkObservation } from './disclosure-observation';

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
  const observation = (
    topic: 'business' | 'orders' | 'cash',
    entity: string | null,
    metric: string,
    measure: 'revenue' | 'profit' | 'stock' | 'flow',
    current: string,
    previous: string,
    source: string,
    axis: 'yearOnYear' | 'periodEnd' = 'yearOnYear'
  ) => ({
    topic,
    entity,
    scope: null,
    basis: null,
    metric,
    measure,
    period: '本中間期',
    state: 'actual' as const,
    valueId: q(current, source),
    comparison: {
      axis,
      period: axis === 'periodEnd' ? '前期末' : '前年上半期',
      valueId: q(previous, source),
      rateId: null,
    },
    conditions: [],
    sourceIds: sources,
  });
  const readings = {
    observations: [
      observation('business', '製品事業', '顧客向け販売額', 'revenue', '120', '100', '製品事業'),
      observation('business', '製品事業', '部門損益', 'profit', '20', '10', '製品事業'),
      observation('business', 'サービス事業', '部門損益', 'profit', '-15', '-10', 'サービス事業'),
      observation('orders', null, '新規契約の受注額', 'stock', '90', '100', '当期受注高'),
      observation(
        'orders',
        null,
        '未消化の案件残高',
        'stock',
        '150',
        '100',
        '当期末受注残高',
        'periodEnd'
      ),
      observation('cash', null, '本業の資金収支', 'flow', '-20', '-30', '当期営業CF'),
    ],
    claims: [
      {
        topic: 'business',
        entity: null,
        text: '価格転嫁が製品事業の増益に寄与。サービス事業は先行投資で赤字拡大。',
        sourceIds: sources,
      },
      {
        topic: 'orders',
        entity: null,
        text: '受注残増加により来期の増収が確定した。',
        sourceIds: sources,
      },
    ],
  };
  const contexts: Array<{
    id: string;
    topic: string;
    entity: string | null;
    scope: string | null;
    basis: string | null;
    period: string | null;
    state: string;
    conditions: string[];
    sourceIds: string[];
  }> = [];
  const contextId = (
    topic: string,
    entity: string | null,
    period: string | null,
    state: string
  ) => {
    const prior = contexts.find(
      (c) => c.topic === topic && c.entity === entity && c.period === period && c.state === state
    );
    if (prior) return prior.id;
    const id = `context-${contexts.length}`;
    contexts.push({
      id,
      topic,
      entity,
      scope: null,
      basis: null,
      period,
      state,
      conditions: [],
      sourceIds: sources,
    });
    return id;
  };
  const observations = readings.observations
    .map((v) => ({
      contextId: contextId(v.topic, v.entity, v.period, v.state),
      metric: v.metric,
      measure: v.measure,
      valueId: v.valueId,
      comparison: {
        ...v.comparison,
        contextId: contextId(v.topic, v.entity, v.comparison.period, 'actual'),
      },
      sourceIds: v.sourceIds,
    }))
    .map(({ comparison, ...v }) => ({
      ...v,
      comparison: {
        axis: comparison.axis,
        contextId: comparison.contextId,
        valueId: comparison.valueId,
        rateId: comparison.rateId,
      },
    }));
  const claims = readings.claims.map((v) => ({
    contextId: contextId(v.topic, v.entity, null, 'unspecified'),
    text: v.text,
    sourceIds: v.sourceIds,
  }));
  return { version: 6, contexts, observations, claims };
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
function visible(result: Awaited<ReturnType<typeof generate>>) {
  return buildSummaryHtml(renderFacts(result.facts, result.presentation), null, {
    companyName: 'テスト',
    title: '開示',
  }).replace(/<details\b[\s\S]*?<\/details>/g, '');
}

describe('構造化を主とする表示と未整理部分の保持', () => {
  it('任意の補足生成に失敗しても確定済みの出来事を通常表示・保存復元する', async () => {
    const statement = '業務提携契約を締結しました。';
    const source = textPage(statement);
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
        blockId: source.blocks[0].id,
        assertionId: `${source.blocks[0].id}:a1`,
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
        state: 'contracted' as const,
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
    const reading = visible({ ...result, attempts: [] });
    expect(reading).toContain('確認済み事項（原文）');
    expect(reading).toContain(statement);
    expect(reading).toContain('要約未作成');
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
  it('同じ行の同額セルを別々に追跡し、確定事実の別名だけを同じセルとして扱う', () => {
    const source = layoutPage(
      [
        ['（単位：百万円）', 0, 100, 90],
        ['営業利益', 0, 124, 50],
        ['100百万円', 100, 124, 60],
        ['100百万円', 200, 124, 60],
      ].map(([text, x, y, width], i) => ({
        id: `p1s${i + 1}`,
        text: String(text),
        x: Number(x),
        y: Number(y),
        width: Number(width),
        height: 10,
      }))
    );
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
    const organization = emptyOrganization();
    expect(unresolvedTableSources(organization, summary, values, display.excerpts)).toEqual([row]);
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
  });
  it('事業別・受注・負のCFを表示し、説明を個別採否して同じ段落の未要約条件を残す', async () => {
    const result = await generate();
    expect(result.presentation.version).toBe(6);
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
      '要約未作成',
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
    const input = JSON.parse(calls[1][1][1].content);
    expect(input.layout[0].rows.length).toBeGreaterThan(0);
    expect(input.excerpts).toEqual(draft.excerpts);
    // A source reference and one number do not prove every assertion in its paragraph.
    expect(
      result.presentation.organization.review!.sources[
        explanationSources(draft.excerpts).find((e) => e.text.includes('受注残高'))!.id
      ]
    ).toContain('未要約');
    const direct = wire();
    direct.observations.reverse();
    direct.observations[5].metric = '販売による収入';
    direct.contexts.find((c) => c.id === direct.observations[5].contextId)!.period =
      '2026年度 上半期';
    const directResult = await generate(direct);
    expect(visible(directResult)).toContain('↑増収 約+20.0%');
    expect(visible(directResult)).toContain('販売による収入');
    expect(
      renderFacts(directResult.facts, directResult.presentation).match(/### 事業別業績/g)
    ).toHaveLength(1);
    expect(visible(directResult)).toContain('前期末');
    expect(visible(directResult)).toContain('対象期');
    expect(visible(directResult)).toContain('2026年度 上半期');
    expect(wire().contexts.length).toBeLessThan(wire().observations.length * 2);
    const reordered = review();
    reordered.claims.reverse();
    reordered.sources.reverse();
    expect(visible(await generate(wire(), reordered))).toContain('↑増収 約+20.0%');
  });
  it('未知形式・不正数量・欠落した点検を採用せず、保存復元で正しい表と未整理の状態を維持する', async () => {
    const result = await generate();
    const copy = structuredClone(result.presentation);
    copy.organization.observations[0].valueId = 'unknown-quantity';
    expect(() => validatePresentation(copy, result.facts)).toThrow('REFERENCE');
    expect(() =>
      validatePresentation({ ...result.presentation, version: 3 }, result.facts)
    ).toThrow('不正');
    const wrongAxis = structuredClone(result.presentation);
    wrongAxis.organization.observations[0].period = '2027年２月期中間期';
    wrongAxis.organization.observations[0].comparison!.period = '2026年2月期第２四半期';
    wrongAxis.organization.observations[0].comparison!.axis = 'periodEnd';
    expect(() => validatePresentation(wrongAxis, result.facts)).toThrow('OBSERVATION_PERIOD');
    const missing = structuredClone(result.presentation);
    delete missing.organization.review!.claims['observation-0'];
    expect(() => validatePresentation(missing, result.facts)).toThrow('点検範囲');
    const duplicateReview = review();
    duplicateReview.claims[1] = { ...duplicateReview.claims[0] };
    const incompleteReview = review();
    incompleteReview.sources.pop();
    const verboseReview = review();
    verboseReview.sources[0].reason = '長'.repeat(81);
    for (const verdict of [
      duplicateReview,
      incompleteReview,
      verboseReview,
      { ...review(), version: 1 },
    ]) {
      const rejected = await generate(wire(), verdict);
      expect(rejected.presentation.organization.status).toBe('unavailable');
      expect(rejected.presentation.organization.observations).toEqual([]);
      expect(visible(rejected)).toContain('営業利益');
    }
    const unsupported = structuredClone(result.presentation);
    unsupported.organization.review!.claims['observation-0'] = '期間対応が未確認';
    expect(visible({ ...result, presentation: unsupported })).not.toContain('↑増収 約+20.0%');
    // Whole signed values stay native. A loss label does not authorize changing the sign.
    expect(() =>
      bindLiteralQuantities('15百万円の赤字', sources, draft.values, draft.excerpts)
    ).toThrow('QUANTITY');
    expect(bindLiteralQuantities('△15百万円', sources, draft.values, draft.excerpts)).toContain(
      '{{value:'
    );
    expect(
      literalValue({ id: 'q', raw: '1億27百万円', decimal: null, unit: '円', sourceIds: sources })
    ).toBe('1億27百万円');
    const quantity = (decimal: string) => ({
      id: decimal,
      raw: decimal + '百万円',
      decimal,
      unit: '百万円',
      sourceIds: sources,
    });
    expect(quantityChange(quantity('10'), quantity('-10'), 'profit')).toBe('↑黒字転換');
    expect(quantityChange(quantity('10'), quantity('0'), 'profit')).toContain('比較値ゼロ');
    const missingContext = wire();
    missingContext.observations[0].contextId = 'absent-context';
    const duplicateContext = wire();
    duplicateContext.contexts.push({ ...duplicateContext.contexts[0] });
    const oversized = wire();
    oversized.observations = Array.from({ length: ORGANIZATION_LIMITS.observations + 1 }, () => ({
      ...oversized.observations[0],
    }));
    for (const raw of [
      JSON.stringify(missingContext),
      JSON.stringify(duplicateContext),
      JSON.stringify(oversized),
      JSON.stringify({ version: 3, tables: [], claims: [] }),
      '{"version":6,"contexts":[],"observations":[],"claims":[],"claims":[]}',
    ]) {
      vi.mocked(generateText).mockReset().mockResolvedValueOnce(first).mockResolvedValueOnce(raw);
      const partial = await generateVerifiedFactSummary(config, 'other', 'source', [page]);
      expect(partial.presentation.organization.status).toBe('unavailable');
      expect(renderFacts(partial.facts, partial.presentation)).toContain('営業利益');
      expect(partial.presentation.organization.issues.length).toBeGreaterThan(0);
      expect(vi.mocked(generateText)).toHaveBeenCalledTimes(2);
    }
    const captioned = layoutPage(
      [
        ['（単位：百万円）', 0, 100, 90],
        ['営業利益', 0, 124, 50],
        ['120', 100, 124, 30],
        ['100', 200, 124, 30],
      ].map(([text, x, y, width], i) => ({
        id: `p1s${i + 1}`,
        text: String(text),
        x: Number(x),
        y: Number(y),
        width: Number(width),
        height: 10,
      }))
    );

    const display = buildPresentation({ ...facts, facts: [] }, [captioned]);
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
      ...result.presentation.organization.observations[0],
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
    expect(organizationClaims(result.presentation.organization).length).toBe(8);
    expect(
      organizationHash(result.presentation.organization, result.facts, draft.values, draft.excerpts)
    ).toBe(result.presentation.organization.review!.contentHash);
  });
  it('説明の期限・点検失敗と重要項目の抽出不足が全体の表示を止めず、未確認を確定値で補わない', async () => {
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
    expect(renderFacts(result.facts, result.presentation)).toContain('要約未作成');
    expect(attempts[attempts.length - 1]?.error).toBe('説明点検の期限');
    const source = textPage(
      '会社名 株式会社テスト | 会計基準 日本基準 | 範囲 連結\n2026年3月期 連結経営成績\n営業利益は100百万円です。'
    );
    const candidate = candidateResponse([numberCandidate(source)], [source], 'earnings');
    vi.mocked(generateText)
      .mockReset()
      .mockResolvedValueOnce(candidate)
      .mockResolvedValueOnce(candidateResponse([], [source], 'earnings'));
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

    expect(() =>
      validatePresentation({ ...incomplete.presentation, unknown: true }, incomplete.facts)
    ).toThrow('不正');
  });
});
