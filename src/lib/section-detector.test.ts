import { describe, expect, it } from 'vitest';
import { detectSections, selectTopPages } from './section-detector';

describe('detectSections', () => {
  it('セクション開始ページを後続ページで上書きしない', () => {
    const sections = detectSections(
      ['1', '【業績】', '売上高 100百万円', '2', '【見通し】', '通期予想 120百万円'].join('\n')
    );

    expect(sections).toEqual([
      { heading: '業績', text: '売上高 100百万円', pageNumber: 1 },
      { heading: '見通し', text: '通期予想 120百万円', pageNumber: 2 },
    ]);
  });
});

describe('selectTopPages', () => {
  it('サマリーページとスコア上位ページの近傍を選ぶ', () => {
    expect(
      selectTopPages(
        [
          { pageNumber: 5, score: 10 },
          { pageNumber: 3, score: 5 },
        ],
        1,
        1,
        1
      )
    ).toEqual([1, 4, 5, 6]);
  });
});
