import type { ExtractedPage } from '@/types/summaryMetadata';
import {
  canonicalJSON,
  hashText,
  exact,
  record,
  type FactSummary,
  type VerifiedFact,
} from './fact-contract';
import {
  factRole,
  sectionPolicies,
  explanationRole,
  dividendPaymentExcerpt,
  isSourceMetadata,
  isRoutineExplanation,
} from './summary-content-policy';
import { companyExcerpt } from './summary-company-excerpt';
import { sourceInventory, paragraphGroups, type SourceExcerpt } from './summary-source-inventory';

export interface SummarySection {
  title: string;
  factIds: string[];
  excerptIds: string[];
  highlights: string[];
}
export interface SummaryPresentation {
  version: 2;
  sourceHash: string;
  overview: string[];
  sections: SummarySection[];
  excerpts: SourceExcerpt[];
}
const numeric = (f: VerifiedFact) => f.kind === 'number' || f.kind === 'range';
const anchor = (f: VerifiedFact) =>
  f.evidence.kind === 'prose' ? f.evidence.blockId : f.evidence.valueId;
export class SummarySourceSelectionError extends Error {}

export function buildPresentation(facts: FactSummary, pages: ExtractedPage[]): SummaryPresentation {
  const excerpts = sourceInventory(pages, undefined, facts.documentType);
  const omitted = excerpts.filter(
    (e) => pages.find((p) => p.pageNumber === e.page)!.selection !== 'selected'
  );
  if (omitted.length)
    throw new SummarySourceSelectionError(
      '本文の根拠がスマート抽出の対象外です。全文で再要約してください。'
    );
  return composePresentation(facts, excerpts);
}

function composePresentation(facts: FactSummary, excerpts: SourceExcerpt[]): SummaryPresentation {
  const policies = sectionPolicies(facts.documentType);
  const sections: SummarySection[] = policies.map(([, title]) => ({
    title,
    factIds: [],
    excerptIds: [],
    highlights: [],
  }));
  const group = (role: string) => sections[policies.findIndex(([r]) => r === role)];
  const paragraphs = paragraphGroups(excerpts);
  for (const f of facts.facts) {
    const source = excerpts.find((e) => e.blockId === anchor(f) || e.spanIds.includes(anchor(f)));
    group(factRole(f, facts.documentType, source?.role ?? 'unclassified')).factIds.push(f.id);
  }
  for (const e of excerpts) group(e.role).excerptIds.push(e.id);
  for (const section of sections) {
    const members = section.factIds.map((id) => facts.facts.find((f) => f.id === id)!);
    section.highlights = paragraphs
      .filter((e) => {
        return (
          section.excerptIds.includes(e.id) &&
          e.role !== 'document' &&
          e.role !== 'unclassified' &&
          (explanationRole(e.text) !== null ||
            dividendPaymentExcerpt(e.text) !== null ||
            (e.role !== 'notes' && /。/.test(e.text))) &&
          companyExcerpt(e) !== null &&
          !members.some((f) => f.statement === e.text)
        );
      })
      .map((e) => e.id);
  }

  // Choose different information roles, never the first three facts or the largest values.
  const overview: string[] = [];
  const take = (f: VerifiedFact | undefined) => {
    if (f && !overview.includes(f.id)) overview.push(f.id);
  };
  const preferredState = facts.documentType === 'earningsRevision' ? 'forecastAfter' : 'actual';
  const primary = facts.facts
    .filter(numeric)
    .sort(
      (a, b) =>
        Number(b.semantics.state === preferredState) -
          Number(a.semantics.state === preferredState) ||
        Number(b.importance === 'key') - Number(a.importance === 'key') ||
        (b.period ?? '').localeCompare(a.period ?? '')
    );
  if (['earnings', 'earningsRevision'].includes(facts.documentType)) {
    take(
      primary.find(
        (f) =>
          f.semantics.metricKind !== 'rate' &&
          /^(?:売上高|売上収益|営業収益)$/.test(f.label) &&
          f.valueKind !== 'forecastBefore'
      )
    );
    take(
      primary.find(
        (f) =>
          f.semantics.metricKind === 'amount' &&
          /^(?:営業利益|営業損失)$/.test(f.label) &&
          f.valueKind !== 'forecastBefore'
      )
    );
    take(
      primary.find(
        (f) =>
          f.semantics.metricKind === 'amount' &&
          /^(?:経常利益|経常損失)$/.test(f.label) &&
          f.valueKind !== 'forecastBefore'
      )
    );
    take(
      primary.find(
        (f) =>
          f.semantics.metricKind === 'amount' &&
          /(?:純利益|純損失|当期利益|当期損失)$/.test(f.label) &&
          f.valueKind !== 'forecastBefore'
      )
    );
    if (facts.documentType === 'earnings')
      for (const f of primary.filter(
        (f) => f.semantics.state === 'forecastAfter' && f.semantics.metricKind === 'amount'
      ))
        take(f);
  } else {
    take(
      facts.facts.find(
        (f) => !numeric(f) && factRole(f, facts.documentType, 'unclassified') === 'content'
      )
    );
    const selected = new Set<string>();
    for (const f of primary.filter((f) => f.importance === 'key')) {
      const metric = canonicalJSON([f.label, f.semantics.subject, f.semantics.scope]);
      if (!selected.has(metric)) {
        take(f);
        selected.add(metric);
      }
    }
  }
  const highlights = sections
    .flatMap((s) => s.highlights)
    .map((id) => paragraphs.find((e) => e.id === id)!);
  for (const role of ['reason', 'condition'] as const) {
    const verified = facts.facts.filter(
      (f) =>
        !numeric(f) &&
        explanationRole(f.statement!) === role &&
        !isSourceMetadata(f.statement!) &&
        !isRoutineExplanation(f.statement!) &&
        factRole(
          f,
          facts.documentType,
          excerpts.find((e) => e.blockId === anchor(f))?.role ?? 'unclassified'
        ) !== 'document'
    );
    if (facts.documentType === 'earnings' && role === 'reason') {
      const resultFacts = verified.filter((f) => /減収|減益|増収|増益/.test(f.statement!));
      const resultExcerpts = highlights.filter(
        (e) =>
          e.role === 'performance' &&
          explanationRole(e.text) === role &&
          /減収|減益|増収|増益/.test(e.text)
      );
      if (resultFacts.length || resultExcerpts.length) {
        resultFacts.forEach(take);
        overview.push(...resultExcerpts.map((e) => e.id));
        continue;
      }
    }
    if (verified.length) take(verified[0]);
    else {
      const excerpt = highlights.find(
        (e) => e.role !== 'notes' && explanationRole(e.text) === role
      );
      if (excerpt) overview.push(excerpt.id);
    }
  }
  for (const role of ['outlook', 'dividend'] as const)
    take(
      facts.facts.find(
        (f) =>
          !numeric(f) &&
          factRole(
            f,
            facts.documentType,
            excerpts.find((e) => e.blockId === anchor(f))?.role ?? 'unclassified'
          ) === role &&
          /修正の有無|変更はありません|上方修正|下方修正/.test(f.statement!)
      )
    );
  if (!overview.length) take(facts.facts.find((f) => f.importance === 'key'));
  return {
    version: 2,
    sourceHash: hashText(canonicalJSON(excerpts)),
    overview,
    sections: sections.filter((s) => s.factIds.length || s.excerptIds.length),
    excerpts,
  };
}

/** Storage integrity, not a second proof of PDF meaning. */
export function validatePresentation(
  value: unknown,
  facts: FactSummary
): asserts value is SummaryPresentation {
  if (
    !record(value) ||
    !exact(value, ['version', 'sourceHash', 'overview', 'sections', 'excerpts']) ||
    value.version !== 2 ||
    !Array.isArray(value.overview) ||
    !Array.isArray(value.sections) ||
    !Array.isArray(value.excerpts)
  )
    throw new Error('要約の表示構成が不正です');
  const ids = new Set(facts.facts.map((f) => f.id));
  const sourceIds = new Set<string>();
  for (const e of value.excerpts) {
    if (
      !record(e) ||
      !exact(e, ['id', 'page', 'blockId', 'kind', 'text', 'heading', 'spanIds', 'role']) ||
      typeof e.blockId !== 'string' ||
      !/^p\d+b\d+$/.test(e.blockId) ||
      e.id !== `source:${e.blockId}` ||
      sourceIds.has(e.id as string) ||
      !Number.isInteger(e.page) ||
      Number(e.page) < 1 ||
      !e.blockId.startsWith(`p${e.page}b`) ||
      !['paragraph', 'row', 'heading'].includes(String(e.kind)) ||
      typeof e.text !== 'string' ||
      !e.text.trim() ||
      !Array.isArray(e.spanIds) ||
      !e.spanIds.every((id) => typeof id === 'string' && /^p\d+s\d+$/.test(id)) ||
      !sectionPolicies(facts.documentType).some(([role]) => role === e.role) ||
      (e.heading !== null &&
        (!record(e.heading) ||
          !exact(e.heading, ['id', 'text']) ||
          typeof e.heading.id !== 'string' ||
          !/^p\d+b\d+$/.test(e.heading.id) ||
          typeof e.heading.text !== 'string' ||
          !e.heading.text.trim()))
    )
      throw new Error('保存された原文引用が不正です');
    sourceIds.add(e.id as string);
  }
  const refs = (v: unknown, allowed: Set<string>) =>
    Array.isArray(v) &&
    new Set(v).size === v.length &&
    v.every((id) => typeof id === 'string' && allowed.has(id));
  const expected = composePresentation(facts, value.excerpts as SourceExcerpt[]);
  if (
    !refs(
      value.overview,
      new Set([...ids, ...expected.sections.flatMap((section) => section.highlights)])
    )
  )
    throw new Error('冒頭要約の参照が不正です');
  for (const s of value.sections)
    if (
      !record(s) ||
      !exact(s, ['title', 'factIds', 'excerptIds', 'highlights']) ||
      typeof s.title !== 'string' ||
      !s.title.trim() ||
      !refs(s.factIds, ids) ||
      !refs(s.excerptIds, sourceIds) ||
      !refs(s.highlights, new Set(s.excerptIds as string[]))
    )
      throw new Error('本文の参照が不正です');
  const shown = value.sections.flatMap((s) => s.factIds);
  const quoted = value.sections.flatMap((s) => s.excerptIds);
  if (
    shown.length !== ids.size ||
    new Set(shown).size !== ids.size ||
    quoted.length !== sourceIds.size ||
    new Set(quoted).size !== sourceIds.size
  )
    throw new Error('本文に事実・原文引用の欠落または重複があります');
  if (value.sourceHash !== expected.sourceHash)
    throw new Error('保存された原文引用が欠落・変更されています');
  // Headline selection may be adjusted independently; body membership stays deterministic.
  if (canonicalJSON(value.sections) !== canonicalJSON(expected.sections))
    throw new Error('本文の所属が一致しません');
}

export function revalidatePresentation(
  value: unknown,
  facts: FactSummary,
  pages: ExtractedPage[]
): SummaryPresentation {
  validatePresentation(value, facts);
  const expected = buildPresentation(facts, pages);
  if (canonicalJSON(value.excerpts) !== canonicalJSON(expected.excerpts))
    throw new Error('原文引用とPDFが一致しません');
  return value;
}
