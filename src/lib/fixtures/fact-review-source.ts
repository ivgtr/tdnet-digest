import { textPage, layoutPage, numberCandidate } from './v4-test-source';
import { buildDocumentContext, bindingFor, resolveScopeIds } from '../document-context';
import { parseFactSummary } from '../fact-summary';
import { parseExactQuantity, quantityNumber } from '../quantity';
import type { TableMapping } from '../source-mappings';
import type { VerifiedFact } from '../fact-contract';
/** Deliberately forged persisted range for shape-vs-source rejection tests. */
export function forgedProvenance(f: VerifiedFact, pages: ReturnType<typeof textPage>[]) {
  if (f.evidence.kind !== 'prose') throw new Error('expected prose');
  const ev = f.evidence,
    block = pages.find((p) => p.pageNumber === f.page)!.blocks.find((b) => b.id === ev.blockId)!;
  return {
    tableId: null,
    assertion: {
      id: ev.assertionId,
      blockId: ev.blockId,
      start: 0,
      end: block.text.normalize('NFKC').length,
    },
    quantityRange: { id: ev.quantityId!, start: 0, end: 1 },
    denominator: null,
    adjustments: [],
  };
}

export const period = '2027年3月期';
export function prose(body: string, value = 100) {
  const pages = [textPage(`会社名 株式会社テスト\n${period} 業績予想\n${body}`)];
  const f = numberCandidate(pages[0], '売上高', value, period);
  f.semantics.scope = f.semantics.basis = null;
  f.valueKind = f.semantics.state = 'forecast';
  return { pages, f };
}
export function evidence(f: VerifiedFact, pages: ReturnType<typeof textPage>[]) {
  const binding = bindingFor(
    buildDocumentContext(pages),
    f.evidence.kind === 'prose' ? f.evidence.blockId : f.evidence.valueId
  );
  f.evidence.contextIds = binding.contextIds;
  f.evidence.scopeIds = resolveScopeIds(binding, f.semantics, true);
  return f;
}
export function saved(
  facts: VerifiedFact[],
  pages: ReturnType<typeof textPage>[],
  type: 'other' | 'earnings' = 'other',
  coverage = false
) {
  return parseFactSummary(
    JSON.stringify({ version: 5, documentType: type, facts, unverified: [] }),
    type,
    pages,
    coverage
  );
}
export function report(extra = '') {
  const pages = [
    textPage(
      `${period} 決算短信〔日本基準〕（連結）\n会社名 株式会社テスト\n${['売上高', '営業利益', '当期純利益'].map((m) => `${period}の${m}は100百万円です。`).join('\n')}${extra ? `\n${extra}` : ''}`
    ),
  ];
  const amounts = ['売上高', '営業利益', '当期純利益'].map((m) =>
    numberCandidate(pages[0], m, 100, period)
  );
  return { pages, amounts };
}

export function event(f: VerifiedFact) {
  const e = structuredClone(f);
  e.kind = 'event';
  e.label = e.statement = e.quote;
  e.value = e.unit = e.valueKind = e.period = null;
  e.quantity = null;
  if (e.evidence.kind === 'prose') e.evidence.quantityId = null;
  e.semantics.metricKind = 'none';
  e.semantics.periodKind = 'none';
  return e;
}

export function assertionCandidate(
  body: string,
  state: VerifiedFact['semantics']['state'],
  polarity: VerifiedFact['semantics']['polarity'],
  kind: 'event' | 'status' = 'event'
) {
  const pages = [textPage(`会社名 株式会社テスト\n1. 事業説明\n${body}`)];
  const f = event(numberCandidate(pages[0], body.startsWith('当社') ? '当社' : '売上高'));
  f.kind = kind;
  f.semantics.scope = f.semantics.basis = null;
  f.semantics.state = state;
  f.semantics.polarity = polarity;
  return { pages, f };
}

export function cells(rows: [string, number, number, number][], n: number) {
  return layoutPage(
    rows.map(([text, x, y, width], i) => ({ id: `x${i}`, text, x, y, width, height: 10 })),
    n
  );
}

/** Table amount fixtures read source geometry; expected reporting meaning stays explicit. */
export function tableAmount(
  pages: ReturnType<typeof textPage>[],
  mapping: TableMapping,
  meaning: {
    period: string;
    subject: string;
    scope: string | null;
    basis: string | null;
    state: NonNullable<VerifiedFact['valueKind']>;
  }
): VerifiedFact {
  const page = pages.find((p) => p.quantities.some((q) => q.id === mapping.valueId))!;
  const quantity = parseExactQuantity(page.quantities.find((q) => q.id === mapping.valueId)!.text)!;
  const text = (ids: string[]) =>
    ids.map((id) => pages.flatMap((p) => p.spans).find((s) => s.id === id)!.text).join('');
  const fact = numberCandidate(
    page,
    text(mapping.metricIds),
    quantityNumber(quantity.decimal)!.value!,
    meaning.period
  );
  fact.unit = quantity.unit ?? text(mapping.unitIds);
  fact.valueKind = meaning.state;
  Object.assign(fact.semantics, {
    subject: meaning.subject,
    scope: meaning.scope,
    basis: meaning.basis,
    state: meaning.state,
  });
  fact.evidence = { kind: 'table', ...mapping, scopeIds: [], qualifierIds: [] };
  return fact;
}
