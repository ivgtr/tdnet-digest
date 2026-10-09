import { describe, expect, it } from 'vitest';
import { textPage } from './fixtures/v4-test-source';
import { selectReportingPeriod } from './reporting-period-selection';
import { sourceInventory } from './summary-source-inventory';
import { earningsTarget } from './summary-earnings-policy';
import { coverageReport } from './fact-coverage';

const metadata = '会社名 株式会社テスト | 範囲 連結 | 会計基準 日本基準';
const heading = '1. 2026年3月期連結経営成績';

// Source ownership belongs here; earnings-target-contract owns candidate/display/restore.
describe('表紙と先頭の実績見出しによる報告期間の共通選択', () => {
  it.each([
    ['参照節', `参考資料\n${heading}`],
    ['本文境界', `当社の事業について説明します。\n${heading}`],
    ['予想', '1. 2026年3月期連結経営成績予想'],
    ['本文の期間', '1. 経営成績\n当期の2026年3月期連結経営成績'],
    ['参照修飾', '1. 参考 2026年3月期連結経営成績'],
    ['値のある見出し', '1. 2026年3月期連結経営成績 売上高100百万円'],
    ['別ページ', ''],
  ])('%sから年のない表紙へ対象期を借りない', (_, section) => {
    const pages = [textPage(`決算短信\n${metadata}\n${section}`), textPage(heading, 2)];
    const excerpts = sourceInventory(pages, undefined, 'earnings');
    expect(selectReportingPeriod(pages.flatMap((page) => page.blocks)).period).toBeNull();
    expect(earningsTarget(excerpts)).toEqual({ target: null, issue: 'missing' });
    const coverage = coverageReport('earnings', pages, []);
    expect(coverage).toHaveLength(1);
    expect(coverage[0]).toMatchObject({
      requirement: 'COVERAGE:報告対象の決算期を確認できません',
      status: 'unknown',
      sourceIds: [],
    });
    if (section.includes('当期の')) {
      expect(excerpts.find((source) => source.text.includes('当期の'))?.role).toBe('performance');
      expect(excerpts.find((source) => source.text.includes('当期の'))?.kind).toBe('paragraph');
    }
  });

  it.each([
    '2026年0月期 決算短信',
    '2026年13月期 決算短信',
    '2026年3月期 決算短信\n2025年3月期 決算短信',
    `決算短信\n${metadata}\n${heading}\n2. 2025年3月期連結経営成績`,
    `決算短信\n${metadata}\n1. 2026年3月期四半期連結経営成績`,
  ])('不正・競合・未知形の期間を推測しない: %s', (source) => {
    const page = textPage(`${source}\n${metadata}`);
    expect(selectReportingPeriod(page.blocks)).toMatchObject({ period: null, issue: 'ambiguous' });
    expect(earningsTarget(sourceInventory([page], undefined, 'earnings'))).toEqual({
      target: null,
      issue: 'ambiguous',
    });
    const coverage = coverageReport('earnings', [page], []);
    expect(coverage).toHaveLength(1);
    expect(coverage[0].requirement).toBe('COVERAGE:報告対象の決算期を確認できません');
  });

  it.each([
    `${metadata}\n範囲 非連結\n${heading}`,
    `${metadata}\n会計基準 IFRS\n${heading}`,
    `決算短信〔日本基準〕（非連結）\n会社名 株式会社テスト\n${heading}`,
  ])('表紙・先頭欄と業績見出しの属性衝突を最後の宣言で置き換えない', (source) => {
    const page = textPage(`${source}\n2026年3月期の営業利益は100百万円です。`);
    expect(earningsTarget(sourceInventory([page], undefined, 'earnings'))).toEqual({
      target: null,
      issue: 'ambiguous',
    });
    const coverage = coverageReport('earnings', [page], []);
    expect(coverage).toHaveLength(3);
    for (const slot of coverage) {
      expect(slot).toMatchObject({ status: 'unknown', sourceIds: [] });
      expect(slot.expected.scope).toBeUndefined();
      expect(slot.expected.basis).toBeUndefined();
    }
  });

  it.each([
    `２０２６年０３月期 決算短信\n${metadata}\n2. 2027年3月期連結経営成績`,
    `決算短信\n${metadata}\n１．２０２６年０３月期連結経営成績`,
  ])('有効月を共通に正規化し、日付のある表紙の所有権と原文字を保つ', (source) => {
    const page = textPage(source);
    const originals = structuredClone(page.blocks);
    const excerpts = sourceInventory([page], undefined, 'earnings');
    const selected = selectReportingPeriod(page.blocks);
    expect(selected.period).toEqual({ fiscal: '2026年3月期', periodKind: 'fullYear' });
    expect(selectReportingPeriod(excerpts).period).toEqual(selected.period);
    expect(page.blocks).toEqual(originals);
    expect(earningsTarget(excerpts)).toMatchObject({
      issue: null,
      target: { fiscal: '2026年3月期', periodKind: 'fullYear' },
    });
    const coverage = coverageReport('earnings', [page], []);
    expect(coverage).toHaveLength(3);
    expect(coverage.map((slot) => slot.expected.period)).toEqual(Array(3).fill('2026年3月期'));
  });
});
