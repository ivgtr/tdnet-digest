import type { ExtractedPage } from '@/types/summaryMetadata';
import { buildSourceLedger, validateSourceLedger, type SourceLedger } from './source-ledger';
import { sameSourceLedgerContent } from './source-ledger-identity';
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
import { reportingMetricKey } from './metric-semantics';
import { declaredForecastFactIds } from './fact-coverage';
import {
  earningsTarget,
  matchesEarningsTarget,
  compareEarningsFacts,
  earningsMetricKey,
} from './summary-earnings-policy';
import { companyExcerpt } from './summary-company-excerpt';
import { unchangedForecastTopic } from './forecast-revision-semantics';
import { sourceInventory, paragraphGroups, type SourceExcerpt } from './summary-source-inventory';
import { narrativeValues, parseNarrativeQuantity, type NarrativeValue } from './summary-narrative';
import {
  emptyOrganization,
  validateOrganization,
  type SummaryOrganization,
} from './summary-organization';

export interface SummarySection {
  title: string;
  factIds: string[];
  excerptIds: string[];
  highlights: string[];
}
export interface SummaryPresentation {
  version: 7;
  sourceHash: string;
  overview: string[];
  sections: SummarySection[];
  excerpts: SourceExcerpt[];
  values: NarrativeValue[];
  organization: SummaryOrganization;
  /** Complete extracted source, independent of display selection or semantic acceptance. */
  sourceLedger?: SourceLedger;
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
  return composePresentation(
    facts,
    excerpts,
    narrativeValues(facts, pages, excerpts),
    facts.documentType === 'earnings' ? declaredForecastFactIds(pages, facts.facts) : new Set(),
    buildSourceLedger(pages, facts.documentType)
  );
}

function composePresentation(
  facts: FactSummary,
  excerpts: SourceExcerpt[],
  values: NarrativeValue[],
  forecastFactIds: ReadonlySet<string> = new Set(),
  sourceLedger?: SourceLedger
): SummaryPresentation {
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
  const target = facts.documentType === 'earnings' ? earningsTarget(excerpts).target : null;
  const primary = facts.facts
    .filter(
      (f) =>
        numeric(f) &&
        (facts.documentType !== 'earnings' ||
          f.semantics.state !== 'actual' ||
          matchesEarningsTarget(f, target))
    )
    .sort(
      (a, b) =>
        Number(b.semantics.state === preferredState) -
          Number(a.semantics.state === preferredState) ||
        (facts.documentType === 'earnings' ? compareEarningsFacts(a, b) : 0) ||
        Number(b.importance === 'key') - Number(a.importance === 'key') ||
        (b.period ?? '').localeCompare(a.period ?? '')
    );
  if (['earnings', 'earningsRevision'].includes(facts.documentType)) {
    take(
      primary.find(
        (f) =>
          f.semantics.metricKind === 'amount' &&
          reportingMetricKey(f.label) === 'revenue' &&
          f.semantics.state === preferredState
      )
    );
    take(
      primary.find(
        (f) =>
          f.semantics.metricKind === 'amount' &&
          reportingMetricKey(f.label) === 'operatingProfit' &&
          f.semantics.state === preferredState
      )
    );
    take(
      primary.find(
        (f) =>
          f.semantics.metricKind === 'amount' &&
          reportingMetricKey(f.label) === 'ordinaryProfit' &&
          f.semantics.state === preferredState
      )
    );
    if (facts.documentType === 'earnings')
      take(
        primary.find(
          (f) =>
            f.semantics.metricKind === 'amount' &&
            earningsMetricKey(f.label) === 'pretaxProfit' &&
            f.semantics.state === preferredState
        )
      );
    take(
      primary.find(
        (f) =>
          f.semantics.metricKind === 'amount' &&
          reportingMetricKey(f.label) === 'netProfit' &&
          f.semantics.state === preferredState
      )
    );
    if (facts.documentType === 'earnings')
      for (const f of primary.filter(
        (f) =>
          f.semantics.state === 'forecastAfter' &&
          f.semantics.metricKind === 'amount' &&
          forecastFactIds.has(f.id)
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
        if (resultFacts.length) take(resultFacts[0]);
        else {
          const reason = resultExcerpts.find((e) =>
            /要因|寄与|牽引|影響|効果|反動|によ|価格|需要|コスト/.test(e.text)
          );
          if (reason) overview.push(reason.id);
        }
        continue;
      }
    }
    if (verified.length) take(verified[0]);
    else {
      const excerpt = highlights.find(
        (e) =>
          e.role !== 'notes' &&
          e.role !== 'dividend' &&
          explanationRole(e.text) === role &&
          (role !== 'condition' ||
            facts.documentType !== 'earnings' ||
            (['performance', 'outlook', 'operations'].includes(e.role) &&
              /季節|偏る|業績予想|見通し|需要|コスト|為替|原材料|未定|影響/.test(e.text))) &&
          (facts.documentType !== 'earnings' ||
            /売上|収益|利益|損失|業績|配当|需要|費用|コスト|季節/.test(e.text))
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
          (unchangedForecastTopic(f.statement!) !== null ||
            /修正の有無|変更はありません|上方修正|下方修正/.test(f.statement!))
      )
    );
  if (!overview.length && facts.documentType !== 'earnings')
    take(facts.facts.find((f) => f.importance === 'key'));
  return {
    version: 7,
    sourceHash: hashText(
      canonicalJSON({
        excerpts,
        values,
        ...(sourceLedger ? { ledgerHash: sourceLedger.sourceHash } : {}),
      })
    ),
    overview,
    sections: sections.filter((s) => s.factIds.length || s.excerptIds.length),
    excerpts,
    values,
    organization: emptyOrganization(),
    ...(sourceLedger ? { sourceLedger } : {}),
  };
}

/** Storage integrity, not a second proof of PDF meaning. */
export function validatePresentation(
  value: unknown,
  facts: FactSummary
): asserts value is SummaryPresentation {
  if (
    !record(value) ||
    !exact(value, [
      'version',
      'sourceHash',
      'overview',
      'sections',
      'excerpts',
      'values',
      'organization',
      ...(Object.prototype.hasOwnProperty.call(value, 'sourceLedger') ? ['sourceLedger'] : []),
    ]) ||
    value.version !== 7 ||
    !Array.isArray(value.overview) ||
    !Array.isArray(value.sections) ||
    !Array.isArray(value.excerpts) ||
    !Array.isArray(value.values)
  )
    throw new Error('要約の表示構成が不正です');
  if (Object.prototype.hasOwnProperty.call(value, 'sourceLedger'))
    validateSourceLedger(value.sourceLedger);
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
  const quantities = new Set<string>();
  for (const q of value.values) {
    const fact = record(q) ? facts.facts.find((f) => f.id === q.id) : undefined;
    const evidenceId =
      fact && (fact.evidence.kind === 'table' ? fact.evidence.valueId : fact.evidence.quantityId);
    const proseBlockId = fact?.evidence.kind === 'prose' ? fact.evidence.blockId : null;
    if (
      !record(q) ||
      !exact(q, [
        'id',
        'raw',
        'decimal',
        'unit',
        'sourceIds',
        ...(fact ? ['sourceQuantityId'] : []),
      ]) ||
      typeof q.id !== 'string' ||
      !(ids.has(q.id) || /^p\d+(?:s\d+|b\d+:q\d+)$/.test(q.id)) ||
      quantities.has(q.id) ||
      typeof q.raw !== 'string' ||
      !q.raw.trim() ||
      !(q.decimal === null || typeof q.decimal === 'string') ||
      !(q.unit === null || typeof q.unit === 'string') ||
      !Array.isArray(q.sourceIds) ||
      !refs(q.sourceIds, sourceIds) ||
      !q.sourceIds.length ||
      (fact &&
        (typeof q.sourceQuantityId !== 'string' ||
          !/^p\d+(?:s\d+|b\d+:q\d+)$/.test(q.sourceQuantityId) ||
          (q.sourceQuantityId !== evidenceId &&
            !(
              proseBlockId !== null &&
              (value.excerpts as SourceExcerpt[]).some(
                (excerpt) =>
                  excerpt.blockId === proseBlockId &&
                  excerpt.spanIds.includes(q.sourceQuantityId as string)
              ) &&
              value.values.some(
                (native) =>
                  record(native) &&
                  native.id === q.sourceQuantityId &&
                  !('sourceQuantityId' in native)
              )
            ))))
    )
      throw new Error('保存された表示数量が不正です');
    quantities.add(q.id);
    const rawQuantity = q.raw;
    const literal = parseNarrativeQuantity(rawQuantity);
    const quantityExcerpts = (value.excerpts as SourceExcerpt[]).filter((e) =>
      (q.sourceIds as string[]).includes(e.id)
    );
    const sourceText = quantityExcerpts
      .map((e) => e.text)
      .join(' ')
      .normalize('NFKC');
    const raw = rawQuantity.normalize('NFKC').replace(/\s/g, '');
    const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // A native multiline range can have its bounds in distinct physical rows.
    // Keep both source rows and the complete range; never expose either bound as a scalar.
    const rangeFragments = literal?.kind === 'range' ? raw.split(/[~～〜]/) : [];
    const nativeRange =
      rangeFragments.length === 2 &&
      quantityExcerpts.some((e) => e.spanIds.includes(q.id as string)) &&
      rangeFragments.every((part, index) =>
        new RegExp(
          `(?<![0-9.,])${[...part].map(escape).join('\\s*')}${index === 0 ? '\\s*[~～〜]' : '(?![0-9.,])'}`
        ).test(sourceText)
      );
    if (
      !literal ||
      (literal.kind === 'number' ? literal.decimal : null) !== q.decimal ||
      (literal.unit !== null && literal.unit !== q.unit) ||
      (fact
        ? q.raw !== fact.quantity!.raw + fact.unit || q.unit !== fact.unit
        : !quantityExcerpts.some((e) =>
            e.text.normalize('NFKC').replace(/\s/g, '').includes(raw)
          ) && !nativeRange)
    )
      throw new Error('保存された表示数量と原文が不一致です');
  }
  const expected = composePresentation(
    facts,
    value.excerpts as SourceExcerpt[],
    value.values as NarrativeValue[],
    new Set(),
    value.sourceLedger as SourceLedger | undefined
  );
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
  validateOrganization(
    value.organization,
    facts,
    value.values as NarrativeValue[],
    value.excerpts as SourceExcerpt[]
  );
}

export function revalidatePresentation(
  value: unknown,
  facts: FactSummary,
  pages: ExtractedPage[]
): SummaryPresentation {
  validatePresentation(value, facts);
  const expected = buildPresentation(facts, pages);
  if (
    canonicalJSON(value.excerpts) !== canonicalJSON(expected.excerpts) ||
    canonicalJSON(value.values) !== canonicalJSON(expected.values) ||
    (value.sourceLedger !== undefined &&
      !sameSourceLedgerContent(value.sourceLedger, expected.sourceLedger!))
  )
    throw new Error('原文引用とPDFが一致しません');
  // Storage-only validation permits headline adjustments. Rechecking the PDF must
  // still reject a stale or adjusted numeric headline from outside its declared unit.
  const actualTarget =
    facts.documentType === 'earnings' ? earningsTarget(expected.excerpts).target : null;
  if (
    facts.documentType === 'earnings' &&
    value.overview.some((id) => {
      const fact = facts.facts.find((fact) => fact.id === id);
      return (
        fact &&
        numeric(fact) &&
        ((fact.semantics.state === 'actual' && !matchesEarningsTarget(fact, actualTarget)) ||
          (fact.semantics.state === 'forecastAfter' && !expected.overview.includes(id)))
      );
    })
  )
    throw new Error('冒頭の数値と原文の報告対象が一致しません');
  return value;
}
