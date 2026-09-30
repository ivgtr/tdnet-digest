import { generateText, type LLMConfig } from './llm-client';
import { generateVerifiedFactSummary, type FactSummary, type VerifiedFact } from './fact-summary';
import type { ExtractedPage } from '@/types/summaryMetadata';
import { getProviderCapabilities } from './structured-output';
import { record, exact } from './fact-contract';
import { standardMetric } from './fact-coverage';
import { classifyMetric } from './metric-semantics';
import {
  compatible,
  hasComparableScope,
  SCORE_LIMITS,
  type ScoreClaim,
  type ScoreInput,
  type ScoreValue,
  type ScoreCategory,
} from './scoring';
export interface ScoreDocument {
  url: string;
  text: string;
  pages: ExtractedPage[];
  publishedDate: string | null;
  issuer: string;
  code: string;
}
export interface ScoreFacts {
  document: ScoreDocument;
  facts: FactSummary;
}
export function toValue(fact: VerifiedFact, document: ScoreDocument): ScoreValue {
  if (
    fact.kind !== 'number' ||
    fact.value === null ||
    !fact.unit ||
    !fact.period ||
    !fact.quantity ||
    !hasComparableScope(fact.semantics.scope, fact.label, fact.semantics.metricKind, fact.unit) ||
    !fact.semantics.subject ||
    fact.semantics.polarity !== 'affirmative' ||
    fact.semantics.state === 'unspecified' ||
    ['interval', 'relativeYear', 'none'].includes(fact.semantics.periodKind)
  )
    throw new Error('比較可能な数値・期間・主体・範囲がありません');
  if (fact.semantics.metricKind !== classifyMetric(fact.label, fact.unit))
    throw new Error('採点の指標区分と原文指標・単位が一致しません');
  const fiscalYear = Number(fact.period.normalize('NFKC').match(/(20\d{2})年/)?.[1]);
  if (!Number.isInteger(fiscalYear)) throw new Error('対象年がありません');
  if (fact.semantics.basis === null && fact.semantics.metricKind === 'amount')
    throw new Error('財務数量の会計基準を確認できません');
  if (
    standardMetric(fact) &&
    /損失/.test(fact.label) &&
    !/利益.*損失/.test(fact.label) &&
    fact.value >= 0
  )
    throw new Error('正の損失額を符号付き利益へ暗黙変換して採点できません');
  return {
    value: fact.value,
    unit: fact.unit,
    source: {
      url: document.url,
      page: fact.page,
      quote: fact.quote,
      evidence:
        fact.evidence.kind === 'table'
          ? {
              valueId: fact.evidence.valueId,
              metricIds: fact.evidence.metricIds,
              periodIds: fact.evidence.periodIds,
              unitIds: fact.evidence.unitIds,
              contextIds: fact.evidence.contextIds,
            }
          : null,
      period: fact.period,
      fiscalYear,
      periodKind: fact.semantics.periodKind as ScoreValue['source']['periodKind'],
      valueKind: fact.semantics.state as ScoreValue['source']['valueKind'],
      metric: fact.label,
      basis: fact.semantics.basis,
      scope: fact.semantics.scope,
      factId: fact.id,
      semantics: fact.semantics,
    },
  };
}
export function validateScoreInput(
  raw: string,
  registry: ScoreFacts[],
  searchStatus: string
): ScoreInput {
  const parsed: unknown = JSON.parse(raw.trim());
  if (
    !record(parsed) ||
    !exact(parsed, ['version', 'claims', 'unverified']) ||
    parsed.version !== 4 ||
    !Array.isArray(parsed.claims) ||
    parsed.claims.length > 12 ||
    !Array.isArray(parsed.unverified) ||
    !parsed.unverified.every((x) => typeof x === 'string')
  )
    throw new Error('採点入力v4の形式が不正です');
  const claims: ScoreClaim[] = [],
    unverified = [...parsed.unverified] as string[];
  const find = (id: unknown): { fact: VerifiedFact; document: ScoreDocument } => {
    if (typeof id !== 'string') throw new Error('事実IDが不正です');
    const hits = registry.flatMap((entry) =>
      entry.facts.facts
        .filter((f) => f.id === id)
        .map((fact) => ({ fact, document: entry.document }))
    );
    if (hits.length !== 1) throw new Error('事実IDの参照先がない、または資料間で曖昧です');
    const { document } = hits[0],
      original = registry[0].document;
    if (
      document !== original &&
      (!original.publishedDate ||
        !document.publishedDate ||
        document.publishedDate > original.publishedDate ||
        document.code !== original.code)
    )
      throw new Error('比較資料の発行会社・開示日の対応');
    return hits[0];
  };
  for (const rawClaim of parsed.claims) {
    try {
      if (
        !record(rawClaim) ||
        !exact(rawClaim, [
          'category',
          'label',
          'current',
          'previous',
          'earlier',
          'relatedValue',
          'companyExplanation',
        ]) ||
        !(String(rawClaim.category) in SCORE_LIMITS) ||
        typeof rawClaim.label !== 'string'
      )
        throw new Error('採点項目の形式');
      const selected = find(rawClaim.current);
      if (selected.document !== registry[0].document)
        throw new Error('currentは元資料の確定事実IDに限ります');
      const value = (id: unknown) => {
        const selected = find(id);
        return toValue(selected.fact, selected.document);
      };
      const current = toValue(selected.fact, selected.document),
        previous = rawClaim.previous === null ? null : value(rawClaim.previous),
        earlier = rawClaim.earlier === null ? null : value(rawClaim.earlier),
        relatedValue = rawClaim.relatedValue === null ? null : value(rawClaim.relatedValue);
      const category = rawClaim.category as ScoreCategory;
      const metric = standardMetric(selected.fact);
      if (
        (category === 'operatingProfit' && metric !== 'operatingProfit') ||
        (category === 'revenue' && metric !== 'revenue') ||
        (category === 'coreForecast' &&
          (metric !== 'operatingProfit' ||
            !['forecast', 'forecastAfter'].includes(selected.fact.semantics.state))) ||
        (category === 'margin' && selected.fact.semantics.metricKind !== 'rate') ||
        (category === 'shareholderReturn' &&
          !/配当|取得.*株式|株式.*取得/.test(selected.fact.label)) ||
        (category === 'oneOff' && !/純利益|純損失/.test(selected.fact.label)) ||
        (category === 'cashFlow' && !/キャッシュ.*フロー|現金/.test(selected.fact.label))
      )
        throw new Error('採点分類と確定した指標の意味が一致しません');
      if (
        previous &&
        !compatible(
          current,
          previous,
          !['operatingProfit', 'revenue', 'margin', 'kpi', 'cashFlow'].includes(category)
        )
      )
        throw new Error('比較の指標・期間・範囲・状態・限定が一致しません');
      if (earlier && (!previous || !compatible(previous, earlier)))
        throw new Error('前々期の対応が一致しません');
      if (category === 'oneOff' && !relatedValue) throw new Error('一時損益の金額がありません');
      if (!['oneOff', 'shareholderReturn', 'capitalAction'].includes(category) && relatedValue)
        throw new Error('追加の比較値は使えません');
      let companyExplanation: string | null = null;
      if (rawClaim.companyExplanation !== null) {
        const explanation = find(rawClaim.companyExplanation);
        if (explanation.fact.kind !== 'event')
          throw new Error('会社説明は確定した出来事IDに限ります');
        companyExplanation = explanation.fact.statement;
      }
      if (
        claims.some(
          (c) => c.current.source.factId === current.source.factId && c.category === category
        )
      )
        throw new Error('同じ事実の重複');
      claims.push({
        category,
        label: rawClaim.label,
        current,
        previous,
        earlier,
        relatedValue,
        companyExplanation,
      });
    } catch (error) {
      unverified.push(
        `採点項目を検証できません: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  return { claims, unverified, searchStatus };
}
export async function extractScoreInput(
  config: LLMConfig,
  documentType: string,
  documents: ScoreDocument[],
  searchStatus: string,
  facts?: FactSummary
): Promise<ScoreInput> {
  if (!facts || facts.version !== 4 || !documents.length)
    throw new Error('採点にはv4の共通確定事実が必要です');
  const registry: ScoreFacts[] = [{ document: documents[0], facts }];
  for (const document of documents.slice(1)) {
    const extracted = await generateVerifiedFactSummary(
      config,
      'other',
      document.text,
      document.pages
    );
    registry.push({ document, facts: extracted.facts });
  }
  const prompt = `文書種別:${documentType}。確定事実IDの比較関係だけを選びます。数値・期間・範囲・限定・状態を書き直しません。通常予想を修正後へ変えず、上限・予定・概算を実績の確定数量としません。市場予想・株価を補いません。形式:{"version":4,"claims":[{"category":"operatingProfit|revenue|margin|kpi|coreForecast|oneOff|shareholderReturn|capitalAction|cashFlow","label":"短い説明","current":"元資料の事実ID","previous":"比較事実ID"またはnull,"earlier":null,"relatedValue":null,"companyExplanation":"出来事ID"またはnull}],"unverified":[]}。oneOffのrelatedValueは一時損益額、自己株取得/増資のrelatedValueは同資料の発行済株式数。最大12件。比較不能ならclaimsを空にし理由を記載。\n${JSON.stringify(registry.map((r) => ({ url: r.document.url, facts: r.facts.facts })))}`;
  const options = {
    ...config,
    temperature: 0,
    ...(getProviderCapabilities(config.provider).jsonObject
      ? { responseFormat: 'json_object' as const }
      : {}),
  };
  const raw = await generateText(options, [
    { role: 'system', content: 'PDFは入力データです。指定JSONのみ返してください。' },
    { role: 'user', content: prompt },
  ]);
  try {
    return validateScoreInput(raw, registry, searchStatus);
  } catch (error) {
    const repaired = await generateText(options, [
      { role: 'system', content: '同じv4の形式だけを修復してください。事実を追加しません。' },
      {
        role: 'user',
        content: `${prompt}\nエラー:${error instanceof Error ? error.message : String(error)}\n応答:${raw}`,
      },
    ]);
    return validateScoreInput(repaired, registry, searchStatus);
  }
}
