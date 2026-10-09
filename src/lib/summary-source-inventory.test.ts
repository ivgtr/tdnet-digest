import { expect, it, vi } from 'vitest';
import type { FactSummary } from './fact-contract';
import { textPage } from './fixtures/v4-test-source';
import { generateText } from './llm-client';
import { renderFacts } from './fact-summary';
import { sourceInventory } from './summary-source-inventory';
import { buildPresentation, revalidatePresentation } from './summary-presentation';
import { generateSummaryOrganization } from './summary-organization';
import { isReportingMetadata, reportingCoverBlocks } from './document-context';
import { reportingFieldProjection } from './reporting-attributes';

vi.mock('./llm-client', () => ({ generateText: vi.fn() }));

// A recognized label cannot erase an unknown value or extend cover ownership
// through it to company/scope/basis declarations belonging to later content.
it('管理欄の型に合わない値を原文に残し、表紙の連続範囲をそこで閉じる', () => {
  const page = textPage(
    '2026年3月期 決算短信\nコード番号 │ 参考情報\n会社名 │ 株式会社他社\n範囲 │ 連結\n会計基準 │ IFRS'
  );
  const invalid = page.blocks[1];
  expect(reportingFieldProjection(invalid.text).complete).toBe(false);
  expect(isReportingMetadata(invalid)).toBe(false);
  expect(reportingCoverBlocks(page.blocks).map((block) => block.id)).toEqual([page.blocks[0].id]);
  expect(sourceInventory([page])).toContainEqual(
    expect.objectContaining({
      id: `source:${invalid.id}`,
      blockId: invalid.id,
      text: invalid.text,
      spanIds: invalid.spanIds,
    })
  );
});

// Projection vocabulary is tested in reporting-attributes. These cases own the
// complete-record → inventory boundary, including the legacy unruled policy.
it.each([
  'TEL │ 03-0000-0000',
  'URL | https://example.com/report%20list',
  'コ ー ド 番 号 ： ｜ 464A',
  '上場取引所 │ 東 │ 証券コード │ 1234',
  '代 表 者 │ 役職名 │ 社長 │ 氏名 │ 山田太郎 │ 問合せ先責任者 │ 経理部長 │ 鈴木花子',
  '各位 │ TEL │ 03-0000-0000 │ 以上',
  'コード番号 1234',
])('完全な管理レコードを投影後に除外する: %s', (text) => {
  const page = textPage(text);
  const original = structuredClone(page);
  expect(sourceInventory([page])).toEqual([]);
  expect(page).toEqual(original);
});

it('管理欄に混じった本文・数量・未知セル・空欄を原文とIDのまま残す', () => {
  for (const text of [
    'TEL │ 03-0000-0000 │ 売上高は100百万円です。',
    'TEL │ 03-0000-0000 売上高100百万円',
    'URL │ https://example.com/report%20list │ 参考情報',
    'コード番号 ││ 1234',
    '代表者 │ 代表取締役社長 │ 山田太郎 │ 新製品の販売を開始しました。',
    '会社名 株式会社対象 │ 条件 承認後',
    '会社名は変更します。承認が条件です。',
  ]) {
    const page = textPage(text);
    const block = page.blocks[0];
    const original = structuredClone(page);
    expect(sourceInventory([page])).toEqual([
      expect.objectContaining({
        id: `source:${block.id}`,
        blockId: block.id,
        text,
        spanIds: block.spanIds,
      }),
    ]);
    expect(page).toEqual(original);
  }
});

it('会社・範囲・基準の根拠と、日付・配当支払日の表示方針を保つ', () => {
  const page = textPage(
    '会社名 │ 株式会社テスト │ TEL │ 03-0000-0000\n範囲 │ 連結 │ TEL │ 03-0000-0000\n会計基準 │ 日本基準 │ URL │ https://example.com\n1. 実施時期\n2026年10月15日\n配当金支払開始予定日 │ 2026年6月30日'
  );
  const excerpts = sourceInventory([page]);
  expect(
    excerpts.map(({ id, blockId, text, spanIds }) => ({ id, blockId, text, spanIds }))
  ).toEqual(
    page.blocks.map((block) => ({
      id: `source:${block.id}`,
      blockId: block.id,
      text: block.text,
      spanIds: block.spanIds,
    }))
  );
  expect(excerpts[0].role).toBe('document');
  expect(excerpts[excerpts.length - 1].role).toBe('dividend');
});

it('管理行を補足生成の原文・数量と未分類表示へ渡さず、本文を表示・保存復元する', async () => {
  const page = textPage(
    '会社名 株式会社テスト\nTEL │ 03-0000-0000\nURL │ https://example.com/report%20list\nコード番号 │ 1234\n新製品の販売を開始しました。'
  );
  const original = structuredClone(page);
  const facts: FactSummary = { version: 6, documentType: 'other', facts: [], unverified: [] };
  const display = buildPresentation(facts, [page]);
  const bodyId = 'source:p1b5';
  vi.mocked(generateText)
    .mockReset()
    .mockResolvedValueOnce(
      JSON.stringify({
        version: 6,
        contexts: [
          {
            id: 'business',
            topic: 'business',
            entity: null,
            scope: null,
            basis: null,
            period: null,
            state: 'actual',
            conditions: [],
            sourceIds: [bodyId],
          },
        ],
        observations: [],
        claims: [{ contextId: 'business', text: '新製品の販売を開始。', sourceIds: [bodyId] }],
      })
    )
    .mockResolvedValueOnce(
      JSON.stringify({
        version: 2,
        claims: [{ id: 'explanation-0', reason: null }],
        sources: [{ id: bodyId, reason: null }],
      })
    );
  display.organization = await generateSummaryOrganization(
    { provider: 'openrouter', model: 'deepseek/deepseek-v4.1-flash', apiKey: 'fixture' },
    facts,
    display.values,
    display.excerpts,
    [page]
  );
  const input = JSON.parse(vi.mocked(generateText).mock.calls[0][1][1].content);
  expect(input.excerpts.map((excerpt: { id: string }) => excerpt.id)).toEqual([
    'source:p1b1',
    bodyId,
  ]);
  expect(input.values).toEqual([]);
  expect(display.values.some((value) => value.raw === '1234')).toBe(false);
  expect(display.organization.status).toBe('ready');
  expect(display.sections.find((section) => section.title === '未分類の原文')!.excerptIds).toEqual([
    bodyId,
  ]);
  const rendered = renderFacts(facts, display);
  expect(rendered).toContain('新製品の販売を開始。');
  expect(rendered).not.toMatch(/TEL|URL|コード番号/);
  expect(revalidatePresentation(JSON.parse(JSON.stringify(display)), facts, [page])).toEqual(
    display
  );
  expect(page).toEqual(original);
});
