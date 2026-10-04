import {
  numericValueKind,
  matchesReportingPeriod,
  periodKind,
  reportingPeriodShape,
} from './period-semantics';
import {
  NET_PROFIT_METRIC,
  BASIC_PER_SHARE_PROFIT_METRIC,
  PER_SHARE_PROFIT_METRIC,
  perShareProfitKeys,
} from './metric-semantics';
import { assertionStates, isLossRecordingPlan, lossRecordingPeriods } from './assertion-semantics';
import type { ExtractedPage } from '@/types/summaryMetadata';
import { unchangedDividend, unchangedDividendReference } from './dividend-semantics';
import type { DocumentType } from './document-type';
import type { VerifiedFact } from './fact-contract';
import { tableContinuations, noteLinks, continuationPage } from './document-links';
import {
  compact,
  verifyTableEvidence,
  verifyProseEvidence,
  verifyProsePeriod,
  verifyPeriodAndKind,
} from './numeric-evidence';
import {
  parseExactQuantity,
  parseExactNumeric,
  proseQuantities,
  quantityNumber,
  declaredQuantityUnit,
} from './quantity';
import { sourceDateOptions } from './source-periods';
import { datedStates } from './fact-validation';
import { buildTableMappings, type TableMapping } from './source-mappings';
import {
  buildDocumentContext,
  documentSubject,
  bindingFor,
  isFinancialUnit,
  reportingUnitTitle,
  isReportingCoverUnit,
  isReportingCoverField,
  headingLevel,
  verifyScopeEvidence,
  applicableDeclarations,
  type DocumentContext,
  type ContextBinding,
} from './document-context';
import {
  isPerformanceReportingTitle,
  forecastReportingTitle,
  resolveForecastReportingTitle,
} from './document-structure';
import { normalized, tableHeaderColumns } from './document-structure';
import type { Diagnostic } from './fact-candidates';
import { isPerShareDividend } from './metric-semantics';
import { tableRowAxis, tableRowDeclarations } from './table-layout';

/** Structural proposals use the same complete numeric proof as accepted facts. */
function provedMappedQuantity(
  pages: ExtractedPage[],
  hint: TableMapping,
  claim: { label: string; unit: string; period: string; valueKind: string }
): boolean {
  const page = pages.find((p) => p.quantities.some((q) => q.id === hint.valueId));
  if (!page || page.selection !== 'selected') return false;
  const quantity = parseExactNumeric(page.quantities.find((q) => q.id === hint.valueId)!.text);
  const value =
    quantity?.kind === 'range' ? null : quantity && quantityNumber(quantity.decimal)?.value;
  if (!quantity || value === undefined || (quantity.kind === 'number' && value === null))
    return false;
  try {
    verifyTableEvidence(continuationPage(pages, page, hint.valueId), hint, {
      ...claim,
      value,
      range: quantity.kind === 'range',
    });
    return true;
  } catch {
    return false;
  }
}
function reportedDividends(
  pages: ExtractedPage[],
  selected = pages,
  context = buildDocumentContext(pages)
) {
  const spans = pages.flatMap((p) => p.spans);
  const mappings = buildTableMappings(pages);
  return selected.flatMap((page) => {
    const text = (ids: string[]) => ids.map((id) => spans.find((s) => s.id === id)!.text).join('');
    return mappings
      .filter(
        (h) => page.quantities.some((q) => q.id === h.valueId) && isIssuerSource(h.valueId, context)
      )
      .flatMap((hint) => {
        if (!/配当の状況/.test(compact(text(hint.contextIds)))) return [];
        const unitText = compact(text(hint.unitIds));
        const unit = unitText === '円銭' ? '円' : unitText;
        if (!isPerShareDividend(text(hint.metricIds), unit)) return [];
        const axis = compact(text(hint.periodIds));
        const period = axis.match(/20\d{2}年\d{1,2}月期/)?.[0];
        const state = numericValueKind(axis, text(hint.contextIds));
        if (state !== 'actual' && state !== 'forecast') return [];
        return period &&
          provedMappedQuantity(pages, hint, {
            label: text(hint.metricIds),
            unit,
            period,
            valueKind: state,
          })
          ? [{ period, state, valueId: hint.valueId }]
          : [];
      });
  });
}
export function standardMetric(fact: VerifiedFact): string | null {
  if (!['number', 'range'].includes(fact.kind) || fact.semantics.metricKind !== 'amount')
    return null;
  return standardMetricLabel(fact.label);
}
function standardMetricLabel(source: string): string | null {
  const label = compact(source);
  if (/調整|コア|EBITDA/i.test(label)) return null;
  if (/^(売上高|売上収益|営業収益)$/.test(label)) return 'revenue';
  if (/^営業(?:利益|損失)(?:\(△\))?$/.test(label)) return 'operatingProfit';
  if (new RegExp(`^${NET_PROFIT_METRIC}(?:又は.*)?(?:\\(△\\))?$`).test(label)) return 'netProfit';
  return null;
}
function revisionMetricLabel(label: string): string | null {
  const metric = standardMetricLabel(label);
  if (metric) return metric;
  const text = normalized(label);
  if (/^経常(?:利益|損失)$/.test(text)) return 'ordinaryProfit';
  if (new RegExp(`^${BASIC_PER_SHARE_PROFIT_METRIC}$`, 'i').test(text)) return '1株当たり利益';
  return null;
}
/** A publication table declares its comparative actuals and ordinary forecasts.
 * Keep source roles even if their quantities cannot yet be verified. */
function forecastPublicationSources(pages: ExtractedPage[], context: DocumentContext) {
  const spans = pages.flatMap((p) => p.spans);
  const nodes = new Map(pages.flatMap((p) => [...p.spans, ...p.blocks]).map((s) => [s.id, s.text]));
  const text = (ids: string[]) =>
    normalized(ids.map((id) => spans.find((s) => s.id === id)!.text).join(''));
  const result: Array<{
    valueId: string | null;
    metric: string;
    period: string;
    state: 'actual' | 'forecast';
    attributes: ReportingAttributes | null;
  }> = context.tableMappings.flatMap((h) => {
    if (
      !pages.some(
        (p) => p.selection === 'selected' && p.quantities.some((q) => q.id === h.valueId)
      ) ||
      !isIssuerSource(h.valueId, context) ||
      !isReportingMetricSource(h.valueId, 'forecast', pages, context)
    )
      return [];
    const axis = text(h.periodIds),
      inherited = text(h.contextIds);
    const metric = revisionMetricLabel(text(h.metricIds)),
      period = sourceFiscalPeriod(axis, inherited);
    const state = numericValueKind(axis, inherited);
    if (!metric || !period || (state !== 'actual' && state !== 'forecast')) return [];
    return [
      {
        valueId: h.valueId,
        metric,
        period,
        state: state as 'actual' | 'forecast',
        attributes: reportingAttributesAt(bindingFor(context, h.valueId)),
      },
    ];
  });
  for (const block of issuerBlocks(
    pages.filter((p) => p.selection === 'selected'),
    context
  )) {
    if (
      block.kind !== 'paragraph' ||
      !proseQuantities(block).length ||
      !isReportingMetricSource(block.id, 'forecast', pages, context)
    )
      continue;
    const binding = bindingFor(context, block.id);
    const inherited = normalized(
      binding.contextIds
        .map((id) => pages.flatMap((p) => [...p.spans, ...p.blocks]).find((s) => s.id === id)!.text)
        .join('')
    );
    const own = normalized(block.text);
    const label = own.match(
      new RegExp(
        `(${PER_SHARE_PROFIT_METRIC}|売上高|売上収益|営業収益|営業利益|営業損失|経常利益|経常損失|${NET_PROFIT_METRIC})(?:は|が|について)`,
        'i'
      )
    )?.[1];
    const metric = label && revisionMetricLabel(label),
      period = sourceFiscalPeriod(own, inherited),
      state = numericValueKind(own, inherited);
    if (metric && period && (state === 'actual' || state === 'forecast'))
      result.push({
        valueId: block.id,
        metric,
        period,
        state,
        attributes: reportingAttributesAt(binding),
      });
  }
  // A lost mapping must not remove a declared header's obligation with it.
  const declaredGroups: Array<Pick<(typeof result)[number], 'period' | 'state' | 'attributes'>> =
    [];
  for (const page of pages.filter((p) => p.selection === 'selected'))
    for (const region of page.tableRegions) {
      // Read explicit row declarations, including closed cells with no mapped values.
      const rowAxes = page.quantities
        .filter((q) => region.valueIds.includes(q.id))
        .map((q) => ({ valueId: q.id, parts: tableRowAxis(region, page.spans, q) }));
      const axes = [
        ...tableRowDeclarations(region, page.spans),
        ...rowAxes.map((row) => row.parts),
      ];
      for (const parts of axes) {
        if (!parts.every((s) => region.spanIds.includes(s.id))) continue;
        const axis = normalized(parts.map((s) => s.text).join(''));
        const period = sourceFiscalPeriod(axis, '');
        if (!period) continue;
        const owner = page.blocks.find((b) => parts.some((s) => b.spanIds.includes(s.id)));
        // Use an original row value's binding when the caption belongs to a
        // table rather than a numbered section. This does not consult mappings.
        const quantity = rowAxes.find((row) =>
          parts.every((part) => row.parts.some((s) => s.id === part.id))
        );
        const anchor = quantity?.valueId ?? owner?.id;
        if (
          !anchor ||
          !isIssuerSource(anchor, context) ||
          !isReportingMetricSource(anchor, 'forecast', pages, context)
        )
          continue;
        const binding = bindingFor(context, anchor);
        const inherited = binding.contextIds
          .map((id) => {
            if (!nodes.has(id)) throw new Error(`REFERENCE:原文の文脈 ${id} がありません`);
            return nodes.get(id)!;
          })
          .join('');
        const state = numericValueKind(axis, inherited);
        if (state !== 'actual' && state !== 'forecast') continue;
        declaredGroups.push({
          period,
          state,
          attributes: reportingAttributesAt(binding),
        });
      }
    }
  const groups = [
    ...new Map(
      [...declaredGroups, ...result].map((s) => [
        JSON.stringify([s.period, s.state, s.attributes]),
        s,
      ])
    ).values(),
  ];
  const metricsByPeriod = new Map<string, string[]>();
  for (const s of groups) {
    if (!metricsByPeriod.has(s.period))
      metricsByPeriod.set(s.period, declaredReportingMetrics(pages, context, s.period, 'forecast'));
    for (const metric of metricsByPeriod.get(s.period)!)
      if (
        !result.some(
          (other) =>
            other.metric === metric &&
            other.period === s.period &&
            other.state === s.state &&
            sameReportingAttributes(other.attributes, s.attributes)
        )
      )
        result.push({
          period: s.period,
          state: s.state,
          attributes: s.attributes,
          metric,
          valueId: null,
        });
  }
  return result;
}
const publicationRequirement = (s: ReturnType<typeof forecastPublicationSources>[number]) =>
  `COVERAGE:業績予想公表の重要指標 ${s.metric} 対象期=${s.period} 区分=${s.state}`;
function declaredReportingMetrics(
  pages: ExtractedPage[],
  context: DocumentContext,
  report: string,
  state: 'actual' | 'forecast',
  revision = false
): string[] {
  const declared = new Set(
    revision ? ['revenue', 'operatingProfit'] : ['revenue', 'operatingProfit', 'netProfit']
  );
  for (const page of pages.filter((p) => p.selection === 'selected'))
    for (const region of page.tableRegions) {
      const anchor = region.valueIds[0];
      if (!anchor || !isReportingMetricSource(anchor, state, pages, context)) continue;
      const text = normalized(
        region.spanIds.map((id) => page.spans.find((s) => s.id === id)!.text).join('')
      );
      const binding = bindingFor(context, anchor);
      const inherited = binding.contextIds
        .map((id) => pages.flatMap((p) => p.spans).find((s) => s.id === id)!.text)
        .join('');
      const titlePeriod = sourceFiscalPeriod('', normalized(inherited));
      if (
        (state === 'forecast' && !text.includes(report) && titlePeriod !== report) ||
        (revision && (!/前回|修正前/.test(text) || !/今回|修正後/.test(text)))
      )
        continue;
      if (/経常(?:利益|損失)/.test(text)) declared.add('ordinaryProfit');
      if (/親会社|当期(?:純)?利益|当期純損失/.test(text)) declared.add('netProfit');
      if (
        tableHeaderColumns(
          region,
          page.spans.filter((s) => region.spanIds.includes(s.id))
        ).some((column) =>
          perShareProfitKeys(
            normalized(
              column.metricIds.map((id) => page.spans.find((s) => s.id === id)!.text).join('')
            )
          ).some((key) => key.startsWith('basic:'))
        )
      )
        declared.add('1株当たり利益');
    }
  for (const block of issuerBlocks(
    pages.filter((p) => p.selection === 'selected'),
    context
  )) {
    if (
      block.kind !== 'paragraph' ||
      !proseQuantities(block).length ||
      !isReportingMetricSource(block.id, state, pages, context)
    )
      continue;
    const text = normalized(block.text);
    const inherited = normalized(
      bindingFor(context, block.id)
        .contextIds.map(
          (id) => pages.flatMap((p) => [...p.blocks, ...p.spans]).find((s) => s.id === id)!.text
        )
        .join('')
    );
    if (sourceFiscalPeriod(text, inherited) !== report || /^\(?注\)?|^※/.test(text)) continue;
    if (/(?:^|の)経常(?:利益|損失)(?:は|が|について)/.test(text)) declared.add('ordinaryProfit');
    const eps = text.match(
      new RegExp(`(?:^|の)(${PER_SHARE_PROFIT_METRIC})(?:は|が|について)`, 'i')
    )?.[1];
    if (eps && revisionMetricLabel(eps) === '1株当たり利益') declared.add('1株当たり利益');
  }
  return [...declared];
}
function ownsRequiredNetProfit(
  label: string,
  pages: ExtractedPage[],
  context: DocumentContext,
  state: 'actual' | 'forecast'
): boolean {
  const hasOwner = pages.some((page) =>
    page.tableRegions.some((region) => {
      const anchor = region.valueIds[0];
      return (
        anchor &&
        isReportingMetricSource(anchor, state, pages, context) &&
        /親会社株主に|親会社の所有者に/.test(
          normalized(region.spanIds.map((id) => page.spans.find((s) => s.id === id)!.text).join(''))
        )
      );
    })
  );
  return !hasOwner || /親会社株主に帰属する|親会社の所有者に帰属する/.test(normalized(label));
}
function unchangedDividendSources(
  pages: ExtractedPage[],
  context: DocumentContext,
  report: string
) {
  return pages
    .filter((p) => p.selection === 'selected')
    .flatMap((page) =>
      page.blocks.flatMap((block) => {
        if (
          block.kind !== 'paragraph' ||
          !unchangedDividend(block.text) ||
          !isIssuerSource(block.id, context)
        )
          return [];
        const binding = bindingFor(context, block.id),
          inherited = binding.contextIds
            .map(
              (id) => pages.flatMap((p) => [...p.spans, ...p.blocks]).find((s) => s.id === id)!.text
            )
            .join('');
        if (sourceFiscalPeriod(normalized(block.text), normalized(inherited)) !== report) return [];
        return [
          ...['中間配当金', '期末配当金', '年間配当金'],
          ...(unchangedDividendReference(block.text) ? ['配当予想'] : []),
        ]
          .filter((label) => normalized(block.text).includes(label))
          .map((label) => ({ blockId: block.id, label }));
      })
    );
}
function revisionReasonSources(pages: ExtractedPage[], context: DocumentContext) {
  const result: string[] = [];
  let inReason = false;
  for (const block of issuerBlocks(pages, context)) {
    const text = normalized(block.text);
    if (/^(?:(?:\d+[.、])|(?:\(\d+\)))?修正の理由$/.test(text)) {
      inReason = true;
      continue;
    }
    if (headingLevel(block) !== null || /^※/.test(text)) inReason = false;
    if (
      inReason &&
      block.kind === 'paragraph' &&
      /売上高|売上収益|営業利益|当社(?:グループ)?/.test(text) &&
      !unchangedDividend(text)
    )
      result.push(block.id);
  }
  return result;
}
function unchangedForecastSources(pages: ExtractedPage[], context: DocumentContext) {
  return issuerBlocks(pages, context).filter(
    (b) =>
      b.kind === 'paragraph' &&
      /^\(注\)(?:\d+[.、])?直近に公表されている(?:配当|業績)予想からの修正の有無[:：]無$/.test(
        normalized(b.text)
      )
  );
}
/** A same-named business metric is not a financial-reporting obligation. */
function isReportingMetricSource(
  anchor: string,
  state: string,
  pages: ExtractedPage[],
  context: DocumentContext
): boolean {
  const binding = bindingFor(context, anchor);
  // The innermost section owns prose and tables; a child business section
  // cannot borrow its parent's financial-results role.
  const title = reportingUnitTitle(binding, pages);
  // An unsectioned claim on the reporting cover belongs to that explicit root.
  // This supplies a source role only; local scope/basis still resolve separately.
  if (state === 'actual' && isReportingCoverUnit(binding, pages)) return true;
  return state === 'forecast'
    ? !!forecastReportingTitle(title)
    : state === 'actual' && !/予想|見通し/.test(title) && isPerformanceReportingTitle(title);
}
/** Prose must prove a direct, complete amount at the reporting source and period. */
function reportingPeriodSource(axis: string, context: string, period: string): boolean {
  return matchesReportingPeriod(
    { period, semantics: { periodKind: periodKind(period, axis, context) } },
    period.match(/20\d{2}年\d{1,2}月期/)?.[0] ?? '',
    period.match(/第[1-4]四半期|中間期/)?.[0]
  );
}
/** A forecast heading declares an obligation; a forecast mentioned in prose does not. */
function declaredForecastUnit(
  pages: ExtractedPage[],
  context: DocumentContext
): { period: string; blockId: string } | null {
  for (const block of pages.flatMap((p) => p.blocks)) {
    const text = compact(block.text);
    const explanation = text.match(/^(.*業績予想)について説明(?:します|いたします)。?$/);
    const page = pages.find((p) => p.pageNumber === block.page)!;
    const tables = page.tableRegions.filter(
      (t) =>
        block.spanIds.length &&
        block.spanIds.every((id) => t.spanIds.includes(id)) &&
        context.tableMappings.some(
          (m) =>
            t.valueIds.includes(m.valueId) && block.spanIds.every((id) => m.contextIds.includes(id))
        )
    );
    const table = tables.length === 1 ? tables[0] : undefined;
    const title =
      headingLevel(block) !== null || (table && forecastReportingTitle(text))
        ? text
        : explanation?.[1];
    const period = title
      ? resolveForecastReportingTitle(
          { ...block, text: title },
          pages.flatMap((p) => p.blocks),
          pages.flatMap((p) => p.spans),
          table
        )?.period
      : null;
    if (period) {
      const owners = [
        ...new Set(
          applicableDeclarations(bindingFor(context, block.id), 'subject', true).map((d) =>
            normalized(d.value)
          )
        ),
      ];
      if (owners.length === 1 && owners[0] === documentSubject(context))
        return { period, blockId: block.id };
    }
  }
  return null;
}
function isIssuerSource(anchor: string, context: DocumentContext): boolean {
  const owners = [
    ...new Set(
      applicableDeclarations(bindingFor(context, anchor), 'subject', true).map((d) =>
        normalized(d.value)
      )
    ),
  ];
  return owners.length === 1 && owners[0] === documentSubject(context);
}
function factAnchor(fact: VerifiedFact): string {
  return fact.evidence.kind === 'table' ? fact.evidence.valueId : fact.evidence.blockId;
}
function isIssuerFact(fact: VerifiedFact, context: DocumentContext): boolean {
  const issuer = documentSubject(context);
  return (
    !!issuer &&
    normalized(fact.semantics.subject ?? '') === issuer &&
    isIssuerSource(factAnchor(fact), context)
  );
}
function issuerBlocks(pages: ExtractedPage[], context: DocumentContext) {
  return pages.flatMap((p) => p.blocks).filter((b) => isIssuerSource(b.id, context));
}
/** One source set owns an issuer assertion's trigger, fulfillment and repair. */
function maAssertionSources(pages: ExtractedPage[], context: DocumentContext) {
  const blocks = issuerBlocks(pages, context);
  return {
    decision: blocks.filter(
      (b) =>
        /株式.*取得|子会社化/.test(normalized(b.text)) &&
        /決議(?:いた)?しました/.test(normalized(b.text))
    ),
    undisclosed: blocks.filter((b) => /取得価額.*非開示/.test(normalized(b.text))),
    schedule: blocks.filter(
      (b) =>
        /譲渡実行日/.test(normalized(b.text)) &&
        datedStates(b.text).some((d) => d.state === 'planned')
    ),
    agreement: blocks.filter((b) => /基本合意書/.test(normalized(b.text))),
  };
}
function linkedKpiSources(pages: ExtractedPage[], context: DocumentContext, noteId: string) {
  return context.tableMappings
    .filter((h) => {
      const binding = bindingFor(context, h.valueId);
      return (
        pages.some((p) => p.quantities.some((q) => q.id === h.valueId)) &&
        isIssuerSource(h.valueId, context) &&
        binding.qualifierIds.includes(noteId)
      );
    })
    .map((h) => h.valueId);
}
type ReportingAttributes = Pick<VerifiedFact['semantics'], 'subject' | 'scope' | 'basis'>;
interface ReportingTarget {
  period: string;
  quarter?: string;
  attributes: ReportingAttributes | null;
}
function reportingAttributesAt(
  binding: ContextBinding,
  documentOnly = false
): ReportingAttributes | null {
  const result: ReportingAttributes = { subject: null, scope: null, basis: null };
  for (const role of ['subject', 'scope', 'basis'] as const) {
    const ds = documentOnly
      ? binding.declarations.filter((d) => d.origin === 'document' && d.role === role)
      : applicableDeclarations(binding, role, true);
    const values = [...new Set(ds.map((d) => normalized(d.value)))];
    if (values.length > 1) return null;
    result[role] = values[0] ?? null;
  }
  return result;
}
function sameReportingAttributes(
  a: ReportingAttributes | null,
  b: ReportingAttributes | null
): boolean {
  return (
    !!a &&
    !!b &&
    ['subject', 'scope', 'basis'].every((role) => {
      const key = role as keyof ReportingAttributes;
      return (
        (a[key] === null ? null : normalized(a[key]!)) ===
        (b[key] === null ? null : normalized(b[key]!))
      );
    })
  );
}
/** Required reporting units do not change the meaning of a locally valid fact. */
function earningsTargets(pages: ExtractedPage[], context: DocumentContext) {
  const report = earningsReportingPeriod(pages);
  const cover = context.bindings.find((b) => b.page === 1);
  // Read only the cover's contiguous explicit fields, before values or sections.
  // Later local attributes cannot redefine its required reporting unit.
  const coverFields = context.bindings.filter(
    (b) =>
      b.anchorId === b.blockId &&
      isReportingCoverField(b, pages) &&
      isIssuerSource(b.anchorId, context)
  );
  const coverSource = coverFields[coverFields.length - 1];
  const coverAttributes = cover ? reportingAttributesAt(cover, true) : null;
  const fields = coverSource ? reportingAttributesAt(coverSource) : null;
  const actual: ReportingTarget | null =
    report && cover
      ? {
          ...report,
          attributes: coverAttributes && {
            subject: coverAttributes.subject ?? fields?.subject ?? null,
            scope: coverAttributes.scope ?? fields?.scope ?? null,
            basis: coverAttributes.basis ?? fields?.basis ?? null,
          },
        }
      : null;
  const declaration = declaredForecastUnit(pages, context);
  let forecast: ReportingTarget | null = null;
  if (declaration) {
    // Fields between the declaration and its first source belong to that unit.
    // A child unit or a later FY declaration cannot replace this reporting target.
    const blocks = pages.flatMap((p) => p.blocks);
    const source = context.bindings.find((b) => {
      if (b.sectionIds[b.sectionIds.length - 1] !== declaration.blockId || b.anchorId !== b.blockId)
        return false;
      const block = blocks.find((block) => block.id === b.blockId)!;
      return (
        block.kind === 'row' ||
        (!/^(?:会社名|上場会社名|名称|範囲|会計基準)/.test(normalized(block.text)) &&
          headingLevel(block) === null)
      );
    });
    const binding = source ?? bindingFor(context, declaration.blockId);
    forecast = { period: declaration.period, attributes: reportingAttributesAt(binding) };
  }
  return { actual, forecast, declaration };
}
function sourceFiscalPeriod(axis: string, context: string): string | null {
  const years = [...new Set(axis.match(/20\d{2}年\d{1,2}月期/g) ?? [])];
  const inherited = [...new Set(context.match(/20\d{2}年\d{1,2}月期/g) ?? [])];
  const applicable = years.length ? years : inherited;
  return applicable.length === 1 ? applicable[0] : null;
}
function targetPeriodKind(target: ReportingTarget): VerifiedFact['semantics']['periodKind'] | null {
  if (!target.quarter) return 'fullYear';
  const q = target.quarter.match(/第([1-3])四半期/)?.[1];
  return q ? (`cumulativeQ${q}` as VerifiedFact['semantics']['periodKind']) : null;
}
function matchesTargetSource(
  anchor: string,
  target: ReportingTarget,
  context: DocumentContext
): boolean {
  return sameReportingAttributes(
    reportingAttributesAt(bindingFor(context, anchor)),
    target.attributes
  );
}
function targetForRequirement(
  requirement: string,
  targets: ReturnType<typeof earningsTargets>
): ReportingTarget | null {
  return /当年決算実績|当年営業利益率/.test(requirement)
    ? targets.actual
    : /通期予想の重要指標|通期予想の1株当たり利益|COVERAGE:予想修正の前後/.test(requirement)
      ? targets.forecast
      : null;
}
function reportedProseMargins(pages: ExtractedPage[], context: DocumentContext, period: string) {
  const target = earningsTargets(pages, context).actual;
  return pages.flatMap((page) =>
    page.blocks.filter((block) => {
      if (block.kind !== 'paragraph') return false;
      if (!isReportingMetricSource(block.id, 'actual', pages, context)) return false;
      if (
        !isIssuerSource(block.id, context) ||
        !target ||
        !matchesTargetSource(block.id, target, context)
      )
        return false;
      const binding = bindingFor(context, block.id);
      const sourceContext = binding.contextIds
        .map(
          (id) =>
            pages.flatMap((p) => [...p.blocks, ...p.spans]).find((s) => s.id === id)?.text ?? ''
        )
        .join('\n');
      return proseQuantities(block).some((q) => {
        const quantity = parseExactQuantity(q.raw);
        const value = quantity && quantityNumber(quantity.decimal)?.value;
        if (!quantity || quantity.unit !== '%' || value === undefined || value === null)
          return false;
        const claim = { label: '売上高営業利益率', value, unit: '%', period, valueKind: 'actual' };
        try {
          verifyProsePeriod(claim, block.text, sourceContext);
          verifyPeriodAndKind(claim, block.text, sourceContext, '');
          verifyProseEvidence(page, block.text, claim);
          return reportingPeriodSource(block.text, sourceContext, period);
        } catch {
          return false;
        }
      });
    })
  );
}
/** A mapping proposes a source; only ordinary numeric proof can create an obligation. */
function reportedTableMargins(pages: ExtractedPage[], context: DocumentContext, period: string) {
  const target = earningsTargets(pages, context).actual;
  const spans = pages.flatMap((p) => p.spans);
  const text = (ids: string[]) => ids.map((id) => spans.find((s) => s.id === id)!.text).join('');
  return context.tableMappings.filter((h) => {
    const page = pages.find((p) => p.quantities.some((q) => q.id === h.valueId));
    if (
      !page ||
      page.selection !== 'selected' ||
      compact(text(h.metricIds)) !== '売上高営業利益率' ||
      !isReportingMetricSource(h.valueId, 'actual', pages, context) ||
      !isIssuerSource(h.valueId, context) ||
      !target ||
      !matchesTargetSource(h.valueId, target, context)
    )
      return false;
    if (
      !provedMappedQuantity(pages, h, {
        label: '売上高営業利益率',
        unit: '%',
        period,
        valueKind: 'actual',
      })
    )
      return false;
    try {
      return reportingPeriodSource(text(h.periodIds), text(h.contextIds), period);
    } catch {
      return false;
    }
  });
}
function earningsReportingPeriod(pages: ExtractedPage[]) {
  const title = pages
    .find((p) => p.pageNumber === 1)
    ?.text.normalize('NFKC')
    .match(/(20\d{2}年\s*\d{1,2}月期)[^\n]*決算短信[^\n]*/);
  return title
    ? { period: compact(title[1]), quarter: reportingPeriodShape(title[0]) ?? undefined }
    : null;
}
function maMetricSources(pages: ExtractedPage[], context: DocumentContext) {
  const spans = pages.flatMap((p) => p.spans);
  const text = (ids: string[]) => ids.map((id) => spans.find((s) => s.id === id)!.text).join('');
  return tableContinuations(pages).flatMap((link) => {
    const periods = link.periodColumns.map((ids) => normalized(text(ids)));
    const dated = periods.map((period) => {
      // A chronological key is not a constraint on the complete source axis.
      // Ordinary numeric proof below still decides its qualified period meaning.
      const fiscal = sourceFiscalPeriod(period, '');
      const match = fiscal?.match(/^(20\d{2})年(\d{1,2})月期$/);
      return match && +match[2] >= 1 && +match[2] <= 12
        ? { period, key: +match[1] * 12 + +match[2] }
        : null;
    });
    if (dated.some((p) => p === null)) return [];
    dated.sort((a, b) => a!.key - b!.key);
    const latest = dated[dated.length - 1]?.period;
    if (!latest) return [];
    const heading = pages.flatMap((p) => p.blocks).find((b) => link.scopeIds.includes(b.id));
    if (!heading) return [];
    return context.tableMappings.flatMap((hint) => {
      const page = pages.find((p) => p.quantities.some((q) => q.id === hint.valueId));
      if (!page || (page.pageNumber !== link.fromPage && page.pageNumber !== link.toPage))
        return [];
      if (
        !link.periodIds.some((id) => hint.periodIds.includes(id)) ||
        normalized(text(hint.periodIds)) !== latest
      )
        return [];
      const metric = standardMetricLabel(text(hint.metricIds));
      const attrs = reportingAttributesAt(bindingFor(context, hint.valueId));
      if (!metric || !attrs?.subject || !normalized(heading.text).includes(attrs.subject))
        return [];
      const unitText = compact(text(hint.unitIds));
      const unit = parseExactQuantity(unitText)?.unit ?? unitText;
      if (
        !provedMappedQuantity(pages, hint, {
          label: text(hint.metricIds),
          unit,
          period: latest,
          valueKind: 'actual',
        })
      )
        return [];
      return [{ metric, period: latest, subject: attrs.subject, valueId: hint.valueId }];
    });
  });
}
export function verifyCoverage(
  type: DocumentType,
  allPages: ExtractedPage[],
  facts: VerifiedFact[],
  context: DocumentContext = buildDocumentContext(allPages)
): void {
  // 原文の整合性・根拠関係は全ページで検証し、必須判定はモデルの本文入力に揃える。
  const pages = allPages.filter((page) => page.selection === 'selected');
  const missing: string[] = [];
  const ownedBlocks = issuerBlocks(pages, context);
  const source = compact(ownedBlocks.map((b) => b.text).join('\n'));
  const revision = /前回|修正前/.test(source) && /今回|修正後/.test(source);
  if (type === 'earnings') {
    const report = earningsReportingPeriod(pages);
    if (!report) throw new Error('COVERAGE:報告対象の決算期を確認できません');
    const period = report.period,
      reportQuarter = report.quarter;
    const issuer = documentSubject(context);
    const targets = earningsTargets(pages, context);
    const applicableMeaning = (f: VerifiedFact) => {
      try {
        const anchor = f.evidence.kind === 'table' ? f.evidence.valueId : f.evidence.blockId;
        const binding = bindingFor(context, anchor);
        verifyScopeEvidence(
          binding,
          f.semantics,
          isFinancialUnit(f, binding, allPages),
          f.evidence.scopeIds
        );
        return true;
      } catch {
        return false;
      }
    };
    const reportingMetric = (f: VerifiedFact) => {
      const anchor = f.evidence.kind === 'table' ? f.evidence.valueId : f.evidence.blockId;
      return (
        pages.some((p) => p.pageNumber === f.page) &&
        isReportingMetricSource(anchor, f.valueKind ?? '', allPages, context)
      );
    };
    // Background assertions retain their own locally applicable attributes.
    const attributesFor = (blocks: { id: string }[]) => {
      const ds = blocks.flatMap((b) => bindingFor(context, b.id).declarations);
      const bindings = blocks.map((b) => bindingFor(context, b.id));
      const values = (role: 'scope' | 'basis') => [
        ...new Set(
          bindings.flatMap((b) => applicableDeclarations(b, role, true).map((d) => d.value))
        ),
      ];
      const scope = values('scope').join('/') || null;
      const basis = values('basis').join('/') || null;
      const scopeId = ds.find((d) => d.role === 'scope' && d.value === scope)?.id;
      return { scope, basis, scopeId };
    };
    const matchesReport = (f: VerifiedFact, kind: string, target: string) =>
      reportingMetric(f) &&
      f.valueKind === kind &&
      matchesReportingPeriod(f, target, kind === 'actual' ? reportQuarter : undefined) &&
      applicableMeaning(f) &&
      sameReportingAttributes(
        f.semantics,
        (kind === 'actual' ? targets.actual : targets.forecast)?.attributes ?? null
      ) &&
      !!f.semantics.subject &&
      issuer === normalized(f.semantics.subject ?? '');
    const has = (metric: string, kind: 'actual' | 'forecast', target: string) =>
      facts.some(
        (f) =>
          (f.kind === 'number' || f.kind === 'range') &&
          revisionMetricLabel(f.label) === metric &&
          (metric !== 'netProfit' || ownsRequiredNetProfit(f.label, pages, context, kind)) &&
          matchesReport(f, kind, target)
      );
    for (const metric of declaredReportingMetrics(pages, context, period, 'actual'))
      if (!has(metric, 'actual', period)) missing.push(`COVERAGE:当年決算実績の重要指標 ${metric}`);
    const forecastUnit = targets.declaration;
    const forecast = forecastUnit?.period;
    if (
      forecast &&
      !facts.some(
        (f) =>
          f.kind === 'status' &&
          f.semantics.polarity === 'affirmative' &&
          /業績予想/.test(compact(f.quote)) &&
          /未定|非開示/.test(compact(f.quote)) &&
          issuer === normalized(f.semantics.subject ?? '') &&
          applicableMeaning(f) &&
          (() => {
            const anchor = f.evidence.kind === 'table' ? f.evidence.valueId : f.evidence.blockId;
            if (!isReportingMetricSource(anchor, 'forecast', allPages, context)) return false;
            if (!sameReportingAttributes(f.semantics, targets.forecast?.attributes ?? null))
              return false;
            const sourcePeriod = forecastReportingTitle(
              reportingUnitTitle(bindingFor(context, anchor), allPages)
            )?.period;
            const ownPeriods = [
              ...new Set(normalized(f.quote).match(/20\d{2}年\d{1,2}月期/g) ?? []),
            ];
            if (ownPeriods.length && (ownPeriods.length !== 1 || ownPeriods[0] !== forecast))
              return false;
            return sourcePeriod === forecast && (!f.period || matchesReportingPeriod(f, forecast));
          })()
      )
    ) {
      for (const metric of declaredReportingMetrics(pages, context, forecast, 'forecast'))
        if (!has(metric, 'forecast', forecast))
          missing.push(
            metric === '1株当たり利益'
              ? 'COVERAGE:通期予想の1株当たり利益'
              : `COVERAGE:通期予想の重要指標 ${metric}`
          );
    }
    const marginPeriod = period + (reportQuarter ?? '');
    if (
      (reportedProseMargins(pages, context, marginPeriod).length > 0 ||
        reportedTableMargins(allPages, context, marginPeriod).length > 0) &&
      !facts.some(
        (f) =>
          (f.kind === 'number' || f.kind === 'range') &&
          /営業利益率/.test(f.label) &&
          f.semantics.metricKind === 'rate' &&
          matchesReport(f, 'actual', period)
      )
    )
      missing.push('COVERAGE:当年営業利益率');
    if (/配当の状況/.test(source)) {
      const reported = reportedDividends(allPages, pages, context);
      const relevant = reported.filter((d) => d.period === period || d.period === forecast);
      const forecasts = relevant.filter((d) => d.state === 'forecast');
      const targets = forecasts.length
        ? forecasts
        : relevant.filter((d) => d.period === period && d.state === 'actual');
      if (!targets.length) missing.push('COVERAGE:配当の報告対象期・区分を確認できません');
      for (const target of new Map(targets.map((d) => [d.period + d.state, d])).values())
        if (
          !facts.some(
            (f) =>
              (f.kind === 'number' || f.kind === 'range') &&
              isPerShareDividend(f.label, f.unit) &&
              f.semantics.metricKind === 'perShare' &&
              f.semantics.periodKind === 'fullYear' &&
              compact(f.period ?? '').match(
                /^(20\d{2}年\d{1,2}月期)(?:通期)?(?:\(予想\))?$/
              )?.[1] === target.period &&
              f.valueKind === target.state &&
              f.semantics.state === target.state &&
              !!f.semantics.subject &&
              issuer === normalized(f.semantics.subject ?? '')
          )
        )
          missing.push(`COVERAGE:配当の重要事実 対象期=${target.period} 区分=${target.state}`);
    }
    const backgroundBlocks = ownedBlocks.filter(
      (b) =>
        /純損失/.test(b.text) &&
        /概算額/.test(b.text) &&
        assertionStates(b.text).includes('forecast')
    );
    const backgroundAttributes = attributesFor(backgroundBlocks);
    if (
      backgroundBlocks.length > 0 &&
      !facts.some(
        (f) =>
          f.kind === 'event' &&
          f.evidence.kind === 'prose' &&
          backgroundBlocks.some(
            (b) => f.evidence.kind === 'prose' && b.id === f.evidence.blockId
          ) &&
          /純損失/.test(f.statement ?? '') &&
          /概算/.test(f.quote) &&
          f.semantics.state === 'forecast' &&
          !!f.semantics.subject &&
          issuer === normalized(f.semantics.subject ?? '') &&
          applicableMeaning(f)
      )
    )
      missing.push(
        `COVERAGE:損失予想の背景・限定。本文事実にも対象会社と報告範囲=${backgroundAttributes.scope}を保持し、scopeIdsへ決算短信の範囲見出し ${backgroundAttributes.scopeId} と会社名見出しを参照してください`
      );
    const plannedLossBlocks = ownedBlocks.filter((b) => isLossRecordingPlan(b.text));
    const plannedAttributes = attributesFor(plannedLossBlocks);
    if (
      plannedLossBlocks.length > 0 &&
      !facts.some(
        (f) =>
          f.kind === 'event' &&
          f.semantics.state === 'planned' &&
          f.evidence.kind === 'prose' &&
          plannedLossBlocks.some(
            (b) => f.evidence.kind === 'prose' && b.id === f.evidence.blockId
          ) &&
          /特別損失/.test(f.quote) &&
          !!f.semantics.subject &&
          issuer === normalized(f.semantics.subject ?? '') &&
          applicableMeaning(f)
      )
    )
      missing.push(
        `COVERAGE:損失の計上予定。原文の期間とsubject・scope=${plannedAttributes.scope}・basis=${plannedAttributes.basis}を確定してください`
      );
    for (const block of unchangedForecastSources(pages, context))
      if (
        !facts.some(
          (f) => f.kind === 'event' && isIssuerFact(f, context) && factAnchor(f) === block.id
        )
      )
        missing.push(`COVERAGE:予想修正なしの明示 ${block.id}`);
  }
  if (type === 'earningsRevision' && !revision) {
    const sources = forecastPublicationSources(pages, context);
    if (!sources.length) missing.push('COVERAGE:業績予想公表の報告対象・重要指標を確認できません');
    for (const s of sources) {
      if (
        !facts.some(
          (f) =>
            (f.kind === 'number' || f.kind === 'range') &&
            revisionMetricLabel(f.label) === s.metric &&
            f.semantics.state === s.state &&
            matchesReportingPeriod(f, s.period) &&
            sameReportingAttributes(f.semantics, s.attributes) &&
            sources.some(
              (other) =>
                other.metric === s.metric &&
                other.period === s.period &&
                other.state === s.state &&
                factAnchor(f) === other.valueId
            )
        )
      )
        missing.push(publicationRequirement(s));
    }
  }
  if (type === 'earningsRevision' && revision) {
    const target = earningsTargets(pages, context).forecast;
    const report = target?.period;
    if (!report) throw new Error('COVERAGE:予想修正の報告対象期を確認できません');
    const issuer = documentSubject(context);
    const candidates = facts.filter(
      (f) =>
        f.semantics.subject &&
        issuer === normalized(f.semantics.subject ?? '') &&
        f.semantics.periodKind === 'fullYear' &&
        compact(f.period ?? '').match(/^(20\d{2}年\d{1,2}月期)(?:通期)?(?:予想)?$/)?.[1] === report
    );
    for (const kind of ['forecastBefore', 'forecastAfter'])
      for (const metric of declaredReportingMetrics(pages, context, report, 'forecast', true))
        if (
          !candidates.some(
            (f) =>
              (f.kind === 'number' || f.kind === 'range') &&
              revisionMetricLabel(f.label) === metric &&
              (metric !== 'netProfit' ||
                ownsRequiredNetProfit(f.label, pages, context, 'forecast')) &&
              f.valueKind === kind &&
              sameReportingAttributes(f.semantics, target?.attributes ?? null) &&
              isIssuerSource(
                f.evidence.kind === 'table' ? f.evidence.valueId : f.evidence.blockId,
                context
              ) &&
              isReportingMetricSource(
                f.evidence.kind === 'table' ? f.evidence.valueId : f.evidence.blockId,
                'forecast',
                allPages,
                context
              )
          )
        )
          missing.push(`COVERAGE:予想修正の前後 ${kind}/${metric} 対象期=${report}`);
    for (const dividend of unchangedDividendSources(pages, context, report))
      if (
        !candidates.some(
          (f) =>
            (f.kind === 'number' || f.kind === 'range') &&
            f.evidence.kind === 'prose' &&
            f.evidence.blockId === dividend.blockId &&
            normalized(f.label) === dividend.label &&
            f.semantics.metricKind === 'perShare' &&
            f.semantics.state === (dividend.label === '配当予想' ? 'forecast' : 'planned') &&
            unchangedDividend(f.quote)
        )
      )
        missing.push(`COVERAGE:据置配当 ${dividend.label} 対象期=${report}`);
    const reasons = revisionReasonSources(pages, context);
    for (const reason of reasons)
      if (
        !facts.some(
          (f) => f.kind === 'event' && isIssuerFact(f, context) && factAnchor(f) === reason
        )
      )
        missing.push(`COVERAGE:業績予想修正の理由 ${reason}`);
    if (/配当予想の修正/.test(source))
      for (const kind of ['forecastBefore', 'forecastAfter'])
        if (
          !candidates.some(
            (f) =>
              (f.kind === 'number' || f.kind === 'range') &&
              isPerShareDividend(f.label, f.unit) &&
              f.semantics.metricKind === 'perShare' &&
              f.valueKind === kind
          )
        )
          missing.push(
            `COVERAGE:配当予想修正の前後 ${kind} 対象期=${report}。円銭の単位見出しは円と銭を全てunitIdsで参照し、数量単位unit=円とします`
          );
  }
  if (type === 'shareRepurchase') {
    if (/上限/.test(source))
      for (const metric of ['count', 'amount'])
        if (
          !facts.some(
            (f) =>
              (f.kind === 'number' || f.kind === 'range') &&
              f.semantics.metricKind === metric &&
              f.semantics.qualifiers.includes('上限') &&
              f.semantics.state === 'planned' &&
              isIssuerFact(f, context)
          )
        )
          missing.push(`COVERAGE:自己株取得の上限・予定 ${metric}`);
    if (
      ownedBlocks.some((b) => /取得.*可能性/.test(normalized(b.text))) &&
      !facts.some(
        (f) =>
          isIssuerFact(f, context) &&
          f.semantics.conditions.some((c) => /取得.*可能性/.test(compact(c)))
      )
    )
      missing.push('COVERAGE:取得の条件');
  }
  if (type === 'businessUpdate') {
    const issuerText = source;
    const month = issuerText.match(/(20\d{2}年\d{1,2}月)(?:度)?(?:の|実績|月次)/)?.[1];
    if (
      month &&
      !facts.some(
        (f) =>
          (f.kind === 'number' || f.kind === 'range') &&
          normalized(f.semantics.subject ?? '') === documentSubject(context) &&
          isIssuerSource(
            f.evidence.kind === 'table' ? f.evidence.valueId : f.evidence.blockId,
            context
          ) &&
          f.semantics.periodKind === 'month' &&
          compact(f.period ?? '') === month
      )
    )
      missing.push('COVERAGE:報告対象月');
    for (const link of noteLinks(pages))
      if (
        month &&
        isIssuerSource(link.headingId, context) &&
        !facts.some(
          (f) =>
            (f.kind === 'number' || f.kind === 'range') &&
            compact(f.label) === link.metric &&
            f.semantics.metricKind !== 'rate' &&
            compact(f.period ?? '') === month &&
            isIssuerFact(f, context) &&
            linkedKpiSources(pages, context, link.noteId).includes(factAnchor(f))
        )
      )
        missing.push('COVERAGE:報告対象月の主要KPI');
    if (
      /速報値/.test(issuerText) &&
      !facts.some(
        (f) =>
          normalized(f.semantics.subject ?? '') === documentSubject(context) &&
          isIssuerSource(
            f.evidence.kind === 'table' ? f.evidence.valueId : f.evidence.blockId,
            context
          ) &&
          f.semantics.qualifiers.includes('速報値')
      )
    )
      missing.push('COVERAGE:速報値の限定');
  }
  if (type === 'ma' && /株式.*取得|子会社化/.test(source)) {
    const asserted = maAssertionSources(pages, context);
    if (
      asserted.decision.length > 0 &&
      !facts.some(
        (f) =>
          f.kind === 'event' &&
          f.semantics.state === 'decided' &&
          isIssuerFact(f, context) &&
          asserted.decision.some((b) => b.id === factAnchor(f))
      )
    )
      missing.push('COVERAGE:取得の決議');
    if (
      asserted.undisclosed.length > 0 &&
      !facts.some(
        (f) =>
          f.kind === 'status' &&
          isIssuerFact(f, context) &&
          asserted.undisclosed.some((b) => b.id === factAnchor(f))
      )
    )
      missing.push('COVERAGE:取得価額の非開示');
    if (
      asserted.schedule.length > 0 &&
      !facts.some(
        (f) =>
          f.dateRoles?.some((d) => d.state === 'planned') &&
          isIssuerFact(f, context) &&
          asserted.schedule.some((b) => b.id === factAnchor(f))
      )
    )
      missing.push('COVERAGE:譲渡の実行予定・日付役割');
    const sources = maMetricSources(pages, context);
    for (const source of new Map(
      sources.map((s) => [s.metric + s.period + s.subject, s])
    ).values()) {
      const ids = sources
        .filter(
          (s) =>
            s.metric === source.metric && s.period === source.period && s.subject === source.subject
        )
        .map((s) => s.valueId);
      if (
        !facts.some(
          (f) =>
            standardMetric(f) === source.metric &&
            f.valueKind === 'actual' &&
            normalized(f.semantics.subject ?? '') === source.subject &&
            f.evidence.kind === 'table' &&
            // The exact latest value has already proved its period ordinarily;
            // a second spelling comparison would reject equivalent full-year text.
            ids.includes(f.evidence.valueId)
        )
      )
        missing.push(
          `COVERAGE:対象会社の最近の重要指標 ${source.metric} 対象期=${source.period} 対象会社=${source.subject}`
        );
    }
  }
  if (
    type === 'ma' &&
    maAssertionSources(pages, context).agreement.length > 0 &&
    !facts.some(
      (f) =>
        f.kind === 'event' &&
        isIssuerFact(f, context) &&
        maAssertionSources(pages, context).agreement.some((b) => b.id === factAnchor(f))
    )
  )
    missing.push('COVERAGE:提携の決定事項');
  if (missing.length) throw new Error(missing.join(' / '));
}

export interface CoverageSlot {
  id: string;
  requirement: string;
  sourceIds: string[];
  expected: {
    label?: string;
    kind?: VerifiedFact['kind'];
    state?: VerifiedFact['semantics']['state'];
    metricKind?: VerifiedFact['semantics']['metricKind'];
    periodKind?: VerifiedFact['semantics']['periodKind'];
    period?: string;
    subject?: string;
    scope?: string;
    basis?: string;
  };
  status: 'satisfied' | 'absent' | 'invalid' | 'unknown' | 'outsideSelection';
}
/** Scope requirements to source units; never join unrelated prose to identify a predicate. */
export function coverageReport(
  type: DocumentType,
  pages: ExtractedPage[],
  facts: VerifiedFact[],
  diagnostics: Diagnostic[] = [],
  context: DocumentContext = buildDocumentContext(pages)
): CoverageSlot[] {
  const collect = (source: ExtractedPage[], accepted: VerifiedFact[]) => {
    try {
      verifyCoverage(type, source, accepted, context);
      return [] as string[];
    } catch (e) {
      return (e instanceof Error ? e.message : String(e)).split(' / ');
    }
  };
  const selected = pages.filter((p) => p.selection === 'selected');
  const reporting = ['earnings', 'earningsRevision'].includes(type);
  const selectedTargets = reporting ? earningsTargets(selected, context) : null;
  const fullTargets = reporting ? earningsTargets(pages, context) : null;
  const obligations = collect(pages, []),
    missing = collect(pages, facts);
  const fullObligations = collect(
    pages.map((p) => ({ ...p, selection: 'selected' as const })),
    []
  );
  const requirementTarget = (requirement: string) => {
    const targets = obligations.includes(requirement) ? selectedTargets : fullTargets;
    return targets ? targetForRequirement(requirement, targets) : null;
  };
  const captions = pages.flatMap((p) => p.blocks);
  const spans = pages.flatMap((p) => p.spans);
  const units = context.tableMappings.map((h) => ({
    anchor: h.valueId,
    label: normalized(h.metricIds.map((id) => spans.find((s) => s.id === id)!.text).join('')),
    axis: normalized(h.periodIds.map((id) => spans.find((s) => s.id === id)!.text).join('')),
    context: normalized(h.contextIds.map((id) => spans.find((s) => s.id === id)!.text).join('')),
  }));
  for (const page of pages)
    for (const block of page.blocks.filter((b) => b.kind === 'paragraph')) {
      const label = normalized(block.text).match(
        new RegExp(
          `(${PER_SHARE_PROFIT_METRIC}|年間配当金|売上高|売上収益|営業収益|営業利益|営業損失|${NET_PROFIT_METRIC})(?:は|が|について)`,
          'i'
        )
      )?.[1];
      if (!label || !proseQuantities(block).length) continue;
      const binding = bindingFor(context, block.id);
      if (
        !isReportingMetricSource(
          block.id,
          numericValueKind(
            block.text,
            binding.contextIds
              .map(
                (id) =>
                  pages.flatMap((p) => [...p.blocks, ...p.spans]).find((s) => s.id === id)!.text
              )
              .join('')
          ) ?? '',
          pages,
          context
        )
      )
        continue;
      units.push({
        anchor: block.id,
        label,
        axis: normalized(block.text),
        context: normalized(
          binding.contextIds
            .map(
              (id) => pages.flatMap((p) => [...p.blocks, ...p.spans]).find((s) => s.id === id)!.text
            )
            .join('')
        ),
      });
    }
  let publicationSources: ReturnType<typeof forecastPublicationSources> | undefined;
  const sourceIds = (requirement: string): string[] => {
    if (/業績予想公表の重要指標/.test(requirement))
      return (publicationSources ??= forecastPublicationSources(
        pages.map((p) => ({ ...p, selection: 'selected' as const })),
        context
      ))
        .filter((s) => publicationRequirement(s) === requirement)
        .flatMap((s) => (s.valueId === null ? [] : [s.valueId]));
    if (type === 'businessUpdate' && requirement === 'COVERAGE:報告対象月') {
      const month = normalized(
        issuerBlocks(pages, context)
          .map((b) => b.text)
          .join('')
      ).match(/(20\d{2}年\d{1,2}月)(?:度)?(?:の|実績|月次)/)?.[1];
      if (!month) return [];
      const proseIds = issuerBlocks(pages, context)
        .filter((b) => {
          if (
            b.kind !== 'paragraph' ||
            !proseQuantities(b).length ||
            !/売上高|売上収益|営業収益|営業利益|MRR|ARR/.test(normalized(b.text))
          )
            return false;
          const own = [...new Set(normalized(b.text).match(/20\d{2}年\d{1,2}月(?![\d期])/g) ?? [])];
          const inherited = [
            ...new Set(
              normalized(
                bindingFor(context, b.id)
                  .contextIds.map(
                    (id) =>
                      captions.find((s) => s.id === id)?.text ??
                      spans.find((s) => s.id === id)?.text ??
                      ''
                  )
                  .join('')
              ).match(/20\d{2}年\d{1,2}月(?![\d期])/g) ?? []
            ),
          ];
          const periods = own.length ? own : inherited;
          return periods.length === 1 && periods[0] === month;
        })
        .map((b) => b.id);
      return [
        ...proseIds,
        ...context.tableMappings
          .filter((h) => {
            if (!isIssuerSource(h.valueId, context)) return false;
            const text = (ids: string[]) =>
              ids.map((id) => spans.find((s) => s.id === id)!.text).join('');
            const q = pages.flatMap((p) => p.quantities).find((q) => q.id === h.valueId);
            const unit =
              q && h.unitIds.includes(h.valueId)
                ? parseExactNumeric(q.text)?.unit
                : declaredQuantityUnit(text(h.unitIds));
            return (
              !!unit &&
              provedMappedQuantity(pages, h, {
                label: text(h.metricIds),
                unit,
                period: month,
                valueKind: 'actual',
              })
            );
          })
          .map((h) => h.valueId),
      ];
    }
    if (/予想修正なしの明示/.test(requirement))
      return unchangedForecastSources(pages, context)
        .filter((b) => requirement.endsWith(b.id))
        .map((b) => b.id);
    if (/業績予想修正の理由/.test(requirement))
      return revisionReasonSources(pages, context).filter((id) => requirement.endsWith(id));
    if (/据置配当/.test(requirement))
      return unchangedDividendSources(
        pages,
        context,
        requirement.match(/対象期=(20\d{2}年\d{1,2}月期)/)![1]
      )
        .filter((s) => requirement.includes(s.label))
        .map((s) => s.blockId);
    if (type === 'ma') {
      const sources = maAssertionSources(pages, context);
      const blocks = /取得の決議/.test(requirement)
        ? sources.decision
        : /取得価額の非開示/.test(requirement)
          ? sources.undisclosed
          : /譲渡の実行/.test(requirement)
            ? sources.schedule
            : /提携の決定/.test(requirement)
              ? sources.agreement
              : null;
      if (blocks) return blocks.map((b) => b.id);
    }
    if (type === 'businessUpdate' && /主要KPI/.test(requirement))
      return [
        ...new Set(
          noteLinks(pages)
            .filter((l) => isIssuerSource(l.headingId, context))
            .flatMap((l) => linkedKpiSources(pages, context, l.noteId))
        ),
      ];
    const metric = requirement.match(
      /revenue|operatingProfit|ordinaryProfit|netProfit|1株当たり利益|営業利益率|配当|KPI/
    )?.[0];
    const marker = {
      revenue: /^(売上高|売上収益|営業収益)$/,
      operatingProfit: /^営業(?:利益|損失)/,
      ordinaryProfit: /^経常(?:利益|損失)$/,
      netProfit: new RegExp(`^${NET_PROFIT_METRIC}$`),
      '1株当たり利益': new RegExp(`^${BASIC_PER_SHARE_PROFIT_METRIC}$`, 'i'),
      営業利益率: /営業利益率/,
      配当: /配当/,
      KPI: /MRR|ARR|KPI/,
    }[metric ?? ''] as RegExp | undefined;
    if (marker) {
      const target = requirementTarget(requirement);
      if (type === 'ma' && /対象会社の最近/.test(requirement))
        return maMetricSources(pages, context)
          .filter(
            (s) =>
              s.metric === metric &&
              requirement.includes(`対象期=${s.period} 対象会社=${s.subject}`)
          )
          .map((s) => s.valueId);
      if (type === 'earnings' && metric === '営業利益率') {
        const report = earningsReportingPeriod(pages);
        const period = report ? report.period + (report.quarter ?? '') : undefined;
        const proseIds = period
          ? reportedProseMargins(pages, context, period).map((b) => b.id)
          : [];
        return [
          ...proseIds,
          ...(period ? reportedTableMargins(pages, context, period).map((h) => h.valueId) : []),
        ];
      }
      const kind =
        requirement.match(/区分=(actual|forecast)/)?.[1] ??
        (requirement.includes('forecastBefore')
          ? 'forecastBefore'
          : requirement.includes('forecastAfter')
            ? 'forecastAfter'
            : /予想/.test(requirement)
              ? 'forecast'
              : /実績|利益率/.test(requirement)
                ? 'actual'
                : null);
      const targetPeriod =
        target?.period ?? requirement.match(/対象期=(20\d{2}年\d{1,2}月期)/)?.[1];
      if (type === 'earnings' && metric === '配当')
        return reportedDividends(pages, pages, context)
          .filter(
            (d) => (!targetPeriod || d.period === targetPeriod) && (!kind || d.state === kind)
          )
          .map((d) => d.valueId);
      return units
        .filter(
          (u) =>
            marker.test(u.label) &&
            (metric !== 'netProfit' ||
              !reporting ||
              ownsRequiredNetProfit(
                u.label,
                pages,
                context,
                /予想/.test(requirement) ? 'forecast' : 'actual'
              )) &&
            (type !== 'businessUpdate' || isIssuerSource(u.anchor, context)) &&
            (!target || matchesTargetSource(u.anchor, target, context)) &&
            (!target ||
              (() => {
                try {
                  return matchesReportingPeriod(
                    {
                      period:
                        (sourceFiscalPeriod(u.axis, u.context) ?? '') +
                        (reportingPeriodShape(u.axis) ?? reportingPeriodShape(u.context) ?? ''),
                      semantics: {
                        periodKind: periodKind(
                          target.period + (target.quarter ?? ''),
                          u.axis,
                          u.context,
                          pages.some((p) =>
                            p.tableRegions.some((t) => t.valueIds.includes(u.anchor))
                          )
                        ),
                      },
                    },
                    target.period,
                    target.quarter
                  );
                } catch {
                  // Retain a matching original fiscal/quarter role even when its
                  // qualifier cannot be proved. Preflight reports the source defect.
                  return (
                    sourceFiscalPeriod(u.axis, u.context) === target.period &&
                    (reportingPeriodShape(u.axis) ?? reportingPeriodShape(u.context)) ===
                      (reportingPeriodShape(target.quarter ?? '') ?? null)
                  );
                }
              })()) &&
            (!targetPeriod || sourceFiscalPeriod(u.axis, u.context) === targetPeriod) &&
            (!target ||
              isReportingMetricSource(
                u.anchor,
                kind === 'forecastBefore' || kind === 'forecastAfter' ? 'forecast' : (kind ?? ''),
                pages,
                context
              )) &&
            (kind === 'forecastBefore'
              ? /前回|修正前/.test(u.axis)
              : kind === 'forecastAfter'
                ? /今回|修正後/.test(u.axis)
                : kind === 'forecast'
                  ? /予想|見込/.test(u.axis + u.context)
                  : kind === 'actual'
                    ? !/予想|見込/.test(u.axis)
                    : true)
        )
        .map((u) => u.anchor);
    }
    const predicate = /損失予想の背景/.test(requirement)
      ? /純損失/
      : /損失の計上予定/.test(requirement)
        ? /特別損失に計上[^。]*予定/
        : /自己株取得/.test(requirement)
          ? requirement.endsWith('count')
            ? /取得する株式.*総数/
            : /取得価額.*総額/
          : /取得の条件/.test(requirement)
            ? /取得.*可能性/
            : /報告対象月/.test(requirement)
              ? /20\d{2}年.*月/
              : /速報値/.test(requirement)
                ? /速報値/
                : /取得の決議/.test(requirement)
                  ? /決議いたしました/
                  : /取得価額の非開示/.test(requirement)
                    ? /取得価額.*非開示/
                    : /譲渡の実行/.test(requirement)
                      ? /譲渡実行日/
                      : /提携の決定/.test(requirement)
                        ? /基本合意書/
                        : null;
    return predicate
      ? captions
          .filter(
            (b) =>
              predicate.test(normalized(b.text)) &&
              (!(
                ['shareRepurchase', 'businessUpdate'].includes(type) ||
                /損失の計上予定|損失予想の背景/.test(requirement)
              ) ||
                isIssuerSource(b.id, context)) &&
              (!/損失の計上予定/.test(requirement) || isLossRecordingPlan(b.text)) &&
              (!/損失予想の背景/.test(requirement) ||
                (/概算額/.test(b.text) && assertionStates(b.text).includes('forecast')))
          )
          .map((b) => b.id)
      : [];
  };
  return [...new Set([...obligations, ...fullObligations])].map((requirement) => {
    const ids = sourceIds(requirement);
    const selectedIds = ids.filter((id) =>
      selected.some(
        (p) => p.blocks.some((b) => b.id === id) || p.quantities.some((q) => q.id === id)
      )
    );
    const rejected = diagnostics.some(
      (d) => d.status !== 'valid' && d.sourceKey !== null && selectedIds.includes(d.sourceKey)
    );
    const status = !obligations.includes(requirement)
      ? 'outsideSelection'
      : !missing.includes(requirement)
        ? 'satisfied'
        : !ids.length
          ? 'unknown'
          : rejected
            ? 'invalid'
            : 'absent';
    const resolvedIds = ids.filter((id) => context.bindings.some((b) => b.anchorId === id));
    const assertion =
      /損失予想の背景|損失の計上予定|取得の決議|譲渡の実行|提携の決定|業績予想修正の理由|予想修正なしの明示/.test(
        requirement
      );
    const amount = /revenue|operatingProfit|ordinaryProfit|netProfit|自己株取得.*amount/.test(
      requirement
    );
    const state = /予想修正なしの明示/.test(requirement)
      ? 'unspecified'
      : /業績予想修正の理由/.test(requirement)
        ? null
        : (requirement.match(/区分=(actual|forecast)/)?.[1] ??
          (requirement.includes('forecastBefore')
            ? 'forecastBefore'
            : requirement.includes('forecastAfter')
              ? 'forecastAfter'
              : /据置配当/.test(requirement)
                ? /据置配当 配当予想 /.test(requirement)
                  ? 'forecast'
                  : 'planned'
                : /予想|損失予想の背景/.test(requirement)
                  ? 'forecast'
                  : /計上予定|自己株取得|譲渡の実行/.test(requirement)
                    ? 'planned'
                    : /決議/.test(requirement)
                      ? 'decided'
                      : /実績|利益率|報告対象月|KPI/.test(requirement)
                        ? 'actual'
                        : null));
    const target = requirementTarget(requirement);
    const maPeriods =
      type === 'ma' && /対象会社の最近/.test(requirement)
        ? [
            ...new Set(
              maMetricSources(pages, context)
                .filter((s) => resolvedIds.includes(s.valueId))
                .map((s) => s.period)
            ),
          ]
        : null;
    const period = target
      ? target.period + (target.quarter ?? '')
      : maPeriods
        ? maPeriods.length === 1
          ? maPeriods[0]
          : null
        : /報告対象月/.test(requirement)
          ? (normalized(
              issuerBlocks(pages, context)
                .map((b) => b.text)
                .join('')
            ).match(/(20\d{2}年\d{1,2}月)(?:度)?(?:の|実績|月次)/)?.[1] ?? null)
          : (requirement.match(/対象期=(20\d{2}年\d{1,2}月期)/)?.[1] ?? null);
    const dates = resolvedIds
      .flatMap((id) => sourceDateOptions(context.bindings.find((b) => b.anchorId === id)!, pages))
      .filter((d) => d.state === state);
    const dateValues = [...new Set(dates.map((d) => d.date))];
    const explicitDate =
      !assertion && state === 'planned' && dateValues.length === 1 ? dateValues[0] : null;
    // A populated repair constraint needs one source period, never a report-cover default.
    const lossPeriodGroups = /損失の計上予定/.test(requirement)
      ? resolvedIds.map((id) => lossRecordingPeriods(captions.find((b) => b.id === id)?.text ?? ''))
      : [];
    const lossPeriods = [...new Set(lossPeriodGroups.flat())];
    let lossPeriodKind: VerifiedFact['semantics']['periodKind'] | null = null;
    if (
      lossPeriodGroups.length &&
      lossPeriodGroups.every((p) => p.length === 1) &&
      lossPeriods.length === 1
    ) {
      try {
        lossPeriodKind = periodKind(lossPeriods[0], lossPeriods[0]);
      } catch {
        /* The ordinary verifier still decides unsupported/ambiguous source meaning. */
      }
    }
    const expected = {
      label: requirement.match(/据置配当 (\S+) 対象期=/)?.[1] ?? null,
      kind: assertion
        ? 'event'
        : /非開示/.test(requirement)
          ? 'status'
          : amount || /配当|1株当たり|利益率|自己株取得|対象月|KPI/.test(requirement)
            ? sourceQuantityKind(resolvedIds, pages)
            : null,
      state,
      metricKind: assertion
        ? 'none'
        : amount
          ? 'amount'
          : /配当|1株当たり/.test(requirement)
            ? 'perShare'
            : /利益率/.test(requirement)
              ? 'rate'
              : /自己株取得.*count/.test(requirement)
                ? 'count'
                : null,
      periodKind: explicitDate
        ? 'eventDate'
        : /損失予想の背景/.test(requirement)
          ? 'none'
          : /計上予定/.test(requirement)
            ? lossPeriodKind
            : /対象月|KPI/.test(requirement)
              ? 'month'
              : target
                ? targetPeriodKind(target)
                : /据置配当/.test(requirement)
                  ? 'fullYear'
                  : null,
      period: explicitDate ?? period,
      subject: target?.attributes?.subject ?? null,
      scope: target?.attributes?.scope ?? null,
      basis: target?.attributes?.basis ?? null,
    };
    return {
      id: `slot:${type}:${requirement}`,
      requirement,
      sourceIds: resolvedIds,
      status,
      // Missing constraints are omitted; null is never an enum/default to copy.
      expected: Object.fromEntries(
        Object.entries(expected).filter(([, v]) => v !== null)
      ) as CoverageSlot['expected'],
    };
  });
}

/** Repair constraints follow literal source syntax, without changing forecast state. */
function sourceQuantityKind(ids: string[], pages: ExtractedPage[]): 'number' | 'range' | null {
  const kinds = new Set(
    [
      ...pages
        .flatMap((p) => p.quantities)
        .filter((q) => ids.includes(q.id))
        .map((q) => q.text),
      ...pages
        .flatMap((p) => p.blocks)
        .filter((b) => ids.includes(b.id))
        .flatMap((b) => proseQuantities(b).map((q) => q.raw)),
    ]
      .map((raw) => parseExactNumeric(raw)?.kind)
      .filter((kind) => kind !== undefined)
  );
  return kinds.size === 1 ? [...kinds][0]! : null;
}
