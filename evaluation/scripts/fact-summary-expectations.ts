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
