import { afterEach, describe, expect, it, vi } from 'vitest';
import { numberCandidate, textPage } from './fixtures/v4-test-source';
import { parseFactSummary } from './fact-summary';
import { buildPresentation } from './fixtures/summary-narrative-source';
import { buildAnalysisInput } from './analysis-input';
import {
  analyzeFacts,
  analysisPrompt,
  parseAnalysis,
  parseAnalysisResponse,
} from './additional-analysis';
import { buildAnalysisStageHtml } from '../content/utils/summaryHtmlBuilder';
import { generateText } from './llm-client';

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
      text: '営業利益: 100百万円',
      sourceIds: value.sourceIds,
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
    ['unknown reference', () => ({ ...issue(), evidenceIds: ['unknown'] })],
    ['empty reference', () => ({ ...issue(), evidenceIds: [] })],
    [
      'repeated reference',
      () => ({
        ...issue(),
        evidenceIds: [`fact:${facts.facts[0].id}`, `fact:${facts.facts[0].id}`],
      }),
    ],
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
