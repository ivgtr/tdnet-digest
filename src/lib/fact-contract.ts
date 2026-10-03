import type { TableEvidence } from './numeric-evidence';
import type { DocumentType } from './document-type';
export const FACT_SCHEMA_VERSION = 4;
export type FactPeriodKind =
  | 'fullYear'
  | 'cumulativeQ1'
  | 'cumulativeQ2'
  | 'cumulativeQ3'
  | 'standaloneQ1'
  | 'standaloneQ2'
  | 'standaloneQ3'
  | 'standaloneQ4'
  | 'month'
  | 'eventDate'
  | 'interval'
  | 'relativeYear'
  | 'none';
export interface FactSemantics {
  subject: string | null;
  scope: string | null;
  basis: string | null;
  periodKind: FactPeriodKind;
  metricKind: 'amount' | 'rate' | 'perShare' | 'count' | 'other' | 'none';
  qualifiers: string[];
  state:
    | 'actual'
    | 'forecast'
    | 'forecastBefore'
    | 'forecastAfter'
    | 'planned'
    | 'decided'
    | 'contracted'
    | 'completed'
    | 'unspecified';
  polarity: 'affirmative' | 'negative' | 'mixed';
  conditions: string[];
}
export type CandidateSemantics = Omit<FactSemantics, 'qualifiers' | 'conditions'> & {
  qualifiers: string[] | null;
  conditions: string[] | null;
};
export type CandidateFact = Omit<VerifiedFact, 'semantics'> & { semantics: CandidateSemantics };
export type FactEvidence =
  | (TableEvidence & { kind: 'table'; scopeIds: string[]; qualifierIds: string[] })
  | {
      kind: 'prose';
      blockId: string;
      contextIds: string[];
      scopeIds: string[];
      qualifierIds: string[];
    };
export interface VerifiedFact {
  id: string;
  importance: 'key' | 'detail';
  kind: 'number' | 'range' | 'event' | 'status';
  label: string;
  value: number | null;
  unit: string | null;
  period: string | null;
  valueKind: 'actual' | 'forecast' | 'forecastBefore' | 'forecastAfter' | null;
  column: null;
  statement: string | null;
  page: number;
  quote: string;
  evidence: FactEvidence;
  semantics: FactSemantics;
  quantity:
    | { raw: string; decimal: string; sourceIds: string[] }
    | { raw: string; decimal: null; lower: string; upper: string; sourceIds: string[] }
    | null;
  dateRoles: Array<{ date: string; state: string; sourceId: string }> | null;
}
export interface FactSummary {
  version: number;
  documentType: DocumentType;
  facts: VerifiedFact[];
  unverified: string[];
}
export const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
export const exact = (v: Record<string, unknown>, keys: string[]) =>
  Object.keys(v).length === keys.length && keys.every((k) => k in v);
/** Browser storage may reorder object keys. Array order and exact values remain significant. */
export function canonicalJSON(value: unknown): string {
  const canonical = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canonical)
      : record(v)
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, canonical(v[k])])
          )
        : v;
  return JSON.stringify(canonical(value));
}
export function stableFactId(fact: Omit<VerifiedFact, 'id'>): string {
  const text = canonicalJSON([
    fact.kind,
    fact.value,
    fact.unit,
    fact.valueKind,
    fact.statement,
    fact.page,
    fact.label,
    fact.period,
    fact.evidence,
    fact.semantics,
    fact.quote,
    fact.quantity,
    fact.dateRoles,
  ]);
  let hash = 14695981039346656037n;
  for (const char of text)
    hash = BigInt.asUintN(64, (hash ^ BigInt(char.codePointAt(0)!)) * 1099511628211n);
  return `fact-${hash.toString(16).padStart(16, '0')}`;
}
export const SEMANTIC_KEYS = [
  'subject',
  'scope',
  'basis',
  'periodKind',
  'metricKind',
  'qualifiers',
  'state',
  'polarity',
  'conditions',
];
export function checkSemantics<Derived extends boolean = false>(
  value: unknown,
  allowDerived?: Derived
): asserts value is Derived extends true ? CandidateSemantics : FactSemantics {
  if (
    !record(value) ||
    !exact(value, SEMANTIC_KEYS) ||
    !['subject', 'scope', 'basis'].every(
      (k) => value[k] === null || (typeof value[k] === 'string' && !!value[k])
    ) ||
    ![
      'fullYear',
      'cumulativeQ1',
      'cumulativeQ2',
      'cumulativeQ3',
      'standaloneQ1',
      'standaloneQ2',
      'standaloneQ3',
      'standaloneQ4',
      'month',
      'eventDate',
      'interval',
      'relativeYear',
      'none',
    ].includes(String(value.periodKind)) ||
    !['amount', 'rate', 'perShare', 'count', 'other', 'none'].includes(String(value.metricKind)) ||
    ![
      'actual',
      'forecast',
      'forecastBefore',
      'forecastAfter',
      'planned',
      'decided',
      'contracted',
      'completed',
      'unspecified',
    ].includes(String(value.state)) ||
    !['affirmative', 'negative', 'mixed'].includes(String(value.polarity)) ||
    !['qualifiers', 'conditions'].every(
      (k) =>
        (allowDerived && value[k] === null) ||
        (Array.isArray(value[k]) &&
          (value[k] as unknown[]).length <= 12 &&
          (value[k] as unknown[]).every((x) => typeof x === 'string' && !!x && x.length < 500))
    )
  )
    throw new Error('意味属性の形式が不正です');
}
