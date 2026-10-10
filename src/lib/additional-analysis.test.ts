import { afterEach, describe, expect, it, vi } from 'vitest';
import { numberCandidate, textPage } from './fixtures/v4-test-source';
import { parseFactSummary } from './fact-summary';
import { buildPresentation } from './fixtures/summary-narrative-source';
import { buildAnalysisInput } from './analysis-input';
import { buildSourceLedger } from './source-ledger';
import {
  analyzeFacts,
  ANALYSIS_LIMITS,
  ANALYSIS_RESOURCE_LIMITS,
  AnalysisValidationError,
  analysisModelInput,
  analysisResponseSchema,
  analysisPrompt,
  parseAnalysis,
  parseAnalysisResponse,
} from './additional-analysis';
import { buildAnalysisStageHtml } from '../content/utils/summaryHtmlBuilder';
import { generateText } from './llm-client';
import type { AnalysisGenerationDiagnostic } from './analysis-trace';

vi.mock('./llm-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./llm-client')>()),
  generateText: vi.fn(),
}));
const page = textPage(
  '会社名 株式会社テスト | 会計基準 日本基準 | 範囲 連結\n2026年3月期 連結経営成績\n営業利益は100百万円です。\n自社保有資産の売却が利益を押し上げました。',
  5
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
const presentation = buildPresentation(facts, [page]);
presentation.organization.claims[0].text = '自社保有資産の売却が利益を押し上げた。';
const input = () => buildAnalysisInput(facts, presentation);
const issue = () => ({
  title: '利益の継続性',
  conclusion: '資産売却を含む増益は本業の継続成長と分けて見る必要があります',
  evidenceIds: [`fact:${facts.facts[0].id}`, 'explanation:explanation-0'],
  reading: '同様の売却が続かない場合は、利益の押し上げが繰り返されない可能性があります',
  caveat: '今回の確認済み入力では売却益の内訳と再発予定は未確認です',
  nextCheck: '次の開示で売却益を除いた本業利益と売却の再発予定を確認する',
});
const response = (issues: unknown[] = [issue()]) => JSON.stringify({ version: 4, issues });
const config = { provider: 'openai', apiKey: 'fixture', model: 'fixture' };
afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('追加分析の根拠と論点の契約', () => {
  // New boundary: independently grounded overview survives issue quarantine;
  // invalid/duplicated overviews cannot replace it with an arbitrary first issue.
  it('全体要約を独立した根拠で照合し、保存復元と改変拒否を保つ', () => {
    const overview = {
      text: '会社説明を踏まえると、計上利益の強さと持続性を分けて評価する局面です。',
      evidenceIds: ['explanation:explanation-0'],
    };
    const result = parseAnalysisResponse(
      JSON.stringify({
        version: 4,
        overallSummary: overview,
        issues: [{ ...issue(), evidenceIds: ['missing'] }],
      }),
      input()
    );
    expect(result.overallSummary).toEqual(overview);
    expect(result.issues).toEqual([]);
    expect(result.evidence.map((e) => e.id)).toEqual(overview.evidenceIds);
    expect(parseAnalysis(JSON.stringify(result), facts, presentation)).toEqual(result);
    for (const patch of [
      { overallSummary: { ...overview, text: '改変された文章' } },
      { overallSummaryCandidate: { ...overview, evidenceIds: ['missing'] } },
      { evidence: [] },
    ])
      expect(() =>
        parseAnalysis(JSON.stringify({ ...result, ...patch }), facts, presentation)
      ).toThrow();
  });

  it.each(['missing', 'copy', 'null', 'legacy'])(
    '全体要約の欠損・不正だけで個別論点を失わない: %s',
    (kind) => {
      const raw = {
        version: 4,
        issues: [issue()],
        ...(kind === 'legacy'
          ? {}
          : {
              overallSummary:
                kind === 'null'
                  ? null
                  : {
                      text: kind === 'copy' ? issue().conclusion : '全体像の文章',
                      evidenceIds: kind === 'missing' ? ['missing'] : issue().evidenceIds,
                    },
            }),
      };
      const result = parseAnalysisResponse(JSON.stringify(raw), input());
      expect(result.issues).toEqual([issue()]);
      expect(result.overallSummary ?? null).toBeNull();
      if (kind === 'missing' || kind === 'copy')
        expect(result.notices).toContainEqual(
          expect.objectContaining({
            path: expect.stringContaining('$.overallSummary'),
            severity: 'quarantined',
          })
        );
      expect(parseAnalysis(JSON.stringify(result), facts, presentation)).toEqual(result);
    }
  );

  it('確認済み事実だけでなく点検済み説明・指標と原文対応を渡し、未点検を除く', () => {
    const display = structuredClone(presentation);
    const value = display.values.find((v) => v.id === facts.facts[0].id)!;
    display.organization.observations = [
      {
        id: 'observation',
        topic: 'business',
        entity: '株式会社テスト',
        scope: '連結',
        basis: '日本基準',
        period: '2026年3月期',
        state: 'actual',
        conditions: [],
        sourceIds: value.sourceIds,
        metric: '営業利益',
        measure: 'profit',
        valueId: value.id,
        comparison: null,
      },
    ];
    display.organization.review!.claims.observation = null;
    display.organization.claims.push({
      ...display.organization.claims[0],
      id: 'rejected',
      text: '根拠なしの将来成長',
    });
    display.organization.review!.claims.rejected = '原文で確認できない';
    const built = buildAnalysisInput(facts, display);
    expect(built.coverage).toMatchObject({
      facts: 1,
      explanations: 1,
      observations: 1,
      pages: [5],
    });
    expect(built.evidence.find((e) => e.id === 'observation:observation')).toMatchObject({
      text: '営業利益: 100百万円（同じ原数量への補足・区分: profit）',
      sourceIds: expect.arrayContaining([...value.sourceIds, facts.facts[0].id]),
      pages: [5],
    });
    expect(built.evidence.find((e) => e.id === 'observation:observation')!.sourceIds).toEqual(
      expect.arrayContaining(built.evidence.find((e) => e.kind === 'fact')!.sourceIds)
    );
    expect(JSON.stringify(built)).not.toContain('根拠なしの将来成長');
    expect(analysisPrompt(built)[0].content).toContain('意味の検証になりません');
  });

  it('累計・分割基準・分母・日付役割を入力に残し、未整理をゼロへ縮めない', () => {
    const changed = structuredClone(facts);
    const fact = changed.facts[0];
    fact.period = '2026年3月期第3四半期';
    fact.semantics.periodKind = 'cumulativeQ3';
    fact.provenance!.denominator = {
      value: 1,
      unit: '株',
      proof: 'metricConvention',
      sourceIds: [fact.evidence.kind === 'prose' ? fact.evidence.blockId : fact.evidence.valueId],
    };
    fact.provenance!.adjustments = [
      { kind: 'stockSplit', noteId: page.blocks[2].id, text: '分割後換算', basis: 'splitAdjusted' },
    ];
    fact.dateRoles = [{ date: '2026年9月30日', state: 'reference', sourceId: page.blocks[2].id }];
    const partial = structuredClone(presentation);
    partial.organization.status = 'partial';
    partial.organization.issues = [];
    const rejected = partial.excerpts.find((e) => e.kind === 'paragraph' && e.role !== 'document')!;
    partial.organization.review!.sources[rejected.id] = '段落の説明は未確認';
    const built = buildAnalysisInput(changed, partial);
    expect(built.evidence[0].context).toContain('第3四半期累計');
    expect(built.evidence[0].context).toContain('1株当たり');
    expect(built.evidence[0].context).toContain('分割後換算');
    expect(built.evidence[0].context).toContain('reference: 2026年9月30日');
    expect(built.coverage.unresolvedSources).toBeGreaterThan(0);
  });

  it('論点と独立したコード構成の根拠を保存し、数値・原文・入力の差替えを拒否する', () => {
    const result = parseAnalysisResponse(response(), input());
    expect(parseAnalysis(JSON.stringify(result), facts, presentation)).toEqual(result);
    for (const mutate of [
      (x: typeof result) => {
        x.evidence[0].text = '営業利益: 999百万円';
      },
      (x: typeof result) => {
        x.evidence[0].pages = [1];
      },
      (x: typeof result) => {
        x.inputHash = 'old-input';
      },
    ]) {
      const saved = structuredClone(result);
      mutate(saved);
      expect(() => parseAnalysis(JSON.stringify(saved), facts, presentation)).toThrow();
    }
    const different = structuredClone(presentation);
    different.organization.review = null;
    expect(() => parseAnalysis(JSON.stringify(result), facts, different)).toThrow();
  });

  it.each([
    '来期は200百万円になる可能性があります',
    '利益が二倍になる可能性があります',
    '第2四半期までに売却が集中し、第3四半期は低調でした',
    '第４四半期・3Q・2026年・①・一株当たり・一件当たり・一桁・二ポイント',
  ])('数字を含む推論を変更せず保持し根拠へ昇格しない: %s', (reading) => {
    const result = parseAnalysisResponse(response([{ ...issue(), reading }]), input());
    expect(result.issues[0].reading).toBe(reading);
    expect(result.notices).toEqual([]);
    expect(result.evidence).toEqual(
      input().evidence.filter((e) => issue().evidenceIds.includes(e.id))
    );
    expect(parseAnalysis(JSON.stringify(result), facts, presentation)).toEqual(result);
  });

  it.each([
    ['same reading', () => ({ ...issue(), reading: issue().conclusion })],
    [
      'literal restatement',
      () => ({ ...issue(), reading: '自社保有資産の売却が利益を押し上げた。' }),
    ],
  ])('%sは警告して本文を保持する', (_name, make) => {
    const result = parseAnalysisResponse(response([make()]), input());
    expect(result.issues).toEqual([make()]);
    expect(result.notices).toContainEqual(
      expect.objectContaining({ code: 'evidence_restatement', severity: 'warning' })
    );
  });

  it('旧形式は再利用せず、重複論点は警告し、空配列と全隔離を区別する', () => {
    for (const version of [2, 3])
      expect(() =>
        parseAnalysisResponse(JSON.stringify({ version, issues: [] }), input())
      ).toThrow();
    const repeated = parseAnalysisResponse(
      response([issue(), { ...issue(), title: '別名' }]),
      input()
    );
    expect(repeated.issues).toHaveLength(2);
    expect(repeated.notices[0].code).toBe('issue_evidence_duplicate');
    const empty = parseAnalysisResponse(response([]), input());
    expect(empty.issues).toEqual([]);
    expect(empty.notices).toEqual([]);
    const rejected = parseAnalysisResponse(
      response([{ ...issue(), evidenceIds: ['invented'] }]),
      input()
    );
    expect(rejected.issues).toEqual([]);
    expect(rejected.evidence).toEqual([]);
    expect(rejected.notices[0].severity).toBe('quarantined');
  });

  it('一論点の同一ページ引用を一つへまとめ、IDは展開式で保持する', () => {
    const result = parseAnalysisResponse(response(), input());
    const html = buildAnalysisStageHtml(
      { loading: false, data: result, error: null },
      facts.facts,
      'https://www.release.tdnet.info/inbs/test.pdf'
    );
    expect(html.match(/href=/g)).toHaveLength(1);
    expect(html).toContain('#page=5');
    expect(html).toContain('<summary>根拠IDを表示</summary>');
    expect(html).toContain('data-analysis-conclusion');
    expect(html).not.toContain('判断不能');
    const escaped = { ...result, issues: [{ ...issue(), title: '<img src=x onerror=alert()>' }] };
    expect(buildAnalysisStageHtml({ loading: false, data: escaped, error: null })).toContain(
      '&lt;img'
    );
  });
});

describe('追加分析の要求予算と診断', () => {
  it('一要求に上限・期限・使用量を残し、入力不足をモデルの無根拠な断定で埋めない', async () => {
    vi.mocked(generateText).mockImplementationOnce(async (options) => {
      expect(options.maxOutputTokens).toBe(8192);
      expect(options.signal).toBeInstanceOf(AbortSignal);
      options.onUsage?.({
        inputTokens: 100,
        outputTokens: 200,
        elapsedMs: 250,
        finishReason: 'stop',
      });
      return response();
    });
    const result = await analyzeFacts(config, facts, presentation);
    expect(result.usage?.outputTokens).toBe(200);
    expect(vi.mocked(generateText)).toHaveBeenCalledTimes(1);
  });
  it('出力上限でも完全なJSONなら表示し、未完の可能性と使用量を残す', async () => {
    vi.mocked(generateText).mockImplementationOnce(async (options) => {
      options.onUsage?.({
        inputTokens: 100,
        outputTokens: 8192,
        elapsedMs: 250,
        finishReason: 'length',
      });
      return response();
    });
    const result = await analyzeFacts(config, facts, presentation);
    expect(result.issues).toHaveLength(1);
    expect(result.notices).toContainEqual(
      expect.objectContaining({ code: 'output_limit', issueIndex: -1 })
    );
    expect(result.usage?.outputTokens).toBe(8192);
    expect(parseAnalysis(JSON.stringify(result), facts, presentation)).toEqual(result);
    expect(vi.mocked(generateText)).toHaveBeenCalledTimes(1);
  });
  it('期限切れを中断し、暗黙の再試行をしない', async () => {
    vi.useFakeTimers();
    vi.mocked(generateText).mockImplementationOnce(
      (options) =>
        new Promise((_resolve, reject) =>
          options.signal!.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          })
        )
    );
    const assertion = expect(analyzeFacts(config, facts, presentation)).rejects.toThrow('制限時間');
    await vi.advanceTimersByTimeAsync(60_000);
    await assertion;
    expect(vi.mocked(generateText)).toHaveBeenCalledTimes(1);
  });
});

describe('生成契約と診断の正負境界', () => {
  it.each([
    ['title', ANALYSIS_LIMITS.title],
    ['reading', ANALYSIS_LIMITS.text],
  ] as const)('%sの文字数をスキーマと同じUnicode文字数で数える', (key, limit) => {
    for (const character of ['続', '𠮷']) {
      const accepted = { ...issue(), [key]: character.repeat(limit) };
      expect(parseAnalysisResponse(response([accepted]), input()).issues).toHaveLength(1);
      const long = parseAnalysisResponse(
        response([{ ...accepted, [key]: character.repeat(limit + 1) }]),
        input()
      );
      expect(long.issues[0][key]).toBe(character.repeat(limit + 1));
      expect(long.notices).toContainEqual(
        expect.objectContaining({
          code: 'text_length',
          path: `$.issues[0].${key}`,
          severity: 'warning',
        })
      );
    }
  });

  it.each([
    ['invalid_json', '$', () => '{broken'],
    ['response_shape', '$', () => JSON.stringify({ version: 4, extra: true })],
    ['response_version', '$.version', () => JSON.stringify({ version: 2, issues: [] })],
    ['issues_type', '$.issues', () => JSON.stringify({ version: 4, issues: {} })],
    [
      'issues_budget',
      '$.issues',
      () => response(Array.from({ length: ANALYSIS_RESOURCE_LIMITS.issues + 1 }, issue)),
    ],
    ['response_budget', '$', () => ' '.repeat(ANALYSIS_RESOURCE_LIMITS.responseBytes + 1)],
    [
      'response_budget',
      '$',
      () =>
        JSON.stringify({
          version: 4,
          issues: [],
          extra: JSON.parse('['.repeat(40) + '0' + ']'.repeat(40)),
        }),
    ],
  ])('表示できない応答は%sで失敗する', (code, path, raw) => {
    expect(() => parseAnalysisResponse(raw(), input())).toThrow(
      expect.objectContaining({ code, path })
    );
  });

  it.each([
    ['issue_shape', '$.issues[1]', null],
    ['text_type', '$.issues[1].reading', { ...issue(), reading: null }],
    ['text_empty', '$.issues[1].reading', { ...issue(), reading: ' ' }],
    [
      'text_budget',
      '$.issues[1].reading',
      { ...issue(), reading: '長'.repeat(ANALYSIS_RESOURCE_LIMITS.text + 1) },
    ],
    ['evidence_type', '$.issues[1].evidenceIds', { ...issue(), evidenceIds: 'not-array' }],
    ['evidence_count', '$.issues[1].evidenceIds', { ...issue(), evidenceIds: [] }],
    ['evidence_id_type', '$.issues[1].evidenceIds[0]', { ...issue(), evidenceIds: [null] }],
    ['evidence_unknown', '$.issues[1].evidenceIds[0]', { ...issue(), evidenceIds: ['p1s58'] }],
    [
      'evidence_budget',
      '$.issues[1].evidenceIds',
      { ...issue(), evidenceIds: Array(ANALYSIS_RESOURCE_LIMITS.references + 1).fill('invented') },
    ],
  ])('%sは元の位置で隔離し正常な隣の論点を残す', (code, path, candidate) => {
    const candidates = [
      issue(),
      candidate,
      { ...issue(), title: '次の問い', reading: '次の売却が実現するかを確認します' },
    ];
    const result = parseAnalysisResponse(
      JSON.stringify({ version: 4, issues: candidates }),
      input()
    );
    expect(result.candidates).toEqual(candidates);
    expect(result.issues.map((x) => x.title)).toEqual([issue().title, '次の問い']);
    expect(result.notices).toContainEqual(
      expect.objectContaining({ code, path, issueIndex: 1, severity: 'quarantined' })
    );
    expect(parseAnalysis(JSON.stringify(result), facts, presentation)).toEqual(result);
  });

  it('構造の軽微な不備を警告し、本文を変更せず、保存された派生結果を再照合する', () => {
    const candidate = {
      ...issue(),
      caveat: undefined,
      nextCheck: '',
      extra: { harmless: true },
      evidenceIds: [issue().evidenceIds[0], issue().evidenceIds[0]],
    };
    const result = parseAnalysisResponse(response([candidate]), input());
    expect(result.issues[0]).toEqual({
      ...issue(),
      caveat: '',
      nextCheck: '',
      evidenceIds: [issue().evidenceIds[0]],
    });
    expect(result.notices.map((n) => n.code)).toEqual(['issue_extra', 'evidence_duplicate']);
    expect(parseAnalysis(JSON.stringify(result), facts, presentation)).toEqual(result);
    for (const mutate of [
      (x: typeof result) => {
        x.notices = [];
      },
      (x: typeof result) => {
        x.issues[0].reading = '改変';
      },
      (x: typeof result) => {
        (x.candidates[0] as { reading: string }).reading = '改変';
      },
      (x: typeof result) => {
        x.coverage.facts++;
      },
    ]) {
      const changed = structuredClone(result);
      mutate(changed);
      expect(() => parseAnalysis(JSON.stringify(changed), facts, presentation)).toThrow();
    }
  });

  it('最上位の追加項目を本文へ混ぜず保存し、注意を再読込でも維持する', () => {
    const extras = {
      caveat: '<img src=x onerror=alert(1)>全論点に関する限定',
      other: { notes: ['入力で確認していない条件'], value: 42 },
      ['__proto__']: { injected: true },
    };
    const result = parseAnalysisResponse(
      JSON.stringify({ version: 4, issues: [issue()], ...extras }),
      input()
    );
    expect(result.rootExtras).toEqual(extras);
    expect(result.issues).toEqual([issue()]);
    expect(result.notices).toEqual([
      expect.objectContaining({ code: 'response_extra', issueIndex: -1, severity: 'warning' }),
    ]);
    const restored = parseAnalysis(JSON.stringify(result), facts, presentation);
    expect(restored).toEqual(result);
    const html = buildAnalysisStageHtml({ loading: false, data: restored, error: null });
    expect(html).toContain('response_extra');
    expect(html).not.toContain(extras.caveat);
    expect(html).not.toContain('onerror');
    const changed = structuredClone(result);
    changed.notices = [];
    expect(() => parseAnalysis(JSON.stringify(changed), facts, presentation)).toThrow();
    for (const rootExtras of [{}, null, { version: 4 }, { issues: [] }]) {
      expect(() =>
        parseAnalysis(JSON.stringify({ ...result, rootExtras }), facts, presentation)
      ).toThrow();
    }
    const prior = parseAnalysisResponse(response(), input());
    expect(prior).not.toHaveProperty('rootExtras');
    expect(parseAnalysis(JSON.stringify(prior), facts, presentation)).toEqual(prior);
  });

  it('深さ上限の最上位追加項目は保存時の包み直しでも復元できる', () => {
    const extra = JSON.parse('['.repeat(31) + '0' + ']'.repeat(31));
    const result = parseAnalysisResponse(
      JSON.stringify({ version: 4, issues: [issue()], extra }),
      input()
    );
    expect(parseAnalysis(JSON.stringify(result), facts, presentation)).toEqual(result);
  });

  it('隔離した論点には本文を表示したという仮の注意を出さない', () => {
    const candidate = {
      ...issue(),
      title: '長'.repeat(ANALYSIS_LIMITS.title + 1),
      evidenceIds: ['invalid'],
    };
    const result = parseAnalysisResponse(response([candidate]), input());
    expect(result.issues).toEqual([]);
    expect(result.candidates).toEqual([candidate]);
    expect(result.notices).toEqual([
      expect.objectContaining({ code: 'evidence_unknown', severity: 'quarantined' }),
    ]);
    const html = buildAnalysisStageHtml({ loading: false, data: result, error: null });
    expect(html).not.toContain('本文は省略せず表示しています');
    expect(html).not.toContain(candidate.conclusion);
    expect(parseAnalysis(JSON.stringify(result), facts, presentation)).toEqual(result);
  });

  it('応答予算の近くまである候補も保存封筒の増分で復元不能にならない', () => {
    const candidate = { ...issue(), extra: Array.from({ length: 9500 }, () => null) };
    const result = parseAnalysisResponse(response([candidate]), input());
    expect(result.issues).toHaveLength(1);
    expect(parseAnalysis(JSON.stringify(result), facts, presentation)).toEqual(result);
  });

  it('既知の入力を未確認とする推論を事実検証済みと扱わず、原文のまま境界を表示する', () => {
    // Synthetic public-source regression: deliberately contradictory model prose.
    // No private run IDs, provider metadata, or raw diagnostic are retained.
    const source = input();
    source.evidence[0].text = '固定資産売却益は1,174,729千円です';
    const candidate = {
      ...issue(),
      reading: '第2四半期までに売却が集中し、第3四半期の利益水準は低い',
      caveat: '固定資産売却益の金額は今回の確認済み入力では未確認です',
      nextCheck: '第4四半期の予定を確認する',
    };
    const result = parseAnalysisResponse(response([candidate]), source);
    expect(result.issues[0]).toEqual(candidate);
    expect(result.evidence[0].text).toBe(source.evidence[0].text);
    const html = buildAnalysisStageHtml({ loading: false, data: result, error: null });
    expect(html).toContain('未検証の推論');
    expect(html).toContain(candidate.caveat);
    expect(html).toContain('1,174,729千円');
    expect(analysisPrompt(source)[0].content).toContain('既にある金額・進捗・説明を未確認としない');
  });

  it('任意の確認条件を埋めず、原文を意味点検済みへ昇格させず表示する', () => {
    const source = buildAnalysisInput(facts, {
      ...presentation,
      sourceLedger: buildSourceLedger([page]),
    });
    const raw = source.evidence.find((e) => e.kind === 'source')!;
    const candidate = { ...issue(), evidenceIds: [raw.id], caveat: '', nextCheck: '' };
    const result = parseAnalysisResponse(response([candidate]), source);
    expect(result.notices).toEqual([]);
    expect(result.issues[0]).toEqual(candidate);
    const html = buildAnalysisStageHtml({ loading: false, data: result, error: null });
    expect(html).toContain('抽出原文（意味未点検）');
    expect(html).toContain(raw.text);
    expect(html).not.toContain('data-analysis-caveat');
    expect(html).not.toContain('data-analysis-next-check');
    const model = analysisModelInput(source);
    expect(model.sourceDocument).toEqual(source.sourceDocument);
    expect(model.allowedEvidenceIds).toContain(raw.id);
    expect(model.evidence.some((e) => e.id === raw.id)).toBe(false);
    expect(
      model.sourceDocument?.pages
        .flatMap((p) => p.rows)
        .some((r) => r[0] === raw.id.slice(4) && r[1] === raw.text)
    ).toBe(true);
  });

  it('引用可能IDだけをモデルへ投影し、長さ・必須キー・件数をプロンプトとスキーマへ揃える', () => {
    const source = input();
    const model = analysisModelInput(source);
    expect(model.allowedEvidenceIds).toEqual(source.evidence.map((e) => e.id));
    expect(model.evidence.filter((e) => e.kind !== 'source')).toEqual(
      source.evidence.filter((e) => e.kind !== 'source').map(({ sourceIds: _sources, ...e }) => e)
    );
    expect(JSON.stringify(model)).not.toContain('sourceIds');
    expect(model.coverage).toEqual(source.coverage);
    const schema = analysisResponseSchema(source);
    expect(schema).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['version', 'overallSummary', 'issues'],
      properties: {
        version: { enum: [4] },
        issues: {
          maxItems: ANALYSIS_RESOURCE_LIMITS.issues,
          items: {
            additionalProperties: false,
            properties: {
              title: { minLength: 1, maxLength: ANALYSIS_RESOURCE_LIMITS.text },
              reading: { minLength: 1, maxLength: ANALYSIS_RESOURCE_LIMITS.text },
              caveat: { minLength: 0, maxLength: ANALYSIS_RESOURCE_LIMITS.text },
              nextCheck: { minLength: 0, maxLength: ANALYSIS_RESOURCE_LIMITS.text },
              evidenceIds: {
                minItems: 1,
                maxItems: ANALYSIS_RESOURCE_LIMITS.references,
                items: { enum: model.allowedEvidenceIds },
              },
            },
          },
        },
      },
    });
    const messages = analysisPrompt(source);
    expect(messages[0].content).toContain('個別論点を横断した全体像');
    expect(messages[0].content).toContain('最初の論点・結論のコピー');
    expect(messages[0].content).toContain('個別論点と同じ一回の応答');
    expect(messages[0].content).toContain('titleは80文字以内');
    expect(messages[0].content).toContain('各350文字以内');
    expect(messages[0].content).toContain('evidence[].idとraw:<行ID>・rawspan:<文字列ID>');
    expect(messages[0].content).toContain('rowsの各行[0]');
    expect(messages[0].content).toContain('looseSpansの各要素[0]');
    expect(messages[0].content).not.toContain('rows[].id');
    expect(messages[0].content).toContain('同じ配列内で重複させません');
    expect(JSON.parse(messages[1].content.split('\n入力: ')[1])).toEqual(model);
    // Projection never removes internal provenance from the saved/displayed evidence.
    const result = parseAnalysisResponse(response(), source);
    expect(result.evidence[0].sourceIds).toEqual(source.evidence[0].sourceIds);
    expect(parseAnalysis(JSON.stringify(result), facts, presentation)).toEqual(result);
  });

  it.each([
    ['openrouter', 'deepseek/deepseek-v4.1-flash', 'json_schema'],
    ['openai', 'fixture', 'json_object'],
    ['custom', 'fixture', undefined],
  ])(
    '%s/%sは既知の応答形式能力だけを使い、暗黙の形式再試行をしない',
    async (provider, model, format) => {
      vi.mocked(generateText).mockResolvedValueOnce(response());
      await analyzeFacts({ ...config, provider, model }, facts, presentation);
      const sent = vi.mocked(generateText).mock.calls[0][0];
      if (format === 'json_schema') {
        expect(sent.responseFormat).toEqual({
          type: 'json_schema',
          json_schema: {
            name: 'tdnet_additional_analysis',
            strict: true,
            schema: analysisResponseSchema(input()),
          },
        });
        expect(sent.reasoningEnabled).toBe(false);
      } else expect(sent.responseFormat).toBe(format);
      expect(vi.mocked(generateText)).toHaveBeenCalledTimes(1);
    }
  );

  it('不明参照の生応答と失敗位置を残し、保存失敗でも生成を再試行しない', async () => {
    const raw = response([{ ...issue(), evidenceIds: ['p1s58'] }]);
    const snapshots: AnalysisGenerationDiagnostic[] = [];
    vi.mocked(generateText).mockImplementationOnce(async (options) => {
      options.onUsage?.({
        inputTokens: 100,
        outputTokens: 1215,
        elapsedMs: 20,
        finishReason: 'stop',
      });
      options.onResponse?.(raw);
      return raw;
    });
    const result = await analyzeFacts(config, facts, presentation, (snapshot) => {
      snapshots.push(snapshot);
      throw new Error('quota');
    });
    expect(result.issues).toEqual([]);
    expect(result.notices).toContainEqual(
      expect.objectContaining({
        code: 'evidence_unknown',
        path: '$.issues[0].evidenceIds[0]',
        severity: 'quarantined',
      })
    );
    expect(snapshots.map((s) => s.outcome)).toEqual(['running', 'running', 'partialSuccess']);
    expect(snapshots[0].response).toBeNull();
    expect(snapshots[snapshots.length - 1]).toMatchObject({
      response: raw,
      usage: { outputTokens: 1215, finishReason: 'stop' },
      error: null,
    });
    expect(vi.mocked(generateText)).toHaveBeenCalledTimes(1);
  });

  it('使用量と中断された生応答を通信層の例外後も保持し、未受信と空応答を区別する', async () => {
    for (const raw of [null, '', '{"version":4,"issues":[']) {
      const snapshots: AnalysisGenerationDiagnostic[] = [];
      vi.mocked(generateText).mockImplementationOnce(async (options) => {
        if (raw !== null) options.onResponse?.(raw);
        if (raw)
          options.onUsage?.({
            inputTokens: 100,
            outputTokens: 8192,
            elapsedMs: 20,
            finishReason: 'length',
          });
        throw new Error(raw ? 'APIの推論・出力上限' : '通信エラー');
      });
      await expect(
        analyzeFacts(config, facts, presentation, (s) => {
          snapshots.push(s);
        })
      ).rejects.toBeInstanceOf(AnalysisValidationError);
      expect(snapshots[snapshots.length - 1]).toMatchObject({
        outcome: 'failure',
        response: raw,
        error: { code: raw ? 'output_limit' : 'request_failed' },
      });
    }
    expect(vi.mocked(generateText)).toHaveBeenCalledTimes(3);
  });

  it('開始前の中断はAPIを呼ばず診断し、成功応答は診断保存失敗でも返す', async () => {
    const controller = new AbortController();
    controller.abort();
    const snapshots: AnalysisGenerationDiagnostic[] = [];
    await expect(
      analyzeFacts({ ...config, signal: controller.signal }, facts, presentation, (s) => {
        snapshots.push(s);
      })
    ).rejects.toThrow(expect.objectContaining({ code: 'interrupted' }));
    expect(snapshots[snapshots.length - 1]).toMatchObject({
      outcome: 'failure',
      response: null,
      error: { code: 'interrupted' },
    });
    expect(vi.mocked(generateText)).not.toHaveBeenCalled();
    vi.mocked(generateText).mockResolvedValueOnce(response());
    const result = await analyzeFacts(config, facts, presentation, () => {
      throw new Error('quota');
    });
    expect(result.issues).toHaveLength(1);
    expect(vi.mocked(generateText)).toHaveBeenCalledTimes(1);
  });

  it('診断保存の待ち時間をモデルの生成期限へ混ぜない', async () => {
    vi.useFakeTimers();
    vi.mocked(generateText).mockResolvedValueOnce(response());
    const completed = analyzeFacts(config, facts, presentation, async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 65_000));
    });
    await vi.runAllTimersAsync();
    expect((await completed).issues).toHaveLength(1);
    expect(vi.mocked(generateText)).toHaveBeenCalledTimes(1);
  });
});
