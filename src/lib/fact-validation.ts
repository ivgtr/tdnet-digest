import {
  periodKind,
  reportingPeriodShape,
  explicitCalendarAxisMatches,
  calendarIntervalSeparator,
} from './period-semantics';
export { periodKind } from './period-semantics';
import {
  declaredSubjectsIn,
  buildDocumentContext,
  bindingFor,
  verifyScopeEvidence,
  isFinancialUnit,
} from './document-context';
import {
  assertionPolarity,
  quantityAssertionPolarity,
  verifyAssertionState,
  isLossRecordingPlan,
  lossRecordingPeriods,
  activePlan,
  planClauseBindings,
  assertionKinds,
} from './assertion-semantics';
import type { ExtractedPage } from '@/types/summaryMetadata';
import { drawingLines } from './pdf-drawing';
import { buildTableRegions, buildTableCells } from './table-layout';
import { sourceProvenance } from './source-provenance';
import { parseExactQuantity, parseExactRange, quantityNumber, proseQuantities } from './quantity';
import {
  verifyTableEvidence,
  verifyProseQuantity,
  verifyProsePeriod,
  compact,
  verifyPeriodAndKind,
} from './numeric-evidence';
import { normalized, quantityCells, buildBlocks } from './document-structure';
import { classifyMetric as metricKind } from './metric-semantics';
export { classifyMetric as metricKind } from './metric-semantics';
import { continuationFor, continuationPage, noteLinks, paragraphNoteLinks } from './document-links';
import {
  checkSemantics,
  exact,
  record,
  stableFactId,
  canonicalJSON,
  type VerifiedFact,
  type CandidateFact,
  type FactEvidence,
} from './fact-contract';

export const FACT_KEYS = [
  'id',
  'importance',
  'kind',
  'label',
  'value',
  'unit',
  'period',
  'valueKind',
  'column',
  'statement',
  'page',
  'quote',
  'evidence',
  'semantics',
  'quantity',
  'dateRoles',
  'provenance',
];
const ekeys = ['contextIds', 'scopeIds', 'qualifierIds'];
const fail = (code: string): never => {
  throw new Error(code);
};
export function validatePages(pages: ExtractedPage[]): void {
  if (
    !Array.isArray(pages) ||
    !pages.length ||
    pages.some((p) => !record(p)) ||
    new Set(pages.map((p) => p.pageNumber)).size !== pages.length
  )
    fail('SOURCE:物理ページの形式');
  for (const p of pages) {
    if (
      !exact(p as unknown as Record<string, unknown>, [
        'pageNumber',
        'text',
        'spans',
        'sourceItems',
        'status',
        'selection',
        'blocks',
        'quantities',
        'drawingOperations',
        'drawingLines',
        'tableRegions',
      ]) ||
      typeof p.text !== 'string' ||
      !Number.isInteger(p.pageNumber) ||
      p.pageNumber < 1 ||
      !['ok', 'empty', 'failed'].includes(p.status) ||
      !['selected', 'omitted'].includes(p.selection) ||
      !Array.isArray(p.spans) ||
      !Array.isArray(p.sourceItems) ||
      !Array.isArray(p.blocks) ||
      !Array.isArray(p.quantities) ||
      !Array.isArray(p.drawingOperations) ||
      !Array.isArray(p.drawingLines) ||
      !Array.isArray(p.tableRegions)
    )
      fail('SOURCE:原文字・構造・抽出状態がありません');
    if (p.status === 'failed') fail(`SOURCE:PDF p.${p.pageNumber}の抽出失敗`);
    if (p.status === 'ok' && (!p.sourceItems.length || !p.spans.length || !p.blocks.length))
      fail('SOURCE:成功ページの原文字欠落');
    if (p.status === 'empty' && p.spans.length) fail('SOURCE:空ページと原文字の状態が不一致');
    if (
      p.sourceItems.some(
        (s) =>
          typeof s.text !== 'string' ||
          !new RegExp(`^p${p.pageNumber}i\\d+$`).test(s.id) ||
          !Array.isArray(s.transform) ||
          s.transform.length !== 6 ||
          !s.transform.every(Number.isFinite) ||
          s.x !== s.transform[4] ||
          s.y !== -s.transform[5] ||
          ![s.width, s.height].every(Number.isFinite) ||
          s.width < 0 ||
          s.height < 0 ||
          typeof s.direction !== 'string' ||
          typeof s.hasEOL !== 'boolean'
      )
    )
      fail('SOURCE:原アイテムの座標・変換・方向・改行情報が不正です');
    if (
      p.spans.some(
        (s) => ![s.x, s.y, s.width, s.height].every(Number.isFinite) || s.height <= 0 || s.width < 0
      )
    )
      fail('SOURCE:座標不正');
    const sourceIds = new Set(p.sourceItems.map((s) => s.id));
    if (
      sourceIds.size !== p.sourceItems.length ||
      new Set(p.spans.map((s) => s.id)).size !== p.spans.length
    )
      fail('SOURCE:原文字IDの重複');
    if (
      p.spans.some(
        (s) =>
          !Array.isArray(s.sourceIds) ||
          !s.sourceIds.length ||
          s.sourceIds.some((id) => !sourceIds.has(id)) ||
          normalized(
            s.sourceIds.map((id) => p.sourceItems.find((i) => i.id === id)!.text).join('')
          ) !== normalized(s.text)
      )
    )
      fail('SOURCE:原文字への対応が不正です');
    if (
      p.spans.some((s) => {
        const originals = s.sourceIds!.map((id) => p.sourceItems.find((i) => i.id === id)!);
        return (
          originals.some(
            (i) => Math.abs(i.transform[1]) > 0.01 || Math.abs(i.transform[2]) > 0.01
          ) ||
          Math.abs(s.x - Math.min(...originals.map((i) => i.x))) > 0.01 ||
          Math.abs(s.x + s.width - Math.max(...originals.map((i) => i.x + i.width))) > 0.01
        );
      })
    )
      fail('SOURCE:派生セルと原文字の座標が不一致です');
    if (
      canonicalJSON(drawingLines(p.drawingOperations, p.pageNumber)) !==
        canonicalJSON(p.drawingLines) ||
      canonicalJSON(buildTableRegions(p)) !== canonicalJSON(p.tableRegions) ||
      canonicalJSON(
        quantityCells(p.spans, buildTableCells(p.drawingLines, p.spans, p.pageNumber))
      ) !== canonicalJSON(p.quantities) ||
      canonicalJSON(buildBlocks(p)) !== canonicalJSON(p.blocks)
    )
      fail('SOURCE:派生構造の不一致');
  }
}
function ids(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length > 32 ||
    !value.every((x) => typeof x === 'string') ||
    new Set(value).size !== value.length
  )
    fail('SCHEMA:根拠ID群の形式');
  return value as string[];
}
function referenceText(pages: ExtractedPage[], refs: string[]): string {
  return refs
    .map((id) => {
      for (const p of pages) {
        const s = p.spans.find((s) => s.id === id);
        const b = p.blocks.find((b) => b.id === id);
        if ((s || b) && p.selection !== 'selected') fail(`REFERENCE:未選択ページの根拠 ${id}`);
        if (s) return s.text;
        if (b) return b.text;
      }
      return fail(`REFERENCE:参照先 ${id}`);
    })
    .join('\n');
}
function declaredSubjects(pages: ExtractedPage[], refs: string[]): string[] {
  const blocks = pages.flatMap((page) =>
    page.blocks.filter((block) => refs.some((id) => block.id === id || block.spanIds.includes(id)))
  );
  return [...new Set(blocks.flatMap(declaredSubjectsIn))];
}
export function sourceQualifiers(text: string): string[] {
  return [
    ...new Set(
      [
        ...text
          .normalize('NFKC')
          .matchAll(/上限|下限|概算額|概算|速報値|約(?=\s*\d)|修正する可能性|修正される可能性/g),
      ].map((m) => m[0])
    ),
  ].sort();
}
export function sourceConditions(text: string): string[] {
  return text
    .split(/(?<=[。])/)
    .map((s) => s.trim())
    .filter((s) => /場合|条件|可能性|限り|ただし|但し/.test(s));
}
export function datedStates(text: string): Array<{ date: string; state: string }> {
  const source = normalized(text),
    matches = [...source.matchAll(/20\d{2}年\d{1,2}月\d{1,2}日/g)],
    clauses = planClauseBindings(source);
  return matches.map((match, i) => {
    const clause = clauses.find(
      (c) => c.start <= match.index! && c.end >= match.index! + match[0].length
    )!;
    const head = source.slice(
      Math.max(clause.start, i ? matches[i - 1].index! + matches[i - 1][0].length : 0),
      match.index!
    );
    const tail = source.slice(
      match.index! + match[0].length,
      Math.min(clause.end, matches[i + 1]?.index ?? source.length)
    );
    const prefixRole = head.match(/(決議|決定|契約締結|締結|実行|基準)日[:：]?$/)?.[1];
    const state = new RegExp(`^${calendarIntervalSeparator}`).test(tail)
      ? 'periodStart'
      : new RegExp(`^${calendarIntervalSeparator}$`).test(head)
        ? 'periodEnd'
        : prefixRole === '決議' || prefixRole === '決定'
          ? 'decided'
          : prefixRole === '契約締結' || prefixRole === '締結'
            ? 'contracted'
            : prefixRole === '基準'
              ? 'reference'
              : clause.planned &&
                  activePlan((prefixRole === '実行' ? '実行日' : '') + match[0] + tail)
                ? 'planned'
                : /決議|決定/.test(tail)
                  ? 'decided'
                  : /締結(?:いた)?しました|契約を結びました/.test(tail)
                    ? 'contracted'
                    : /時点|現在|終値/.test(tail)
                      ? 'reference'
                      : 'unspecified';
    return { date: match[0], state };
  });
}
function stateSupported(state: VerifiedFact['semantics']['state'], text: string): boolean {
  const source = compact(text);
  if (state === 'planned') return activePlan(source);
  const markers = {
    decided: /決議|決定|決定額/,
    contracted: /締結|契約/,
    completed: /取得しました|取得した|実施しました|完了/,
    forecast: /予想|見込|見通し|今後の見通し/,
    forecastBefore: /前回|従来|修正前|直近の配当予想/,
    forecastAfter: /今回|修正後|決定額/,
    actual: /実績|経営成績|連結業績|損益計算書|当期|前期|月度|決算短信|時点|保有状況/,
  };
  if (state === 'unspecified')
    return !activePlan(source) && !Object.values(markers).some((re) => re.test(source));
  return markers[state].test(source);
}
export function validateFact(
  value: unknown,
  pages: ExtractedPage[],
  documentContext = buildDocumentContext(pages)
): VerifiedFact {
  if (
    !record(value) ||
    !exact(value, FACT_KEYS) ||
    typeof value.id !== 'string' ||
    !/^f\d+$|^fact-[a-f0-9]{16}$/.test(value.id) ||
    !['key', 'detail'].includes(String(value.importance)) ||
    !['number', 'range', 'event', 'status'].includes(String(value.kind)) ||
    typeof value.label !== 'string' ||
    !value.label.trim() ||
    typeof value.quote !== 'string' ||
    !Number.isInteger(value.page) ||
    value.column !== null
  )
    fail('SCHEMA:事実項目の形式');
  checkSemantics(
    (value as Record<string, unknown>).semantics,
    /^f\d+$/.test(String((value as Record<string, unknown>).id))
  );
  const fact = value as unknown as CandidateFact;
  if (
    ['number', 'range'].includes(fact.kind) &&
    fact.valueKind !== null &&
    fact.valueKind !== fact.semantics.state
  )
    fail(
      `STATE:valueKind=${fact.valueKind}とsemantics.state=${fact.semantics.state}が不一致です。同じ実績/予想区分を指定してください`
    );
  if (fact.period !== null) {
    if (typeof fact.period !== 'string') fail('SCHEMA:期間の形式');
    const period = normalized(fact.period);
    if (
      !/^(?:20\d{2}年\d{1,2}月期(?:(?:第[1-4]四半期|中間期|通期)(?:[(（]?(?:累計|単独)[)）]?)?)?(?:[(（]予想[)）])?|20\d{2}年\d{1,2}月(?:度)?|20\d{2}年\d{1,2}月\d{1,2}日(?:[~～〜-]20\d{2}年\d{1,2}月\d{1,2}日)?(?:[(（]予定[)）])?|(?:翌|次|当|前)連結会計年度)$/.test(
        period
      )
    )
      fail('PERIOD:未対応の期間形式');
    for (const m of period.matchAll(/(20\d{2})年(\d{1,2})月(?:(\d{1,2})日)?/g)) {
      const year = Number(m[1]),
        month = Number(m[2]),
        day = Number(m[3] ?? 1),
        date = new Date(Date.UTC(year, month - 1, day));
      if (
        date.getUTCFullYear() !== year ||
        date.getUTCMonth() !== month - 1 ||
        date.getUTCDate() !== day
      )
        fail('PERIOD:不正な年月日');
    }
  }
  const page =
    pages.find((p) => p.pageNumber === fact.page) ?? fail('REFERENCE:物理ページがありません');
  if (page.selection !== 'selected') fail('REFERENCE:未選択ページの事実は採用できません');
  if (!record(fact.evidence)) fail('SCHEMA:根拠の形式');
  const ev = fact.evidence;
  const expected =
    ev.kind === 'table'
      ? ['kind', 'valueId', 'metricIds', 'periodIds', 'unitIds', ...ekeys]
      : ['kind', 'blockId', 'assertionId', 'quantityId', ...ekeys];
  if (
    !['table', 'prose'].includes(ev.kind) ||
    !exact(ev as unknown as Record<string, unknown>, expected)
  )
    fail('SCHEMA:根拠の項目');
  const contexts = ids(ev.contextIds),
    scopes = ids(ev.scopeIds),
    qualifiers = ids(ev.qualifierIds);
  const continuation = ev.kind === 'table' ? continuationFor(pages, page, ev.valueId) : undefined;
  const context = referenceText(pages, contexts),
    scope = referenceText(pages, scopes),
    notes = referenceText(pages, qualifiers);
  let source = '',
    axis = '',
    quantity: VerifiedFact['quantity'] = null,
    resultEvidence: FactEvidence = ev;
  let atY = 0;
  if (ev.kind === 'table') {
    if (
      !['number', 'range'].includes(fact.kind) ||
      (fact.kind === 'number'
        ? typeof fact.value !== 'number' || !Number.isFinite(fact.value)
        : fact.value !== null) ||
      typeof fact.unit !== 'string' ||
      !fact.unit ||
      typeof fact.period !== 'string' ||
      fact.statement !== null
    )
      fail('SCHEMA:表の数値');
    const claim = {
      label: fact.label,
      value: fact.value,
      range: fact.kind === 'range',
      unit: fact.unit!,
      period: fact.period!,
      valueKind: fact.valueKind ?? 'actual',
    };
    const checked = verifyTableEvidence(
      continuationPage(pages, page, ev.valueId),
      {
        valueId: ev.valueId,
        metricIds: ev.metricIds,
        periodIds: ev.periodIds,
        unitIds: ev.unitIds,
        contextIds: ev.contextIds,
      },
      claim,
      false
    );
    const cell =
      page.quantities.find((q) => q.id === ev.valueId) ?? fail('QUANTITY:数量の全断片がありません');
    const sourceIds = cell.spanIds.flatMap((id) => page.spans.find((s) => s.id === id)!.sourceIds!);
    if (fact.kind === 'range') {
      const parsed = parseExactRange(cell.text) ?? fail('QUANTITY:不正な範囲');
      quantity = {
        raw: cell.text,
        decimal: null,
        lower: parsed.lower,
        upper: parsed.upper,
        sourceIds,
      };
    } else {
      const parsed = parseExactQuantity(cell.text) ?? fail('QUANTITY:不正な数量');
      if (quantityNumber(parsed.decimal)?.value !== fact.value)
        fail('QUANTITY:数値化で精度を失います');
      quantity = { raw: cell.text, decimal: parsed.decimal, sourceIds };
    }
    source = checked.quote;
    axis = referenceText(pages, ev.periodIds);
    atY = cell.y;
    resultEvidence = {
      ...checked.evidence,
      kind: 'table',
      scopeIds: scopes,
      qualifierIds: qualifiers,
    };
    if (fact.quote && fact.quote !== source) fail('REFERENCE:根拠と引用が不一致');
  } else {
    const block =
      page.blocks.find((b) => b.id === ev.blockId) ?? fail('REFERENCE:段落がありません');
    if (block.kind !== 'paragraph') fail('STRUCTURE:表を本文引用で代用できません');
    source = block.text;
    atY = block.y;
    if (normalized(fact.quote) !== normalized(source)) fail('REFERENCE:段落全体の引用が必要です');
    if (fact.kind === 'number' || fact.kind === 'range') {
      if (
        (fact.kind === 'number' ? typeof fact.value !== 'number' : fact.value !== null) ||
        typeof fact.unit !== 'string' ||
        !fact.unit ||
        fact.statement !== null
      )
        fail('SCHEMA:本文の数量');
      const proseClaim = {
        label: fact.label,
        value: fact.value,
        range: fact.kind === 'range',
        unit: fact.unit!,
        period: fact.period ?? '',
        valueKind: fact.valueKind ?? 'actual',
        subject: fact.semantics.subject,
        scope: fact.semantics.scope,
      };
      const selected =
        proseQuantities(block).find((q) => q.id === ev.quantityId) ??
        fail('QUANTITY:選択した本文数量がありません');
      const proved = verifyProseQuantity(page, source, proseClaim, selected);
      if (!selected || selected.start !== proved.start || selected.raw !== proved.raw)
        fail('QUANTITY:選択した数量の範囲が指標の根拠と不一致です');
      verifyProsePeriod(proseClaim, source, context);
      const raw = /円\d{2}銭$/.test(normalized(proved.raw))
        ? normalized(proved.raw)
        : normalized(proved.raw).slice(0, -normalized(fact.unit!).length);
      const sourceIds = block.spanIds.flatMap(
        (id) => page.spans.find((s) => s.id === id)!.sourceIds!
      );
      if (fact.kind === 'range') {
        const parsed = parseExactRange(raw);
        if (!parsed) fail('QUANTITY:本文の範囲');
        quantity = {
          raw,
          decimal: null,
          lower: parsed!.lower,
          upper: parsed!.upper,
          sourceIds,
        };
      } else {
        const parsed = parseExactQuantity(raw);
        if (!parsed || quantityNumber(parsed.decimal)?.value !== fact.value)
          fail('QUANTITY:本文数量の不一致・精度不足');
        quantity = { raw, decimal: parsed!.decimal, sourceIds };
      }
    } else {
      if (
        fact.value !== null ||
        fact.unit !== null ||
        fact.valueKind !== null ||
        normalized(fact.statement ?? '') !== normalized(source)
      )
        fail('SEMANTICS:主語・否定・条件を含む完結した原文が必要です');
      if (normalized(fact.label) !== normalized(source))
        fail('SEMANTICS:出来事のlabelも完結した原文です。自由な主張文へ変更できません');
      if (!assertionKinds(source).includes(fact.kind as 'event' | 'status'))
        fail('SEMANTICS:明示状態がありません');
    }
  }
  const anchor = ev.kind === 'table' ? ev.valueId : ev.blockId;
  const binding = bindingFor(documentContext, anchor);
  const nearest = page.blocks.find(
    (b) => b.id === binding.sectionIds[binding.sectionIds.length - 1]
  );
  verifyScopeEvidence(
    binding,
    fact.semantics,
    isFinancialUnit(
      { ...fact, semantics: { ...fact.semantics, qualifiers: [], conditions: [] } },
      binding,
      pages
    ),
    scopes
  );
  const allowedContexts = new Set([
    ...binding.contextIds,
    ...page.blocks
      .filter((b) => binding.sectionIds.includes(b.id))
      .flatMap((b) => [b.id, ...b.spanIds]),
  ]);
  if (
    contexts.some((id) => !allowedContexts.has(id)) ||
    binding.contextIds.some(
      (required) =>
        ![...contexts, ...scopes].some(
          (id) =>
            id === required ||
            pages.flatMap((p) => p.blocks).some((b) => b.id === id && b.spanIds.includes(required))
        )
    )
  )
    fail(`SCOPE:適用見出しの不一致。必要なcontextIds=${JSON.stringify(binding.contextIds)}`);
  // Cross-page notes need a shared named metric series; adjacency alone is insufficient.
  for (const link of noteLinks(pages).filter(
    (link) => link.fromPage === page.pageNumber && link.metric === normalized(fact.label)
  )) {
    if (!qualifiers.includes(link.noteId)) fail('QUALIFIER:同じ系列の注記が未参照');
    const heading = normalized(referenceText(pages, [link.headingId]));
    const escapedMetric = link.metric.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const business = heading.match(new RegExp(`${escapedMetric}[(（]([^()（）]+)[)）]`))?.[1];
    if (business && (fact.semantics.scope !== business || !scopes.includes(link.headingId)))
      fail('SCOPE:月次系列の対象事業・見出しの根拠が欠落しています');
  }
  if ((fact.kind === 'number' || fact.kind === 'range') && ev.kind === 'prose')
    for (const link of paragraphNoteLinks(pages).filter((link) => link.blockId === ev.blockId)) {
      if (!qualifiers.includes(link.noteId))
        fail(`QUALIFIER:同じ節の注記 ${link.noteId} をqualifierIdsで参照する必要があります`);
    }
  for (const id of qualifiers) {
    const owner = pages.find(
      (p) => p.spans.some((s) => s.id === id) || p.blocks.some((b) => b.id === id)
    )!;
    if (
      owner.pageNumber !== page.pageNumber &&
      !noteLinks(pages).some(
        (link) =>
          link.noteId === id &&
          link.fromPage === page.pageNumber &&
          link.metric === normalized(fact.label) &&
          [...contexts, ...scopes].includes(link.headingId)
      )
    )
      fail('SCOPE:注記系列の継続を確認できません');
  }
  const row = ev.kind === 'table' ? page.blocks.find((b) => b.spanIds.includes(ev.valueId)) : null;
  const rowQualifiers = row ? sourceQualifiers(row.text) : [];
  if (rowQualifiers.some((q) => !sourceQualifiers(source + notes).includes(q)))
    fail('QUALIFIER:値の行の限定が未参照');
  const local = source + '\n' + context + '\n' + notes;
  if (
    (fact.kind === 'number' || fact.kind === 'range') &&
    fact.semantics.state === 'planned' &&
    /取得/.test(fact.label)
  ) {
    const stockHeading = page.blocks
      .filter((b) => b.y < atY && /取得対象株式.*種類/.test(normalized(b.text)))
      .sort((a, b) => b.y - a.y)[0];
    if (
      stockHeading &&
      (!fact.semantics.scope ||
        !normalized(stockHeading.text.split('\n').find((line) => /種類/.test(line)) ?? '').endsWith(
          normalized(fact.semantics.scope)
        ) ||
        !scopes.some((id) => id === stockHeading.id || stockHeading.spanIds.includes(id)))
    )
      fail(
        `SCOPE:予定数量の対象株式が欠落・不一致です。scopeIds=${stockHeading.id}、原文=${stockHeading.text}`
      );
  }

  if (fact.kind === 'number' || fact.kind === 'range') {
    const plannedDates = [
      ...new Set(
        datedStates(local)
          .filter((d) => d.state === 'planned')
          .map((d) => d.date)
      ),
    ];
    if (
      fact.semantics.state === 'planned' &&
      fact.semantics.periodKind === 'eventDate' &&
      plannedDates.length > 1
    )
      fail('PERIOD:適用する予定日が曖昧です');
    if (!fact.period && pages.some((p) => /20\d{2}年\d{1,2}月/.test(normalized(p.text))))
      fail(
        `PERIOD:原文の対象期間が欠落しています。日付の役割候補=${JSON.stringify(datedStates(local))}`
      );
    if (fact.period) {
      if (fact.semantics.state === 'actual' || fact.semantics.state.startsWith('forecast'))
        verifyPeriodAndKind(
          {
            label: fact.label,
            value: fact.value,
            range: fact.kind === 'range',
            unit: fact.unit!,
            period: fact.period,
            valueKind: fact.semantics.state,
          },
          axis || source,
          context,
          nearest?.text ?? '',
          ev.kind === 'table' && page.tableRegions.some((t) => t.valueIds.includes(ev.valueId))
        );
      else {
        if (!normalized(local).includes(normalized(fact.period)))
          fail(
            `PERIOD:予定日・期間の適用根拠。候補=${JSON.stringify(page.blocks.filter((b) => b.y < atY && /予定|買付けの委託/.test(b.text)).map((b) => ({ blockId: b.id, spanIds: b.spanIds, text: b.text })))}`
          );
        if (
          fact.semantics.periodKind === 'eventDate' &&
          ![source, ...contexts.map((id) => referenceText(pages, [id]))]
            .flatMap(datedStates)
            .some((d) => d.date === normalized(fact.period!) && d.state === fact.semantics.state)
        )
          fail('PERIOD:日付の役割が不一致です');
      }
    }
    if (
      fact.semantics.periodKind !==
      periodKind(
        fact.period,
        axis || source,
        context,
        ev.kind === 'table' && page.tableRegions.some((t) => t.valueIds.includes(ev.valueId))
      )
    )
      fail('PERIOD:期間区分の不一致');
    if (
      fact.semantics.metricKind !==
      metricKind(fact.label, fact.unit, ev.kind === 'prose' ? source : '')
    )
      fail('METRIC:量の種類の不一致');
    if (
      fact.valueKind !==
      (['actual', 'forecast', 'forecastBefore', 'forecastAfter'].includes(fact.semantics.state)
        ? fact.semantics.state
        : null)
    )
      fail(
        'STATE:planned/decided/contracted/completed/unspecifiedではvalueKind=null。財務実績・予想だけはstateと同じvalueKindが必要です'
      );
  } else {
    const recordingPeriods = isLossRecordingPlan(source) ? lossRecordingPeriods(source) : null;
    if (recordingPeriods !== null) {
      if (recordingPeriods.length > 1)
        fail('PERIOD:計上予定に複数の対象期間があり単一期間を確定できません');
      const target = recordingPeriods[0];
      if (target) {
        const kind = periodKind(target, target);
        const sameAxis =
          kind === 'relativeYear'
            ? normalized(fact.period ?? '') === target
            : !!fact.period && explicitCalendarAxisMatches(target, fact.period);
        const sameShape =
          kind === 'fullYear' ||
          reportingPeriodShape(fact.period ?? '') === reportingPeriodShape(target);
        if (
          !sameAxis ||
          !sameShape ||
          fact.semantics.periodKind !== kind ||
          periodKind(fact.period, target) !== kind
        )
          fail('PERIOD:計上する述語に対応する対象期間が欠落・不一致です');
      } else if (fact.period !== null || fact.semantics.periodKind !== 'none')
        fail('PERIOD:計上予定との対応を証明できない期間を付与できません');
    } else {
      const relativePeriods = [
        ...new Set(normalized(source).match(/(?:翌|次|当|前)連結会計年度/g) ?? []),
      ];
      if (relativePeriods.length > 1)
        fail('PERIOD:複数の相対年度を含む段落は単一期間として確定できません');
      if (relativePeriods.length === 1 && normalized(fact.period ?? '') !== relativePeriods[0])
        fail(
          `PERIOD:原文の相対年度が欠落・不一致です。period=${relativePeriods[0]}、periodKind=relativeYearが必要です`
        );
      if (fact.period && new Set(datedStates(source).map((d) => d.date)).size > 1)
        fail('PERIOD:複数の日付役割を含む段落はperiod=nullとし、全日付をdateRolesへ保持します');
      if (fact.period && !normalized(local).includes(normalized(fact.period)))
        fail('PERIOD:出来事の対象期間の根拠がありません');
      if (fact.semantics.periodKind !== periodKind(fact.period, source, context + notes))
        fail(
          `PERIOD:出来事の期間区分が不一致。period=${fact.period}に対応する区分=${periodKind(fact.period, source, context + notes)}`
        );
    }
    if (fact.semantics.metricKind !== 'none') fail('METRIC:出来事を数量の種類へ変換できません');
    if (fact.period && fact.semantics.periodKind === 'eventDate') {
      const date = normalized(fact.period).match(/20\d{2}年\d{1,2}月\d{1,2}日/)?.[0];
      if (!datedStates(source).some((d) => d.date === date && d.state === fact.semantics.state))
        fail('PERIOD:出来事の日付の役割と状態が不一致です');
    }
  }
  if (fact.kind === 'event' || fact.kind === 'status')
    verifyAssertionState(fact.semantics.state, source);
  else if (
    !['actual', 'forecast', 'forecastBefore', 'forecastAfter'].includes(fact.semantics.state) &&
    !stateSupported(fact.semantics.state, local)
  )
    fail(
      'STATE:状態の根拠がありません。取得予定は取得方法・予定日の段落をcontextIdsで参照してください'
    );
  const allQualifiers = sourceQualifiers(local);
  if (
    fact.semantics.qualifiers !== null &&
    JSON.stringify([...fact.semantics.qualifiers].sort()) !== JSON.stringify(allQualifiers)
  )
    fail(`QUALIFIER:上限・概算・速報等の不一致。原文の限定=${JSON.stringify(allQualifiers)}`);
  const conditions = [
    ...new Map(
      [
        source,
        ...contexts.map((id) => referenceText(pages, [id])),
        ...qualifiers.map((id) => referenceText(pages, [id])),
      ]
        .flatMap(sourceConditions)
        .map((c) => [normalized(c), c])
    ).values(),
  ];
  if (
    fact.semantics.conditions !== null &&
    JSON.stringify(fact.semantics.conditions.map(normalized).sort()) !==
      JSON.stringify(conditions.map(normalized).sort())
  )
    fail(`CONDITION:条件の欠落・不一致。原文の条件文全体=${JSON.stringify(conditions)}`);
  const polarity =
    ev.kind === 'prose' && (fact.kind === 'number' || fact.kind === 'range')
      ? quantityAssertionPolarity(source, fact.label)
      : assertionPolarity(source);
  if (fact.semantics.polarity !== polarity)
    fail(`POLARITY:否定の不一致。完結した原文の区分=${polarity}（混在する文はmixed）`);
  for (const k of ['subject', 'scope', 'basis'] as const) {
    const text = fact.semantics[k];
    if (text !== null && !normalized(scope).includes(normalized(text)))
      fail(
        `SCOPE:${k}の適用根拠。選択した原文=${scope}。scopeIdsには会社・基準のほか対象事業・株式の種類が書かれた見出しを参照します`
      );
  }
  if (
    fact.semantics.subject &&
    !declaredSubjects(pages, scopes).includes(normalized(fact.semantics.subject))
  )
    fail(
      `SCOPE:対象会社名は原文の会社名欄全体が必要です。部分名を採用できません。候補=${JSON.stringify(declaredSubjects(pages, scopes))}`
    );
  if (fact.semantics.scope && fact.semantics.scope === fact.semantics.subject)
    fail(
      'SCOPE:会社名はsubjectです。scopeへ重複して割り当てず、連結/個別/事業/株式の種類が明記されなければscope=nullです'
    );
  if (
    continuation &&
    (!fact.semantics.subject ||
      !normalized(referenceText(pages, continuation.scopeIds)).includes(
        normalized(fact.semantics.subject)
      ) ||
      !continuation.scopeIds.every((id) => scopes.includes(id)))
  )
    fail('SCOPE:継続表の対象会社が不一致');
  const issuerHeading = pages
    .find((p) => p.pageNumber === 1)
    ?.blocks.find((b) => /上場会社名|会社名/.test(normalized(b.text)));
  if ((fact.kind === 'number' || fact.kind === 'range') && issuerHeading && !fact.semantics.subject)
    fail('SCOPE:明記された対象会社を欠く数量です');
  const reportingHeading = pages
    .find((p) => p.pageNumber === 1)
    ?.blocks.find((b) => /決算短信/.test(b.text));
  // Per-share dividends belong to the issuer's shares. A consolidation caption
  // from the financial statements does not establish their security scope.
  if (
    fact.semantics.metricKind === 'perShare' &&
    /配当/.test(fact.label) &&
    ['連結', '非連結', '個別'].includes(fact.semantics.scope ?? '')
  ) {
    const localDeclaration = scopes.some((id) => {
      const b = page.blocks.find((b) => b.id === id || b.spanIds.includes(id));
      return (
        b &&
        b !== reportingHeading &&
        b.y <= atY &&
        /配当|株式/.test(b.text) &&
        normalized(b.text).includes(normalized(fact.semantics.scope!))
      );
    });
    if (!localDeclaration)
      fail('SCOPE:1株当たり配当の対象に財務諸表の連結/個別見出しを転用できません');
  }
  if (fact.semantics.metricKind === 'perShare' && /配当/.test(fact.label) && fact.semantics.basis) {
    const localDeclaration = scopes.some((id) => {
      const b = page.blocks.find((b) => b.id === id || b.spanIds.includes(id));
      return (
        b &&
        b !== reportingHeading &&
        b.y <= atY &&
        /配当|株式/.test(b.text) &&
        normalized(b.text).includes(normalized(fact.semantics.basis!))
      );
    });
    if (!localDeclaration) fail('SCOPE:1株当たり配当へ財務諸表の会計基準を転用できません');
  }
  const section = page.blocks
    .filter((b) => b.y < atY && /^\d+[.．]/.test(normalized(b.text)))
    .sort((a, b) => b.y - a.y)[0];
  if (
    (fact.kind === 'number' || fact.kind === 'range') &&
    section &&
    /概要/.test(section.text) &&
    /株式会社|有限会社/.test(section.text) &&
    (!fact.semantics.subject ||
      !normalized(section.text).includes(normalized(fact.semantics.subject)) ||
      !scopes.some((id) => id === section.id || section.spanIds.includes(id)))
  )
    fail('SCOPE:局所的な会社概要の対象が不一致');
  if (fact.quantity !== null && canonicalJSON(fact.quantity) !== canonicalJSON(quantity))
    fail('QUANTITY:保存した原数量の不一致');
  const sourceId =
    ev.kind === 'prose' ? ev.blockId : page.blocks.find((b) => b.spanIds.includes(ev.valueId))!.id;
  const ownText = ev.kind === 'prose' ? source : page.blocks.find((b) => b.id === sourceId)!.text;
  const dateRoles = [
    { id: sourceId, text: ownText },
    ...contexts.map((id) => ({ id, text: referenceText(pages, [id]) })),
    ...qualifiers.map((id) => ({ id, text: referenceText(pages, [id]) })),
  ].flatMap((item) => datedStates(item.text).map((d) => ({ ...d, sourceId: item.id })));
  if (fact.dateRoles !== null && canonicalJSON(fact.dateRoles) !== canonicalJSON(dateRoles))
    fail('PERIOD:保存した日付役割が原文と不一致です');
  const provenance = sourceProvenance({ ...fact, evidence: resultEvidence }, pages);
  if (
    (fact.id.startsWith('fact-') || fact.provenance !== null) &&
    canonicalJSON(fact.provenance) !== canonicalJSON(provenance)
  )
    fail('REFERENCE:保存した原文範囲・分母・調整基準が不一致です');
  const checked = {
    ...fact,
    quote: source,
    evidence: resultEvidence,
    quantity,
    dateRoles,
    provenance,
    semantics: { ...fact.semantics, qualifiers: allQualifiers, conditions },
  };
  checkSemantics(checked.semantics);
  const id = stableFactId(checked);
  if (fact.id.startsWith('fact-') && fact.id !== id)
    fail('REFERENCE:保存した確定IDが根拠・意味と一致しません');
  return { ...checked, id };
}
