import type { ExtractedPage } from '@/types/summaryMetadata';
import {
  canonicalJSON,
  hashText,
  exact,
  record,
  type FactSummary,
  type VerifiedFact,
} from './fact-contract';
import { CONTENT_TITLES } from './summary-content-policy';
import { sourceInventory, type SourceExcerpt } from './summary-source-inventory';

export interface SummarySection {
  title: string;
  factIds: string[];
  excerptIds: string[];
}
export interface SummaryPresentation {
  version: 1;
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
  const excerpts = sourceInventory(pages);
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
  const sections: SummarySection[] = [];
  const group = (title: string) => {
    let section = sections.find((s) => s.title === title);
    if (!section) {
      section = { title, factIds: [], excerptIds: [] };
      sections.push(section);
    }
    return section;
  };
  for (const f of facts.facts) {
    const source = excerpts.find((e) => e.blockId === anchor(f));
    const title =
      source?.heading?.text ??
      (numeric(f)
        ? /配当/.test(f.label)
          ? '配当'
          : f.valueKind === 'actual'
            ? '実績'
            : f.valueKind === 'forecastBefore'
              ? '修正前予想'
              : f.valueKind === 'forecastAfter'
                ? '修正後予想'
                : f.valueKind === 'forecast'
                  ? '会社予想'
                  : CONTENT_TITLES[facts.documentType]
        : '会社の説明・条件');
    group(title).factIds.push(f.id);
  }
  for (const e of excerpts) group(e.heading?.text ?? '開示本文・補足').excerptIds.push(e.id);

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
        Number(b.importance === 'key') - Number(a.importance === 'key')
    );
  if (['earnings', 'earningsRevision', 'businessUpdate'].includes(facts.documentType)) {
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
          f.semantics.metricKind !== 'rate' &&
          /営業(?:利益|損失)/.test(f.label) &&
          f.valueKind !== 'forecastBefore'
      )
    );
  } else {
    take(facts.facts.find((f) => !numeric(f) && f.semantics.state !== 'unspecified'));
    take(primary.find((f) => f.importance === 'key'));
  }
  take(
    facts.facts.find(
      (f) => !numeric(f) && /修正|変更|理由|要因|影響|条件|予定|可能性|未定/.test(f.statement!)
    )
  );
  if (!overview.length) take(facts.facts.find((f) => f.importance === 'key'));
  return {
    version: 1,
    sourceHash: hashText(canonicalJSON(excerpts)),
    overview,
    sections,
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
    value.version !== 1 ||
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
      !exact(e, ['id', 'page', 'blockId', 'kind', 'text', 'heading']) ||
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
  if (!refs(value.overview, ids)) throw new Error('冒頭要約の参照が不正です');
  for (const s of value.sections)
    if (
      !record(s) ||
      !exact(s, ['title', 'factIds', 'excerptIds']) ||
      typeof s.title !== 'string' ||
      !s.title.trim() ||
      !refs(s.factIds, ids) ||
      !refs(s.excerptIds, sourceIds)
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
  const expected = composePresentation(facts, value.excerpts as SourceExcerpt[]);
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
