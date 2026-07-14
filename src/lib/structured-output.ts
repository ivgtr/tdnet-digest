import type { DocumentType } from './document-type';
import type { ChatMessage } from './llm-client';
import type { ExtractionResult, InvestmentStance } from './summary-schema';

export interface ProviderCapabilities {
  jsonObject: boolean;
  strictJsonSchema: boolean;
}

export interface ValidationResult {
  success: boolean;
  data?: ExtractionResult;
  errors: string[];
}

const INVESTMENT_STANCES = new Set<InvestmentStance>([
  'positive',
  'slightlyPositive',
  'neutral',
  'slightlyNegative',
  'negative',
  'unknown',
]);

const REQUIRED_ROOT_FIELDS: Record<DocumentType, string[]> = {
  earnings: ['summary', 'performance', 'dividend', 'earningsQuality', 'investmentView', 'topics'],
  earningsRevision: ['summary', 'revisionItems', 'investmentView', 'topics'],
  shareholderBenefit: ['summary', 'changeType', 'details', 'investmentView', 'topics'],
  dividend: ['summary', 'dividendDetails', 'investmentView', 'topics'],
  shareRepurchase: ['summary', 'details', 'investmentView', 'topics'],
  stockSplit: ['summary', 'details', 'investmentView', 'topics'],
  capitalPolicy: ['summary', 'transaction', 'investmentView', 'topics'],
  ma: ['summary', 'deal', 'investmentView', 'topics'],
  businessUpdate: ['summary', 'kpis', 'investmentView', 'topics'],
  governance: ['summary', 'people', 'investmentView', 'topics'],
  other: ['summary', 'content', 'topics'],
};

export function getProviderCapabilities(provider: string): ProviderCapabilities {
  switch (provider) {
    case 'openai':
      return { jsonObject: true, strictJsonSchema: false };
    case 'anthropic':
    case 'google':
    case 'openrouter':
    case 'custom':
    default:
      return { jsonObject: false, strictJsonSchema: false };
  }
}

export function parseAndValidateExtraction(
  text: string,
  documentType: DocumentType,
  totalPages: number
): ValidationResult {
  const parsed = parseJsonResponse(text);
  if (!parsed || !isRecord(parsed)) {
    return { success: false, errors: ['応答をJSONオブジェクトとして解析できません'] };
  }

  const errors: string[] = [];
  for (const field of REQUIRED_ROOT_FIELDS[documentType]) {
    if (!(field in parsed)) errors.push(`必須フィールド ${field} がありません`);
  }

  if (typeof parsed.summary !== 'string' || parsed.summary.trim() === '') {
    errors.push('summary は空でない文字列である必要があります');
  }
  if (!Array.isArray(parsed.topics)) errors.push('topics は配列である必要があります');

  if (documentType !== 'other') {
    validateInvestmentView(parsed.investmentView, errors);
  }
  if (documentType === 'earnings') validateEarningsSemantics(parsed, errors);
  validateArrayLimits(parsed, documentType, errors);
  validatePageValues(parsed, totalPages, 'root', errors);

  if (errors.length > 0) return { success: false, errors };

  sanitizeArraysAndPages(parsed, totalPages);
  return { success: true, data: parsed as unknown as ExtractionResult, errors: [] };
}

function validateEarningsSemantics(value: Record<string, unknown>, errors: string[]): void {
  const dividend = value.dividend;
  if (dividend !== null) {
    if (!isRecord(dividend) || !Array.isArray(dividend.periods)) {
      errors.push('dividend.periods は配列である必要があります');
    } else {
      const statuses = new Set(['actual', 'forecast']);
      const assessments = new Set(['increase', 'unchanged', 'decrease', 'unknown']);
      dividend.periods.forEach((period, index) => {
        if (!isRecord(period)) {
          errors.push(`dividend.periods[${index}] はオブジェクトである必要があります`);
          return;
        }
        if (!statuses.has(String(period.status))) {
          errors.push(`dividend.periods[${index}].status が許可値ではありません`);
        }
        if (!assessments.has(String(period.assessment))) {
          errors.push(`dividend.periods[${index}].assessment が許可値ではありません`);
        }
        validateConfidence(period.confidence, `dividend.periods[${index}].confidence`, errors);
      });
    }
  }

  const quality = value.earningsQuality;
  if (!isRecord(quality)) {
    errors.push('earningsQuality はオブジェクトである必要があります');
    return;
  }
  const cashFlow = quality.operatingCashFlow;
  if (cashFlow !== null) {
    if (!isRecord(cashFlow)) {
      errors.push('earningsQuality.operatingCashFlow はオブジェクトまたはnullである必要があります');
    } else {
      if (!new Set(['reported', 'notReported', 'notPrepared', 'unknown']).has(String(cashFlow.status))) {
        errors.push('earningsQuality.operatingCashFlow.status が許可値ではありません');
      }
      validateConfidence(cashFlow.confidence, 'earningsQuality.operatingCashFlow.confidence', errors);
    }
  }
  if (!Array.isArray(quality.capitalActions)) {
    errors.push('earningsQuality.capitalActions は配列である必要があります');
  } else {
    const assessments = new Set(['shareholderReturn', 'capitalAction', 'unknown']);
    quality.capitalActions.forEach((action, index) => {
      if (!isRecord(action)) {
        errors.push(`earningsQuality.capitalActions[${index}] はオブジェクトである必要があります`);
        return;
      }
      if (!assessments.has(String(action.returnAssessment))) {
        errors.push(`earningsQuality.capitalActions[${index}].returnAssessment が許可値ではありません`);
      }
      validateConfidence(
        action.confidence,
        `earningsQuality.capitalActions[${index}].confidence`,
        errors
      );
    });
  }
}

function validateConfidence(value: unknown, path: string, errors: string[]): void {
  if (!new Set(['high', 'medium', 'low']).has(String(value))) {
    errors.push(`${path} が許可値ではありません`);
  }
}

export function buildJsonRepairMessages(
  invalidText: string,
  errors: string[],
  schema: string
): ChatMessage[] {
  return [
    {
      role: 'system',
      content: `あなたはJSON修復アシスタントです。入力にない事実を追加せず、指定形式に合うJSONオブジェクトだけを返してください。コードブロックや説明文は禁止です。\n\n【形式】\n${schema}`,
    },
    {
      role: 'user',
      content: `次の応答を修復してください。\n\n【検証エラー】\n- ${errors.join('\n- ')}\n\n【応答】\n${invalidText}`,
    },
  ];
}

function parseJsonResponse(text: string): unknown | null {
  const codeBlock = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (codeBlock?.[1] ?? text).trim();

  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(candidate.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

function validateInvestmentView(value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push('investmentView はオブジェクトである必要があります');
    return;
  }

  for (const horizon of ['shortTerm', 'mediumTerm', 'longTerm'] as const) {
    const assessment = value[horizon];
    if (!isRecord(assessment)) {
      errors.push(`investmentView.${horizon} がありません`);
      continue;
    }
    if (!INVESTMENT_STANCES.has(assessment.stance as InvestmentStance)) {
      errors.push(`investmentView.${horizon}.stance が許可値ではありません`);
    }
    validateEvidenceArray(assessment.rationale, 2, `${horizon}.rationale`, errors);
  }

  validateEvidenceArray(value.positives, 2, 'positives', errors);
  validateEvidenceArray(value.risks, 2, 'risks', errors);
  validateEvidenceArray(value.watchPoints, 3, 'watchPoints', errors);
  if (typeof value.rationale !== 'string') {
    errors.push('investmentView.rationale は文字列である必要があります');
  }
}

function validateEvidenceArray(
  value: unknown,
  maxItems: number,
  path: string,
  errors: string[]
): void {
  if (!Array.isArray(value)) {
    errors.push(`investmentView.${path} は配列である必要があります`);
    return;
  }
  if (value.length > maxItems) errors.push(`investmentView.${path} は最大${maxItems}件です`);

  value.forEach((item, index) => {
    if (!isRecord(item) || typeof item.text !== 'string' || item.text.trim() === '') {
      errors.push(`investmentView.${path}[${index}] のtextが不正です`);
    }
  });
}

function validateArrayLimits(
  value: Record<string, unknown>,
  documentType: DocumentType,
  errors: string[]
): void {
  const limits: Array<[unknown, number, string]> = [
    [value.topics, documentType === 'earnings' ? 8 : 4, 'topics'],
  ];

  if (documentType === 'capitalPolicy') {
    limits.push([value.useOfFunds, 3, 'useOfFunds'], [value.partnership, 3, 'partnership']);
  }
  if (documentType === 'businessUpdate') {
    limits.push([value.drivers, 3, 'drivers'], [value.oneOffFactors, 2, 'oneOffFactors']);
  }
  if (documentType === 'governance') {
    limits.push(
      [value.governanceChanges, 3, 'governanceChanges'],
      [value.internalControl, 3, 'internalControl']
    );
  }

  for (const [array, max, path] of limits) {
    if (Array.isArray(array) && array.length > max) errors.push(`${path} は最大${max}件です`);
  }
}

function validatePageValues(
  value: unknown,
  totalPages: number,
  path: string,
  errors: string[]
): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      validatePageValues(item, totalPages, `${path}[${index}]`, errors)
    );
    return;
  }
  if (!isRecord(value)) return;

  if (
    'page' in value &&
    value.page !== null &&
    (!Number.isInteger(value.page) ||
      (value.page as number) < 1 ||
      (value.page as number) > totalPages)
  ) {
    errors.push(`${path}.page がPDF範囲外です`);
  }
  for (const [key, child] of Object.entries(value)) {
    validatePageValues(child, totalPages, `${path}.${key}`, errors);
  }
}

function sanitizeArraysAndPages(value: unknown, totalPages: number): void {
  if (Array.isArray(value)) {
    value.forEach((item) => sanitizeArraysAndPages(item, totalPages));
    return;
  }
  if (!isRecord(value)) return;

  if (
    'page' in value &&
    value.page !== null &&
    (!Number.isInteger(value.page) ||
      (value.page as number) < 1 ||
      (value.page as number) > totalPages)
  ) {
    value.page = null;
  }
  for (const child of Object.values(value)) sanitizeArraysAndPages(child, totalPages);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
