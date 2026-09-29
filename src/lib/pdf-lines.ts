import type { TextItem, TextMarkedContent } from 'pdfjs-dist/types/src/display/api';

/**
 * テキストアイテムをY座標でグループ化して行に変換
 * チェーン効果を回避するため、許容誤差を固定値で使用
 */
export function groupTextItemsByY(items: Array<TextItem | TextMarkedContent>): string[] {
  if (items.length === 0) {
    return [];
  }

  const Y_TOLERANCE = 2; // Y座標の許容誤差（ピクセル）
  const lines: Map<number, Array<{ x: number; width: number; text: string }>> = new Map();

  for (const item of items) {
    if (!('str' in item) || !item.str) {
      continue;
    }

    // Y座標を取得（transform[5]がY座標）
    const y = item.transform?.[5] ?? 0;
    const x = item.transform?.[4] ?? 0;

    // 既存の行の中から、Y座標が近い行を探す
    let matchedY: number | null = null;
    for (const existingY of lines.keys()) {
      if (Math.abs(existingY - y) <= Y_TOLERANCE) {
        matchedY = existingY;
        break;
      }
    }

    if (matchedY !== null) {
      // 既存の行に追加
      lines.get(matchedY)!.push({ x, width: item.width ?? 0, text: item.str });
    } else {
      // 新しい行を作成
      lines.set(y, [{ x, width: item.width ?? 0, text: item.str }]);
    }
  }

  // Y座標でソート（上から下へ）して、各行のテキストを結合
  const sortedYs = Array.from(lines.keys()).sort((a, b) => b - a); // 降順（PDFは下が小さい値）
  return sortedYs.map((y) => {
    const items = lines.get(y)!.sort((a, b) => a.x - b.x);
    return items.reduce((line, item, index) => {
      if (index === 0) return item.text;
      const previous = items[index - 1];
      const gap = item.x - previous.x - previous.width;
      return line + (gap <= 1.5 ? '' : ' ') + item.text;
    }, '');
  });
}
