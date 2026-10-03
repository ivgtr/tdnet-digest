import { describe, it, expect } from 'vitest';
import { drawingLines, type DrawingOperation } from './pdf-drawing';
const op = (index: number, fn: string, args: unknown[] = []): DrawingOperation => ({
  index,
  fn,
  args,
});
const path = (index: number, paint: string, commands: number[]) =>
  op(index, 'constructPath', [paint, [commands], null]);
describe('PDFの描かれた罫線の証明', () => {
  it('変換・復元・矩形クリップを適用し、クリップ外の線と背景塗りを除外する', () => {
    const lines = drawingLines(
      [
        op(0, 'save'),
        op(1, 'transform', [2, 0, 0, 2, 10, 20]),
        op(2, 'clip'),
        path(3, 'endPath', [0, 0, 0, 1, 20, 0, 1, 20, 10, 1, 0, 10, 4]),
        path(4, 'stroke', [0, -10, 5, 1, 30, 5]),
        path(5, 'stroke', [0, 30, 5, 1, 50, 5]),
        path(6, 'fill', [0, 0, 0, 1, 20, 0, 1, 20, 10, 1, 0, 10, 4]),
        op(7, 'restore'),
        path(8, 'stroke', [0, 0, 0, 1, 10, 0]),
      ],
      1
    );
    expect(lines.map((l) => [l.x1, l.y1, l.x2, l.y2, l.operatorIndices])).toEqual([
      [10, -30, 50, -30, [4]],
      [0, -0, 10, -0, [8]],
    ]);
  });
  it('ページの回転とForm変換を原座標で保持する', () => {
    const lines = drawingLines(
      [
        op(0, 'paintFormXObjectBegin', [[0, 1, -1, 0, 100, 20], null]),
        path(1, 'stroke', [0, 0, 0, 1, 30, 0]),
        op(2, 'paintFormXObjectEnd'),
      ],
      2
    );
    expect(lines[0]).toMatchObject({
      id: 'p2g1',
      x1: 100,
      y1: -50,
      x2: 100,
      y2: -20,
      operatorIndices: [1],
    });
  });
  it('曲線クリップ・透明塗り・細くない矩形を表の根拠にしない', () => {
    expect(
      drawingLines(
        [
          op(0, 'clip'),
          path(1, 'endPath', [0, 0, 0, 2, 1, 1, 10, 10, 20, 20]),
          path(2, 'stroke', [0, 0, 0, 1, 30, 0]),
        ],
        1
      )
    ).toEqual([]);
    expect(
      drawingLines(
        [op(0, 'setFillTransparent'), path(1, 'fill', [0, 0, 0, 1, 30, 0, 1, 30, 1, 1, 0, 1, 4])],
        1
      )
    ).toEqual([]);
  });
  it.each([
    [op(0, 'restore')],
    [path(0, 'unknown', [0, 0, 0, 1, 10, 0])],
    [op(0, 'transform', [1, 0, 0, 1, 0, NaN])],
    [op(0, 'setGState', [['bad']])],
  ])('不正な描画契約は黙って文字だけに置き換えない: %j', (...operations) => {
    expect(() => drawingLines(operations, 1)).toThrow('SOURCE_DRAWING:');
  });
});
