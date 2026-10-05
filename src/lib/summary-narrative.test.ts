import { describe, expect, it, vi } from 'vitest';
import type { FactSummary } from './fact-contract';
import { narrativeResponseSchema } from './summary-narrative-schema';
import { generateText } from './llm-client';
import { textPage, layoutPage, numberCandidate } from './fixtures/v4-test-source';
import { reviewCandidates } from './fact-candidates';
import { candidateResponse } from './fixtures/candidate-test-source';
import {
  completePresentation,
  fixedNarrativeContent,
  fixedNarrativeReview,
} from './fixtures/summary-narrative-source';
import {
  buildPresentation,
  validatePresentation,
  revalidatePresentation,
} from './summary-presentation';
import { generateVerifiedFactSummary, renderFacts } from './fact-summary';
import {
  narrativeClaims,
  NARRATIVE_TOKEN,
  assembleNarrative,
  applyNarrativeEdits,
  validateNarrativeContent,
  type NarrativeContent,
} from './summary-narrative';
import { buildSummaryHtml } from '../content/utils/summaryHtmlBuilder';
import type { SummaryAttempt } from './summary-trace';
import { literalValue, quantityChange } from './summary-narrative-renderer';

vi.mock('./llm-client', () => ({ generateText: vi.fn() }));
const config = { provider: 'openai', model: 'fixture', apiKey: 'fixture' };
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
function content(): NarrativeContent {
  const result = fixedNarrativeContent(facts, draft);
  result.sections[0].tables[0].headers.push('前年同期比');
  result.sections[0].tables[0].rows[0].cells.push(value(q('20.0', '前年同期比')));
  result.sections.push({
    id: 'segments',
    title: '事業別業績',
    sourceIds: sources,
    summary: [],
    tables: [
      {
        caption: {
          id: 'segment-caption',
          text: '当期と前年同期。利益は事業別損益。',
          sourceIds: sources,
        },
        headers: ['事業', '売上高', '売上前年比', '利益', '利益前年比・赤字の変化', '主因'],
        rows: [
          {
            id: 'product',
            sourceIds: sources,
            cells: [
              '製品事業',
              value(q('120', '製品事業')),
              change(q('120', '製品事業'), q('100', '製品事業'), 'revenue'),
              value(q('20', '製品事業')),
              change(q('20', '製品事業'), q('10', '製品事業'), 'profit'),
              '価格転嫁が寄与',
            ],
          },
          {
            id: 'service',
            sourceIds: sources,
            cells: [
              'サービス事業',
              '記載なし',
              '記載なし',
              value(q('-15', 'サービス事業')),
              change(q('-15', 'サービス事業'), q('-10', 'サービス事業'), 'profit'),
              '先行投資で赤字拡大',
            ],
          },
        ],
      },
    ],
  });
  result.sections.push({
    id: 'orders',
    title: '受注・需要の動き',
    sourceIds: sources,
    summary: [
      {
        id: 'delivery',
        text: '受注残は新規案件の積み上がりで増加。納期長期化に注意。',
        sourceIds: sources,
      },
    ],
    tables: [
      {
        caption: {
          id: 'order-caption',
          text: '受注高は前年同期、受注残は前期末との比較。',
          sourceIds: sources,
        },
        headers: ['指標', '当期', '比較値', '増減', '背景'],
        rows: [
          {
            id: 'intake',
            sourceIds: sources,
            cells: [
              '受注高',
              value(q('90', '当期受注高')),
              value(q('100', '当期受注高')),
              change(q('90', '当期受注高'), q('100', '当期受注高'), 'stock'),
              '大型案件の反動',
            ],
          },
          {
            id: 'backlog',
            sourceIds: sources,
            cells: [
              '期末受注残高',
              value(q('150', '当期末受注残高')),
              value(q('100', '当期末受注残高')),
              change(q('150', '当期末受注残高'), q('100', '当期末受注残高'), 'stock'),
              '新規案件の積み上がり',
            ],
          },
        ],
      },
    ],
  });
  result.sections.push({
    id: 'cash',
    title: 'キャッシュフロー',
    sourceIds: sources,
    summary: [
      {
        id: 'cash-reason',
        text: '営業CFは在庫増で支出。設備投資を進め、借入で資金を確保。',
        sourceIds: sources,
      },
    ],
    tables: [
      {
        caption: {
          id: 'cash-caption',
          text: 'フローは前年同期比較。現金同等物は期首から期末。',
          sourceIds: sources,
        },
        headers: ['指標', '当期・期末', '比較値・期首', '増減額'],
        rows: [
          {
            id: 'operating-cash',
            sourceIds: sources,
            cells: [
              '営業CF',
              value(q('-20', '当期営業CF')),
              value(q('-30', '当期営業CF')),
              change(q('-20', '当期営業CF'), q('-30', '当期営業CF'), 'flow'),
            ],
          },
          {
            id: 'investing-cash',
            sourceIds: sources,
            cells: ['投資CF', value(q('-60', '当期投資CF')), '記載なし', '比較不能'],
          },
          {
            id: 'financing-cash',
            sourceIds: sources,
            cells: ['財務CF', value(q('50', '当期財務CF')), '記載なし', '比較不能'],
          },
          {
            id: 'cash-balance',
            sourceIds: sources,
            cells: [
              '現金同等物',
              value(q('70', '期首現金同等物')),
              value(q('100', '期首現金同等物')),
              `{{delta:${q('70', '期首現金同等物')}|${q('100', '期首現金同等物')}}}`,
            ],
          },
        ],
      },
    ],
  });
  return result;
}

function synthesisResponse(content: NarrativeContent) {
  const literal = (text: string) =>
    text.replace(NARRATIVE_TOKEN, (_token, kind: string, args: string) => {
      const parts = args.split('|');
      const values = parts
        .slice(0, kind === 'value' ? 1 : 2)
        .map((id) => literalValue(draft.values.find((v) => v.id === id)!));
      return kind === 'value'
        ? values[0]
        : `{{${kind}:${[...values, ...parts.slice(2)].join('|')}}}`;
    });
  const line = (c: { text: string; sourceIds: string[] }) => ({
    text: literal(c.text),
    sourceIds: c.sourceIds,
  });
  return {
    version: 3,
    overview: content.overview.map(line),
    sections: content.sections.map((s) => ({
      title: s.title,
      summary: s.summary.map(line),
      tables: s.tables.map((t) => ({
        caption: line(t.caption),
        headers: t.headers,
        rows: t.rows.map((r) => ({ cells: r.cells.map(literal), sourceIds: r.sourceIds })),
      })),
    })),
  };
}
describe('説明要約の生成・点検・数値参照', () => {
  it('通常の生成経路を原文照合→要約→独立点検→同じ保存表示へ接続する', async () => {
    const response = synthesisResponse(content());
    const summary = assembleNarrative(response, facts, draft.values, draft.excerpts);
    const review = fixedNarrativeReview(summary, facts, draft);
    review.findings = [
      {
        status: 'supported',
        claimId: 'row-0-0-0',
        sourceIds: sources,
        reason: '売上と比較対象は原文と整合する。',
      },
      {
        status: 'detail',
        claimId: 'summary-2-0',
        sourceIds: sources,
        reason: '主要なCFと主因は本文にあり、小科目の明細は不要。',
      },
    ];
    vi.mocked(generateText)
      .mockReset()
      .mockResolvedValueOnce(candidateResponse(facts.facts, [page]))
      .mockResolvedValueOnce(JSON.stringify(response))
      .mockResolvedValueOnce(JSON.stringify({ version: 3, findings: review.findings }));
    const attempts: SummaryAttempt[] = [];
    const generated = await generateVerifiedFactSummary(
      { ...config, provider: 'openrouter', model: 'deepseek/deepseek-v4.1-flash' },
      'other',
      page.text,
      [page],
      (a) => {
        attempts.push(a);
      }
    );
    expect(
      vi
        .mocked(generateText)
        .mock.calls.map(([c]) => ({ effort: c.reasoningEffort, enabled: c.reasoningEnabled }))
    ).toEqual([
      { effort: 'low', enabled: undefined },
      { effort: undefined, enabled: false },
      { effort: undefined, enabled: false },
    ]);
    expect(attempts.map((a) => a.phase)).toEqual(['first', 'summary', 'summaryReview']);
    const generationInput = vi.mocked(generateText).mock.calls[1][1][1].content;
    expect(generationInput).toContain('sourceUnitColumns');
    expect(generationInput).not.toContain('valueColumns');
    for (const e of draft.excerpts) expect(generationInput).toContain(JSON.stringify(e.text));
    expect(generated.repairAttempted).toBe(false);
    expect(generated.presentation.narrative!.review.findings).toEqual(review.findings);
    const invalidReview = structuredClone(generated.presentation) as unknown as {
      narrative: { review: { findings: Array<{ status: string }> } };
    };
    invalidReview.narrative.review.findings[0].status = 'unknown';
    expect(() => revalidatePresentation(invalidReview, generated.facts, [page])).toThrow(
      '点検結果の形式'
    );
    const restored = revalidatePresentation(
      JSON.parse(JSON.stringify(generated.presentation)),
      generated.facts,
      [page]
    );
    expect(renderFacts(generated.facts, restored)).toBe(
      renderFacts(generated.facts, generated.presentation)
    );
    const html = buildSummaryHtml(renderFacts(generated.facts, restored), null, {
      companyName: 'テスト',
      title: '開示',
    });
    const reading = html.replace(/<details\b[\s\S]*?<\/details>/g, '');
    for (const text of [
      '事業別業績',
      '↑増収 約+20.0%',
      '↑増益 約+100.0%',
      '↓赤字拡大 約+50.0%',
      '↓減少 約−10.0%',
      '↑増加 約+50.0%',
      '↑増加（+10百万円）',
      '−30百万円',
      '納期長期化に注意',
    ])
      expect(reading).toContain(text);
    expect(reading.split('業績と増減要因')[0]).toContain('前年同期比 20.0%');
    expect(reading.split('事業別業績')[0]).not.toContain('比較未確認');
    expect(reading).not.toContain('原文抜粋');
    expect(reading).not.toContain('サービス事業の当期損益は');
    expect(html).toContain('サービス事業の当期損益は');
    expect(reading).not.toContain('CFは改善');
    expect(generated.facts).toEqual(facts);
  });

  it('数字の直書き・未知根拠・数量の欠落・単位混在と保存後の文変更を拒否する', () => {
    const good = content();
    validateNarrativeContent(good, facts, draft.values, draft.excerpts);
    const literal = synthesisResponse(good);
    literal.sections[0].summary[0].text = '製品売上は１２０百万円。';
    const bound = assembleNarrative(literal, facts, draft.values, draft.excerpts);
    expect(bound.sections[0].summary[0].text).toContain(value(q('120', '製品事業')));
    literal.sections[0].summary[0].text = '製品売上は121百万円。';
    expect(() => assembleNarrative(literal, facts, draft.values, draft.excerpts)).toThrow(
      '引用原文にありません'
    );
    literal.sections[0].summary[0].text = '製品売上は121百万円、利益は999百万円。';
    try {
      assembleNarrative(literal, facts, draft.values, draft.excerpts);
      throw new Error('拒否されませんでした');
    } catch (e) {
      expect((e as Error).message).toContain('121百万円');
      expect((e as Error).message).toContain('999百万円');
    }
    literal.sections[0].summary[0].text = '製品売上は120千円。';
    expect(() => assembleNarrative(literal, facts, draft.values, draft.excerpts)).toThrow(
      '引用原文にありません'
    );
    literal.sections[0].summary[0].text = '製品売上は100百万円。';
    expect(() => assembleNarrative(literal, facts, draft.values, draft.excerpts)).not.toThrow();
    literal.sections[0].summary[0].text = '製品売上は120百万円。';
    literal.sections[0].summary[0].sourceIds = draft.excerpts
      .filter((e) => e.text.includes('大型案件'))
      .map((e) => e.id);
    expect(() => assembleNarrative(literal, facts, draft.values, draft.excerpts)).toThrow(
      '引用原文にありません'
    );
    expect(() =>
      assembleNarrative(
        { ...synthesisResponse(good), version: 1 },
        facts,
        draft.values,
        draft.excerpts
      )
    ).toThrow('version=3');
    const periodResponse = synthesisResponse(good);
    const evidence = facts.facts[0].evidence;
    periodResponse.sections[0].summary[0].sourceIds = draft.excerpts
      .filter((e) =>
        evidence.kind === 'table'
          ? e.spanIds.includes(evidence.valueId)
          : e.blockId === evidence.blockId
      )
      .map((e) => e.id);
    periodResponse.sections[0].summary[0].text = '2026年3月期の業績を確認する。';
    expect(() =>
      assembleNarrative(periodResponse, facts, draft.values, draft.excerpts)
    ).not.toThrow();
    periodResponse.sections[0].summary[0].text = '2027年3月期の業績を確認する。';
    expect(() => assembleNarrative(periodResponse, facts, draft.values, draft.excerpts)).toThrow(
      'REFERENCE'
    );
    expect(() => assembleNarrative(good, facts, draft.values, draft.excerpts)).toThrow('SCHEMA');
    const editBase = synthesisResponse(good);
    const edits = {
      version: 2,
      edits: [{ op: 'replace', path: '/sections/0/summary/0/text', value: '変更した説明。' }],
    };
    const edited = applyNarrativeEdits(editBase, edits) as typeof editBase;
    expect(edited.sections[0].summary[0].text).toBe('変更した説明。');
    expect(edited.sections.slice(1)).toEqual(editBase.sections.slice(1));
    expect(editBase.sections[0].summary[0].text).not.toBe('変更した説明。');
    editBase.sections[0].tables[0].rows[0].sourceIds = [draft.excerpts[0].id];
    const originalSources = editBase.sections[0].tables[0].rows[0].sourceIds;
    const additionalSource = draft.excerpts[1].id;
    const cited = applyNarrativeEdits(editBase, {
      version: 2,
      edits: [
        {
          op: 'cite',
          path: '/sections/0/tables/0/rows/0/sourceIds',
          value: [additionalSource, originalSources[0]],
        },
      ],
    }) as typeof editBase;
    expect(cited.sections[0].tables[0].rows[0].sourceIds).toEqual([
      ...originalSources,
      additionalSource,
    ]);
    expect(cited.sections[0].tables[0].rows[0].cells).toEqual(
      editBase.sections[0].tables[0].rows[0].cells
    );
    const repairWire = narrativeResponseSchema(sources, 'edits', [], editBase);
    const editWire = repairWire.properties.edits as {
      items: { anyOf: Array<{ properties: { op: { enum: string[] }; path: { enum: string[] } } }> };
    };
    const citationWire = editWire.items.anyOf.find((v) => v.properties.op.enum[0] === 'cite')!;
    expect(citationWire.properties.path.enum).toContain('/sections/0/tables/0/caption/sourceIds');
    expect(citationWire.properties.path.enum).not.toContain(
      '/sections/0/tables/0/headers/0/sourceIds'
    );
    expect(() => applyNarrativeEdits(editBase, { ...edits, version: 1 })).toThrow('version=2');
    expect(() =>
      applyNarrativeEdits(editBase, {
        version: 2,
        edits: [{ op: 'cite', path: '/sections/0/title', value: [additionalSource] }],
      })
    ).toThrow('cite');
    for (const path of ['/sections/99/title', '/__proto__/text', '/sections/0/unknown'])
      expect(() =>
        applyNarrativeEdits(editBase, {
          version: 2,
          edits: [{ op: 'replace', path, value: '不正' }],
        })
      ).toThrow('SCHEMA');
    expect(() =>
      applyNarrativeEdits(editBase, { version: 2, edits: [edits.edits[0], edits.edits[0]] })
    ).toThrow('SCHEMA');
    expect(() => applyNarrativeEdits(editBase, editBase)).toThrow('SCHEMA');
    const addressPages = [textPage('取引先の所在地は東京都中央区1丁目2番です。', 1)];
    const addressFacts: FactSummary = {
      version: 6,
      documentType: 'other',
      facts: [],
      unverified: [],
    };
    const addressDraft = buildPresentation(addressFacts, addressPages);
    const addressResponse = {
      version: 3,
      overview: [],
      sections: [
        {
          title: '取引条件',
          summary: [
            {
              text: '所在地は東京都中央区1丁目2番。',
              sourceIds: addressDraft.excerpts.map((e) => e.id),
            },
          ],
          tables: [],
        },
      ],
    };
    expect(() =>
      assembleNarrative(addressResponse, addressFacts, addressDraft.values, addressDraft.excerpts)
    ).not.toThrow();
    addressResponse.sections[0].summary[0].text = '所在地は東京都中央区3丁目2番。';
    expect(() =>
      assembleNarrative(addressResponse, addressFacts, addressDraft.values, addressDraft.excerpts)
    ).toThrow('REFERENCE');
    const dropped = applyNarrativeEdits(editBase, {
      version: 2,
      edits: [{ op: 'remove', path: '/sections/0' }],
    });
    expect(() => assembleNarrative(dropped, facts, draft.values, draft.excerpts)).toThrow(
      'COVERAGE'
    );
    const doubledUnit = structuredClone(good);
    doubledUnit.sections[0].tables[0].rows[0].cells[1] += '百万円';
    expect(() =>
      validateNarrativeContent(doubledUnit, facts, draft.values, draft.excerpts)
    ).toThrow('単位を重複');
    const emptyCell = structuredClone(good);
    emptyCell.sections[1].tables[0].rows[0].cells[5] = '';
    validateNarrativeContent(emptyCell, facts, draft.values, draft.excerpts);
    const cells = [
      ['（単位：百万円）', 0, 0],
      ['売上高', 0, 20],
      ['120', 100, 20],
      ['100', 200, 20],
      ['利益', 0, 40],
      ['20', 100, 40],
      ['10', 200, 40],
      ['別の説明です。', 0, 60],
      ['数量', 0, 80],
      ['90', 100, 80],
      ['80', 200, 80],
    ] as const;
    const unitPage = layoutPage(
      cells.map(([text, x, y], i) => ({
        id: `p1s${i + 1}`,
        text,
        x,
        y,
        width: text.length * 10,
        height: 10,
      }))
    );
    const unitValues = buildPresentation(
      { version: 6, documentType: 'other', facts: [], unverified: [] },
      [unitPage]
    ).values;
    expect(unitValues.find((v) => v.decimal === '120')?.unit).toBe('百万円');
    expect(unitValues.find((v) => v.decimal === '90')?.unit).toBeNull();
    const adjacentPage = layoutPage(
      [
        ['売上', 0, 20, 20],
        ['120', 100, 20, 30],
        ['千円', 135, 20, 20],
        ['110', 200, 20, 30],
        ['千円', 235, 20, 20],
        ['数量', 0, 40, 20],
        ['90', 300, 40, 20],
        ['85', 400, 40, 20],
      ].map(([text, x, y, width], i) => ({
        id: `p1s${i + 1}`,
        text: text as string,
        x: x as number,
        y: y as number,
        width: width as number,
        height: 10,
      }))
    );
    const adjacent = buildPresentation(
      { version: 6, documentType: 'other', facts: [], unverified: [] },
      [adjacentPage]
    ).values;
    expect(adjacent.find((v) => v.decimal === '110')?.unit).toBe('千円');
    expect(adjacent.find((v) => v.decimal === '90')?.unit).toBeNull();

    const columnPage = layoutPage(
      [
        ['百万円', 100, 0, 30],
        ['％', 200, 0, 10],
        ['売上高', 0, 20, 40],
        ['120', 100, 20, 30],
        ['5.0', 180, 20, 30],
        ['別の説明です。', 0, 40, 80],
        ['別項目', 0, 60, 40],
        ['90', 110, 60, 20],
        ['8.0', 180, 60, 30],
      ].map(([text, x, y, width], i) => ({
        id: `p1s${i + 1}`,
        text: text as string,
        x: x as number,
        y: y as number,
        width: width as number,
        height: 10,
      }))
    );
    const columns = buildPresentation(
      { version: 6, documentType: 'other', facts: [], unverified: [] },
      [columnPage]
    ).values;
    expect(columns.find((v) => v.decimal === '120')?.unit).toBe('百万円');
    expect(columns.find((v) => v.decimal === '5.0')?.unit).toBe('%');
    expect(columns.find((v) => v.decimal === '90')?.unit).toBeNull();
    const groupedPage = layoutPage([
      { id: 'p1s1', text: '金額（千円）', x: 100, y: 0, width: 60, height: 10 },
      { id: 'p1s2', text: 'サービス', x: 0, y: 20, width: 40, height: 10 },
      { id: 'p1s3', text: '120', x: 100, y: 20, width: 30, height: 10 },
      { id: 'p1s4', text: 'その他', x: 0, y: 40, width: 40, height: 10 },
      { id: 'p1s5', text: '90', x: 110, y: 40, width: 20, height: 10 },
    ]);
    // Reading classification must not decide whether these physical cells exist.
    groupedPage.blocks.forEach((b) => {
      b.kind = 'paragraph';
    });
    const grouped = buildPresentation(
      { version: 6, documentType: 'other', facts: [], unverified: [] },
      [groupedPage]
    ).values;
    expect(grouped.find((v) => v.decimal === '120')?.unit).toBe('千円');
    expect(grouped.find((v) => v.decimal === '90')?.unit).toBe('千円');
    const chartPage = layoutPage([
      { id: 'p1s1', text: '(百万円)', x: 0, y: 0, width: 60, height: 10 },
      { id: 'p1s2', text: '338', x: 200, y: 20, width: 30, height: 10 },
      { id: 'p1s3', text: '別の説明。', x: 0, y: 40, width: 60, height: 10 },
      { id: 'p1s4', text: '289', x: 200, y: 60, width: 30, height: 10 },
    ]);
    const chart = buildPresentation(
      { version: 6, documentType: 'other', facts: [], unverified: [] },
      [chartPage]
    ).values;
    expect(chart.find((v) => v.decimal === '338')?.unit).toBe('百万円');
    expect(chart.find((v) => v.decimal === '289')?.unit).toBeNull();
    const splitUnit = buildPresentation(
      { version: 6, documentType: 'other', facts: [], unverified: [] },
      [
        layoutPage([
          { id: 'p1s1', text: '税金支払は7,602千', x: 0, y: 0, width: 120, height: 10 },
          { id: 'p1s2', text: '円。調査では8割が利用。', x: 0, y: 12, width: 140, height: 10 },
        ]),
      ]
    );
    expect(splitUnit.values.find((v) => v.decimal === '7602')?.unit).toBe('千円');
    expect(splitUnit.values.find((v) => v.decimal === '8')?.unit).toBe('割');
    const fragmentsPage = layoutPage([
      { id: 'p1s1', text: '(百万円)', x: 0, y: 0, width: 60, height: 10 },
      { id: 'p1s2', text: '1', x: 100, y: 20, width: 10, height: 10 },
      { id: 'p1s3', text: '億', x: 110, y: 20, width: 10, height: 10 },
      { id: 'p1s4', text: '27', x: 120, y: 20, width: 20, height: 10 },
      { id: 'p1s5', text: '百万円', x: 140, y: 20, width: 30, height: 10 },
    ]);
    const fragments = buildPresentation(
      { version: 6, documentType: 'other', facts: [], unverified: [] },
      [fragmentsPage]
    ).values;
    expect(fragments.some((v) => v.decimal === '27' && v.unit === '百万円')).toBe(false);
    const inlineRow = layoutPage([
      { id: 'p1s1', text: '当期', x: 0, y: 0, width: 20, height: 10 },
      { id: 'p1s2', text: '7,017', x: 80, y: 0, width: 30, height: 10 },
      { id: 'p1s3', text: '百万円（6.3％）', x: 110, y: 0, width: 80, height: 10 },
      { id: 'p1s4', text: '前年', x: 220, y: 0, width: 20, height: 10 },
      { id: 'p1s5', text: '6,599', x: 280, y: 0, width: 30, height: 10 },
      { id: 'p1s6', text: '百万円（－％）', x: 310, y: 0, width: 80, height: 10 },
    ]);
    const inline = buildPresentation(
      { version: 6, documentType: 'other', facts: [], unverified: [] },
      [inlineRow]
    ).values;
    expect(inline.find((v) => v.decimal === '7017')?.unit).toBe('百万円');
    expect(inline.find((v) => v.decimal === '6.3')?.unit).toBe('%');
    const columnFacts = {
      version: 6 as const,
      documentType: 'other' as const,
      facts: [],
      unverified: [],
    };
    const columnDisplay = buildPresentation(columnFacts, [columnPage]);
    const fractional = assembleNarrative(
      {
        version: 3,
        overview: [],
        sections: [
          {
            title: '指標',
            tables: [],
            summary: [{ text: 'ROE5.00%。', sourceIds: columnDisplay.excerpts.map((e) => e.id) }],
          },
        ],
      },
      columnFacts,
      columnDisplay.values,
      columnDisplay.excerpts
    );
    expect(fractional.sections[0].summary[0].text).toContain('{{value:');
    const literalPage = textPage('施策は4つで構成し、3領域へ注力します。寄付額は1億27百万円です。');
    const literalDisplay = buildPresentation(columnFacts, [literalPage]);
    const literalResponse = {
      version: 3,
      overview: [],
      sections: [
        {
          title: '施策',
          tables: [],
          summary: [
            {
              text: '4つの施策のうち3領域を重視。寄付額は1億27百万円。',
              sourceIds: literalDisplay.excerpts.map((e) => e.id),
            },
          ],
        },
      ],
    };
    const whole = assembleNarrative(
      literalResponse,
      columnFacts,
      literalDisplay.values,
      literalDisplay.excerpts
    );
    expect(literalValue(literalDisplay.values.find((v) => v.raw === '1億27百万円')!)).toBe(
      '1億27百万円'
    );
    expect(() =>
      validatePresentation(completePresentation(literalDisplay, columnFacts, whole), columnFacts)
    ).not.toThrow();
    literalResponse.sections[0].summary[0].text = '寄付額は1億28百万円。';
    expect(() =>
      assembleNarrative(
        literalResponse,
        columnFacts,
        literalDisplay.values,
        literalDisplay.excerpts
      )
    ).toThrow('引用原文にありません');
    literalResponse.sections[0].summary[0].text = '{{value:p1b1:q1}}';
    expect(() =>
      assembleNarrative(
        literalResponse,
        columnFacts,
        literalDisplay.values,
        literalDisplay.excerpts
      )
    ).toThrow('生成時の数量IDは不要');
    const labels = structuredClone(draft.excerpts);
    labels[0].text +=
      ' ToSTNeT-3、午前8時45分、会社法第165条第3項。1UP投資部屋。B2C事業。第20期定時株主総会。第3回会議。';
    const named = structuredClone(good);
    named.sections[0].summary[0].text =
      '会社法第165条第３項に基づき、午前８時45分のToSTNeT-3で取引する。';
    validateNarrativeContent(named, facts, draft.values, labels);
    named.sections[0].summary[0].text = '1UP投資部屋で紹介。基本的１株当たり利益。';
    validateNarrativeContent(named, facts, draft.values, labels);
    named.sections[0].summary[0].text = '第20期定時株主総会で承認、第3回会議で検討。';
    validateNarrativeContent(named, facts, draft.values, labels);
    named.sections[0].summary[0].text = '第21期定時株主総会で承認。';
    expect(() => validateNarrativeContent(named, facts, draft.values, labels)).toThrow('REFERENCE');
    named.sections[0].summary[0].text = '2UP投資部屋で紹介。';
    expect(() => validateNarrativeContent(named, facts, draft.values, labels)).toThrow('REFERENCE');
    named.sections[0].summary[0].text = 'B2事業。';
    expect(() => validateNarrativeContent(named, facts, draft.values, labels)).toThrow('REFERENCE');
    named.sections[0].summary[0].text = '100JPYを取得する。';
    expect(() => validateNarrativeContent(named, facts, draft.values, labels)).toThrow('QUANTITY');
    named.sections[0].summary[0].text = '午前9時45分のToSTNeT-4で取引する。';
    expect(() => validateNarrativeContent(named, facts, draft.values, labels)).toThrow('REFERENCE');
    for (const [mutate, message] of [
      [
        (c: NarrativeContent) => {
          c.sections[0].summary[0].text = '売上高は999百万円。';
        },
        'QUANTITY',
      ],
      [
        (c: NarrativeContent) => {
          c.sections[0].summary[0].sourceIds = ['source:p99b1'];
        },
        'REFERENCE',
      ],
      [
        (c: NarrativeContent) => {
          c.sections[0].tables = [];
        },
        'COVERAGE',
      ],
    ] as const) {
      const changed = structuredClone(good);
      mutate(changed);
      expect(() => validateNarrativeContent(changed, facts, draft.values, draft.excerpts)).toThrow(
        message
      );
    }
    const units = structuredClone(draft.values);
    units.find((v) => v.id === q('120', '製品事業'))!.unit = '千円';
    expect(() => validateNarrativeContent(good, facts, units, draft.excerpts)).toThrow(
      'COMPARISON'
    );
    const magnitude = draft.values.find((v) => v.id === q('20', '製品事業'))!;
    const priorMagnitude = draft.values.find((v) => v.id === q('10', '製品事業'))!;
    expect(quantityChange(magnitude, priorMagnitude, 'loss')).toContain('↓損失拡大 約+100.0%');
    const wrongLoss = structuredClone(good);
    wrongLoss.sections[1].tables[0].rows[1].cells[4] = change(
      q('-15', 'サービス事業'),
      q('-10', 'サービス事業'),
      'loss'
    );
    expect(() => validateNarrativeContent(wrongLoss, facts, draft.values, draft.excerpts)).toThrow(
      'COMPARISON'
    );
    const saved = completePresentation(draft, facts, good);
    saved.narrative!.content.sections[0].summary[0].text = '収益性は今後も向上する。';
    expect(() => validatePresentation(saved, facts)).toThrow('点検範囲');
    expect(() => validatePresentation({ ...saved, version: 2 }, facts)).toThrow('不正');
    expect(() => validatePresentation({ ...saved, narrative: null }, facts)).toThrow('不正');
  });

  it('重要条件の欠落を独立点検で修復し、再失敗は原文抜粋で代用しない', async () => {
    const response = synthesisResponse(content());
    const summary = assembleNarrative(response, facts, draft.values, draft.excerpts);
    const badReview = {
      version: 3,
      findings: [
        {
          status: 'importantOmission',
          claimId: 'summary-2-0',
          sourceIds: sources,
          reason: '納期長期化の条件が欠落',
        },
      ],
    };
    // A structural repair must not consume the separate semantic repair.
    const malformedResponse = structuredClone(response);
    malformedResponse.sections[0].summary[0].text = '売上高999百万円。';
    const correction = {
      version: 2,
      edits: [
        {
          op: 'replace',
          path: '/sections/0/summary/0/text',
          value: response.sections[0].summary[0].text,
        },
      ],
    };
    const wrongCorrection = {
      version: 2,
      edits: [{ op: 'replace', path: '/sections/0/summary/0/text', value: '売上高999百万円。' }],
    };
    vi.mocked(generateText)
      .mockReset()
      .mockResolvedValueOnce(candidateResponse(facts.facts, [page]))
      .mockResolvedValueOnce(JSON.stringify(malformedResponse))
      .mockResolvedValueOnce(JSON.stringify(correction))
      .mockResolvedValueOnce(JSON.stringify(badReview))
      .mockResolvedValueOnce(JSON.stringify(wrongCorrection))
      .mockResolvedValueOnce(JSON.stringify(correction))
      .mockResolvedValueOnce(JSON.stringify({ version: 3, findings: [] }));
    const repairedAttempts: SummaryAttempt[] = [];
    const repaired = await generateVerifiedFactSummary(
      { ...config, provider: 'openrouter', model: 'deepseek/deepseek-v4.1-flash' },
      'other',
      page.text,
      [page],
      (a) => {
        repairedAttempts.push(a);
      }
    );
    expect(vi.mocked(generateText).mock.calls[1][0].reasoningEnabled).toBe(false);
    for (const index of [1, 2, 3]) {
      const format = vi.mocked(generateText).mock.calls[index][0].responseFormat;
      expect(format && typeof format === 'object' && format.type).toBe('json_schema');
    }
    expect(vi.mocked(generateText).mock.calls[2][1][1].content).toContain(
      '/sections/0/summary/0/text'
    );
    expect(vi.mocked(generateText).mock.calls[2][1][1].content).toContain('literalAlternatives');
    expect(
      vi
        .mocked(generateText)
        .mock.calls.slice(2)
        .every(([c]) => c.reasoningEffort === undefined && c.reasoningEnabled === false)
    ).toBe(true);
    for (const index of [2, 4, 5])
      expect(vi.mocked(generateText).mock.calls[index][0].maxOutputTokens).toBe(8192);
    expect(repaired.repairAttempted).toBe(true);
    expect(repairedAttempts.map((a) => a.phase)).toEqual([
      'first',
      'summary',
      'summaryRepair',
      'summaryReview',
      'summaryRepair',
      'summaryRepair',
      'summaryReviewRepair',
    ]);
    vi.mocked(generateText)
      .mockReset()
      .mockResolvedValueOnce(candidateResponse(facts.facts, [page]))
      .mockResolvedValueOnce(JSON.stringify(response))
      .mockResolvedValueOnce(JSON.stringify(badReview))
      .mockResolvedValueOnce(JSON.stringify(correction))
      .mockResolvedValueOnce(JSON.stringify(badReview));
    const attempts: SummaryAttempt[] = [];
    await expect(
      generateVerifiedFactSummary(config, 'other', page.text, [page], (a) => {
        attempts.push(a);
      })
    ).rejects.toThrow('納期長期化');
    expect(attempts.map((a) => a.phase)).toEqual([
      'first',
      'summary',
      'summaryReview',
      'summaryRepair',
      'summaryReviewRepair',
    ]);
    expect(vi.mocked(generateText)).toHaveBeenCalledTimes(5);
    const incomplete = fixedNarrativeReview(summary, facts, draft);
    incomplete.reviewedClaimIds = narrativeClaims(summary)
      .slice(1)
      .map((c) => c.id);
    expect(() =>
      validatePresentation(completePresentation(draft, facts, summary), facts)
    ).not.toThrow();
    const malformed = completePresentation(draft, facts, summary);
    malformed.narrative!.review = incomplete;
    expect(() => validatePresentation(malformed, facts)).toThrow('点検範囲');
  });
});
