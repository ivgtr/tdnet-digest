import { afterEach, describe, expect, it, vi } from 'vitest';
import { numberCandidate, textPage } from './fixtures/v4-test-source';
import { parseFactSummary } from './fact-summary';
import { buildPresentation } from './fixtures/summary-narrative-source';
import { buildAnalysisInput } from './analysis-input';
import {
  analyzeFacts,
  ANALYSIS_LIMITS,
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

vi.mock('./llm-client', () => ({ generateText: vi.fn() }));
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
const response = (issues = [issue()]) => JSON.stringify({ version: 3, issues });
const config = { provider: 'openai', apiKey: 'fixture', model: 'fixture' };
afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('追加分析の根拠と論点の契約', () => {
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
      text: `営業利益: 確定事実 fact:${facts.facts[0].id} の同じ原数量への補足（区分: profit）`,
      sourceIds: [...value.sourceIds, facts.facts[0].id],
      pages: [5],
    });
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
    ['generated arithmetic', () => ({ ...issue(), reading: '来期は200百万円になります' })],
    ['kanji arithmetic', () => ({ ...issue(), reading: '利益が二倍になる可能性があります' })],
    ['same reading', () => ({ ...issue(), reading: issue().conclusion })],
    [
      'literal restatement',
      () => ({ ...issue(), reading: '自社保有資産の売却が利益を押し上げた。' }),
    ],
  ])('%s is rejected at the schema boundary', (_name, make) => {
    expect(() => parseAnalysisResponse(response([make()]), input())).toThrow();
  });

  it('旧時間軸形式・重複論点を拒否し、不足時に四枠を埋めない', () => {
    expect(() => parseAnalysisResponse('{"version":2,"interpretation":{}}', input())).toThrow();
    expect(() =>
      parseAnalysisResponse(response([issue(), { ...issue(), title: '別名' }]), input())
    ).toThrow();
    expect(parseAnalysisResponse(response([]), input()).issues).toEqual([]);
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
    expect(html).toContain('結論（推論）');
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
  it('出力打切りを成功扱いにせず、確認済み入力の件数をエラーへ残す', async () => {
    vi.mocked(generateText).mockImplementationOnce(async (options) => {
      options.onUsage?.({
        inputTokens: 100,
        outputTokens: 8192,
        elapsedMs: 250,
        finishReason: 'length',
      });
      return response();
    });
    await expect(analyzeFacts(config, facts, presentation)).rejects.toThrow(
      /出力上限.*事実1・説明1・指標0.*8192token/
    );
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
      expect(() =>
        parseAnalysisResponse(
          response([{ ...accepted, [key]: character.repeat(limit + 1) }]),
          input()
        )
      ).toThrow(expect.objectContaining({ code: 'text_length', path: `$.issues[0].${key}` }));
    }
  });

  it.each([
    ['invalid_json', '$', () => '{broken'],
    ['response_shape', '$', () => JSON.stringify({ version: 3, issues: [], extra: true })],
    ['response_version', '$.version', () => JSON.stringify({ version: 2, issues: [] })],
    ['issues_type', '$.issues', () => JSON.stringify({ version: 3, issues: {} })],
    ['issues_count', '$.issues', () => response(Array.from({ length: 5 }, issue))],
    [
      'issue_shape',
      '$.issues[0]',
      () => JSON.stringify({ version: 3, issues: [{ title: '欠損' }] }),
    ],
    [
      'text_type',
      '$.issues[0].reading',
      () => JSON.stringify({ version: 3, issues: [{ ...issue(), reading: null }] }),
    ],
    ['text_empty', '$.issues[0].caveat', () => response([{ ...issue(), caveat: '  ' }])],
    [
      'text_placeholder',
      '$.issues[0].reading',
      () => response([{ ...issue(), reading: ' 判断不能 ' }]),
    ],
    [
      'evidence_type',
      '$.issues[0].evidenceIds',
      () => JSON.stringify({ version: 3, issues: [{ ...issue(), evidenceIds: 'not-array' }] }),
    ],
    [
      'evidence_count',
      '$.issues[0].evidenceIds',
      () => response([{ ...issue(), evidenceIds: [] }]),
    ],
    [
      'evidence_id_type',
      '$.issues[0].evidenceIds[0]',
      () => JSON.stringify({ version: 3, issues: [{ ...issue(), evidenceIds: [null] }] }),
    ],
    [
      'evidence_unknown',
      '$.issues[0].evidenceIds[0]',
      () => response([{ ...issue(), evidenceIds: [facts.facts[0].id] }]),
    ],
    [
      'evidence_unknown',
      '$.issues[0].evidenceIds[0]',
      () => response([{ ...issue(), evidenceIds: [input().evidence[0].sourceIds[1]] }]),
    ],
    [
      'evidence_duplicate',
      '$.issues[0].evidenceIds[1]',
      () =>
        response([{ ...issue(), evidenceIds: [issue().evidenceIds[0], issue().evidenceIds[0]] }]),
    ],
  ])('%sを失敗位置とともに区別する', (code, path, raw) => {
    expect(() => parseAnalysisResponse(raw(), input())).toThrow(
      expect.objectContaining({ code, path })
    );
  });

  it('引用可能IDだけをモデルへ投影し、長さ・必須キー・件数をプロンプトとスキーマへ揃える', () => {
    const source = input();
    const model = analysisModelInput(source);
    expect(model.allowedEvidenceIds).toEqual(source.evidence.map((e) => e.id));
    expect(model.evidence).toEqual(source.evidence.map(({ sourceIds: _sources, ...e }) => e));
    expect(JSON.stringify(model)).not.toContain('sourceIds');
    expect(model.coverage).toEqual(source.coverage);
    const schema = analysisResponseSchema(source);
    expect(schema).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['version', 'issues'],
      properties: {
        version: { enum: [3] },
        issues: {
          maxItems: ANALYSIS_LIMITS.issues,
          items: {
            additionalProperties: false,
            properties: {
              title: { minLength: 1, maxLength: ANALYSIS_LIMITS.title },
              reading: { minLength: 1, maxLength: ANALYSIS_LIMITS.text },
              evidenceIds: {
                minItems: 1,
                maxItems: ANALYSIS_LIMITS.references,
                items: { enum: model.allowedEvidenceIds },
              },
            },
          },
        },
      },
    });
    const messages = analysisPrompt(source);
    expect(messages[0].content).toContain('titleは80文字以内');
    expect(messages[0].content).toContain('各350文字以内');
    expect(messages[0].content).toContain('evidence[].idと同一');
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
    await expect(
      analyzeFacts(config, facts, presentation, (snapshot) => {
        snapshots.push(snapshot);
        throw new Error('quota');
      })
    ).rejects.toThrow(
      expect.objectContaining({
        code: 'evidence_unknown',
        path: '$.issues[0].evidenceIds[0]',
      })
    );
    expect(snapshots.map((s) => s.outcome)).toEqual(['running', 'running', 'failure']);
    expect(snapshots[0].response).toBeNull();
    expect(snapshots[snapshots.length - 1]).toMatchObject({
      response: raw,
      usage: { outputTokens: 1215, finishReason: 'stop' },
      error: { code: 'evidence_unknown', path: '$.issues[0].evidenceIds[0]' },
    });
    expect(vi.mocked(generateText)).toHaveBeenCalledTimes(1);
  });

  it('使用量と中断された生応答を通信層の例外後も保持し、未受信と空応答を区別する', async () => {
    for (const raw of [null, '', '{"version":3,"issues":[']) {
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
