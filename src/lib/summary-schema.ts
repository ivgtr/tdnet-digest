/**
 * 文書タイプ別JSON抽出スキーマ定義
 *
 * 2パス要約のパス1（情報抽出）でLLMに返させるJSONの構造を定義する。
 * TypeScript型定義と、LLMプロンプトに埋め込むスキーマ文字列の両方を提供。
 */

import type { DocumentType, EarningsContext } from './document-type';

// ── 共通型 ──

interface FinancialItem {
  name: string;
  amount: string;
  change?: string | null;
}

// ── 決算短信 ──

export interface EarningsExtraction {
  summary: string;
  performance: {
    periodLabel: string;
    items: FinancialItem[];
  };
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
    lastYearProgress: string | null;
  } | null;
  forecast: {
    label: string;
    items: FinancialItem[];
  } | null;
  revision: string | null;
  dividend: {
    interim: string | null;
    yearEnd: string | null;
    annual: string | null;
    dividendRevision: string | null;
  } | null;
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
  | DividendExtraction
  | MAExtraction
  | ShareRepurchaseExtraction
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
  "progress": {                          // 進捗率（通期予想に対して）
    "ordinaryIncome": "経常利益の進捗率（例: 58.3%）",
    "lastYearProgress": "前年同期の進捗率（あれば）"
  },`
    : `
  "progress": null,                      // 通期決算では不要`;

  return `{
  "summary": "全体要約（2-5文。業績の傾向、通期見通し、修正/配当の有無を含む）",
  "performance": {
    "periodLabel": "期間ラベル（例: 第2四半期連結実績）",
    "items": [
      { "name": "勘定科目名", "amount": "金額（単位付き）", "change": "前年同期比/前期比（例: +12.3%）" }
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
      { "name": "勘定科目名", "amount": "金額", "change": "前期比（例: +8.5%）" }
    ]
  },
  "revision": "業績予想の修正内容（修正なしの場合は'修正なし'）",
  "dividend": {
    "interim": "中間配当額",
    "yearEnd": "期末配当額",
    "annual": "年間配当額",
    "dividendRevision": "配当予想の修正（旧→新、中間/期末/年間ごと）"
  },
  "topics": ["具体的な数値を含むトピック（最大8点）"]
}`;
}

function getEarningsRatingRules(ctx: EarningsContext): string {
  const isQuarterly = ctx.period !== 'fullYear';

  const standardRates: Record<string, number> = {
    q1: 25,
    q2: 50,
    q3: 75,
    fullYear: 100,
  };
  const standardRate = standardRates[ctx.period];

  const progressOrLanding = isQuarterly
    ? `■ 進捗: 経常利益の進捗率 − 標準進捗率(${standardRate}%)の差で判定
★5: +10pt以上 / ★4: +5〜+10pt / ★3: ±5pt / ★2: △5〜△10pt / ★1: △10pt超 / 通期予想が未定・ゼロ・赤字→「★—」`
    : `■ 着地: 経常利益の実績 vs 会社予想の乖離率で判定
★5: +15%以上or黒字転換 / ★4: +5〜+15% / ★3: ±5% / ★2: △5〜△15% / ★1: △15%未満or赤字転落 / 会社予想なし→「—（取得不能）」`;

  const forecastRevision = isQuarterly
    ? `■ 予想修正: 通期予想の従来予想からの修正方向
↑上方修正（従来予想比+XX.X%を付記） / →修正なし / ↓下方修正（従来予想比△XX.X%を付記） / —予想未定`
    : `■ 配当: 増配/減配/据置の方向
↑増配（XX円→YY円） / →据置 / ↓減配 / —未定or記載なし`;

  return `
■ 対前年: 経常利益の増減率で判定
★5: +30%以上or黒字転換 / ★4: +10〜+30% / ★3: +3〜+10% / ★2: △3〜+3% / ★1: △3%未満or赤字転落

${progressOrLanding}

${forecastRevision}

※★は★（黒星）と☆（白星）を並べて5段階（例: ★★★★☆=4点）。括弧は全角（）
※数値が本文にない場合は「—（取得不能）」
※赤字で増減率が無意味な場合は「★—（赤字のため評価対象外）」`;
}

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
  "topics": ["具体的な数値を含むトピック（最大4点）"]
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
    case 'dividend':
      return DIVIDEND_SCHEMA;
    case 'ma':
      return MA_SCHEMA;
    case 'shareRepurchase':
      return SHARE_REPURCHASE_SCHEMA;
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
