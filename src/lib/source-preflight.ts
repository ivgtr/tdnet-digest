import type { ExtractedPage } from '@/types/summaryMetadata';
import type { DocumentType } from './document-type';
import type { DocumentContext } from './document-context';
import { coverageReport, revisionMetricLabel } from './fact-coverage';
import {
  parseExactNumeric,
  quantityNumber,
  declaredQuantityUnit,
  proseQuantities,
} from './quantity';
import { verifyTableEvidence, verifyProseQuantity, verifyProsePeriod } from './numeric-evidence';
import { proseReportingMetrics } from './metric-semantics';
import { continuationSpans, continuationPage } from './document-links';
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
      const block = page.blocks.find((b) => b.id === id && b.kind === 'paragraph');
      if (block) {
        const serialized = source.pages
          .find((p: { page: number }) => p.page === page.pageNumber)
          ?.blocks.find((b: { id: string }) => b.id === id);
        if (!serialized?.assertions?.length) return `${id}:入力に主張範囲がありません`;
        const numeric =
          slot.expected.kind === 'number' ||
          slot.expected.kind === 'range' ||
          ['amount', 'rate', 'perShare', 'count'].includes(slot.expected.metricKind ?? '');
        if (!numeric) return null;
        const metric = slot.requirement.match(
          /revenue|operatingProfit|ordinaryProfit|netProfit|1株当たり利益/
        )?.[0];
        const binding = context.bindings.find((b) => b.anchorId === id)!;
        const labels = slot.expected.label
          ? [slot.expected.label]
          : proseReportingMetrics(
              block.text,
              '株式の取得価額の総額|取得価額の総額|取得する株式の総数',
              binding.declarations
                .filter((d) => d.role === 'subject' || d.role === 'scope')
                .map((d) => d.value)
            )
              .map((m) => m.label)
              .filter((label) => !metric || revisionMetricLabel(label) === metric);
        if (!labels.length) return `${id}:必要な本文指標を確認できません`;
        for (const label of labels) {
          for (const quantity of proseQuantities(block)) {
            const parsed = parseExactNumeric(quantity.raw),
              value =
                parsed?.kind === 'range' ? null : parsed && quantityNumber(parsed.decimal)?.value;
            if (
              !parsed?.unit ||
              (parsed.kind === 'number' && value === null) ||
              value === undefined ||
              !serialized.quantities.some((q: { id: string }) => q.id === quantity.id)
            )
              continue;
            try {
              const claim = {
                label,
                value,
                range: parsed.kind === 'range',
                unit: parsed.unit,
                period: slot.expected.period ?? '',
                valueKind: slot.expected.state ?? 'actual',
                subject: slot.expected.subject ?? null,
                scope: slot.expected.scope ?? null,
              };
              const inherited = binding.contextIds
                .map(
                  (id) =>
                    pages.flatMap((p) => [...p.spans, ...p.blocks]).find((s) => s.id === id)!.text
                )
                .join('');
              if (slot.expected.period) verifyProsePeriod(claim, block.text, inherited);
              const proof = verifyProseQuantity(page, block.text, claim);
              if (proof.start === quantity.start && proof.raw === quantity.raw) return null;
            } catch {
              /* Other quantities in this assertion may belong to another metric. */
            }
          }
        }
        return `${id}:必要な本文数量を検証可能な形で選択できません`;
      }
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
      const parsed = parseExactNumeric(q.text),
        value = parsed?.kind === 'range' ? null : parsed && quantityNumber(parsed.decimal)?.value;
      if (!parsed || value === undefined || (parsed.kind === 'number' && value === null))
        return `${id}:原文の数量を表現できません`;
      const unit =
        hint.unitIds.includes(id) && parsed?.unit
          ? parsed.unit
          : declaredQuantityUnit(text(hint.unitIds));
      if (!unit) return `${id}:単位の役割を確認できません`;
      try {
        verifyTableEvidence(
          continuationPage(pages, page, id),
          hint,
          {
            label: text(hint.metricIds),
            value,
            range: parsed.kind === 'range',
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
