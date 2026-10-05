import { canonicalJSON, type VerifiedFact } from './fact-contract';

export interface SummaryComparison {
  reference: VerifiedFact;
  axis: 'year' | 'revision';
  direction: 'up' | 'down' | 'same';
}

/** Compare exact source decimals; no derived percentage, rounding or range midpoint. */
function compare(a: string, b: string): SummaryComparison['direction'] {
  const scale = Math.max(a.split('.')[1]?.length ?? 0, b.split('.')[1]?.length ?? 0);
  const integer = (value: string) => {
    const [whole, fraction = ''] = value.split('.');
    return BigInt(whole + fraction.padEnd(scale, '0'));
  };
  return integer(a) > integer(b) ? 'up' : integer(a) < integer(b) ? 'down' : 'same';
}

export function summaryComparison(
  current: VerifiedFact,
  facts: VerifiedFact[]
): SummaryComparison | null {
  if (current.kind !== 'number' || current.quantity?.decimal == null) return null;
  const revision = current.semantics.state === 'forecastAfter';
  const year = current.period?.match(/^(20\d{2})年(\d{1,2})月期/);
  if (!revision && (current.semantics.state !== 'actual' || !year)) return null;
  const period = revision
    ? current.period
    : current.period!.replace(year![1]!, String(Number(year![1]) - 1));
  const proof = (f: VerifiedFact) =>
    f.evidence.kind === 'table' ? f.provenance?.tableId : f.provenance?.assertion?.id;
  if (!proof(current)) return null;
  const key = (f: VerifiedFact) =>
    canonicalJSON([
      f.label,
      f.unit,
      f.semantics.subject,
      f.semantics.scope,
      f.semantics.basis,
      f.semantics.periodKind,
      f.semantics.metricKind,
      f.semantics.qualifiers,
      f.semantics.polarity,
      f.semantics.conditions,
      f.provenance?.adjustments,
    ]);
  const references = facts.filter(
    (f) =>
      f.id !== current.id &&
      f.kind === 'number' &&
      f.quantity?.decimal != null &&
      f.period === period &&
      f.semantics.state === (revision ? 'forecastBefore' : 'actual') &&
      f.evidence.kind === current.evidence.kind &&
      proof(f) === proof(current) &&
      key(f) === key(current)
  );
  if (references.length !== 1) return null;
  const reference = references[0]!;
  return {
    reference,
    axis: revision ? 'revision' : 'year',
    direction: compare(current.quantity.decimal, reference.quantity!.decimal!),
  };
}

export function comparisonLabel(current: VerifiedFact, comparison: SummaryComparison): string {
  const { direction, reference, axis } = comparison;
  if (axis === 'revision')
    return { up: '↑上方修正', down: '↓下方修正', same: '→据え置き' }[direction];
  if (direction === 'same') return '→横ばい';
  if (/利益|損失/.test(current.label)) {
    const now = compare(current.quantity!.decimal!, '0');
    const before = compare(reference.quantity!.decimal!, '0');
    // A positive amount labelled as a loss reports its magnitude, not a positive profit.
    if (/損失$/.test(current.label) && now !== 'down' && before !== 'down')
      return direction === 'up' ? '↓損失拡大' : '↑損失縮小';
    if (before === 'down' && now === 'up') return '↑黒字転換';
    if (before === 'up' && now === 'down') return '↓赤字転落';
    if (before === 'down' && now === 'same') return '↑赤字解消';
    if (now === 'down' && before === 'down') return direction === 'up' ? '↑赤字縮小' : '↓赤字拡大';
    return direction === 'up' ? '↑増益' : '↓減益';
  }
  if (/売上高|売上収益|営業収益/.test(current.label)) return direction === 'up' ? '↑増収' : '↓減収';
  return direction === 'up' ? '↑増加' : '↓減少';
}

/** A missing accepted comparison is different from an absent figure in the original PDF. */
export function comparisonIssue(current: VerifiedFact, facts: VerifiedFact[]): string {
  if (current.kind !== 'number' || current.quantity?.decimal == null) return '比較未確認';
  const revision = current.semantics.state === 'forecastAfter';
  const year = current.period?.match(/^(20\d{2})年(\d{1,2})月期/);
  if (!revision && (current.semantics.state !== 'actual' || !year)) return '比較未確認';
  const target = revision
    ? current.period
    : current.period!.replace(year![1]!, String(Number(year![1]) - 1));
  const related = facts.filter(
    (f) =>
      f.id !== current.id &&
      f.label === current.label &&
      f.period === target &&
      f.semantics.state === (revision ? 'forecastBefore' : 'actual')
  );
  if (!related.length) return revision ? '修正前の値が要約に未抽出' : '前年の値が要約に未抽出';
  return '比較条件・根拠の対応が未確認';
}
