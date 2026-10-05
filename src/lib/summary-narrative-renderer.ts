import { NARRATIVE_TOKEN, type NarrativeValue } from './summary-narrative';
import { parseExactRange } from './quantity';

const format = (value: string) =>
  value.replace(
    /^(-?)(\d+)/,
    (_m, sign: string, digits: string) => sign + digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  );

export function literalValue(value: NarrativeValue): string {
  if (value.decimal !== null) return format(value.decimal) + (value.unit ?? '');
  const range = parseExactRange(value.raw)!;
  return `${format(range.lower)}～${format(range.upper)}${value.unit ?? ''}`;
}
function integers(a: string, b: string): { now: bigint; before: bigint; scale: number } {
  const scale = Math.max(a.split('.')[1]?.length ?? 0, b.split('.')[1]?.length ?? 0);
  const integer = (s: string) => {
    const [whole, fraction = ''] = s.split('.');
    return BigInt(whole + fraction.padEnd(scale, '0'));
  };
  return { now: integer(a), before: integer(b), scale };
}
function difference(current: NarrativeValue, reference: NarrativeValue): string {
  const { now, before, scale } = integers(current.decimal!, reference.decimal!);
  const delta = now - before;
  const digits = (delta < 0n ? -delta : delta).toString().padStart(scale + 1, '0');
  const decimal = scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits;
  return `${delta > 0n ? '+' : delta < 0n ? '−' : ''}${format(decimal)}${current.unit}`;
}
export function quantityChange(
  current: NarrativeValue,
  reference: NarrativeValue,
  metric: string
): string {
  const { now, before } = integers(current.decimal!, reference.decimal!);
  const direction = now > before ? 'up' : now < before ? 'down' : 'same';
  if (metric === 'flow')
    return `${{ up: '↑増加', down: '↓減少', same: '→横ばい' }[direction]}（${difference(current, reference)}）`;
  if (metric === 'profit') {
    if (before < 0n && now > 0n) return '↑黒字転換';
    if (before >= 0n && now < 0n) return '↓赤字転落';
    if (before < 0n && now === 0n) return '↑赤字解消';
  }
  if (metric === 'loss') {
    if (now < 0n || before < 0n)
      throw new Error('NARRATIVE_COMPARISON:損失額は正の大きさで比較してください');
    const label =
      direction === 'same' ? '→損失額横ばい' : direction === 'up' ? '↓損失拡大' : '↑損失縮小';
    if (before === 0n) return `${label}（率算出不可：比較値ゼロ）`;
    const delta = now - before;
    const magnitude = delta < 0n ? -delta : delta;
    const tenths = (magnitude * 1000n + before / 2n) / before;
    return `${label} 約${delta > 0n ? '+' : delta < 0n ? '−' : ''}${tenths / 10n}.${tenths % 10n}%（損失額）`;
  }
  const loss = metric === 'profit' && before < 0n && now < 0n;
  const label =
    direction === 'same'
      ? '→横ばい'
      : loss
        ? direction === 'up'
          ? '↑赤字縮小'
          : '↓赤字拡大'
        : metric === 'profit'
          ? direction === 'up'
            ? '↑増益'
            : '↓減益'
          : metric === 'revenue'
            ? direction === 'up'
              ? '↑増収'
              : '↓減収'
            : direction === 'up'
              ? '↑増加'
              : '↓減少';
  if (before === 0n) return `${label}（率算出不可：比較値ゼロ）`;
  if (!loss && (before < 0n || now < 0n)) return `${label}（${difference(current, reference)}）`;
  const abs = (v: bigint) => (v < 0n ? -v : v);
  const delta = loss ? abs(now) - abs(before) : now - before;
  const tenths = (abs(delta) * 1000n + abs(before) / 2n) / abs(before);
  const magnitude = tenths === 0n && delta !== 0n ? '0.1%未満' : `${tenths / 10n}.${tenths % 10n}%`;
  return `${label} 約${delta > 0n ? '+' : delta < 0n ? '−' : ''}${magnitude}${loss ? '（赤字額）' : ''}`;
}
/** Meaning of the selected pair is checked separately against its cited source. */
export function renderNarrativeText(text: string, values: NarrativeValue[]): string {
  const registry = new Map(values.map((v) => [v.id, v]));
  return text.replace(NARRATIVE_TOKEN, (_m, kind: string, args: string) => {
    if (kind === 'value') return literalValue(registry.get(args)!);
    const [current, reference, metric] = args.split('|');
    return kind === 'delta'
      ? difference(registry.get(current)!, registry.get(reference)!)
      : quantityChange(registry.get(current)!, registry.get(reference)!, metric);
  });
}
