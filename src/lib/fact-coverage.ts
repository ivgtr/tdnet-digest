import {
  numericValueKind,
  matchesReportingPeriod,
  periodKind,
  reportingPeriodShape,
  reportingPeriodText,
} from './period-semantics';
import { NET_PROFIT_METRIC } from './metric-semantics';
import { assertionStates } from './assertion-semantics';
import type { ExtractedPage } from '@/types/summaryMetadata';
import type { DocumentType } from './document-type';
import type { VerifiedFact } from './fact-contract';
import { tableContinuations, noteLinks, continuationSpans } from './document-links';
import {
  compact,
  verifyTableEvidence,
  verifyProseEvidence,
  verifyProsePeriod,
  verifyPeriodAndKind,
} from './numeric-evidence';
import { parseExactQuantity, proseQuantities, quantityNumber } from './quantity';
import { sourceDateOptions } from './source-periods';
import { buildTableMappings, type TableMapping } from './source-mappings';
import {
  buildDocumentContext,
  bindingFor,
  isFinancialUnit,
  reportingUnitTitle,
  isReportingCoverUnit,
  verifyScopeEvidence,
  applicableDeclarations,
  type DocumentContext,
} from './document-context';
import { isPerformanceReportingTitle } from './document-structure';
import { normalized } from './document-structure';
import type { Diagnostic } from './fact-candidates';
import { isPerShareDividend } from './metric-semantics';

/** Structural proposals use the same complete numeric proof as accepted facts. */
function provedMappedNumber(
  pages: ExtractedPage[],
  hint: TableMapping,
  claim: { label: string; unit: string; period: string; valueKind: string }
): boolean {
  const page = pages.find((p) => p.quantities.some((q) => q.id === hint.valueId));
  if (!page || page.selection !== 'selected') return false;
  const quantity = parseExactQuantity(page.quantities.find((q) => q.id === hint.valueId)!.text);
  const value = quantity && quantityNumber(quantity.decimal)?.value;
  if (value === undefined || value === null) return false;
  try {
    verifyTableEvidence({ ...page, spans: continuationSpans(pages, page, hint.valueId) }, hint, {
      ...claim,
      value,
    });
    return true;
  } catch {
    return false;
  }
}
function reportedDividends(pages: ExtractedPage[], selected = pages) {
  const spans = pages.flatMap((p) => p.spans);
  const mappings = buildTableMappings(pages);
  return selected.flatMap((page) => {
    const text = (ids: string[]) => ids.map((id) => spans.find((s) => s.id === id)!.text).join('');
    return mappings
      .filter((h) => page.quantities.some((q) => q.id === h.valueId))
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
          provedMappedNumber(pages, hint, {
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
  const label = compact(fact.label);
  if (/調整|コア|EBITDA/i.test(label)) return null;
  if (/^(売上高|売上収益|営業収益)$/.test(label)) return 'revenue';
  if (/^営業(?:利益|損失)(?:\(△\))?$/.test(label)) return 'operatingProfit';
  if (new RegExp(`^${NET_PROFIT_METRIC}(?:又は.*)?(?:\\(△\\))?$`).test(label)) return 'netProfit';
  return null;
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
    ? /業績予想|今後の見通し/.test(title)
    : state === 'actual' && !/予想|見通し/.test(title) && isPerformanceReportingTitle(title);
}
/** Prose must prove a direct, complete amount at the reporting source and period. */
function reportingPeriodSource(axis: string, context: string, period: string): boolean {
  return matchesReportingPeriod(
    { period, semantics: { periodKind: periodKind(period, axis + context) } },
    period.match(/20\d{2}年\d{1,2}月期/)?.[0] ?? '',
    period.match(/第[1-4]四半期|中間期/)?.[0]
  );
}
function reportedProseMargins(pages: ExtractedPage[], context: DocumentContext, period: string) {
  return pages.flatMap((page) =>
    page.blocks.filter((block) => {
      if (block.kind !== 'paragraph') return false;
      if (!isReportingMetricSource(block.id, 'actual', pages, context)) return false;
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
  const spans = pages.flatMap((p) => p.spans);
  const text = (ids: string[]) => ids.map((id) => spans.find((s) => s.id === id)!.text).join('');
  return context.tableMappings.filter((h) => {
    const page = pages.find((p) => p.quantities.some((q) => q.id === h.valueId));
    if (
      !page ||
      page.selection !== 'selected' ||
      compact(text(h.metricIds)) !== '売上高営業利益率' ||
      !isReportingMetricSource(h.valueId, 'actual', pages, context)
    )
      return false;
    if (
      !provedMappedNumber(pages, h, {
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
export function verifyCoverage(
  type: DocumentType,
  allPages: ExtractedPage[],
  facts: VerifiedFact[],
  context: DocumentContext = buildDocumentContext(allPages)
): void {
  // 原文の整合性・根拠関係は全ページで検証し、必須判定はモデルの本文入力に揃える。
  const pages = allPages.filter((page) => page.selection === 'selected');
  const missing: string[] = [];
  const source = compact(pages.map((p) => p.text).join('\n'));
  if (type === 'earnings') {
    const first = pages.find((p) => p.pageNumber === 1);
    const report = earningsReportingPeriod(pages);
    if (!report) throw new Error('COVERAGE:報告対象の決算期を確認できません');
    const period = report.period,
      reportQuarter = report.quarter;
    const issuer = first?.blocks.find((b) => /上場会社名/.test(compact(b.text)))?.text;
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
    // Only diagnostics need an expected value; facts are matched at their own source unit.
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
    const has = (metric: string, kind: string, target: string) =>
      facts.some(
        (f) =>
          standardMetric(f) === metric &&
          reportingMetric(f) &&
          f.valueKind === kind &&
          matchesReportingPeriod(f, target, kind === 'actual' ? reportQuarter : undefined) &&
          applicableMeaning(f) &&
          !!f.semantics.subject &&
          (!issuer || compact(issuer).includes(compact(f.semantics.subject)))
      );
    for (const metric of ['revenue', 'operatingProfit', 'netProfit'])
      if (!has(metric, 'actual', period)) missing.push(`COVERAGE:当年決算実績の重要指標 ${metric}`);
    const forecast = source.match(/(20\d{2}年\d{1,2}月期)(?:の)?(?:通期)?(?:連結)?業績予想/);
    if (
      forecast &&
      !facts.some(
        (f) =>
          f.kind === 'status' &&
          /業績予想/.test(compact(f.quote)) &&
          /未定|非開示/.test(compact(f.quote))
      )
    ) {
      for (const metric of ['revenue', 'operatingProfit', 'netProfit'])
        if (!has(metric, 'forecast', forecast[1]))
          missing.push(`COVERAGE:通期予想の重要指標 ${metric}`);
    }
    const marginPeriod = period + (reportQuarter ?? '');
    if (
      (reportedProseMargins(pages, context, marginPeriod).length > 0 ||
        reportedTableMargins(allPages, context, marginPeriod).length > 0) &&
      !facts.some(
        (f) =>
          f.kind === 'number' &&
          /営業利益率/.test(f.label) &&
          f.semantics.metricKind === 'rate' &&
          f.valueKind === 'actual' &&
          matchesReportingPeriod(f, period, reportQuarter) &&
          reportingMetric(f) &&
          applicableMeaning(f)
      )
    )
      missing.push('COVERAGE:当年営業利益率');
    if (
      forecast &&
      /1株当たり当期純利益/.test(compact(first?.text ?? '')) &&
      !facts.some(
        (f) =>
          f.kind === 'number' &&
          /^(?:1|１)株当たり当期純利益/.test(f.label) &&
          f.semantics.metricKind === 'perShare' &&
          f.valueKind === 'forecast' &&
          compact(f.period ?? '').includes(forecast[1])
      )
    )
      missing.push('COVERAGE:通期予想の1株当たり利益');
    if (/配当の状況/.test(source)) {
      const reported = reportedDividends(allPages, pages);
      const relevant = reported.filter((d) => d.period === period || d.period === forecast?.[1]);
      const forecasts = relevant.filter((d) => d.state === 'forecast');
      const targets = forecasts.length
        ? forecasts
        : relevant.filter((d) => d.period === period && d.state === 'actual');
      if (!targets.length) missing.push('COVERAGE:配当の報告対象期・区分を確認できません');
      for (const target of new Map(targets.map((d) => [d.period + d.state, d])).values())
        if (
          !facts.some(
            (f) =>
              f.kind === 'number' &&
              isPerShareDividend(f.label, f.unit) &&
              f.semantics.metricKind === 'perShare' &&
              f.semantics.periodKind === 'fullYear' &&
              compact(f.period ?? '').match(
                /^(20\d{2}年\d{1,2}月期)(?:通期)?(?:\(予想\))?$/
              )?.[1] === target.period &&
              f.valueKind === target.state &&
              f.semantics.state === target.state &&
              !!f.semantics.subject &&
              (!issuer || compact(issuer).includes(compact(f.semantics.subject)))
          )
        )
          missing.push(`COVERAGE:配当の重要事実 対象期=${target.period} 区分=${target.state}`);
    }
    const backgroundBlocks = pages
      .flatMap((p) => p.blocks)
      .filter(
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
          (!issuer || compact(issuer).includes(compact(f.semantics.subject))) &&
          applicableMeaning(f)
      )
    )
      missing.push(
        `COVERAGE:損失予想の背景・限定。本文事実にも対象会社と報告範囲=${backgroundAttributes.scope}を保持し、scopeIdsへ決算短信の範囲見出し ${backgroundAttributes.scopeId} と会社名見出しを参照してください`
      );
    const plannedLossBlocks = pages
      .flatMap((p) => p.blocks)
      .filter(
        (b) =>
          /特別損失に計上[^。]*予定/.test(compact(b.text)) &&
          assertionStates(b.text).length === 1 &&
          assertionStates(b.text)[0] === 'planned'
      );
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
          (!issuer || compact(issuer).includes(compact(f.semantics.subject))) &&
          applicableMeaning(f)
      )
    )
      missing.push(
        `COVERAGE:損失の計上予定。原文の期間とsubject・scope=${plannedAttributes.scope}・basis=${plannedAttributes.basis}を確定してください`
      );
  }
  if (type === 'earningsRevision' && /前回|修正前/.test(source) && /今回|修正後/.test(source)) {
    const report = source.match(/(20\d{2}年\d{1,2}月期)(?:通期)?(?:連結|個別)?業績予想/)?.[1];
    if (!report) throw new Error('COVERAGE:予想修正の報告対象期を確認できません');
    const issuer = pages
      .find((p) => p.pageNumber === 1)
      ?.blocks.find((b) => /会社名/.test(compact(b.text)));
    const candidates = facts.filter(
      (f) =>
        f.semantics.subject &&
        (!issuer || compact(issuer.text).includes(compact(f.semantics.subject))) &&
        f.semantics.periodKind === 'fullYear' &&
        compact(f.period ?? '').match(/^(20\d{2}年\d{1,2}月期)(?:通期)?(?:予想)?$/)?.[1] === report
    );
    for (const kind of ['forecastBefore', 'forecastAfter'])
      for (const metric of ['revenue', 'operatingProfit'])
        if (!candidates.some((f) => standardMetric(f) === metric && f.valueKind === kind))
          missing.push(`COVERAGE:予想修正の前後 ${kind}/${metric} 対象期=${report}`);
    if (/配当予想の修正/.test(source))
      for (const kind of ['forecastBefore', 'forecastAfter'])
        if (
          !candidates.some(
            (f) =>
              f.kind === 'number' &&
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
              f.kind === 'number' &&
              f.semantics.metricKind === metric &&
              f.semantics.qualifiers.includes('上限') &&
              f.semantics.state === 'planned' &&
              f.semantics.subject
          )
        )
          missing.push(`COVERAGE:自己株取得の上限・予定 ${metric}`);
    if (
      /可能性/.test(source) &&
      !facts.some((f) => f.semantics.conditions.some((c) => /取得.*可能性/.test(compact(c))))
    )
      missing.push('COVERAGE:取得の条件');
  }
  if (type === 'businessUpdate') {
    const month = source.match(/(20\d{2}年\d{1,2}月)(?:度)?(?:の|実績|月次)/)?.[1];
    if (
      month &&
      !facts.some(
        (f) =>
          f.kind === 'number' &&
          f.semantics.periodKind === 'month' &&
          compact(f.period ?? '') === month
      )
    )
      missing.push('COVERAGE:報告対象月');
    for (const link of noteLinks(pages))
      if (
        month &&
        !facts.some(
          (f) =>
            f.kind === 'number' &&
            compact(f.label) === link.metric &&
            f.semantics.metricKind !== 'rate' &&
            compact(f.period ?? '') === month
        )
      )
        missing.push('COVERAGE:報告対象月の主要KPI');
    if (/速報値/.test(source) && !facts.some((f) => f.semantics.qualifiers.includes('速報値')))
      missing.push('COVERAGE:速報値の限定');
  }
  if (type === 'ma' && /株式.*取得|子会社化/.test(source)) {
    if (
      /決議いたしました|決議しました/.test(source) &&
      !facts.some(
        (f) =>
          f.kind === 'event' &&
          f.semantics.state === 'decided' &&
          /株式.*取得|子会社化/.test(compact(f.quote))
      )
    )
      missing.push('COVERAGE:取得の決議');
    if (
      /取得価額.*非開示/.test(source) &&
      !facts.some((f) => f.kind === 'status' && /取得価額.*非開示/.test(compact(f.quote)))
    )
      missing.push('COVERAGE:取得価額の非開示');
    if (
      /譲渡実行日/.test(source) &&
      !facts.some(
        (f) =>
          f.dateRoles?.some((d) => d.state === 'planned') && /譲渡実行日/.test(compact(f.quote))
      )
    )
      missing.push('COVERAGE:譲渡の実行予定・日付役割');
    for (const link of tableContinuations(pages)) {
      const owner = pages.find((p) => p.pageNumber === link.fromPage)!;
      const heading = owner.blocks.find((b) => link.scopeIds.includes(b.id));
      const latest = link.periodIds
        .map((id) => owner.spans.find((s) => s.id === id)!.text)
        .map(compact)
        .sort()
        .slice(-1)[0];
      for (const metric of ['revenue', 'operatingProfit', 'netProfit'])
        if (
          !facts.some(
            (f) =>
              standardMetric(f) === metric &&
              f.valueKind === 'actual' &&
              compact(f.period ?? '') === latest &&
              f.semantics.subject &&
              heading &&
              compact(heading.text).includes(compact(f.semantics.subject))
          )
        )
          missing.push(`COVERAGE:対象会社の最近の重要指標 ${metric}`);
    }
  }
  if (
    type === 'ma' &&
    /基本合意書/.test(source) &&
    !facts.some((f) => f.kind === 'event' && /基本合意書/.test(f.quote))
  )
    missing.push('COVERAGE:提携の決定事項');
  if (missing.length) throw new Error(missing.join(' / '));
}

export interface CoverageSlot {
  id: string;
  requirement: string;
  sourceIds: string[];
  expected: {
    kind?: VerifiedFact['kind'];
    state?: VerifiedFact['semantics']['state'];
    metricKind?: VerifiedFact['semantics']['metricKind'];
    periodKind?: VerifiedFact['semantics']['periodKind'];
    period?: string;
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
  const obligations = collect(pages, []),
    missing = collect(pages, facts);
  const fullObligations = collect(
    pages.map((p) => ({ ...p, selection: 'selected' as const })),
    []
  );
  const captions = pages.flatMap((p) => p.blocks);
  const spans = pages.flatMap((p) => p.spans);
  const units = context.tableMappings.map((h) => ({
    anchor: h.valueId,
    label: normalized(h.metricIds.map((id) => spans.find((s) => s.id === id)!.text).join('')),
    axis: normalized(h.periodIds.map((id) => spans.find((s) => s.id === id)!.text).join('')),
    context: normalized(h.contextIds.map((id) => spans.find((s) => s.id === id)!.text).join('')),
  }));
  const sourceIds = (requirement: string): string[] => {
    const metric = requirement.match(
      /revenue|operatingProfit|netProfit|1株当たり利益|営業利益率|配当|KPI/
    )?.[0];
    const marker = {
      revenue: /^(売上高|売上収益|営業収益)$/,
      operatingProfit: /^営業(?:利益|損失)/,
      netProfit: /(?:当期|四半期|中間).*純(?:利益|損失)/,
      '1株当たり利益': /株当たり.*利益/,
      営業利益率: /営業利益率/,
      配当: /配当/,
      KPI: /MRR|ARR|KPI/,
    }[metric ?? ''] as RegExp | undefined;
    if (marker) {
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
      const targetPeriod = requirement.match(/対象期=(20\d{2}年\d{1,2}月期)/)?.[1];
      if (type === 'earnings' && metric === '配当')
        return reportedDividends(pages)
          .filter(
            (d) => (!targetPeriod || d.period === targetPeriod) && (!kind || d.state === kind)
          )
          .map((d) => d.valueId);
      return units
        .filter(
          (u) =>
            marker.test(u.label) &&
            (!targetPeriod || u.axis.match(/20\d{2}年\d{1,2}月期/)?.[0] === targetPeriod) &&
            (type !== 'earnings' ||
              !['revenue', 'operatingProfit', 'netProfit'].includes(metric!) ||
              isReportingMetricSource(u.anchor, kind ?? '', pages, context)) &&
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
    const assertion = /損失予想の背景|損失の計上予定|取得の決議|譲渡の実行|提携の決定/.test(
      requirement
    );
    const amount = /revenue|operatingProfit|netProfit|自己株取得.*amount/.test(requirement);
    const state =
      requirement.match(/区分=(actual|forecast)/)?.[1] ??
      (requirement.includes('forecastBefore')
        ? 'forecastBefore'
        : requirement.includes('forecastAfter')
          ? 'forecastAfter'
          : /予想|損失予想の背景/.test(requirement)
            ? 'forecast'
            : /計上予定|自己株取得|譲渡の実行/.test(requirement)
              ? 'planned'
              : /決議/.test(requirement)
                ? 'decided'
                : /実績|利益率|報告対象月|KPI/.test(requirement)
                  ? 'actual'
                  : null);
    const period = requirement.match(/対象期=(20\d{2}年\d{1,2}月期)/)?.[1] ?? null;
    const dates = resolvedIds
      .flatMap((id) => sourceDateOptions(context.bindings.find((b) => b.anchorId === id)!, pages))
      .filter((d) => d.state === state);
    const dateValues = [...new Set(dates.map((d) => d.date))];
    const explicitDate =
      !assertion && state === 'planned' && dateValues.length === 1 ? dateValues[0] : null;
    // A populated repair constraint needs one source period, never a report-cover default.
    const lossPeriods = /損失の計上予定/.test(requirement)
      ? [
          ...new Set(
            resolvedIds.flatMap(
              (id) =>
                reportingPeriodText(captions.find((b) => b.id === id)?.text ?? '').match(
                  /(?:翌|次|当|前)連結会計年度|20\d{2}年\d{1,2}月(?:期(?:第[1-4]四半期|中間期|通期)?(?:累計|単独)?|\d{1,2}日|度)?/g
                ) ?? []
            )
          ),
        ]
      : [];
    let lossPeriodKind: VerifiedFact['semantics']['periodKind'] | null = null;
    if (lossPeriods.length === 1) {
      try {
        lossPeriodKind = periodKind(lossPeriods[0], lossPeriods[0]);
      } catch {
        /* The ordinary verifier still decides unsupported/ambiguous source meaning. */
      }
    }
    const expected = {
      kind: assertion
        ? 'event'
        : /非開示/.test(requirement)
          ? 'status'
          : amount || /配当|1株当たり|利益率|自己株取得|対象月|KPI/.test(requirement)
            ? 'number'
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
              : null,
      period: explicitDate ?? period,
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
