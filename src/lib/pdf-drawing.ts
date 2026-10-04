const operatorNames = [
  'save',
  'restore',
  'transform',
  'paintFormXObjectBegin',
  'paintFormXObjectEnd',
  'constructPath',
  'clip',
  'eoClip',
  'setGState',
  'setLineWidth',
  'setStrokeTransparent',
  'setFillTransparent',
  'setStrokeRGBColor',
  'setFillRGBColor',
] as const;
const OPS = Object.fromEntries(
  [
    ...operatorNames,
    'stroke',
    'closeStroke',
    'fill',
    'eoFill',
    'fillStroke',
    'eoFillStroke',
    'closeFillStroke',
    'closeEOFillStroke',
    'endPath',
  ].map((name) => [name, name])
);

/** Only the current PDF.js drawing contract is accepted. Original operator indices survive. */
export interface DrawingOperation {
  index: number;
  fn: string;
  args: unknown[];
}
export interface DrawingLine {
  id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  operatorIndices: number[];
}
type Matrix = [number, number, number, number, number, number];
type Point = [number, number];
type Box = [number, number, number, number];
const retained = new Set<string>([
  OPS.save,
  OPS.restore,
  OPS.transform,
  OPS.paintFormXObjectBegin,
  OPS.paintFormXObjectEnd,
  OPS.constructPath,
  OPS.clip,
  OPS.eoClip,
  OPS.setGState,
  OPS.setLineWidth,
  OPS.setStrokeTransparent,
  OPS.setFillTransparent,
  OPS.setStrokeRGBColor,
  OPS.setFillRGBColor,
]);
const plain = (value: unknown): unknown =>
  ArrayBuffer.isView(value)
    ? Array.from(value as unknown as ArrayLike<number>)
    : Array.isArray(value)
      ? value.map(plain)
      : value;
export function drawingOperations(
  list: { fnArray: number[]; argsArray: Array<unknown[] | null> },
  registry: Record<string, number>
): DrawingOperation[] {
  const names = new Map(Object.entries(registry).map(([name, code]) => [code, name]));
  return list.fnArray.flatMap((fn, index) => {
    const name = names.get(fn);
    if (!name) throw new Error('SOURCE_DRAWING:PDF.jsの未知の描画演算');
    if (!retained.has(name)) return [];
    const args = list.argsArray[index] == null ? [] : (plain(list.argsArray[index]) as unknown[]);
    if (name === 'constructPath') {
      const paint = names.get(args[0] as number);
      if (!paint) throw new Error('SOURCE_DRAWING:PDF.jsの未知の描画方式');
      args[0] = paint;
    }
    return [{ index, fn: name, args }];
  });
}
const multiply = (a: Matrix, b: Matrix): Matrix => [
  a[0] * b[0] + a[2] * b[1],
  a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3],
  a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4],
  a[1] * b[4] + a[3] * b[5] + a[5],
];
const point = (matrix: Matrix, x: number, y: number): Point => [
  matrix[0] * x + matrix[2] * y + matrix[4],
  -(matrix[1] * x + matrix[3] * y + matrix[5]),
];
const matrix = (raw: unknown): Matrix => {
  if (!Array.isArray(raw) || raw.length !== 6 || !raw.every(Number.isFinite))
    throw new Error('SOURCE_DRAWING:変換行列が不正です');
  return raw as Matrix;
};
/** Curves are preserved as drawing input, but are never used as horizontal table rules. */
function paths(data: unknown, transform: Matrix): { paths: Point[][]; curved: boolean } {
  if (!Array.isArray(data) || data.length !== 1 || !Array.isArray(data[0])) {
    // PDF.js represents a genuinely empty path by null.
    if (Array.isArray(data) && data.length === 1 && data[0] === null)
      return { paths: [], curved: false };
    throw new Error('SOURCE_DRAWING:描画パスが不正です');
  }
  const commands = data[0] as number[],
    result: Point[][] = [];
  let current: Point[] = [],
    curved = false;
  for (let i = 0; i < commands.length; ) {
    const op = commands[i++];
    if (op === 0 || op === 1) {
      const x = commands[i++],
        y = commands[i++];
      if (![x, y].every(Number.isFinite)) throw new Error('SOURCE_DRAWING:パス座標が不正です');
      if (op === 0) {
        if (current.length) result.push(current);
        current = [];
      }
      current.push(point(transform, x, y));
    } else if (op === 4) {
      if (current.length) {
        current.push(current[0]);
        result.push(current);
        current = [];
      }
    } else if (op === 2 || op === 3) {
      const count = op === 2 ? 6 : 4;
      if (!commands.slice(i, i + count).every(Number.isFinite) || i + count > commands.length)
        throw new Error('SOURCE_DRAWING:曲線座標が不正です');
      i += count;
      curved = true;
    } else throw new Error('SOURCE_DRAWING:未知のパス演算');
  }
  if (current.length) result.push(current);
  return { paths: result, curved };
}
const rectangular = (p: Point[]) =>
  p.length === 5 &&
  p[0][0] === p[4][0] &&
  p[0][1] === p[4][1] &&
  p.slice(1).every((n, i) => Math.abs(n[0] - p[i][0]) < 0.05 || Math.abs(n[1] - p[i][1]) < 0.05);
const bounds = (p: Point[]): Box => [
  Math.min(...p.map((n) => n[0])),
  Math.min(...p.map((n) => n[1])),
  Math.max(...p.map((n) => n[0])),
  Math.max(...p.map((n) => n[1])),
];
const intersection = (a: Box, b: Box): Box => [
  Math.max(a[0], b[0]),
  Math.max(a[1], b[1]),
  Math.min(a[2], b[2]),
  Math.min(a[3], b[3]),
];

/** Convex Form bounds clip the actual transformed rectangle, not only its envelope. */
function clipToForm(a: Point, b: Point, polygon: Point[]): [Point, Point] | null {
  const cross = (u: Point, v: Point) => u[0] * v[1] - u[1] * v[0];
  const area = polygon.reduce((sum, p, i) => sum + cross(p, polygon[(i + 1) % polygon.length]), 0);
  if (Math.abs(area) < 1e-9) return null;
  const sign = Math.sign(area),
    direction: Point = [b[0] - a[0], b[1] - a[1]];
  let from = 0,
    to = 1;
  for (const [i, p] of polygon.entries()) {
    const next = polygon[(i + 1) % polygon.length],
      edge: Point = [next[0] - p[0], next[1] - p[1]];
    const start = cross(edge, [a[0] - p[0], a[1] - p[1]]) * sign,
      delta = cross(edge, direction) * sign;
    if (Math.abs(delta) < 1e-9) {
      if (start < -1e-9) return null;
    } else if (delta > 0) from = Math.max(from, -start / delta);
    else to = Math.min(to, -start / delta);
    if (from > to) return null;
  }
  return [
    [a[0] + from * direction[0], a[1] + from * direction[1]],
    [a[0] + to * direction[0], a[1] + to * direction[1]],
  ];
}

/** Painted axis-aligned rules only: clipping paths, cell backgrounds and glyph outlines do not become grids. */
export function drawingLines(operations: DrawingOperation[], pageNumber: number): DrawingLine[] {
  if (!Array.isArray(operations) || operations.length > 100000)
    throw new Error('SOURCE_DRAWING:描画情報の形式・処理上限');
  type State = {
    transform: Matrix;
    clip: Box | null;
    formClips: Point[][];
    unresolvedClip: boolean;
    stroke: boolean;
    fill: boolean;
    strokeAlpha: number;
    fillAlpha: number;
  };
  let state: State = {
    transform: [1, 0, 0, 1, 0, 0],
    clip: null,
    formClips: [],
    unresolvedClip: false,
    stroke: true,
    fill: true,
    strokeAlpha: 1,
    fillAlpha: 1,
  };
  const stack: State[] = [];
  const lines: Omit<DrawingLine, 'id'>[] = [];
  let clipPending = false,
    previousIndex = -1;
  const save = () => stack.push({ ...state, transform: [...state.transform] });
  const restore = () => {
    const before = stack.pop();
    if (!before) throw new Error('SOURCE_DRAWING:描画状態の復元が不正です');
    state = before;
  };
  for (const operation of operations) {
    if (
      !operation ||
      Object.keys(operation).length !== 3 ||
      !['index', 'fn', 'args'].every((k) => k in operation) ||
      !Number.isInteger(operation.index) ||
      operation.index <= previousIndex ||
      !retained.has(operation.fn) ||
      !Array.isArray(operation.args)
    )
      throw new Error('SOURCE_DRAWING:描画演算の形式・順序が不正です');
    previousIndex = operation.index;
    const args = operation.args;
    if (
      [
        OPS.save,
        OPS.restore,
        OPS.paintFormXObjectEnd,
        OPS.clip,
        OPS.eoClip,
        OPS.setStrokeTransparent,
        OPS.setFillTransparent,
      ].includes(operation.fn) &&
      args.length !== 0
    )
      throw new Error('SOURCE_DRAWING:引数なし演算の形式が不正です');
    if (
      operation.fn === OPS.setLineWidth &&
      (args.length !== 1 || typeof args[0] !== 'number' || !Number.isFinite(args[0]) || args[0] < 0)
    )
      throw new Error('SOURCE_DRAWING:線幅の形式が不正です');
    if (
      [OPS.setStrokeRGBColor, OPS.setFillRGBColor].includes(operation.fn) &&
      (args.length !== 1 || typeof args[0] !== 'string' || !/^#[0-9a-f]{6}$/i.test(args[0]))
    )
      throw new Error('SOURCE_DRAWING:色の形式が不正です');
    if (operation.fn === OPS.save) save();
    else if (operation.fn === OPS.restore) restore();
    else if (operation.fn === OPS.transform)
      state.transform = multiply(state.transform, matrix(args));
    else if (operation.fn === OPS.paintFormXObjectBegin) {
      if (
        args.length !== 2 ||
        !(
          args[1] === null ||
          (Array.isArray(args[1]) && args[1].length === 4 && args[1].every(Number.isFinite))
        )
      )
        throw new Error('SOURCE_DRAWING:Form境界の形式が不正です');
      save();
      if (args[0] !== null) state.transform = multiply(state.transform, matrix(args[0]));
      if (Array.isArray(args[1])) {
        const b = args[1] as number[];
        const polygon = [
          point(state.transform, b[0], b[1]),
          point(state.transform, b[2], b[1]),
          point(state.transform, b[2], b[3]),
          point(state.transform, b[0], b[3]),
        ];
        const box = bounds(polygon);
        state.clip = state.clip ? intersection(state.clip, box) : box;
        state.formClips = [...state.formClips, polygon];
      }
    } else if (operation.fn === OPS.paintFormXObjectEnd) restore();
    else if (operation.fn === OPS.clip || operation.fn === OPS.eoClip) clipPending = true;
    else if (operation.fn === OPS.setStrokeTransparent) state.stroke = false;
    else if (operation.fn === OPS.setFillTransparent) state.fill = false;
    else if (operation.fn === OPS.setStrokeRGBColor) state.stroke = true;
    else if (operation.fn === OPS.setFillRGBColor) state.fill = true;
    else if (operation.fn === OPS.setGState) {
      if (
        args.length !== 1 ||
        !Array.isArray(args[0]) ||
        !args[0].every(
          (entry) => Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'string'
        )
      )
        throw new Error('SOURCE_DRAWING:描画状態の形式が不正です');
      for (const entry of args[0] as Array<[string, unknown]>) {
        if (entry[0] === 'CA' || entry[0] === 'ca') {
          if (
            typeof entry[1] !== 'number' ||
            !Number.isFinite(entry[1]) ||
            entry[1] < 0 ||
            entry[1] > 1
          )
            throw new Error('SOURCE_DRAWING:透明度の形式が不正です');
          if (entry[0] === 'CA') state.strokeAlpha = entry[1];
          else state.fillAlpha = entry[1];
        }
      }
    } else if (operation.fn === OPS.constructPath) {
      if (
        args.length !== 3 ||
        ![
          OPS.stroke,
          OPS.closeStroke,
          OPS.fill,
          OPS.eoFill,
          OPS.fillStroke,
          OPS.eoFillStroke,
          OPS.closeFillStroke,
          OPS.closeEOFillStroke,
          OPS.endPath,
        ].includes(args[0] as string)
      )
        throw new Error('SOURCE_DRAWING:描画方式が不正です');
      const path = paths(args[1], state.transform),
        op = args[0];
      const stroke =
        state.stroke &&
        state.strokeAlpha > 0 &&
        [
          OPS.stroke,
          OPS.closeStroke,
          OPS.fillStroke,
          OPS.eoFillStroke,
          OPS.closeFillStroke,
          OPS.closeEOFillStroke,
        ].includes(op as string);
      const fill =
        state.fill &&
        state.fillAlpha > 0 &&
        [
          OPS.fill,
          OPS.eoFill,
          OPS.fillStroke,
          OPS.eoFillStroke,
          OPS.closeFillStroke,
          OPS.closeEOFillStroke,
        ].includes(op as string);
      if (!path.curved && !state.unresolvedClip) {
        for (const p of path.paths) {
          const box = bounds(p),
            thin = rectangular(p) && Math.min(box[2] - box[0], box[3] - box[1]) <= 1.5;
          const segments: Array<[Point, Point]> = stroke
            ? p.slice(1).map((to, i) => [p[i], to])
            : fill && thin
              ? box[2] - box[0] > box[3] - box[1]
                ? [
                    [
                      [box[0], (box[1] + box[3]) / 2],
                      [box[2], (box[1] + box[3]) / 2],
                    ],
                  ]
                : [
                    [
                      [(box[0] + box[2]) / 2, box[1]],
                      [(box[0] + box[2]) / 2, box[3]],
                    ],
                  ]
              : [];
          for (let [a, b] of segments) {
            if (Math.abs(a[0] - b[0]) > 0.05 && Math.abs(a[1] - b[1]) > 0.05) continue;
            if (state.clip) {
              const c = state.clip;
              if (Math.abs(a[1] - b[1]) < 0.05) {
                if (a[1] < c[1] || a[1] > c[3]) continue;
                const left = Math.min(a[0], b[0]),
                  right = Math.max(a[0], b[0]);
                if (Math.max(c[0], left) >= Math.min(c[2], right)) continue;
                a = [Math.max(c[0], left), a[1]];
                b = [Math.min(c[2], right), b[1]];
              } else {
                if (a[0] < c[0] || a[0] > c[2]) continue;
                const top = Math.min(a[1], b[1]),
                  bottom = Math.max(a[1], b[1]);
                if (Math.max(c[1], top) >= Math.min(c[3], bottom)) continue;
                a = [a[0], Math.max(c[1], top)];
                b = [b[0], Math.min(c[3], bottom)];
              }
            }
            let clipped: [Point, Point] | null = [a, b];
            for (const polygon of state.formClips) {
              clipped = clipToForm(clipped[0], clipped[1], polygon);
              if (!clipped) break;
            }
            if (!clipped) continue;
            [a, b] = clipped;
            if (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) < 6) continue;
            if (a[0] > b[0] || a[1] > b[1]) [a, b] = [b, a];
            lines.push({
              x1: a[0],
              y1: a[1],
              x2: b[0],
              y2: b[1],
              operatorIndices: [operation.index],
            });
          }
        }
      }
      if (clipPending) {
        if (path.curved || path.paths.length !== 1 || !rectangular(path.paths[0]))
          state.unresolvedClip = true;
        else {
          const box = bounds(path.paths[0]);
          state.clip = state.clip ? intersection(state.clip, box) : box;
        }
        clipPending = false;
      }
    }
  }
  if (stack.length || clipPending) throw new Error('SOURCE_DRAWING:描画状態が閉じていません');
  const unique: Omit<DrawingLine, 'id'>[] = [];
  for (const line of lines) {
    const existing = unique.find((l) =>
      ['x1', 'y1', 'x2', 'y2'].every((k) => Math.abs(l[k as 'x1'] - line[k as 'x1']) < 0.05)
    );
    if (existing) existing.operatorIndices.push(...line.operatorIndices);
    else unique.push(line);
  }
  return unique.map((line, i) => ({ ...line, id: `p${pageNumber}g${i + 1}` }));
}
