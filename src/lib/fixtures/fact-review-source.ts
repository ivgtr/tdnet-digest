import { textPage, layoutPage, numberCandidate } from './v4-test-source';
import { buildDocumentContext, bindingFor, resolveScopeIds } from '../document-context';
import { parseFactSummary } from '../fact-summary';
import type { VerifiedFact } from '../fact-contract';

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
    JSON.stringify({ version: 4, documentType: type, facts, unverified: [] }),
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
  e.semantics.metricKind = 'none';
  e.semantics.periodKind = 'none';
  return e;
}

export function cells(rows: [string, number, number, number][], n: number) {
  return layoutPage(
    rows.map(([text, x, y, width], i) => ({ id: `x${i}`, text, x, y, width, height: 10 })),
    n
  );
}
