/**
 * 文書タイプ別JSON抽出スキーマ定義
 *
 * 2パス要約のパス1（情報抽出）でLLMに返させるJSONの構造を定義する。
 * TypeScript型定義と、LLMプロンプトに埋め込むスキーマ文字列の両方を提供。
 */

import type { DocumentType, EarningsContext } from './document-type';
import type { EvidenceFact } from '@/types/summaryMetadata';

// ── 共通型 ──

interface FinancialItem {
  name: string;
  amount: string;
  previousAmount?: string | null;
  change?: string | null;
  page: number | null;
}

export type InvestmentStance =
  | 'positive'
  | 'slightlyPositive'
  | 'neutral'
  | 'slightlyNegative'
  | 'negative'
  | 'unknown';

export type SemanticConfidence = 'high' | 'medium' | 'low';

export interface OperatingCashFlowAnalysis {
  status: 'reported' | 'notReported' | 'notPrepared' | 'unknown';
  amount: string | null;
  direction: 'inflow' | 'outflow' | 'unknown';
  interpretation: string;
  evidenceText: string;
  page: number | null;
  confidence: SemanticConfidence;
}

export interface CapitalActionAnalysis {
  type:
    | 'dividend'
    | 'shareRepurchase'
    | 'shareCancellation'
    | 'shareholderBenefit'
    | 'stockSplit'
    | 'stockConsolidation'
    | 'lotSizeChange'
    | 'other';
  purpose: string | null;
  returnAssessment: 'shareholderReturn' | 'capitalAction' | 'unknown';
  interpretation: string;
  reason: string;
  evidenceText: string;
  page: number | null;
  confidence: SemanticConfidence;
}

export interface DividendPeriodAnalysis {
  fiscalYear: string;
  status: 'actual' | 'forecast';
  interim: string | null;
  yearEnd: string | null;
  annual: string | null;
  comparisonAnnual: string | null;
  comparisonBasis: 'reported' | 'splitAdjusted' | 'unknown';
  assessment: 'increase' | 'unchanged' | 'decrease' | 'unknown';
  interpretation: string | null;
  evidenceText: string;
  page: number | null;
  confidence: SemanticConfidence;
  /** パス1後にコード側で生成する欠損安全な表示文字列 */
  displayText?: string;
}

export interface DividendRevisionAnalysis {
  fiscalYear: string | null;
  before: string | null;
  after: string | null;
  reason: string | null;
  page: number | null;
}

export interface ForecastRevisionAnalysis {
  direction: 'up' | 'unchanged' | 'down' | 'unknown';
  metric: string | null;
  before: string | null;
  after: string | null;
  interpretation: string;
  page: number | null;
  confidence: SemanticConfidence;
}

export interface EarningsQuality {
  operatingMargin: {
    current: string | null;
    previous: string | null;
    change: string | null;
    page: number | null;
    /** パス1後にコード側で生成する比較表示。比較不能ならnull */
    comparisonText?: string | null;
  } | null;
  coreEarnings: EvidenceFact | null;
  oneOffItems: EvidenceFact[];
  operatingCashFlow: OperatingCashFlowAnalysis | null;
  financialHealth: EvidenceFact[];
  capitalActions: CapitalActionAnalysis[];
  /** analysis schema v7以前のキャッシュとの後方互換用 */
  shareholderReturns?: EvidenceFact[];
}

export interface HorizonAssessment {
  stance: InvestmentStance;
  rationale: EvidenceFact[];
}

export interface InvestmentView {
  shortTerm: HorizonAssessment;
  mediumTerm: HorizonAssessment;
  longTerm: HorizonAssessment;
  positives: EvidenceFact[];
  risks: EvidenceFact[];
  watchPoints: EvidenceFact[];
  rationale: string;
}

// ── 決算短信 ──

export interface EarningsExtraction {
  summary: string;
  performance: {
    periodLabel: string;
    items: FinancialItem[];
  };
  businessPl?: {
    items: Array<FinancialItem & { assessment?: string }>;
  } | null;
  evaluation: {
    actual: {
      vsLastYear: string | null;
      progressOrLanding: string | null;
    };
    forecast: {
      vsLastYear: string | null;
      revisionOrDividend: string | null;
    } | null;
  } | null;
  progress: {
    ordinaryIncome: string;
    basis?: 'profitProgress' | 'lossConsumption';
    lastYearProgress: string | null;
    page: number | null;
  } | null;
  forecast: {
    label: string;
    items: FinancialItem[];
  } | null;
  forecastRevision: ForecastRevisionAnalysis | null;
  revision: string | null;
  dividend: {
    forecastAvailability: 'reported' | 'notReported' | 'unknown';
    periods: DividendPeriodAnalysis[];
    currentRevision: DividendRevisionAnalysis | null;
  } | null;
  earningsQuality: EarningsQuality;
  investmentView: InvestmentView;
  topics: string[];
}

// ── 業績修正 ──

export interface EarningsRevisionExtraction {
  summary: string;
  revisionItems: {
    name: string;
    previous: string;
    revised: string;
    change: string | null;
  }[];
  reason: string | null;
  dividendRevision: {
    content: string;
    reason: string | null;
  } | null;
  investmentView: InvestmentView;
  topics: string[];
}

export interface ShareholderBenefitExtraction {
  summary: string;
  changeType: 'establish' | 'expand' | 'reduce' | 'abolish' | 'change' | 'unknown';
  details: {
    before: string | null;
    after: string | null;
    eligibleShareholders: string | null;
    requiredShares: string | null;
    referenceDate: string | null;
    startDate: string | null;
    holdingRequirement: string | null;
    costImpact: string | null;
  };
  purpose: string | null;
  investmentView: InvestmentView;
  topics: string[];
}

// ── 配当 ──

export interface DividendExtraction {
  summary: string;
  dividendDetails: {
    interim: string | null;
    yearEnd: string | null;
    annual: string | null;
    payoutRatio: string | null;
    revision: string | null;
    comparison: string | null;
  };
  policy: string | null;
  investmentView: InvestmentView;
  topics: string[];
}

// ── M&A ──

export interface MAExtraction {
  summary: string;
  deal: {
    targetCompany: string | null;
    transactionType: string | null;
    scheme: string | null;
    acquisitionRatio: string | null;
    acquisitionPrice: string | null;
    contractDate: string | null;
    expectedDate: string | null;
  };
  purpose: string | null;
  impact: {
    revenue: string | null;
    profit: string | null;
    consolidation: string | null;
  } | null;
  investmentView: InvestmentView;
  topics: string[];
}

// ── 自己株式取得 ──

export interface ShareRepurchaseExtraction {
  summary: string;
  details: {
    shareCount: string | null;
    totalAmount: string | null;
    period: string | null;
    method: string | null;
    cancellation: string | null;
  };
  purpose: string | null;
  investmentView: InvestmentView;
  topics: string[];
}

export interface StockSplitExtraction {
  summary: string;
  details: {
    action: 'split' | 'consolidation' | 'unknown';
    ratio: string | null;
    recordDate: string | null;
    effectiveDate: string | null;
    sharesBefore: string | null;
    sharesAfter: string | null;
    authorizedSharesChange: string | null;
    dividendImpact: string | null;
  };
  purpose: string | null;
  investmentView: InvestmentView;
  topics: string[];
}

export interface CapitalPolicyExtraction {
  summary: string;
  transaction: {
    method: string | null;
    counterparty: string | null;
    amount: string | null;
    sharesOrRights: string | null;
    dilution: string | null;
    price: string | null;
    paymentDate: string | null;
  };
  useOfFunds: EvidenceFact[];
  partnership: EvidenceFact[];
  investmentView: InvestmentView;
  topics: string[];
}

export interface BusinessUpdateExtraction {
  summary: string;
  period: string | null;
  kpis: {
    name: string;
    value: string;
    comparison: string | null;
    scope: string | null;
    page: number | null;
  }[];
  drivers: EvidenceFact[];
  oneOffFactors: EvidenceFact[];
  investmentView: InvestmentView;
  topics: string[];
}

export interface GovernanceExtraction {
  summary: string;
  changeType: string | null;
  people: {
    name: string;
    previousRole: string | null;
    newRole: string | null;
    effectiveDate: string | null;
  }[];
  governanceChanges: EvidenceFact[];
  internalControl: EvidenceFact[];
  investmentView: InvestmentView;
  topics: string[];
}

// ── その他 ──

export interface OtherExtraction {
  summary: string;
  content: {
    description: string | null;
    scope: string | null;
    schedule: string | null;
  };
  impact: string | null;
  topics: string[];
}

// ── ユニオン型 ──

export type ExtractionResult =
  | EarningsExtraction
  | EarningsRevisionExtraction
  | ShareholderBenefitExtraction
  | DividendExtraction
  | MAExtraction
  | ShareRepurchaseExtraction
  | StockSplitExtraction
  | CapitalPolicyExtraction
  | BusinessUpdateExtraction
  | GovernanceExtraction
  | OtherExtraction;

// ── スキーマ文字列生成 ──

function buildEarningsSchema(ctx: EarningsContext): string {
  const isQuarterly = ctx.period !== 'fullYear';
  const progressOrLandingDesc = isQuarterly
    ? 'progress（進捗率と標準進捗率を含む）'
    : 'landing（対会社予想の乖離率）';
  const revisionOrDividendDesc = isQuarterly
    ? 'revision（↑上方修正/→修正なし/↓下方修正 + 従来予想比）'
    : 'dividend（↑増配/→据置/↓減配 + 金額変動）';
  const forecastLabel = isQuarterly ? '通期予想' : '来期予想（本文にある場合のみ）';
  const progressField = isQuarterly
    ? `
  "progress": {                          // 進捗率（通期予想に対して）※通期予想が「未定」と明記の場合のみprogress全体をnull
    "ordinaryIncome": "経常利益の進捗率（例: 58.3%）※レンジ予想なら「XX.X%〜YY.Y%」形式。通期予想が「未定」と明記の場合のみprogress全体をnullに",
    "basis": "profitProgress（黒字実績÷黒字予想）またはlossConsumption（赤字実績の絶対値÷赤字予想の絶対値）",
    "lastYearProgress": "前年同期の進捗率 ※不明ならnull",
    "page": 3
  },`
    : `
  "progress": null,                      // 通期決算では不要`;

  return `{
  "summary": "全体要約（1-3文。業績の傾向、通期見通し、修正/配当の有無を含む）",
  "performance": {
    "periodLabel": "期間ラベル（例: 第2四半期連結実績）",
    "items": [
      { "name": "勘定科目名", "amount": "当期金額（単位付き。同じ数値が複数ある場合は最も精密な桁を優先）", "previousAmount": "同じ表または本文にある前年同期/前期の比較金額（当期金額と同じ単位） ※なければnull", "change": "前年同期比/前期比（例: +12.3%） ※本文に増減率がない場合はnull", "page": 1 }
    ]
  },
  "businessPl": {
    "items": [
      { "name": "売上高/売上収益、売上総利益/粗利、営業利益/事業利益のいずれか", "amount": "当期金額（最も精密な単位）", "previousAmount": "前年同期/前期金額（当期と同じ単位） ※なければnull", "change": "前年同期比/前期比 ※なければnull", "page": 1 }
    ]
  },
  "evaluation": {
    "actual": {
      "vsLastYear": "★表記（例: ★★★★☆）+ 根拠（例: 前年同期比+15.2%）",
      "progressOrLanding": "★表記 + 根拠（${progressOrLandingDesc}）"
    },
    "forecast": {
      "vsLastYear": "★表記 + 根拠",
      "revisionOrDividend": "${revisionOrDividendDesc}"
    }
  },${progressField}
  "forecast": {
    "label": "${forecastLabel}",
    "items": [
      { "name": "勘定科目名", "amount": "予想金額", "previousAmount": "比較対象となる前期実績金額 ※本文になければnull", "change": "前期比（例: +8.5%） ※本文に増減率がない場合はnull", "page": 1 }
    ]
  },
  "forecastRevision": { "direction": "up/unchanged/down/unknown", "metric": "評価対象の利益指標 ※なければnull", "before": "従来予想額またはレンジ ※なければnull", "after": "今回予想額またはレンジ ※なければnull", "interpretation": "予想修正の内容を金額ベースで簡潔に正規化", "page": 1, "confidence": "high/medium/low" },
  "revision": "業績予想の修正内容（修正なしの場合は'修正なし'）",
  "dividend": {
    "forecastAvailability": "配当の状況の表に（予想）行があればreported、明示的になければnotReported、判別不能ならunknown",
    "periods": [
      { "fiscalYear": "年度ラベル", "status": "actualまたはforecast", "interim": "中間配当額 ※なければnull", "yearEnd": "期末配当額 ※なければnull", "annual": "年間配当額 ※なければnull", "comparisonAnnual": "この年度と比較可能な直前年度の年間配当額 ※株式分割等があれば調整後金額、なければ記載額、不明ならnull", "comparisonBasis": "reported/splitAdjusted/unknown", "assessment": "increase/unchanged/decrease/unknown", "interpretation": "株式数変化も考慮した配当の意味を簡潔に説明 ※説明不要ならnull", "evidenceText": "判断根拠となる表または本文の記述", "page": 1, "confidence": "high/medium/low" }
    ],
    "currentRevision": { "fiscalYear": "修正対象年度", "before": "修正前年間配当", "after": "修正後年間配当", "reason": "修正理由 ※なければnull", "page": 1 }
    // 配当修正がない場合はcurrentRevision全体をnull。beforeとafterが両方ないオブジェクトを作らない
  },
  "earningsQuality": {
    "operatingMargin": {
      "current": "当期の営業利益率/事業利益率（例: 8.2%）",
      "previous": "前年同期の利益率 ※算出根拠がなければnull",
      "change": "前年差（例: +1.2pt） ※算出不能ならnull",
      "page": 1
    },
    "coreEarnings": { "text": "本業利益の方向と根拠", "page": 1 },
    "oneOffItems": [{ "text": "特別損益など一時要因（最大3点）", "page": 1 }],
    "operatingCashFlow": { "status": "reported/notReported/notPrepared/unknown", "amount": "営業CF金額 ※数値がなければnull", "direction": "inflow/outflow/unknown", "interpretation": "会社固有の表現を正規化した意味", "evidenceText": "判断根拠となる原文", "page": 4, "confidence": "high/medium/low" },
    "financialHealth": [{ "text": "自己資本・有利子負債・資金余力等（最大3点）", "page": 4 }],
    "capitalActions": [{ "type": "dividend/shareRepurchase/shareCancellation/shareholderBenefit/stockSplit/stockConsolidation/lotSizeChange/other", "purpose": "資料に記載された目的 ※なければnull", "returnAssessment": "shareholderReturn/capitalAction/unknown", "interpretation": "投資家向けに簡潔に正規化した施策内容", "reason": "分類理由", "evidenceText": "判断根拠となる原文", "page": 1, "confidence": "high/medium/low" }]
  },
  "investmentView": {
    "shortTerm": { "stance": "positive/slightlyPositive/neutral/slightlyNegative/negative/unknown", "rationale": [{ "text": "開示直後〜数週間の根拠（最大2点）", "page": 1 }] },
    "mediumTerm": { "stance": "positive/slightlyPositive/neutral/slightlyNegative/negative/unknown", "rationale": [{ "text": "6か月〜1年の根拠（最大2点）", "page": 2 }] },
    "longTerm": { "stance": "positive/slightlyPositive/neutral/slightlyNegative/negative/unknown", "rationale": [{ "text": "1年以上の根拠（最大2点）", "page": 4 }] },
    "positives": [{ "text": "最大の好材料（最大2点）", "page": 1 }],
    "risks": [{ "text": "最大のリスク（最大2点。根拠がなければ空配列）", "page": 4 }],
    "watchPoints": [{ "text": "次回確認点（最大3点）", "page": 2 }],
    "rationale": "最大の加点要因と減点要因を一文で説明。点数や市場データは使用しない"
  },
  "topics": ["具体的な数値を含むトピック（最大8点）"]
}`;
}

function getEarningsRatingRules(ctx: EarningsContext): string {
  const isQuarterly = ctx.period !== 'fullYear';
  const evaluationMetric = ctx.accountingStandard === 'jpGaap' ? '経常利益' : '税引前利益';

  const standardRates: Record<string, number> = {
    q1: 25,
    q2: 50,
    q3: 75,
    fullYear: 100,
  };
  const standardRate = standardRates[ctx.period];

  const progressOrLanding = isQuarterly
    ? `■ 進捗: 実績と通期予想が黒字なら${evaluationMetric}の進捗率、両方赤字なら損失消化率を標準進捗率(${standardRate}%)と比較して判定
★5: +10pt以上 / ★4: +5〜+10pt / ★3: ±5pt / ★2: △5〜△10pt / ★1: △10pt超 / 通期予想が「未定」と明記→「★—」
※損失消化率は「当期損失の絶対値 ÷ 通期予想損失の絶対値 × 100」で算出し、標準より低いほど高評価とする
※レンジ予想の場合は中央値で進捗率を算出して判定すること（レンジ予想は「未定」ではない）`
    : `■ 着地: ${evaluationMetric}の実績 vs 会社予想の乖離率で判定
★5: +15%以上or黒字転換 / ★4: +5〜+15% / ★3: ±5% / ★2: △5〜△15% / ★1: △15%未満or赤字転落 / 会社予想なし→「—（取得不能）」`;

  const forecastRevision = isQuarterly
    ? `■ 予想修正: 通期予想の従来予想からの修正方向
↑上方修正（従来予想比+XX.X%を付記） / →修正なし / ↓下方修正（従来予想比△XX.X%を付記） / —予想未定`
    : `■ 配当: 増配/減配/据置の方向
↑増配（XX円→YY円） / →据置 / ↓減配 / —未定or記載なし`;

  return `
■ 対前年: ${evaluationMetric}の増減率で判定
★5: +30%以上or黒字転換 / ★4: +10〜+30% / ★3: +3〜+10% / ★2: △3〜+3% / ★1: △3%未満or赤字転落
※当期・前年がともに赤字なら損失改善率を算出し、赤字縮小はプラス、赤字拡大はマイナスとして同じ★基準で判定する
※前年同期比/前期比の増減率が本文に記載されていない場合（初連結化、新規上場等）は「★—（前年同期比なし）」

${progressOrLanding}

${forecastRevision}

※★は★（黒星）と☆（白星）を並べて5段階（例: ★★★★☆=4点）。括弧は全角（）
※数値が本文にない場合は「—（取得不能）」
※赤字でも比較金額がある場合は評価対象外にせず、黒字転換・赤字転落・赤字縮小・赤字拡大を判定する`;
}

const INVESTMENT_VIEW_SCHEMA = `"investmentView": {
    "shortTerm": { "stance": "positive/slightlyPositive/neutral/slightlyNegative/negative/unknown", "rationale": [{ "text": "短期の根拠（最大2点）", "page": 1 }] },
    "mediumTerm": { "stance": "positive/slightlyPositive/neutral/slightlyNegative/negative/unknown", "rationale": [{ "text": "中期の根拠（最大2点）", "page": 1 }] },
    "longTerm": { "stance": "positive/slightlyPositive/neutral/slightlyNegative/negative/unknown", "rationale": [{ "text": "長期の根拠（最大2点）", "page": 1 }] },
    "positives": [{ "text": "好材料（最大2点）", "page": 1 }],
    "risks": [{ "text": "リスク（最大2点。根拠がなければ空配列）", "page": 1 }],
    "watchPoints": [{ "text": "次回確認点（最大3点）", "page": 1 }],
    "rationale": "最大の加点要因と減点要因を一文で説明。点数や市場データは使用しない"
  }`;

const EARNINGS_REVISION_SCHEMA = `{
  "summary": "全体要約（1-3文。修正の方向性と主要因、配当への影響を含む）",
  "revisionItems": [
    { "name": "勘定科目名", "previous": "前回予想額", "revised": "修正後額", "change": "増減率" }
  ],
  "reason": "修正理由（2-3行で簡潔に）",
  "dividendRevision": {
    "content": "配当予想の修正内容（中間/期末/年間の旧→新）",
    "reason": "配当修正の理由"
  },
  ${INVESTMENT_VIEW_SCHEMA},
  "topics": ["具体的な数値を含むトピック（最大4点）"]
}`;

const SHAREHOLDER_BENEFIT_SCHEMA = `{
  "summary": "全体要約（1-3文。拡充/縮小/廃止と対象範囲を含む）",
  "changeType": "establish/expand/reduce/abolish/change/unknown",
  "details": {
    "before": "変更前の優待内容。なければnull",
    "after": "変更後の優待内容。なければnull",
    "eligibleShareholders": "対象株主",
    "requiredShares": "必要保有株数",
    "referenceDate": "基準日",
    "startDate": "開始日",
    "holdingRequirement": "継続保有条件",
    "costImpact": "会社負担・業績影響。本文になければnull"
  },
  "purpose": "制度変更の目的",
  ${INVESTMENT_VIEW_SCHEMA},
  "topics": ["具体的な数値を含むトピック（最大4点）"]
}`;

const DIVIDEND_SCHEMA = `{
  "summary": "全体要約（1-3文。配当水準の変化と理由を含む）",
  "dividendDetails": {
    "interim": "中間配当額",
    "yearEnd": "期末配当額",
    "annual": "年間配当額",
    "payoutRatio": "配当性向",
    "revision": "予想修正（旧→新、中間/期末/年間ごと）",
    "comparison": "前期比較（前期年間配当→今期年間配当、増減額、増配/減配/据置）"
  },
  "policy": "配当方針や株主還元方針（1-2行）",
  ${INVESTMENT_VIEW_SCHEMA},
  "topics": ["具体的な数値を含むトピック（最大4点）"]
}`;

const MA_SCHEMA = `{
  "summary": "全体要約（1-3文。取引の狙い、規模、業績影響を含む）",
  "deal": {
    "targetCompany": "対象会社名",
    "transactionType": "取引内容（株式取得/譲渡/その他）",
    "scheme": "スキーム（子会社化/持分法適用/合併/事業譲渡/その他）",
    "acquisitionRatio": "取得比率",
    "acquisitionPrice": "取得価額",
    "contractDate": "契約締結日（YYYY年M月D日形式）",
    "expectedDate": "取得予定日（YYYY年M月D日形式）"
  },
  "purpose": "取引の目的（2-3行で簡潔に）",
  "impact": {
    "revenue": "売上への影響",
    "profit": "利益への影響",
    "consolidation": "連結範囲の変更"
  },
  ${INVESTMENT_VIEW_SCHEMA},
  "topics": ["具体的な数値を含むトピック（最大4点）"]
}`;

const SHARE_REPURCHASE_SCHEMA = `{
  "summary": "全体要約（1-3文。取得枠の規模、目的、消却有無を含む）",
  "details": {
    "shareCount": "取得株数（発行済株式総数に対する割合を含む）",
    "totalAmount": "取得価額の総額",
    "period": "取得期間",
    "method": "取得方法（市場買付/その他）",
    "cancellation": "消却予定の有無と時期"
  },
  "purpose": "取得の目的（1-2行で簡潔に）",
  ${INVESTMENT_VIEW_SCHEMA},
  "topics": ["具体的な数値を含むトピック（最大4点）"]
}`;

const STOCK_SPLIT_SCHEMA = `{
  "summary": "全体要約（1-3文。比率、日程、実質的な株主価値の変更有無を含む）",
  "details": {
    "action": "split/consolidation/unknown",
    "ratio": "分割・併合比率",
    "recordDate": "基準日",
    "effectiveDate": "効力発生日",
    "sharesBefore": "実施前株式数",
    "sharesAfter": "実施後株式数",
    "authorizedSharesChange": "発行可能株式総数の変更",
    "dividendImpact": "1株配当と実質配当への影響"
  },
  "purpose": "実施目的",
  ${INVESTMENT_VIEW_SCHEMA},
  "topics": ["具体的な数値を含むトピック（最大4点）"]
}`;

const CAPITAL_POLICY_SCHEMA = `{
  "summary": "全体要約（1-3文。調達・提携内容、希薄化、資金使途を含む）",
  "transaction": {
    "method": "第三者割当/新株予約権/資本業務提携等",
    "counterparty": "割当先・提携先",
    "amount": "調達額",
    "sharesOrRights": "発行株式数・新株予約権数",
    "dilution": "希薄化率",
    "price": "発行価額・行使価額",
    "paymentDate": "払込期日"
  },
  "useOfFunds": [{ "text": "資金使途（最大3点）", "page": 1 }],
  "partnership": [{ "text": "業務提携内容（最大3点）", "page": 1 }],
  ${INVESTMENT_VIEW_SCHEMA},
  "topics": ["具体的な数値を含むトピック（最大4点）"]
}`;

const BUSINESS_UPDATE_SCHEMA = `{
  "summary": "全体要約（1-3文。主要KPIの方向と要因を含む）",
  "period": "対象月・対象期間",
  "kpis": [{ "name": "KPI名", "value": "実績値", "comparison": "前年同月比/前年同期比", "scope": "既存店/全店/事業範囲等", "page": 1 }],
  "drivers": [{ "text": "増減要因（最大3点）", "page": 1 }],
  "oneOffFactors": [{ "text": "天候・休日数等の一過性要因（最大2点）", "page": 1 }],
  ${INVESTMENT_VIEW_SCHEMA},
  "topics": ["具体的な数値を含むトピック（最大4点）"]
}`;

const GOVERNANCE_SCHEMA = `{
  "summary": "全体要約（1-3文。変更内容と施行日を含む）",
  "changeType": "役員異動/体制変更/内部統制/再発防止等",
  "people": [{ "name": "氏名", "previousRole": "旧役職", "newRole": "新役職", "effectiveDate": "就任・退任日" }],
  "governanceChanges": [{ "text": "ガバナンス体制の変更（最大3点）", "page": 1 }],
  "internalControl": [{ "text": "内部統制・再発防止策（最大3点）", "page": 1 }],
  ${INVESTMENT_VIEW_SCHEMA},
  "topics": ["具体的な事実を含むトピック（最大4点）"]
}`;

const OTHER_SCHEMA = `{
  "summary": "全体要約（1-3文。影響の有無と重要点を含む）",
  "content": {
    "description": "開示の主要内容",
    "scope": "対象範囲（会社/子会社/事業/その他）",
    "schedule": "期限・予定（日付/期間）"
  },
  "impact": "業績・株価への影響",
  "topics": ["具体的な数値を含むトピック（最大4点）"]
}`;

/**
 * 文書タイプに応じたJSONスキーマ文字列を取得
 */
export function getJsonSchema(
  documentType: DocumentType,
  earningsContext?: EarningsContext
): string {
  switch (documentType) {
    case 'earnings':
      return buildEarningsSchema(
        earningsContext || { period: 'q2', accountingStandard: 'jpGaap', isConsolidated: true }
      );
    case 'earningsRevision':
      return EARNINGS_REVISION_SCHEMA;
    case 'shareholderBenefit':
      return SHAREHOLDER_BENEFIT_SCHEMA;
    case 'dividend':
      return DIVIDEND_SCHEMA;
    case 'ma':
      return MA_SCHEMA;
    case 'shareRepurchase':
      return SHARE_REPURCHASE_SCHEMA;
    case 'stockSplit':
      return STOCK_SPLIT_SCHEMA;
    case 'capitalPolicy':
      return CAPITAL_POLICY_SCHEMA;
    case 'businessUpdate':
      return BUSINESS_UPDATE_SCHEMA;
    case 'governance':
      return GOVERNANCE_SCHEMA;
    case 'other':
      return OTHER_SCHEMA;
  }
}

/**
 * 決算評価の判定ルール文字列を取得（決算短信のパス1プロンプト用）
 */
export function getEarningsRatingRulesText(ctx: EarningsContext): string {
  return getEarningsRatingRules(ctx);
}
