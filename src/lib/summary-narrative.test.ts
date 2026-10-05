import { describe, expect, it, vi } from 'vitest';
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
  assembleNarrative,
  validateNarrativeContent,
  type NarrativeContent,
} from './summary-narrative';
import { buildSummaryHtml } from '../content/utils/summaryHtmlBuilder';
import type { SummaryAttempt } from './summary-trace';
import { quantityChange } from './summary-narrative-renderer';

vi.mock('./llm-client', () => ({ generateText: vi.fn() }));
const config = { provider: 'openai', model: 'fixture', apiKey: 'fixture' };
const page = textPage(
  '会社名 株式会社テスト | 会計基準 日本基準 | 範囲 連結\n2026年3月期 連結経営成績\n営業利益は100百万円です。\n1. 事業別業績\n製品事業の当期売上は120百万円、前年売上は100百万円。当期利益は20百万円、前年利益は10百万円。価格転嫁で増益。\nサービス事業の当期損益は△15百万円、前年損益は△10百万円。先行投資で赤字が拡大。\n2. 受注の状況\n当期受注高は90百万円、前年同期受注高は100百万円。大型案件の反動。\n当期末受注残高は150百万円、前期末受注残高は100百万円。新規案件が積み上がったが納期が長期化。\n3. キャッシュ・フロー\n当期営業CFは△20百万円、前年同期営業CFは△30百万円。在庫増で営業CFは支出。\n当期投資CFは△60百万円。設備投資が主因。\n当期財務CFは50百万円。借入で資金を確保。\n期首現金同等物は100百万円、期末現金同等物は70百万円。'
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
  const line = (c: { text: string; sourceIds: string[] }) => ({
    text: c.text,
    sourceIds: c.sourceIds,
  });
  return {
    version: 1,
    overview: content.overview.map(line),
    sections: content.sections.map((s) => ({
      title: s.title,
      summary: s.summary.map(line),
      tables: s.tables.map((t) => ({
        caption: line(t.caption),
        headers: t.headers,
        rows: t.rows.map((r) => ({ cells: r.cells, sourceIds: r.sourceIds })),
      })),
    })),
  };
}
describe('説明要約の生成・点検・数値参照', () => {
  it('通常の生成経路を原文照合→要約→独立点検→同じ保存表示へ接続する', async () => {
    const response = synthesisResponse(content());
    const summary = assembleNarrative(response, facts, draft.values, draft.excerpts);
    const review = fixedNarrativeReview(summary, facts, draft);
    vi.mocked(generateText)
      .mockReset()
      .mockResolvedValueOnce(candidateResponse(facts.facts, [page]))
      .mockResolvedValueOnce(JSON.stringify(response))
      .mockResolvedValueOnce(JSON.stringify(review));
    const attempts: SummaryAttempt[] = [];
    const generated = await generateVerifiedFactSummary(config, 'other', page.text, [page], (a) => {
      attempts.push(a);
    });
    expect(attempts.map((a) => a.phase)).toEqual(['first', 'summary', 'summaryReview']);
    expect(generated.repairAttempted).toBe(false);
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
    expect(reading).not.toContain('原文抜粋');
    expect(reading).not.toContain('サービス事業の当期損益は');
    expect(html).toContain('サービス事業の当期損益は');
    expect(reading).not.toContain('CFは改善');
    expect(generated.facts).toEqual(facts);
  });

  it('数字の直書き・未知根拠・数量の欠落・単位混在と保存後の文変更を拒否する', () => {
    const good = content();
    validateNarrativeContent(good, facts, draft.values, draft.excerpts);
    expect(() => assembleNarrative(good, facts, draft.values, draft.excerpts)).toThrow('SCHEMA');
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
    const labels = structuredClone(draft.excerpts);
    labels[0].text += ' ToSTNeT-3、午前8時45分、会社法第165条第3項。1UP投資部屋。';
    const named = structuredClone(good);
    named.sections[0].summary[0].text =
      '会社法第165条第３項に基づき、午前８時45分のToSTNeT-3で取引する。';
    validateNarrativeContent(named, facts, draft.values, labels);
    named.sections[0].summary[0].text = '1UP投資部屋で紹介。基本的１株当たり利益。';
    validateNarrativeContent(named, facts, draft.values, labels);
    named.sections[0].summary[0].text = '2UP投資部屋で紹介。';
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
      ...fixedNarrativeReview(summary, facts, draft),
      issues: [{ claimId: 'summary-2-0', sourceIds: sources, reason: '納期長期化の条件が欠落' }],
    };
    vi.mocked(generateText)
      .mockReset()
      .mockResolvedValueOnce(candidateResponse(facts.facts, [page]))
      .mockResolvedValueOnce(JSON.stringify(response))
      .mockResolvedValueOnce(JSON.stringify(badReview))
      .mockResolvedValueOnce(JSON.stringify(response))
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
