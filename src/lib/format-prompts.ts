/**
 * 2パス要約: パス2（フォーマット整形）用プロンプト
 *
 * パス1で抽出したJSONデータを、固定テンプレートに沿ったテキスト形式に変換する。
 * プロンプトはシンプルに保ち、出力の安定性を最大化する。
 */

import type { DocumentType, EarningsContext } from './document-type';

const FORMAT_ROLE = `あなたはデータ整形アシスタントです。
与えられたJSONデータを指定されたテキスト形式に正確に変換してください。`;

const FORMAT_RULES = `
【ルール】
- JSONデータに含まれる情報のみを使用してください（情報の追加・捏造厳禁）
- 見出しは「## 」（半角シャープ2つ + 半角スペース）で統一してください
- 指定されたセクション以外は追加しないでください
- テンプレートの順序を厳守してください

【null・欠損値の処理ルール（最重要）】
- セクション全体のデータがnull・空配列の場合: セクション（見出し含む）を丸ごと省略
- 箇条書き項目の値がnullの場合: その行を丸ごと省略（「null」という文字列を出力しない）
- items配列内のchangeがnullの場合: 括弧部分を省略し「- {name}: {amount}」のみ出力
- 「null」という文字列は絶対に出力しないでください`;

// ── 決算短信テンプレート ──

function buildEarningsTemplate(ctx: EarningsContext): string {
  const isQuarterly = ctx.period !== 'fullYear';
  const forecastGroupLabel = isQuarterly ? '【通期予想】' : '【来期予想】（データがある場合のみ）';

  return `
--- 出力テンプレート ---

## 決算評価（経常利益ベース）
【実績】
- 対前年: {{evaluation.actual.vsLastYear}}
- ${isQuarterly ? '進捗' : '着地'}:   {{evaluation.actual.progressOrLanding}}

${forecastGroupLabel}
- 対前年:  {{evaluation.forecast.vsLastYear}}
- ${isQuarterly ? '予想修正' : '配当'}:  {{evaluation.forecast.revisionOrDividend}}

## 全体要約
{{summary}}

## 業績サマリー（{{performance.periodLabel}}）
{{performance.items を1行ずつ: - {name}: {amount}（{change}）  ※changeがnullなら括弧ごと省略}}

${
  isQuarterly
    ? `## 進捗率（通期予想に対して）
- 経常利益: {{progress.ordinaryIncome}}（前年同期{{progress.lastYearProgress}}）
`
    : ''
}## {{forecast.label}}
{{forecast.items を1行ずつ: - {name}: {amount}（{change}）  ※changeがnullなら括弧ごと省略}}

## 修正・配当
- 業績予想の修正: {{revision}}
※以下のdividendフィールドがnullの項目は行ごと省略すること:
- 中間配当: {{dividend.interim}}
- 期末配当: {{dividend.yearEnd}}
- 年間配当: {{dividend.annual}}
- 配当予想の修正: {{dividend.dividendRevision}}

## トピックス
{{topics を1行ずつ: - {内容}}}

--- テンプレートここまで ---`;
}

// ── 業績修正テンプレート ──

const EARNINGS_REVISION_TEMPLATE = `
--- 出力テンプレート ---

## 全体要約
{{summary}}

## 修正内容
{{revisionItems を1行ずつ: - {name}: 前回予想{previous} → 修正後{revised}（{change}）}}

## 修正理由
{{reason}}

## 配当予想の修正
- 修正内容: {{dividendRevision.content}}
- 修正理由: {{dividendRevision.reason}}

## トピックス
{{topics を1行ずつ: - {内容}}}

--- テンプレートここまで ---`;

// ── 配当テンプレート ──

const DIVIDEND_TEMPLATE = `
--- 出力テンプレート ---

## 全体要約
{{summary}}

## 配当内容
- 中間配当: {{dividendDetails.interim}}
- 期末配当: {{dividendDetails.yearEnd}}
- 年間配当: {{dividendDetails.annual}}
- 配当性向: {{dividendDetails.payoutRatio}}
- 予想修正: {{dividendDetails.revision}}
- 前期比較: {{dividendDetails.comparison}}

## 配当方針
{{policy}}

## トピックス
{{topics を1行ずつ: - {内容}}}

--- テンプレートここまで ---`;

// ── M&Aテンプレート ──

const MA_TEMPLATE = `
--- 出力テンプレート ---

## 全体要約
{{summary}}

## 取引概要
- 対象会社: {{deal.targetCompany}}
- 取引内容: {{deal.transactionType}}
- スキーム: {{deal.scheme}}
- 取得比率: {{deal.acquisitionRatio}}
- 取得価額: {{deal.acquisitionPrice}}
- 契約締結日: {{deal.contractDate}}
- 取得予定日: {{deal.expectedDate}}

## 目的
{{purpose}}

## 業績・連結への影響
- 売上への影響: {{impact.revenue}}
- 利益への影響: {{impact.profit}}
- 連結範囲の変更: {{impact.consolidation}}

## トピックス
{{topics を1行ずつ: - {内容}}}

--- テンプレートここまで ---`;

// ── 自己株式取得テンプレート ──

const SHARE_REPURCHASE_TEMPLATE = `
--- 出力テンプレート ---

## 全体要約
{{summary}}

## 取得内容
- 取得株数: {{details.shareCount}}
- 取得価額: {{details.totalAmount}}
- 取得期間: {{details.period}}
- 取得方法: {{details.method}}
- 消却予定: {{details.cancellation}}

## 目的
{{purpose}}

## トピックス
{{topics を1行ずつ: - {内容}}}

--- テンプレートここまで ---`;

// ── その他テンプレート ──

const OTHER_TEMPLATE = `
--- 出力テンプレート ---

## 全体要約
{{summary}}

## 開示内容
{{content.description}}
- 対象範囲: {{content.scope}}
- 期限・予定: {{content.schedule}}

## 業績・株価への影響
- 影響内容: {{impact}}

## トピックス
{{topics を1行ずつ: - {内容}}}

--- テンプレートここまで ---`;

/**
 * パス2（フォーマット整形）用プロンプトを取得
 *
 * @param documentType 文書タイプ
 * @param jsonData パス1で抽出したJSONデータ
 * @param earningsContext 決算コンテキスト（決算短信の場合のみ）
 * @returns { system, user } — systemプロンプトとuserメッセージ
 */
export function getFormatPrompt(
  documentType: DocumentType,
  jsonData: unknown,
  earningsContext?: EarningsContext
): { system: string; user: string } {
  let template: string;

  switch (documentType) {
    case 'earnings':
      template = buildEarningsTemplate(
        earningsContext || { period: 'q2', accountingStandard: 'jpGaap', isConsolidated: true }
      );
      break;
    case 'earningsRevision':
      template = EARNINGS_REVISION_TEMPLATE;
      break;
    case 'shareholderBenefit':
    case 'stockSplit':
    case 'capitalPolicy':
    case 'businessUpdate':
    case 'governance':
      template = OTHER_TEMPLATE;
      break;
    case 'dividend':
      template = DIVIDEND_TEMPLATE;
      break;
    case 'ma':
      template = MA_TEMPLATE;
      break;
    case 'shareRepurchase':
      template = SHARE_REPURCHASE_TEMPLATE;
      break;
    case 'other':
      template = OTHER_TEMPLATE;
      break;
  }

  const systemPrompt = `${FORMAT_ROLE}${FORMAT_RULES}
${template}`;

  const jsonStr = typeof jsonData === 'string' ? jsonData : JSON.stringify(jsonData, null, 2);

  return {
    system: systemPrompt,
    user: `以下のJSONデータをテンプレートに従ってテキスト形式に変換してください。\n\n${jsonStr}`,
  };
}
