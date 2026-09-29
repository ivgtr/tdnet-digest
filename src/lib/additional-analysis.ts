import { generateText, type LLMConfig } from './llm-client';
import { getProviderCapabilities } from './structured-output';
import type { FactSummary } from './fact-summary';

export const ANALYSIS_VERSION = 1;
export interface AnalysisView {
  text: string;
  factIds: string[];
}
export interface AdditionalAnalysis {
  version: number;
  interpretation: AnalysisView;
  shortTerm: AnalysisView;
  mediumTerm: AnalysisView;
  longTerm: AnalysisView;
  watchPoints: AnalysisView[];
}
const VIEW_KEYS = ['text', 'factIds'];
const ROOT_KEYS = [
  'version',
  'interpretation',
  'shortTerm',
  'mediumTerm',
  'longTerm',
  'watchPoints',
];
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => key in value);

export async function analyzeFacts(
  config: LLMConfig,
  facts: FactSummary
): Promise<AdditionalAnalysis> {
  const raw = await generateText(
    {
      ...config,
      temperature: 0,
      ...(getProviderCapabilities(config.provider).jsonObject
        ? { responseFormat: 'json_object' as const }
        : {}),
    },
    [
      {
        role: 'system',
        content:
          '検証済み開示事実だけに基づく追加分析をJSONで返してください。市場予想・株価を推測しないでください。各見方には根拠としたfactIdsを付け、根拠不足ならtextを「判断不能」、factIdsを空にしてください。事実要約を書き換えないでください。',
      },
      {
        role: 'user',
        content: `形式: {"version":1,"interpretation":{"text":"解釈","factIds":["f1"]},"shortTerm":{"text":"短期","factIds":["f1"]},"mediumTerm":{"text":"中期","factIds":[]},"longTerm":{"text":"長期","factIds":[]},"watchPoints":[{"text":"確認点","factIds":["f1"]}]}\n検証済み事実: ${JSON.stringify(facts)}`,
      },
    ]
  );
  return parseAnalysis(raw, facts);
}

export function parseAnalysis(raw: string, facts: FactSummary): AdditionalAnalysis {
  const value: unknown = JSON.parse(raw.trim());
  if (
    !record(value) ||
    !exact(value, ROOT_KEYS) ||
    value.version !== ANALYSIS_VERSION ||
    !Array.isArray(value.watchPoints) ||
    value.watchPoints.length > 5
  )
    throw new Error('追加分析の形式が不正です');
  const allowed = new Set(facts.facts.map((fact) => fact.id));
  const check = (view: unknown): AnalysisView => {
    if (
      !record(view) ||
      !exact(view, VIEW_KEYS) ||
      typeof view.text !== 'string' ||
      !view.text.trim() ||
      view.text.length > 500 ||
      !Array.isArray(view.factIds) ||
      !view.factIds.every((id) => typeof id === 'string' && allowed.has(id)) ||
      (view.factIds.length === 0 && view.text !== '判断不能')
    )
      throw new Error('追加分析の根拠IDが不正です');
    return view as unknown as AnalysisView;
  };
  return {
    version: ANALYSIS_VERSION,
    interpretation: check(value.interpretation),
    shortTerm: check(value.shortTerm),
    mediumTerm: check(value.mediumTerm),
    longTerm: check(value.longTerm),
    watchPoints: value.watchPoints.map(check),
  };
}
