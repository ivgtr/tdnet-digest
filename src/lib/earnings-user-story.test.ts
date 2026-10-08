/// <reference types="node" />
import { describe, expect, it } from 'vitest';
import { textPage } from './fixtures/v4-test-source';
import { coverageReport } from './fact-coverage';
import {
  earningsCoverPage,
  assertEarningsStoryCoverage,
  replayEarningsStory,
} from '../../evaluation/scripts/earnings-story-fixture';

describe('決算短信を要約し、閉じて再表示する利用者のストーリー', () => {
  it.each([
    ['個別', false],
    ['連結', true],
  ] as const)('付録の%s業績にある経常利益を報告対象の連結義務へ混ぜない', (scope, required) => {
    const pages = [
      earningsCoverPage(),
      textPage(
        `1. 2026年8月期 ${scope}経営成績\n範囲 ${scope}\n2026年8月期の経常利益は343213百万円です。`,
        2
      ),
    ];
    expect(
      coverageReport('earnings', pages, []).some(
        (slot) => slot.requirement === 'COVERAGE:当年決算実績の重要指標 ordinaryProfit'
      )
    ).toBe(required);
  });

  it.each(['個別', '非連結', '単体', '連結'])(
    '非連結表紙に対する局所%sは同じ範囲の別名だけで義務を除かない',
    (scope) => {
      const page = textPage(
        `2026年3月期 決算短信（非連結）\n会社名 株式会社テスト | 会計基準 日本基準 | 範囲 非連結\n1. 2026年3月期 ${scope}経営成績\n範囲 ${scope}\n2026年3月期の経常利益は100百万円です。`
      );
      expect(
        coverageReport('earnings', [page], []).some(
          (slot) => slot.requirement === 'COVERAGE:当年決算実績の重要指標 ordinaryProfit'
        )
      ).toBe(scope !== '連結');
    }
  );

  it('隣接率のある原表紙→生成入力→当期優先表示→保存再検証で、当期・前年・次期の値を保つ', async () => {
    const result = await replayEarningsStory([earningsCoverPage()]);
    expect(result.quantities).toBe(23);
    expect(result.coverage).toHaveLength(13);
    expect(() => assertEarningsStoryCoverage(result.coverage, true)).not.toThrow();
    // Negative controls prove that empty/subset/duplicate reports cannot pass vacuously.
    for (const invalid of [
      [],
      result.coverage.filter((slot) => !slot.requirement.startsWith('COVERAGE:当年決算実績')),
      result.coverage.slice(1),
      [...result.coverage.slice(1), result.coverage[1]],
      result.coverage.map((slot, i) => (i === 0 ? { ...slot, sourceIds: [] } : slot)),
    ])
      expect(() => assertEarningsStoryCoverage(invalid, false)).toThrow();
    const unconfirmed = result.coverage.map((slot, i) =>
      i === 0 ? { ...slot, status: 'absent' as const } : slot
    );
    expect(() => assertEarningsStoryCoverage(unconfirmed, true)).toThrow();
  });
});
