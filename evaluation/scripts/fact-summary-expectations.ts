import type { VerifiedFact } from '../../src/lib/fact-contract';
import type { DocumentType } from '../../src/lib/document-type';
export interface Expected {
  labels: string[];
  periods: string[];
  variants: { value: number; unit: string; page: number }[];
  semantics: Partial<VerifiedFact['semantics']>;
  adjustmentBasis?: 'splitAdjusted' | 'beforeSplit' | 'afterSplit';
}
export interface Case {
  id: string;
  title: string;
  documentType: DocumentType;
  url: string;
  expected: Expected[];
  publishedDate?: string;
  code?: string;
  forbidden?: Array<{ label: string; value: number; period: string; state: string }>;
  expectedEvidence?: {
    page: number;
    blockId: string;
    kind: string;
    semantics: Partial<VerifiedFact['semantics']>;
  }[];
}
const compact = (text: string) => text.normalize('NFKC').replace(/\s/g, '');
const attributesMatch = (fact: VerifiedFact, expected: Partial<VerifiedFact['semantics']>) =>
  Object.entries(expected).every(([key, value]) => {
    const actual = fact.semantics[key as keyof VerifiedFact['semantics']];
    if (typeof value === 'string')
      return typeof actual === 'string' && compact(actual) === compact(value);
    if (Array.isArray(value))
      return (
        Array.isArray(actual) &&
        JSON.stringify([...actual].map(compact).sort()) ===
          JSON.stringify([...value].map(compact).sort())
      );
    return actual === value;
  });
export function expectedErrors(
  item: Case,
  result: { facts: VerifiedFact[]; unverified?: string[] }
): string[] {
  const errors: string[] = [];
  for (const expected of item.expected) {
    if (
      !result.facts.some(
        (fact) =>
          fact.kind === 'number' &&
          expected.labels.some((label) => compact(fact.label) === compact(label)) &&
          expected.periods.some((period) => compact(fact.period ?? '') === compact(period)) &&
          attributesMatch(fact, expected.semantics) &&
          (!expected.adjustmentBasis ||
            (fact.provenance?.denominator?.value === 1 &&
              fact.provenance.adjustments.some((a) => a.basis === expected.adjustmentBasis))) &&
          expected.variants.some(
            (v) =>
              fact.value === v.value &&
              compact(fact.unit ?? '') === compact(v.unit) &&
              fact.page === v.page
          )
      )
    )
      errors.push(
        `意味を保った重要事実が不足: ${expected.labels.join('/')} ${expected.periods.join('/')} ${expected.variants.map((v) => v.value + v.unit).join('/')}`
      );
  }
  for (const expected of item.expectedEvidence ?? []) {
    if (
      !result.facts.some(
        (fact) =>
          fact.page === expected.page &&
          fact.kind === expected.kind &&
          fact.evidence.kind === 'prose' &&
          fact.evidence.blockId === expected.blockId &&
          attributesMatch(fact, expected.semantics)
      )
    )
      errors.push(`完結した原文の重要事項が不足: p.${expected.page} ${expected.blockId}`);
  }
  for (const forbidden of item.forbidden ?? [])
    if (
      result.facts.some(
        (f) =>
          compact(f.label) === compact(forbidden.label) &&
          f.value === forbidden.value &&
          compact(f.period ?? '') === compact(forbidden.period) &&
          f.semantics.state === forbidden.state
      )
    )
      errors.push(`禁止する重要数値の対応: ${forbidden.label} ${forbidden.value}`);
  if (result.unverified?.length)
    errors.push(`未確認が残っています: ${result.unverified.join(' / ')}`);
  return errors;
}
/** A fact's value, metric and meaning must appear together in one rendered list item. */
export function renderedFactErrors(facts: VerifiedFact[], lines: string[]): string[] {
  const stateLabels: Record<string, string> = {
    actual: '実績',
    forecast: '予想',
    forecastBefore: '修正前予想',
    forecastAfter: '修正後予想',
    planned: '実施予定',
    decided: '決議・決定',
    contracted: '契約',
    completed: '実施済み',
    unspecified: '状態未特定',
  };
  const basisLabels = {
    splitAdjusted: '株式分割調整済み',
    beforeSplit: '株式分割前',
    afterSplit: '株式分割後',
  };
  return facts.flatMap((f) => {
    const value =
      f.kind === 'number'
        ? `${f.label}:${f.quantity!.decimal}${f.unit}`
        : f.kind === 'range' && 'lower' in f.quantity!
          ? `${f.label}:${f.quantity!.lower}～${f.quantity!.upper}${f.unit}`
          : f.statement!;
    const required = [
      value,
      f.semantics.subject,
      f.semantics.scope,
      f.semantics.basis,
      f.period,
      ...(f.kind === 'number' || f.kind === 'range'
        ? [stateLabels[f.semantics.state], ...(f.semantics.polarity === 'negative' ? ['否定'] : [])]
        : []),
      `PDFp.${f.page}`,
      ...f.semantics.qualifiers,
      ...(f.semantics.periodKind.startsWith('cumulativeQ') ? ['累計'] : []),
      ...(f.semantics.periodKind.startsWith('standaloneQ') ? ['単独'] : []),
      ...(f.provenance?.adjustments.map((a) => basisLabels[a.basis]) ?? []),
      ...(f.provenance?.denominator ? ['1株当たり'] : []),
      ...(/配当予想の変更はありません/.test(compact(f.quote)) &&
      f.semantics.metricKind === 'perShare'
        ? ['配当予想の変更なし']
        : []),
    ]
      .filter((v): v is string => !!v)
      .map(compact);
    return lines.some((line) => required.every((term) => compact(line).includes(term)))
      ? []
      : [`表示の数値・指標・期間・意味が同一項目に揃いません: ${f.id} ${f.label}`];
  });
}
