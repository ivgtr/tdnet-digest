import type { ExtractedPage } from '@/types/summaryMetadata';
import type { DocumentType } from './document-type';
import type { DocumentContext } from './document-context';
import { coverageReport } from './fact-coverage';
import { parseExactQuantity, quantityNumber, declaredQuantityUnit } from './quantity';
import { verifyTableEvidence } from './numeric-evidence';
import { continuationSpans } from './document-links';
/** Required source choices must survive serialization before spending a generation attempt. */
export function preflightCandidateSource(
  type: DocumentType,
  pages: ExtractedPage[],
  context: DocumentContext,
  input: string
): void {
  const source = JSON.parse(input);
  const failures: string[] = [];
  for (const slot of coverageReport(type, pages, [], [], context).filter(
    (s) => s.status !== 'outsideSelection'
  )) {
    if (!slot.sourceIds.length) {
      failures.push(`${slot.requirement}:原文の根拠対応が未解決`);
      continue;
    }
    const issues = slot.sourceIds.map((id) => {
      if (!source.unitContexts[id]) return `${id}:入力に適用文脈がありません`;
      const page = pages.find(
        (p) =>
          p.selection === 'selected' &&
          (p.quantities.some((q) => q.id === id) || p.blocks.some((b) => b.id === id))
      );
      if (!page) return `${id}:選択した原文がありません`;
      if (page.blocks.some((b) => b.id === id && b.kind === 'paragraph')) return null;
      const mappings = context.tableMappings.filter((h) => h.valueId === id);
      if (mappings.length !== 1) return `${id}:表の根拠対応が一意ではありません`;
      const q = source.pages
        .find((p: { page: number }) => p.page === page.pageNumber)
        ?.quantities.find((q: { id: string }) => q.id === id);
      if (!q || typeof q.tableId !== 'string') return `${id}:入力の数量・表所属がありません`;
      if (q.eligibility?.status !== 'selectable')
        return `${id}:${q.eligibility?.reason ?? '数量の検証可能性がありません'}`;
      const hint = mappings[0],
        spans = continuationSpans(pages, page, id);
      const text = (ids: string[]) =>
        ids.map((id) => spans.find((s) => s.id === id)!.text).join('');
      const parsed = parseExactQuantity(q.text),
        value = parsed && quantityNumber(parsed.decimal)?.value;
      if (value === null || value === undefined) return `${id}:確定数量を表現できません`;
      const unit =
        hint.unitIds.includes(id) && parsed?.unit
          ? parsed.unit
          : declaredQuantityUnit(text(hint.unitIds));
      if (!unit) return `${id}:単位の役割を確認できません`;
      try {
        verifyTableEvidence(
          { ...page, spans },
          hint,
          {
            label: text(hint.metricIds),
            value,
            unit,
            period: slot.expected.period ?? '',
            valueKind: slot.expected.state ?? 'actual',
          },
          !!slot.expected.period &&
            ['actual', 'forecast', 'forecastBefore', 'forecastAfter'].includes(
              slot.expected.state ?? ''
            )
        );
        return null;
      } catch (error) {
        return `${id}:${error instanceof Error ? error.message : String(error)}`;
      }
    });
    if (issues.every((i) => i !== null)) failures.push(`${slot.requirement}:${issues.join(' / ')}`);
  }
  if (failures.length)
    throw new Error(
      `SOURCE_PREFLIGHT:重要事実を生成入力から検証可能な形で選べません: ${failures.join(' / ')}`
    );
}
