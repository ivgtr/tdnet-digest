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
  expectedRanges?: Array<
    Omit<Expected, 'variants' | 'adjustmentBasis'> & {
      lower: number;
      upper: number;
      unit: string;
      page: number;
    }
  >;
  publishedDate?: string;
  code?: string;
  sourceHash?: string;
  forbidden?: Array<{ label: string; value: number; period: string; state: string }>;
  expectedEvidence?: {
    page: number;
    blockId: string;
    alternatives?: { page: number; blockId: string }[];
    kind: string;
    semantics: Partial<VerifiedFact['semantics']>;
  }[];
  expectedConditions?: { page: number; text: string }[];
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
          fact.kind === expected.kind &&
          fact.evidence.kind === 'prose' &&
          [expected, ...(expected.alternatives ?? [])].some(
            (source) =>
              fact.page === source.page &&
              fact.evidence.kind === 'prose' &&
              fact.evidence.blockId === source.blockId
          ) &&
          attributesMatch(fact, expected.semantics)
      )
    )
      errors.push(`完結した原文の重要事項が不足: p.${expected.page} ${expected.blockId}`);
  }
  for (const expected of item.expectedRanges ?? []) {
    if (
      !result.facts.some(
        (fact) =>
          fact.kind === 'range' &&
          expected.labels.some((label) => compact(fact.label) === compact(label)) &&
          expected.periods.some((period) => compact(fact.period ?? '') === compact(period)) &&
          attributesMatch(fact, expected.semantics) &&
          fact.page === expected.page &&
          compact(fact.unit ?? '') === compact(expected.unit) &&
          fact.quantity &&
          'lower' in fact.quantity &&
          Number(fact.quantity.lower) === expected.lower &&
          Number(fact.quantity.upper) === expected.upper
      )
    )
      errors.push(
        `意味を保った重要範囲が不足: ${expected.labels.join('/')} ${expected.lower}～${expected.upper}${expected.unit}`
      );
  }
  for (const expected of item.expectedConditions ?? []) {
    if (
      !result.facts.some(
        (fact) =>
          fact.page === expected.page &&
          (fact.semantics.conditions?.some(
            (condition) => compact(condition) === compact(expected.text)
          ) ||
            ((fact.kind === 'event' || fact.kind === 'status') &&
              compact(fact.statement ?? '').includes(compact(expected.text))))
      )
    )
      errors.push(`原文の重要条件が不足: p.${expected.page} ${expected.text}`);
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
/** Keep the strict verdict while separating independently missing facts from
 * residual rejection diagnostics. Candidate importance/kind never define this oracle.
 */
export function independentAssessment(
  item: Case,
  result: { facts: VerifiedFact[]; unverified?: string[] }
) {
  const missingFacts = expectedErrors(item, { facts: result.facts });
  return {
    missingFacts,
    diagnostics: result.unverified ?? [],
    importantFactsSatisfied: missingFacts.length === 0,
    strictSuccess: missingFacts.length === 0 && !result.unverified?.length,
  };
}
/** A fact's value, metric and meaning must appear together in one visible item or table row/context. */
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
    const numeric = f.kind === 'number' || f.kind === 'range';
    const value =
      f.kind === 'number'
        ? f.quantity!.decimal
        : f.kind === 'range' && 'lower' in f.quantity!
          ? `${f.quantity!.lower}～${f.quantity!.upper}`
          : (() => {
              const original = compact(f.statement!);
              const note = original.match(
                /^\(?注\)?直近に公表されている(配当予想|業績予想)からの修正の有無[:：]?無$/
              );
              const body =
                f.kind === 'event' &&
                f.semantics.polarity === 'negative' &&
                f.semantics.conditions.length === 0 &&
                /^[^。]*業績予想[^。]*(?:修正は行っておりません|修正を行っておりません|変更はありません)。?$/.test(
                  original
                );
              return note ? `${note[1]}：変更なし` : body ? '業績予想：変更なし' : f.statement!;
            })();
    const required = [
      value,
      ...(numeric ? [f.unit] : []),
      ...(f.kind === 'number' || f.kind === 'range' ? [f.label] : []),
      f.semantics.subject,
      f.semantics.scope,
      f.semantics.basis,
      f.period,
      ...(f.kind === 'number' || f.kind === 'range'
        ? f.semantics.state === 'unspecified'
          ? []
          : [stateLabels[f.semantics.state]]
        : []),
      `p.${f.page}`,
      ...f.semantics.qualifiers,
      ...f.semantics.conditions,
      ...(f.semantics.periodKind.startsWith('cumulativeQ') && !/中間期/.test(f.period ?? '')
        ? ['累計']
        : []),
      ...(f.semantics.periodKind.startsWith('standaloneQ') ? ['単独'] : []),
      ...(f.provenance?.adjustments.map((a) => basisLabels[a.basis]) ?? []),
      ...(/配当予想の変更はありません/.test(compact(f.quote)) &&
      f.semantics.metricKind === 'perShare'
        ? ['配当予想の変更なし']
        : []),
    ]
      .filter((v): v is string => !!v)
      .map(compact);
    return lines.some((line) =>
      required.every((term) =>
        compact(line)
          .replace(/(?<=\d),(?=\d)/g, '')
          .includes(term)
      )
    )
      ? []
      : [`表示の数値・指標・期間・意味が同一項目に揃いません: ${f.id} ${f.label}`];
  });
}
