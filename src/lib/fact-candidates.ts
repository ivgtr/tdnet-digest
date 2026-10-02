import type { ExtractedPage } from '@/types/summaryMetadata';
import type { DocumentType } from './document-type';
import {
  exact,
  record,
  checkSemantics,
  type CandidateFact,
  type FactSemantics,
  type VerifiedFact,
} from './fact-contract';
import {
  bindingFor,
  buildDocumentContext,
  resolveScopeIds,
  isFinancialUnit,
  applicableDeclarations,
  type DocumentContext,
} from './document-context';
import { coverageReport } from './fact-coverage';
import { continuationSpans } from './document-links';
import { sourceDateOptions } from './source-periods';
import { uniqueTableMapping } from './source-mappings';
import {
  parseExactQuantity,
  parseExactRange,
  quantityNumber,
  declaredQuantityUnit,
} from './quantity';
import { verifyPeriodAndKind, verifyProsePeriod, verifyTableEvidence } from './numeric-evidence';
import { classifyMetric } from './metric-semantics';
import { validateFact, periodKind } from './fact-validation';
import { assertionPolarity, assertionStates, verifyAssertionState } from './assertion-semantics';

export const CANDIDATE_VERSION = 2;
export interface Candidate {
  candidateId: string;
  importance: VerifiedFact['importance'];
  kind: VerifiedFact['kind'];
  source:
    | {
        kind: 'table';
        valueId: string;
        contextBindingId: string;
      }
    | {
        kind: 'prose';
        blockId: string;
        quantityId: string | null;
        metric: string | null;
        contextBindingId: string;
      };
  meaning: Omit<FactSemantics, 'qualifiers' | 'conditions'> & { period: string | null };
}
export interface Diagnostic {
  candidateId: string | null;
  sourceKey: string | null;
  check: string;
  status: 'valid' | 'invalid' | 'blocked';
  message: string;
}
export interface CandidateReview {
  facts: VerifiedFact[];
  reportedUnverified: string[];
  candidateSources: Map<string, Candidate['source']>;
  unverified: string[];
  diagnostics: Diagnostic[];
  envelopeValid: boolean;
}
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
export function proseQuantities(block: { id: string; text: string }) {
  return [
    ...block.text
      .normalize('NFKC')
      .matchAll(
        /[△▲−-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:[～〜~][△▲−-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)?(?:(?:百万|千|億)?円|[%％]|株|人|件|店舗|社|個|ドル|USD|EUR)/g
      ),
  ].map((m, i) => ({ id: `${block.id}:q${i + 1}`, raw: m[0], start: m.index }));
}
export function factSourceKey(f: VerifiedFact): string {
  return JSON.stringify(
    f.evidence.kind === 'table'
      ? ['table', f.evidence.valueId, f.evidence.metricIds, f.evidence.periodIds]
      : [
          'prose',
          f.evidence.blockId,
          f.kind === 'event' || f.kind === 'status' ? 'assertion' : [f.label, f.quantity?.raw],
          ...(f.kind === 'event' || f.kind === 'status' ? [] : [f.period]),
        ]
  );
}
export function checkCandidate(item: unknown): asserts item is Candidate {
  if (
    !record(item) ||
    !exact(item, ['candidateId', 'importance', 'kind', 'source', 'meaning']) ||
    typeof item.candidateId !== 'string' ||
    !/^c\d+$/.test(item.candidateId) ||
    !['key', 'detail'].includes(String(item.importance)) ||
    !['number', 'range', 'event', 'status'].includes(String(item.kind))
  )
    throw new Error('SCHEMA:候補項目の形式が不正です');
  if (!record(item.source) || typeof item.source.contextBindingId !== 'string')
    throw new Error('SCHEMA:候補の原文単位が不正です');
  const s = item.source;
  if (s.kind === 'table') {
    if (!exact(s, ['kind', 'valueId', 'contextBindingId']) || typeof s.valueId !== 'string')
      throw new Error('SCHEMA:表候補の形式が不正です');
  } else if (s.kind === 'prose') {
    if (
      !exact(s, ['kind', 'blockId', 'quantityId', 'metric', 'contextBindingId']) ||
      typeof s.blockId !== 'string' ||
      ![s.quantityId, s.metric].every((v) => v === null || typeof v === 'string')
    )
      throw new Error('SCHEMA:本文候補の形式が不正です');
  } else throw new Error('SCHEMA:未知の原文形式です');
  if (
    !record(item.meaning) ||
    !exact(item.meaning, [
      'subject',
      'scope',
      'basis',
      'period',
      'periodKind',
      'metricKind',
      'state',
      'polarity',
    ]) ||
    !(item.meaning.period === null || typeof item.meaning.period === 'string')
  )
    throw new Error('SCHEMA:意味候補の形式が不正です');
  const { period: _period, ...meaning } = item.meaning;
  void _period;
  try {
    checkSemantics({ ...meaning, qualifiers: null, conditions: null }, true);
  } catch (e) {
    throw new Error(`SCHEMA:${message(e)}`);
  }
}
function compose(
  candidate: Candidate,
  pages: ExtractedPage[],
  context: DocumentContext,
  diagnostics: Diagnostic[]
): CandidateFact {
  const s =
    candidate.source.kind === 'table'
      ? {
          ...candidate.source,
          ...uniqueTableMapping(context.tableMappings, candidate.source.valueId),
        }
      : candidate.source;
  const anchor = s.kind === 'table' ? s.valueId : s.blockId;
  const binding = bindingFor(context, anchor);
  if (s.contextBindingId !== binding.id)
    throw new Error('REFERENCE:別の原文単位の文脈を適用できません');
  const page = pages.find((p) => p.pageNumber === binding.page)!;
  if (page.selection !== 'selected')
    throw new Error('REFERENCE:未選択ページの事実は採用できません');
  const block = page.blocks.find((b) => b.id === binding.blockId)!;
  const text = (ids: string[]) =>
    ids
      .map(
        (id) =>
          pages.flatMap((p) => p.spans).find((x) => x.id === id)?.text ??
          (() => {
            throw new Error(`REFERENCE:span ${id} がありません`);
          })()
      )
      .join('');
  const numeric = candidate.kind === 'number' || candidate.kind === 'range';
  const quantity =
    s.kind === 'table'
      ? page.quantities.find((q) => q.id === s.valueId)
      : proseQuantities(block).find((q) => q.id === s.quantityId);
  if (numeric && !quantity) throw new Error('QUANTITY:数量全断片の原文単位がありません');
  if (s.kind === 'prose' && !numeric && (s.quantityId !== null || s.metric !== null))
    throw new Error('SCHEMA:出来事に数量・指標を設定できません');
  if (s.kind === 'table' && !numeric) throw new Error('SCHEMA:表を出来事へ変換できません');
  if (s.kind === 'prose' && numeric && quantity && 'raw' in quantity) {
    const escaped = (s.metric ?? '')
      .normalize('NFKC')
      .replace(/\s/g, '')
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const prefix = new RegExp(
      `${escaped}(?:について|に関して|に対して|において|として|[はがをにでと、:()])*`,
      'g'
    );
    const normalizedSource = block.text.normalize('NFKC');
    const plain = normalizedSource.replace(/\s/g, '');
    const positions = [...plain.matchAll(prefix)].map((m) => m.index! + m[0].length);
    const at = normalizedSource.slice(0, quantity.start).replace(/\s/g, '').length;
    if (!positions.includes(at)) throw new Error('QUANTITY:選択した数量は指標に直接対応しません');
  }
  const raw = quantity ? ('text' in quantity ? quantity.text : quantity.raw) : '';
  const parsed = numeric
    ? candidate.kind === 'range'
      ? parseExactRange(raw)
      : parseExactQuantity(raw)
    : null;
  if (numeric && !parsed) throw new Error('QUANTITY:不正な原数量です');
  const label = s.kind === 'table' ? text(s.metricIds) : numeric ? s.metric : block.text;
  if (!label) throw new Error('METRIC:指標がありません');
  const inlineUnit = parsed?.unit;
  const units = s.kind === 'table' ? s.unitIds.filter((id) => id !== s.valueId) : [];
  const unitText = numeric
    ? s.kind === 'table'
      ? (s.unitIds.includes(s.valueId) ? (inlineUnit ?? '') : '') + text(units)
      : inlineUnit
    : null;
  // 円銭 is a declared decimal-yen column convention, not a silent unknown-unit conversion.
  const declaredUnit = unitText?.normalize('NFKC').replace(/\s/g, '') ?? null;
  const unit = declaredUnit === null ? null : declaredQuantityUnit(declaredUnit);
  if (numeric && unit === null) throw new Error('QUANTITY:未対応・不正な単位宣言です');
  const value = parsed && 'decimal' in parsed ? quantityNumber(parsed.decimal)?.value : null;
  if (candidate.kind === 'number' && value === undefined)
    throw new Error('QUANTITY:数値化で精度を失います');
  const { period, ...meaning } = candidate.meaning;
  const base: CandidateFact = {
    id: `f${candidate.candidateId.slice(1)}`,
    importance: candidate.importance,
    kind: candidate.kind,
    label,
    value: value ?? null,
    unit: unit ?? null,
    period,
    valueKind:
      numeric && ['actual', 'forecast', 'forecastBefore', 'forecastAfter'].includes(meaning.state)
        ? (meaning.state as VerifiedFact['valueKind'])
        : null,
    column: null,
    statement: numeric ? null : block.text,
    page: page.pageNumber,
    quote: s.kind === 'table' ? '' : block.text,
    evidence:
      s.kind === 'table'
        ? {
            kind: 'table',
            valueId: s.valueId,
            metricIds: s.metricIds,
            periodIds: s.periodIds,
            unitIds: s.unitIds,
            contextIds: binding.contextIds,
            scopeIds: [],
            qualifierIds: binding.qualifierIds,
          }
        : {
            kind: 'prose',
            blockId: s.blockId,
            contextIds: binding.contextIds,
            scopeIds: [],
            qualifierIds: binding.qualifierIds,
          },
    semantics: { ...meaning, qualifiers: null, conditions: null },
    quantity: null,
    dateRoles: null,
  };
  if (s.kind === 'prose' && block.kind !== 'paragraph')
    throw new Error('STRUCTURE:表を本文候補で代用できません');
  if (s.kind === 'table')
    verifyTableEvidence(
      { ...page, spans: continuationSpans(pages, page, s.valueId) },
      {
        valueId: s.valueId,
        metricIds: s.metricIds,
        periodIds: s.periodIds,
        unitIds: s.unitIds,
        contextIds: binding.contextIds,
      },
      {
        label,
        value: base.value,
        unit: base.unit!,
        period: period ?? '',
        valueKind: base.valueKind ?? 'actual',
        range: candidate.kind === 'range',
      },
      false
    );
  const financial = isFinancialUnit(
    { ...base, semantics: { ...meaning, qualifiers: [], conditions: [] } },
    binding,
    pages
  );
  // Independent meaning checks run only after source ownership is resolved.
  const attempt = (check: string, fn: () => void) => {
    try {
      fn();
      diagnostics.push({
        candidateId: candidate.candidateId,
        sourceKey: anchor,
        check,
        status: 'valid',
        message: '原文との照合を通過',
      });
    } catch (e) {
      diagnostics.push({
        candidateId: candidate.candidateId,
        sourceKey: anchor,
        check,
        status: /^STRUCTURE:|曖昧|複数の主張状態|未対応|原文で確定できる区分=unspecified/.test(
          message(e)
        )
          ? 'blocked'
          : 'invalid',
        message: message(e),
      });
    }
  };
  for (const role of ['subject', 'scope', 'basis'] as const)
    attempt(`scope.${role}`, () => {
      base.evidence.scopeIds.push(...resolveScopeIds(binding, meaning, financial, [role]));
    });
  base.evidence.scopeIds = [...new Set(base.evidence.scopeIds)];
  const applicableText = binding.contextIds
    .map((id) => {
      const b = pages.flatMap((p) => p.blocks).find((b) => b.id === id);
      return b?.text ?? pages.flatMap((p) => p.spans).find((s) => s.id === id)?.text ?? '';
    })
    .join('\n');
  if (numeric) {
    attempt('metric', () => {
      if (meaning.metricKind !== classifyMetric(label, unit))
        throw new Error('METRIC:原文指標・単位と量の種類が不一致です');
    });
    attempt('period', () => {
      const axis = s.kind === 'table' ? text(s.periodIds) : block.text;
      if (s.kind === 'prose')
        verifyProsePeriod(
          {
            label,
            value: base.value,
            unit: base.unit!,
            period: period ?? '',
            valueKind: base.valueKind ?? '',
          },
          axis,
          applicableText
        );
      if (meaning.periodKind !== periodKind(period, axis + applicableText))
        throw new Error('PERIOD:期間区分の不一致です');
      if (['actual', 'forecast', 'forecastBefore', 'forecastAfter'].includes(meaning.state))
        verifyPeriodAndKind(
          {
            label,
            value: base.value,
            unit: base.unit!,
            period: period ?? '',
            valueKind: meaning.state as NonNullable<VerifiedFact['valueKind']>,
            range: candidate.kind === 'range',
          },
          axis,
          applicableText,
          ''
        );
    });
    if (s.kind === 'prose' && assertionStates(block.text + '\n' + applicableText).length)
      attempt('state', () =>
        verifyAssertionState(meaning.state, block.text + '\n' + applicableText)
      );
  } else
    attempt('period', () => {
      if (meaning.periodKind !== periodKind(period, block.text))
        throw new Error('PERIOD:出来事の期間区分が不一致です');
      const relative = [
        ...new Set(
          block.text
            .normalize('NFKC')
            .replace(/\s/g, '')
            .match(/(?:翌|次|当|前)連結会計年度/g) ?? []
        ),
      ];
      if (relative.length > 1 || (relative.length === 1 && period !== relative[0]))
        throw new Error('PERIOD:原文の相対年度が欠落・不一致です');
    });
  if (!numeric) attempt('state', () => verifyAssertionState(meaning.state, block.text));
  attempt('polarity', () => {
    if (
      meaning.polarity !==
      assertionPolarity(s.kind === 'table' ? text(s.metricIds) + text(s.periodIds) : block.text)
    )
      throw new Error('POLARITY:原文の否定区分が不一致です');
  });
  return base;
}
export function reviewCandidates(
  raw: string,
  type: DocumentType,
  pages: ExtractedPage[],
  context = buildDocumentContext(pages)
): CandidateReview {
  const result: CandidateReview = {
    facts: [],
    reportedUnverified: [],
    candidateSources: new Map(),
    unverified: [],
    diagnostics: [],
    envelopeValid: false,
  };
  try {
    const parsed: unknown = JSON.parse(raw.trim());
    if (
      !record(parsed) ||
      !exact(parsed, ['candidateVersion', 'documentType', 'candidates', 'unverified']) ||
      parsed.candidateVersion !== CANDIDATE_VERSION ||
      parsed.documentType !== type ||
      !Array.isArray(parsed.candidates) ||
      parsed.candidates.length > 20 ||
      !Array.isArray(parsed.unverified) ||
      !parsed.unverified.every((x) => typeof x === 'string' && x.length <= 1000)
    )
      throw new Error('SCHEMA:候補応答の形式が不正です（candidateVersion=2が必要）');
    const ids = new Set<string>();
    for (const item of parsed.candidates) {
      if (!record(item) || typeof item.candidateId !== 'string' || ids.has(item.candidateId))
        throw new Error('SCHEMA:候補IDの形式・重複');
      ids.add(item.candidateId);
    }
    result.envelopeValid = true;
    result.reportedUnverified = [...parsed.unverified] as string[];
    result.unverified = [...result.reportedUnverified];
    for (const item of parsed.candidates) {
      let anchor: string | null = null;
      const start = result.diagnostics.length;
      try {
        if (record(item) && record(item.source)) {
          const id = item.source.kind === 'table' ? item.source.valueId : item.source.blockId;
          if (typeof id === 'string') anchor = id;
        }
        checkCandidate(item);
        result.candidateSources.set(item.candidateId, item.source);
        anchor = item.source.kind === 'table' ? item.source.valueId : item.source.blockId;
        const fact = compose(item, pages, context, result.diagnostics);
        if (!result.diagnostics.slice(start).some((d) => d.status !== 'valid')) {
          const checked = validateFact(fact, pages, context);
          const previous = result.facts.find((f) => factSourceKey(f) === factSourceKey(checked));
          if (previous && previous.id !== checked.id)
            throw new Error('SEMANTICS:同一原文単位の意味候補が競合します');
          if (!previous) result.facts.push(checked);
        }
      } catch (e) {
        result.diagnostics.push({
          candidateId: record(item) ? String(item.candidateId) : null,
          sourceKey: anchor,
          check: message(e).split(':')[0],
          status: /^(SCHEMA|REFERENCE|QUANTITY|STRUCTURE)|^表の根拠を確認できません/.test(
            message(e)
          )
            ? 'blocked'
            : 'invalid',
          message: message(e),
        });
      }
    }
  } catch (e) {
    result.diagnostics.push({
      candidateId: null,
      sourceKey: null,
      check: 'envelope',
      status: 'blocked',
      message: message(e),
    });
  }
  result.unverified.push(
    ...result.diagnostics
      .filter((d) => d.status !== 'valid')
      .map((d) => `${d.candidateId ?? '応答'} ${d.message}`)
  );
  return result;
}
export function serializeCandidateSource(
  pages: ExtractedPage[],
  context = buildDocumentContext(pages),
  documentType?: DocumentType
): string {
  const selected = pages.filter((p) => p.selection === 'selected');
  const hintsByPage = new Map(
    selected.map((p) => [
      p.pageNumber,
      context.tableMappings.filter((h) => p.quantities.some((q) => q.id === h.valueId)),
    ])
  );
  const declarations: Array<Record<string, unknown>> = [],
    templates: Array<Record<string, unknown>> = [];
  const declarationIds = new Map<string, string>(),
    templateIds = new Map<string, string>();
  const units: Record<string, string> = {};
  for (const b of context.bindings.filter((b) => selected.some((p) => p.pageNumber === b.page))) {
    const owner = selected
      .find((p) => p.pageNumber === b.page)!
      .blocks.find((block) => block.id === b.blockId)!;
    if ((owner.kind === 'paragraph') !== (b.anchorId === b.blockId)) continue;
    const ds = [...new Set(b.declarations.map((d) => JSON.stringify(d)))].map((key) => {
      if (!declarationIds.has(key)) {
        const id = `d${declarations.length + 1}`;
        declarationIds.set(key, id);
        const declaration = JSON.parse(key);
        declarations.push({ ...declaration, sourceId: declaration.id, id });
      }
      return declarationIds.get(key)!;
    });
    const ownerPage = selected.find((p) => p.pageNumber === b.page)!;
    const hint = hintsByPage.get(ownerPage.pageNumber)!.find((h) => h.valueId === b.anchorId);
    const metric = hint
      ? hint.metricIds
          .map((id) => pages.flatMap((p) => p.spans).find((s) => s.id === id)!.text)
          .join('')
      : owner.text;
    const sourceUnit = hint
      ? hint.unitIds
          .map((id) =>
            id === hint.valueId
              ? (parseExactQuantity(ownerPage.quantities.find((q) => q.id === id)!.text)?.unit ??
                '')
              : pages.flatMap((p) => p.spans).find((s) => s.id === id)!.text
          )
          .join('')
      : null;
    const financial = isFinancialUnit(
      {
        kind: b.anchorId === b.blockId ? 'event' : 'number',
        label: metric,
        quote: owner.text,
        semantics: {
          subject: null,
          scope: null,
          basis: null,
          periodKind: 'none',
          metricKind: classifyMetric(
            metric,
            sourceUnit === null ? null : declaredQuantityUnit(sourceUnit)
          ),
          qualifiers: [],
          conditions: [],
          state: 'unspecified',
          polarity: 'affirmative',
        },
      },
      b,
      pages
    );
    const meaningOptions = Object.fromEntries(
      (['subject', 'scope', 'basis'] as const).map((role) => [
        role,
        [...new Set(applicableDeclarations(b, role, financial).map((d) => d.value))],
      ])
    );
    const template = {
      contextIds: b.contextIds,
      declarationIds: ds,
      qualifierIds: b.qualifierIds,
      meaningOptions,
      dateOptions: sourceDateOptions(b, pages),
    };
    const key = JSON.stringify(template);
    if (!templateIds.has(key)) {
      const id = `t${templates.length + 1}`;
      templateIds.set(key, id);
      templates.push({ id, ...template });
    }
    units[b.anchorId] = templateIds.get(key)!;
  }
  const sourcePages = selected.map((p) => {
    const hints = hintsByPage.get(p.pageNumber)!;
    const tableRefs = new Set([
      ...p.blocks.filter((b) => b.kind === 'row').flatMap((b) => b.spanIds),
      ...hints.flatMap((h) => [...h.metricIds, ...h.periodIds, ...h.unitIds, ...h.contextIds]),
      ...context.bindings.filter((b) => b.page === p.pageNumber).flatMap((b) => b.contextIds),
    ]);
    return {
      page: p.pageNumber,
      blocks: p.blocks.map((b) => ({
        id: b.id,
        kind: b.kind,
        ...(b.kind === 'paragraph'
          ? { text: b.text, quantities: proseQuantities(b) }
          : { spanIds: b.spanIds }),
      })),
      // Coordinates are rounded hints for selection; original coordinates/items
      // are retained untouched and used by the verifier.
      spans: p.spans
        .filter((s) => tableRefs.has(s.id))
        .map((s) => [s.id, s.text, Math.round(s.x * 10) / 10, Math.round(s.y * 10) / 10]),
      quantities: p.quantities
        .filter((q) => p.blocks.some((b) => b.kind === 'row' && b.spanIds.includes(q.id)))
        .map((q) => ({ id: q.id, text: q.text, spanIds: q.spanIds })),
      hints,
    };
  });
  return JSON.stringify({
    ...(documentType
      ? {
          obligations: coverageReport(documentType, pages, [], [], context).filter(
            (s) => s.status !== 'outsideSelection'
          ),
        }
      : {}),
    declarations,
    contextTemplates: templates,
    unitContexts: units,
    spanFormat: ['id', 'text', 'x', 'y'],
    pages: sourcePages,
  });
}
