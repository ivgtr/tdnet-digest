import type { VerifiedFact } from '../../src/lib/fact-contract';
import type { DocumentType } from '../../src/lib/document-type';
export interface Expected {
  labels: string[];
  periods: string[];
  variants: { value: number; unit: string; page: number }[];
  semantics: Partial<VerifiedFact['semantics']>;
}
export interface Case {
  id: string;
  title: string;
  documentType: DocumentType;
  url: string;
  expected: Expected[];
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
export function expectedErrors(item: Case, result: { facts: VerifiedFact[] }): string[] {
  const errors: string[] = [];
  for (const expected of item.expected) {
    if (
      !result.facts.some(
        (fact) =>
          fact.kind === 'number' &&
          expected.labels.some((label) => compact(fact.label) === compact(label)) &&
          expected.periods.some((period) => compact(fact.period ?? '') === compact(period)) &&
          attributesMatch(fact, expected.semantics) &&
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
  return errors;
}
