import { describe, expect, it } from 'vitest';
import { buildTableCells } from './table-layout';
import type { DrawingLine } from './pdf-drawing';
import type { PdfSpan } from './pdf-layout';

const line = (x1: number, y1: number, x2: number, y2: number): DrawingLine => ({
  id: `${x1},${y1},${x2},${y2}`,
  x1,
  y1,
  x2,
  y2,
  operatorIndices: [0],
});
const grid = (xs: number[], ys: number[]) => [
  ...xs.map((x) => line(x, ys[0], x, ys[ys.length - 1])),
  ...ys.map((y) => line(xs[0], y, xs[xs.length - 1], y)),
];
const bounds = (cells: ReturnType<typeof buildTableCells>) =>
  cells.map(({ left, top, right, bottom }) => [left, top, right, bottom]);

describe('罫線セルの探索', () => {
  it('独立した6表の軸を組み合わせず、原文のセル順と所属を保持する', () => {
    const lines = [];
    const expected = [];
    for (let table = 0; table < 6; table++) {
      const xs = Array.from({ length: 7 }, (_, i) => table * 100 + i * 10);
      const ys = Array.from({ length: 4 }, (_, i) => table * 80 + i * 10);
      lines.push(...grid(xs, ys));
      for (let row = 0; row < 3; row++)
        for (let col = 0; col < 6; col++)
          expected.push([xs[col], ys[row], xs[col + 1], ys[row + 1]]);
    }
    const spans = [
      { id: 'p2s1', text: '123', x: 2, y: 7, width: 5, height: 5 },
      { id: 'p2s2', text: '456', x: 502, y: 407, width: 5, height: 5 },
      { id: 'p2s3', text: '表の間の本文', x: 75, y: 50, width: 10, height: 5 },
    ] as PdfSpan[];
    const cells = buildTableCells(lines, spans, 2);
    expect(bounds(cells)).toEqual(expected);
    expect(cells.map((c) => c.id)).toEqual(expected.map((_, i) => `p2cell${i + 1}`));
    expect(cells.flatMap((c) => c.spanIds)).toEqual(['p2s1', 'p2s2']);
  });

  it('内部罫線がない結合セルと最小幅・高さのセルを保持する', () => {
    const lines = [
      ...grid([0, 40], [0, 10, 20]),
      line(20, 10, 20, 20),
      ...grid([60, 68], [0, 4]),
      ...grid([80, 87], [0, 3]),
    ];
    expect(bounds(buildTableCells(lines, [], 1))).toEqual([
      [0, 0, 40, 10],
      [60, 0, 68, 4],
      [0, 10, 20, 20],
      [20, 10, 40, 20],
    ]);
  });

  it.each([
    { gap: 0.79, count: 1 },
    { gap: 0.81, count: 0 },
  ])('分割された実罫線の既存の許容幅を変えない: $gap', ({ gap, count }) => {
    const lines = [
      line(0, 0, 10, 0),
      line(10 + gap, 0, 20, 0),
      line(0, 10, 20, 10),
      line(0, 0, 0, 10),
      line(20, 0, 20, 10),
    ];
    expect(buildTableCells(lines, [], 1)).toHaveLength(count);
  });

  it.each(['top', 'bottom', 'left', 'right'])('欠けた%s辺を別表や文字から補わない', (missing) => {
    const edges = {
      top: line(0, 0, 20, 0),
      bottom: line(0, 10, 20, 10),
      left: line(0, 0, 0, 10),
      right: line(20, 0, 20, 10),
    };
    const lines = [
      ...Object.entries(edges)
        .filter(([side]) => side !== missing)
        .map(([, edge]) => edge),
      ...grid([40, 60], [30, 40]),
    ];
    expect(bounds(buildTableCells(lines, [], 1))).toEqual([[40, 30, 60, 40]]);
  });

  it('閉じたセルがない疎なページでも、枝刈り処理を無制限にしない', () => {
    const axes = Array.from({ length: 318 }, (_, i) => i * 10);
    const lines = [
      ...axes.map((x) => line(x, 5000, x, 5001)),
      ...axes.map((y) => line(5000, y, 5001, y)),
    ];
    expect(() => buildTableCells(lines, [], 1)).toThrow('SOURCE_DRAWING:表のセル解析の処理上限');
  });

  it('多数の罫線と実在するセルの探索上限は引き続き失敗にする', () => {
    expect(() =>
      buildTableCells(
        Array.from({ length: 2001 }, () => line(0, 0, 20, 0)),
        [],
        1
      )
    ).toThrow('SOURCE_DRAWING:表の罫線解析の処理上限');
    const axes = Array.from({ length: 318 }, (_, i) => i * 10);
    expect(() => buildTableCells(grid(axes, axes), [], 1)).toThrow(
      'SOURCE_DRAWING:表のセル解析の処理上限'
    );
  });
});
