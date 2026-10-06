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
} from './summary-organization';
import { validateSavedFacts } from './fact-cache';
import { bindLiteralQuantities, quantitySourceClosure, checkText } from './summary-narrative';
import { buildSummaryHtml } from '../content/utils/summaryHtmlBuilder';
import type { SummaryAttempt } from './summary-trace';
import { literalValue, quantityChange } from './summary-narrative-renderer';

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

const value = (id: string) => `{{value:${id}}}`;
const change = (a: string, b: string, metric: string) => `{{change:${a}|${b}|${metric}}}`;
function wire() {
  return {
    version: 4,
    tables: [
      {
        caption: { text: '事業別の業績と需要・資金の変化', sourceIds: sources },
        headers: ['項目', '当期', '比較値', '増減'],
        rows: [
          {
            cells: [
              '製品事業 売上',
              value(q('120', '製品事業')),
              value(q('100', '製品事業')),
              change(q('120', '製品事業'), q('100', '製品事業'), 'revenue'),
            ],
            sourceIds: sources,
          },
          {
            cells: [
              '製品事業 利益',
              value(q('20', '製品事業')),
              value(q('10', '製品事業')),
              change(q('20', '製品事業'), q('10', '製品事業'), 'profit'),
            ],
            sourceIds: sources,
          },
          {
            cells: [
              'サービス事業 損益',
              value(q('-15', 'サービス事業')),
              value(q('-10', 'サービス事業')),
              change(q('-15', 'サービス事業'), q('-10', 'サービス事業'), 'profit'),
            ],
            sourceIds: sources,
          },
          {
            cells: [
              '受注高',
              value(q('90', '当期受注高')),
              value(q('100', '当期受注高')),
              change(q('90', '当期受注高'), q('100', '当期受注高'), 'stock'),
            ],
            sourceIds: sources,
          },
          {
            cells: [
              '期末受注残高',
              value(q('150', '当期末受注残高')),
              value(q('100', '当期末受注残高')),
              change(q('150', '当期末受注残高'), q('100', '当期末受注残高'), 'stock'),
            ],
            sourceIds: sources,
          },
          {
            cells: [
              '営業CF',
              value(q('-20', '当期営業CF')),
              value(q('-30', '当期営業CF')),
              change(q('-20', '当期営業CF'), q('-30', '当期営業CF'), 'flow'),
            ],
            sourceIds: sources,
          },
        ],
      },
    ],
    claims: [
      {
        text: '価格転嫁が製品事業の増益に寄与。サービス事業は先行投資で赤字拡大。',
        sourceIds: sources,
      },
      { text: '受注残増加により来期の増収が確定した。', sourceIds: sources },
    ],
  };
}
function review(input = wire()) {
  return {
    version: 1,
    claims: Object.fromEntries([
      ...input.tables.flatMap((t, i) => [
        [`table-${i}-caption`, null],
        ...t.rows.map((_, j) => [`table-${i}-row-${j}`, null]),
      ]),
      ...input.claims.map((_, i) => [
        `explanation-${i}`,
        i === 1 ? '来期増収確定の根拠がない' : null,
      ]),
    ]),
    sources: Object.fromEntries(
      explanationSources(draft.excerpts).map((e) => [
        e.id,
        e.text.includes('受注残高') ? '納期長期化の条件が未要約' : null,
      ])
    ),
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
  it('事業別・受注・負のCFを表示し、説明を個別採否して同じ段落の未要約条件を残す', async () => {
    const result = await generate();
    expect(result.presentation.version).toBe(4);
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
  });
  it('未知形式・不正数量・欠落した点検を採用せず、保存復元で正しい表と未整理の状態を維持する', async () => {
    const result = await generate();
    const copy = structuredClone(result.presentation);
    copy.organization.tables[0].rows[0].cells[1] = '999百万円';
    expect(() => validatePresentation(copy, result.facts)).toThrow('QUANTITY');
    expect(() =>
      validatePresentation({ ...result.presentation, version: 3 }, result.facts)
    ).toThrow('不正');
    const missing = structuredClone(result.presentation);
    delete missing.organization.review!.claims['table-0-row-0'];
    expect(() => validatePresentation(missing, result.facts)).toThrow('点検範囲');
    const unsupported = structuredClone(result.presentation);
    unsupported.organization.review!.claims['table-0-row-0'] = '期間対応が未確認';
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
    for (const raw of [
      JSON.stringify({ version: 3, tables: [], claims: [] }),
      '{"version":4,"tables":[],"claims":[],"claims":[]}',
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
    expect(organizationClaims(result.presentation.organization).length).toBe(9);
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
    expect(result.presentation.organization.tables).toEqual([]);
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
