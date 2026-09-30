import {
  checkSemantics,
  exact,
  record,
  stableFactId,
  canonicalJSON,
  type FactSummary,
} from './fact-contract';
import { FACT_KEYS } from './fact-validation';
import { quantityNumber, parseExactQuantity, parseExactRange } from './quantity';
import { toValue } from './score-extraction';
import { classifyMetric } from './metric-semantics';
import {
  assessClaim,
  hasComparableScope,
  SCORE_LIMITS,
  scoreVerdict,
  type ExperimentalScore,
  type ScoreValue,
} from './scoring';
import { renderFacts } from './fact-summary';
/** Shape/integrity validation only. Source meaning is rechecked against the PDF for follow-ups. */
export function validateSavedFacts(value: unknown): asserts value is FactSummary {
  if (
    !record(value) ||
    !exact(value, ['version', 'documentType', 'facts', 'unverified']) ||
    value.version !== 4 ||
    ![
      'earnings',
      'earningsRevision',
      'shareholderBenefit',
      'dividend',
      'shareRepurchase',
      'stockSplit',
      'capitalPolicy',
      'ma',
      'businessUpdate',
      'governance',
      'other',
    ].includes(String(value.documentType)) ||
    !Array.isArray(value.facts) ||
    !value.facts.length ||
    value.facts.length > 20 ||
    !Array.isArray(value.unverified) ||
    !value.unverified.every((x) => typeof x === 'string')
  )
    throw new Error('保存された事実v4の形式が不正です');
  const ids = new Set<string>();
  for (const fact of value.facts) {
    if (
      !record(fact) ||
      !exact(fact, FACT_KEYS) ||
      typeof fact.id !== 'string' ||
      !/^fact-[a-f0-9]{16}$/.test(fact.id) ||
      ids.has(fact.id) ||
      !['key', 'detail'].includes(String(fact.importance)) ||
      !['number', 'range', 'event', 'status'].includes(String(fact.kind)) ||
      typeof fact.label !== 'string' ||
      !fact.label ||
      typeof fact.quote !== 'string' ||
      !Number.isInteger(fact.page) ||
      Number(fact.page) < 1 ||
      fact.column !== null ||
      ![null, 'actual', 'forecast', 'forecastBefore', 'forecastAfter'].includes(
        fact.valueKind as string | null
      ) ||
      !(fact.period === null || typeof fact.period === 'string')
    )
      throw new Error('保存された事実の項目が不正です');
    ids.add(fact.id);
    checkSemantics(fact.semantics);
    if (
      !Array.isArray(fact.dateRoles) ||
      !fact.dateRoles.every(
        (d) =>
          record(d) &&
          exact(d, ['date', 'state', 'sourceId']) &&
          typeof d.date === 'string' &&
          /^20\d{2}年\d{1,2}月\d{1,2}日$/.test(d.date) &&
          [
            'planned',
            'decided',
            'contracted',
            'reference',
            'periodStart',
            'periodEnd',
            'unspecified',
          ].includes(String(d.state)) &&
          typeof d.sourceId === 'string' &&
          /^p\d+[sb]\d+$/.test(d.sourceId)
      )
    )
      throw new Error('保存された日付役割が不正です');
    const ev = fact.evidence;
    if (!record(ev) || !['table', 'prose'].includes(String(ev.kind)))
      throw new Error('保存された根拠形式が不正です');
    const groupKeys =
      ev.kind === 'table'
        ? ['metricIds', 'periodIds', 'unitIds', 'contextIds', 'scopeIds', 'qualifierIds']
        : ['contextIds', 'scopeIds', 'qualifierIds'];
    if (
      !exact(ev, ['kind', ev.kind === 'table' ? 'valueId' : 'blockId', ...groupKeys]) ||
      typeof ev[ev.kind === 'table' ? 'valueId' : 'blockId'] !== 'string' ||
      !groupKeys.every(
        (k) =>
          Array.isArray(ev[k]) &&
          (ev[k] as unknown[]).length <= 32 &&
          (ev[k] as unknown[]).every((id) => typeof id === 'string' && /^p\d+[sb]\d+$/.test(id))
      )
    )
      throw new Error('保存された根拠IDが不正です');
    if (fact.kind === 'number') {
      const q = fact.quantity;
      if (
        typeof fact.value !== 'number' ||
        typeof fact.unit !== 'string' ||
        !fact.unit ||
        fact.statement !== null ||
        !record(q) ||
        !exact(q, ['raw', 'decimal', 'sourceIds']) ||
        typeof q.raw !== 'string' ||
        typeof q.decimal !== 'string' ||
        parseExactQuantity(q.raw)?.decimal !== q.decimal ||
        quantityNumber(q.decimal)?.value !== fact.value ||
        !Array.isArray(q.sourceIds) ||
        !q.sourceIds.length ||
        !q.sourceIds.every((id) => typeof id === 'string' && /^p\d+i\d+$/.test(id))
      )
        throw new Error('保存された原数量が不正です');
    } else if (fact.kind === 'range') {
      const q = fact.quantity,
        parsed = record(q) && typeof q.raw === 'string' ? parseExactRange(q.raw) : null;
      if (
        fact.value !== null ||
        typeof fact.unit !== 'string' ||
        !fact.unit ||
        fact.statement !== null ||
        !record(q) ||
        !exact(q, ['raw', 'decimal', 'lower', 'upper', 'sourceIds']) ||
        q.decimal !== null ||
        !parsed ||
        q.lower !== parsed.lower ||
        q.upper !== parsed.upper ||
        !Array.isArray(q.sourceIds) ||
        !q.sourceIds.length ||
        !q.sourceIds.every((id) => typeof id === 'string' && /^p\d+i\d+$/.test(id))
      )
        throw new Error('保存された数量範囲が不正です');
    } else if (
      fact.value !== null ||
      fact.unit !== null ||
      fact.quantity !== null ||
      fact.valueKind !== null ||
      typeof fact.statement !== 'string' ||
      fact.statement.normalize('NFKC').replace(/\s/g, '') !==
        fact.quote.normalize('NFKC').replace(/\s/g, '')
    )
      throw new Error('保存された完結原文が不正です');
  }
  for (const fact of (value as unknown as FactSummary).facts)
    if (stableFactId(fact) !== fact.id) throw new Error('保存された確定事実IDと内容が不一致です');
  renderFacts(value as unknown as FactSummary);
}

/** Reject malformed cached scores and current-source mutations; this is not PDF semantic proof. */
export function validateSavedScore(
  value: unknown,
  facts: FactSummary,
  pdfUrl: string
): asserts value is ExperimentalScore {
  if (
    !record(value) ||
    !exact(value, [
      'value',
      'verdict',
      'positives',
      'negatives',
      'breakdown',
      'unverified',
      'searchStatus',
    ]) ||
    typeof value.value !== 'number' ||
    !Number.isInteger(value.value) ||
    value.value < 0 ||
    value.value > 100 ||
    value.verdict !== scoreVerdict(value.value) ||
    typeof value.searchStatus !== 'string' ||
    !['positives', 'negatives', 'unverified'].every(
      (k) => Array.isArray(value[k]) && (value[k] as unknown[]).every((x) => typeof x === 'string')
    ) ||
    !Array.isArray(value.breakdown) ||
    !value.breakdown.length ||
    value.breakdown.length > 12
  )
    throw new Error('保存された採点の形式が不正です');
  const check = (v: unknown): ScoreValue => {
    if (
      !record(v) ||
      !exact(v, ['value', 'unit', 'source']) ||
      typeof v.value !== 'number' ||
      !Number.isFinite(v.value) ||
      typeof v.unit !== 'string' ||
      !record(v.source) ||
      !exact(v.source, [
        'url',
        'page',
        'quote',
        'evidence',
        'period',
        'fiscalYear',
        'periodKind',
        'valueKind',
        'metric',
        'basis',
        'scope',
        'factId',
        'semantics',
      ])
    )
      throw new Error('保存された比較値の形式が不正です');
    const s = v.source;
    checkSemantics(s.semantics);
    if (
      !['url', 'quote', 'period', 'metric', 'factId'].every((k) => typeof s[k] === 'string') ||
      !hasComparableScope(s.scope, String(s.metric), s.semantics.metricKind, v.unit) ||
      s.semantics.metricKind !== classifyMetric(String(s.metric), v.unit) ||
      !/^fact-[a-f0-9]{16}$/.test(String(s.factId)) ||
      !Number.isInteger(s.page) ||
      Number(s.page) < 1 ||
      !Number.isInteger(s.fiscalYear) ||
      s.periodKind !== s.semantics.periodKind ||
      s.valueKind !== s.semantics.state ||
      s.scope !== s.semantics.scope ||
      s.basis !== s.semantics.basis
    )
      throw new Error('保存された比較値の意味属性が不正です');
    if (
      s.evidence !== null &&
      (!record(s.evidence) ||
        !exact(s.evidence, ['valueId', 'metricIds', 'periodIds', 'unitIds', 'contextIds']) ||
        typeof s.evidence.valueId !== 'string' ||
        !['metricIds', 'periodIds', 'unitIds', 'contextIds'].every(
          (k) =>
            Array.isArray((s.evidence as Record<string, unknown>)[k]) &&
            ((s.evidence as Record<string, unknown>)[k] as unknown[]).every(
              (id: unknown) => typeof id === 'string'
            )
        ))
    )
      throw new Error('保存された比較値の根拠が不正です');
    return v as unknown as ScoreValue;
  };
  for (const b of value.breakdown) {
    if (
      !record(b) ||
      !exact(b, [
        'category',
        'label',
        'impact',
        'strength',
        'current',
        'previous',
        'earlier',
        'comparison',
        'companyExplanation',
        'relatedValue',
      ]) ||
      !(String(b.category) in SCORE_LIMITS) ||
      typeof b.label !== 'string' ||
      !['positive', 'negative', 'neutral'].includes(String(b.impact)) ||
      !['small', 'medium', 'large'].includes(String(b.strength)) ||
      !(b.companyExplanation === null || typeof b.companyExplanation === 'string') ||
      typeof b.comparison !== 'string'
    )
      throw new Error('保存された採点内訳が不正です');
    const current = check(b.current),
      fact = facts.facts.find((f) => f.id === current.source.factId);
    if (!fact || current.source.url !== pdfUrl)
      throw new Error('保存された採点の元事実がありません');
    const expected = toValue(fact, {
      url: pdfUrl,
      pages: [],
      text: '',
      publishedDate: null,
      issuer: '',
      code: '',
    });
    if (canonicalJSON(expected) !== canonicalJSON(current))
      throw new Error('保存された採点の数量・意味が確定事実と不一致です');
    for (const k of ['previous', 'earlier', 'relatedValue']) if (b[k] !== null) check(b[k]);
    if (assessClaim(b as unknown as import('./scoring').ScoreClaim) !== b.comparison)
      throw new Error('保存された比較条件が不一致です');
  }
}
