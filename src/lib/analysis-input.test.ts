import { describe, expect, it, vi } from 'vitest';
import { textPage, numberCandidate } from './fixtures/v4-test-source';
import { parseFactSummary } from './fact-summary';
import { buildPresentation } from './summary-presentation';
import { generateSummaryOrganization } from './summary-organization';
import { generateText } from './llm-client';
import { buildAnalysisInput } from './analysis-input';
import { parseAnalysis, parseAnalysisResponse } from './additional-analysis';
import { buildAnalysisStageHtml } from '../content/utils/summaryHtmlBuilder';
import type { DisclosureObservation } from './disclosure-observation';

vi.mock('./llm-client', () => ({ generateText: vi.fn() }));
const page = textPage(
  '会社名 株式会社テスト | 会計基準 日本基準 | 範囲 連結\n2026年3月期 連結経営成績\n営業利益は100百万円です。\n固定資産売却益1,174百万円を計上。物件売却は上期に集中し、下期利益は相対的に低い。\n固定資産売却益の精密値は1,174,729千円です。',
  4
);
const facts = parseFactSummary(
  JSON.stringify({
    version: 6,
    documentType: 'other',
    facts: [numberCandidate(page)],
    unverified: [],
  }),
  'other',
  [page]
);
const config = { provider: 'openai', model: 'fixture', apiKey: 'fixture' };
async function fixture(correct: boolean) {
  const display = buildPresentation(facts, [page]);
  const source = display.excerpts.find((e) => e.text.includes('物件売却は'))!;
  const rounded = display.values.find((v) => v.decimal === '1174')!;
  const precise = display.values.find((v) => v.decimal === '1174729')!;
  const context = {
    id: 'performance',
    topic: 'performance',
    entity: null,
    scope: '連結',
    basis: '日本基準',
    period: '2026年3月期',
    state: 'actual',
    conditions: [],
    sourceIds: [source.id],
  };
  const claim = (text: string) => ({ contextId: context.id, text, sourceIds: [source.id] });
  const draft = {
    version: 6,
    contexts: [context],
    observations: [],
    claims: correct
      ? [
          claim(`固定資産売却益{{value:${rounded.id}}}を計上。`),
          claim('物件売却は上期に集中し、下期利益は相対的に低い。'),
        ]
      : [
          // The quantity exists, but its owning source is deliberately absent. Do not
          // detach even the later, valid sentence from this unreviewed compound claim.
          claim(
            `固定資産売却益{{value:${precise.id}}}を計上。物件売却は上期に集中し、下期利益は相対的に低い。`
          ),
          claim('固定資産の売却があった。'),
        ],
  };
  vi.mocked(generateText)
    .mockReset()
    .mockResolvedValueOnce(JSON.stringify(draft))
    .mockImplementationOnce(async (_config, messages) => {
      const request = messages[1].content;
      const candidates = JSON.parse(request.split('\n指標・説明: ')[1].split('\n対象段落: ')[0]);
      const sources = JSON.parse(request.split('\n対象段落: ')[1]);
      return JSON.stringify({
        version: 2,
        claims: candidates.claims.map((c: { id: string }) => ({ id: c.id, reason: null })),
        sources: sources.map((id: string) => ({ id, reason: null })),
      });
    });
  display.organization = await generateSummaryOrganization(
    config,
    facts,
    display.values,
    display.excerpts,
    [page]
  );
  return { display, source };
}

describe('追加分析の不採用説明と入力範囲', () => {
  it('親事実を別途引用しない補足指標でも数量・限定条件・原文ページを保存と表示まで保持する', () => {
    // This boundary receives already-verified facts. Source verification owns the
    // validity of these attributes; this test owns their survival through selection.
    const summary = structuredClone(facts);
    const parent = summary.facts[0];
    parent.label = '年間配当金合計';
    parent.value = 37;
    parent.valueKind = 'forecast';
    parent.unit = '円';
    parent.quantity = { raw: '37.00円', decimal: '37.00', sourceIds: ['dividend-value'] };
    parent.semantics.metricKind = 'perShare';
    parent.semantics.state = 'forecast';
    parent.semantics.qualifiers = ['記念配当を含む'];
    parent.semantics.conditions = ['株主総会の承認を条件とする'];
    parent.provenance = {
      ...parent.provenance!,
      denominator: { value: 1, unit: '株', proof: 'explicit', sourceIds: ['denominator'] },
      adjustments: [
        {
          kind: 'stockSplit',
          noteId: 'split-note',
          text: '株式分割調整済み',
          basis: 'splitAdjusted',
        },
      ],
    };
    const display = buildPresentation(summary, [page]);
    display.excerpts.push({
      ...display.excerpts[0],
      id: 'split-note',
      blockId: 'split-note',
      page: 7,
    });
    display.values.push({
      id: 'previous-dividend',
      raw: '35.00円',
      decimal: '35.00',
      unit: '円',
      sourceIds: ['previous-source'],
    });
    const observation: DisclosureObservation = {
      id: 'observation-0',
      topic: 'dividend',
      entity: null,
      scope: null,
      basis: null,
      period: parent.period,
      state: 'forecast',
      conditions: [],
      sourceIds: [display.excerpts[0].id],
      metric: parent.label,
      measure: 'other',
      valueId: parent.id,
      comparison: {
        axis: 'yearOnYear',
        period: '2025年3月期',
        state: 'actual',
        valueId: 'previous-dividend',
        rateId: null,
      },
    };
    display.organization.observations = [observation];
    display.organization.review = {
      contentHash: 'review',
      claims: { 'observation-0': null },
      sources: {},
    };
    const input = buildAnalysisInput(summary, display);
    const evidence = input.evidence.find((e) => e.id === 'observation:observation-0')!;
    const parentEvidence = input.evidence.find((e) => e.id === `fact:${parent.id}`)!;
    expect(evidence.text).toContain('年間配当金合計: 37.00円');
    expect(evidence.text).toContain('2025年3月期 実績: 35.00円');
    expect(evidence.text).not.toContain(`fact:${parent.id}`);
    for (const condition of [
      '株式会社テスト',
      '1株当たり',
      '株式分割調整済み',
      '記念配当を含む',
      '株主総会の承認を条件とする',
    ])
      expect(evidence.context).toContain(condition);
    expect(evidence.sourceIds).toEqual(expect.arrayContaining(parentEvidence.sourceIds));
    expect(evidence.pages).toEqual([4, 7]);
    const result = parseAnalysisResponse(
      JSON.stringify({
        version: 4,
        issues: [
          {
            title: '配当の比較',
            conclusion: '配当水準の変化を確認する。',
            reading: '条件を踏まえて読む。',
            caveat: '継続性は別途確認が必要。',
            nextCheck: '次期の配当方針を確認する。',
            evidenceIds: [evidence.id],
          },
        ],
      }),
      input
    );
    expect(result.evidence).toEqual([evidence]);
    const restored = parseAnalysis(JSON.stringify(result), summary, display);
    const html = buildAnalysisStageHtml({ loading: false, data: restored, error: null });
    for (const text of [
      '37.00円',
      '35.00円',
      '1株当たり',
      '株式分割調整済み',
      '株主総会の承認を条件とする',
      'p.7',
    ])
      expect(html).toContain(text);
    const tampered = structuredClone(result);
    tampered.evidence[0].context = '';
    expect(() => parseAnalysis(JSON.stringify(tampered), summary, display)).toThrow();
  });

  it('同じ段落の別の説明が採用されても未確認・不採用項目の警告を入力・保存・表示へ残す', async () => {
    const { display } = await fixture(false);
    expect(display.organization.issues).toEqual([
      expect.objectContaining({ reason: 'NARRATIVE_REFERENCE:選択数量の原文を明示してください' }),
    ]);
    const input = buildAnalysisInput(facts, display);
    expect(input.coverage).toMatchObject({
      explanations: 1,
      unverifiedItems: 1,
      unverifiedSourcePages: [4],
    });
    expect(input.coverage.limitations.join('')).toContain('一時要因・時期・条件');
    expect(input.evidence.some((e) => e.kind !== 'source' && e.text.includes('下期利益'))).toBe(
      false
    );
    expect(input.evidence.some((e) => e.kind === 'source' && e.text.includes('下期利益'))).toBe(
      true
    );
    expect(JSON.stringify(input.evidence.filter((e) => e.kind !== 'source'))).not.toContain(
      '1174729'
    );
    expect(input.evidence.some((e) => e.id.includes('gap'))).toBe(false);
    const result = parseAnalysisResponse(JSON.stringify({ version: 4, issues: [] }), input);
    const restored = parseAnalysis(JSON.stringify(result), facts, display);
    const html = buildAnalysisStageHtml({ loading: false, data: restored, error: null });
    expect(html).toContain('未確認・不採用項目1件');
    expect(html).toContain('原文ページ 4');
    expect(html).toContain('一時要因・時期・条件');
    const changed = structuredClone(display);
    changed.organization.issues = [];
    expect(buildAnalysisInput(facts, changed).inputHash).not.toBe(input.inputHash);
    expect(() => parseAnalysis(JSON.stringify(result), facts, changed)).toThrow();
  });

  it('個別の原文根拠と独立点検を通った売却益と時期の説明は丸め・単位を変えず保持する', async () => {
    const { display } = await fixture(true);
    const input = buildAnalysisInput(facts, display);
    expect(display.organization.issues).toEqual([]);
    expect(input.coverage).toMatchObject({ explanations: 2, unverifiedItems: 0 });
    expect(input.evidence.map((e) => e.text)).toContain('固定資産売却益1,174百万円を計上。');
    expect(input.evidence.map((e) => e.text)).toContain(
      '物件売却は上期に集中し、下期利益は相対的に低い。'
    );
    expect(
      input.evidence
        .filter((e) => e.kind !== 'source')
        .map((e) => e.text)
        .join('')
    ).not.toContain('1,174,729');
    expect(vi.mocked(generateText).mock.calls[0][1][0].content).toContain(
      '否定・条件・因果・対象の限定を切り離す分割はしない'
    );
  });

  it('候補生成前の要求失敗を不採用候補と誤表示せず未確認項目として残す', async () => {
    const display = buildPresentation(facts, [page]);
    vi.mocked(generateText).mockReset().mockRejectedValueOnce(new Error('fixture timeout'));
    display.organization = await generateSummaryOrganization(
      config,
      facts,
      display.values,
      display.excerpts,
      [page]
    );
    expect(display.organization.status).toBe('unavailable');
    expect(display.organization.claims).toEqual([]);
    expect(display.organization.observations).toEqual([]);
    const input = buildAnalysisInput(facts, display);
    expect(input.coverage).toMatchObject({
      explanations: 0,
      observations: 0,
      unverifiedItems: 1,
      unverifiedSourcePages: [4],
    });
    expect(input.coverage.limitations[0]).toContain('生成・点検に未確認または不採用');
    const result = parseAnalysisResponse(JSON.stringify({ version: 4, issues: [] }), input);
    const html = buildAnalysisStageHtml({ loading: false, data: result, error: null });
    expect(html).toContain('未確認・不採用項目1件');
    expect(html).not.toContain('不採用候補');
  });
});
