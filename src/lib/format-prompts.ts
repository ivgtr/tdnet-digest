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
- 「null」という文字列は絶対に出力しないでください

【根拠ページ】
- EvidenceFactのpageが整数の場合は文末に「[p.{page}]」を付けてください
- pageがnullの場合はページ表記を省略してください
- 同じ項目内に複数の根拠がある場合は「[p.1, p.3]」形式にまとめてください

【方向性の表示】
- positive=強気、slightlyPositive=やや強気、neutral=中立、slightlyNegative=やや弱気、negative=弱気、unknown=判断不能 と変換してください`;

const INVESTMENT_VIEW_TEMPLATE = `
## 時間軸別の見方
- 短期: {{investmentView.shortTerm.stanceを日本語変換}} — {{rationaleのtextを「 / 」で連結}} {{根拠ページ}}
- 中期: {{investmentView.mediumTerm.stanceを日本語変換}} — {{rationaleのtextを「 / 」で連結}} {{根拠ページ}}
- 長期: {{investmentView.longTerm.stanceを日本語変換}} — {{rationaleのtextを「 / 」で連結}} {{根拠ページ}}

## 好材料
{{investmentView.positives を1行ずつ: - {text} [p.{page}]}}

## リスク
{{investmentView.risks を1行ずつ: - {text} [p.{page}]}}

## 次回確認点
{{investmentView.watchPoints を1行ずつ: - {text} [p.{page}]}}

## 評価理由
{{investmentView.rationale}}`;

// ── 決算短信テンプレート ──

function buildEarningsTemplate(ctx: EarningsContext): string {
  const isQuarterly = ctx.period !== 'fullYear';
  const forecastGroupLabel = isQuarterly ? '【通期予想】' : '【来期予想】（データがある場合のみ）';
  const evaluationMetric = ctx.accountingStandard === 'jpGaap' ? '経常利益' : '税引前利益';

  return `
--- 出力テンプレート ---

## 全体要約
{{summary}}

## 決算評価（${evaluationMetric}ベース）
【実績】
- 対前年: {{evaluation.actual.vsLastYear}}
- ${isQuarterly ? '進捗' : '着地'}:   {{evaluation.actual.progressOrLanding}}

${forecastGroupLabel}
- 対前年:  {{evaluation.forecast.vsLastYear}}
- ${isQuarterly ? '予想修正' : '配当'}:  {{evaluation.forecast.revisionOrDividend}}

## 業績サマリー（{{performance.periodLabel}}）
{{performance.items を1行ずつ: - {name}: {amount}（{change}） [p.{page}]  ※changeがnullなら括弧ごと省略}}

## 事業P/L
{{businessPl.items を1行ずつ: - {name}: {amount} — {assessment} [p.{page}]}}

${
  isQuarterly
    ? `## 進捗率（通期予想に対して）
{{progress.basisがlossConsumptionなら「- ${evaluationMetric}の損失消化率: {progress.ordinaryIncome}」、それ以外は「- ${evaluationMetric}: {progress.ordinaryIncome}」}}{{progress.lastYearProgressがnullでない場合のみ: （前年同期{progress.lastYearProgress}）}} [p.{{progress.page}}]
`
    : ''
}## {{forecast.label}}
{{forecast.items を1行ずつ: - {name}: {amount}（{change}） [p.{page}]  ※changeがnullなら括弧ごと省略}}

## 修正・配当
- 業績予想の修正: {{revision}}
{{dividend.periods を年度ごとに1行ずつ: - 配当（{fiscalYear}・{statusがactualなら実績、forecastなら予想}）: 中間{interim} / 期末{yearEnd} / 年間{annual} [p.{page}] ※nullの内訳は省略}}
- 当期配当予想の修正（{{dividend.currentRevision.fiscalYear}}）: {{dividend.currentRevision.before}}→{{dividend.currentRevision.after}} {{pageがあれば[p.N]}}

## 利益の質
- 営業利益率: {{earningsQuality.operatingMargin.current}}（前年同期{{earningsQuality.operatingMargin.previous}}、前年差{{earningsQuality.operatingMargin.change}}） {{pageがあれば[p.N]}}
- 本業利益: {{earningsQuality.coreEarnings.text}} {{pageがあれば[p.N]}}
{{earningsQuality.oneOffItems を1行ずつ: - 一時損益: {text} [p.{page}]}}
- 営業CF: {{earningsQuality.operatingCashFlow.interpretation}}{{earningsQuality.operatingCashFlow.amountがnullでなければ: （{amount}）}} {{pageがあれば[p.N]}}
{{earningsQuality.financialHealth を1行ずつ: - 財務: {text} [p.{page}]}}
{{earningsQuality.capitalActions を1行ずつ: - 株主還元: {interpretation} [p.{page}]}}

## 時間軸別の見方
- 短期: {{investmentView.shortTerm.stanceを日本語変換}} — {{rationaleのtextを「 / 」で連結}} {{根拠ページ}}
- 中期: {{investmentView.mediumTerm.stanceを日本語変換}} — {{rationaleのtextを「 / 」で連結}} {{根拠ページ}}
- 長期: {{investmentView.longTerm.stanceを日本語変換}} — {{rationaleのtextを「 / 」で連結}} {{根拠ページ}}

## 好材料
{{investmentView.positives を1行ずつ: - {text} [p.{page}]}}

## リスク
{{investmentView.risks を1行ずつ: - {text} [p.{page}]}}

## 次回確認点
{{investmentView.watchPoints を1行ずつ: - {text} [p.{page}]}}

## 評価理由
{{investmentView.rationale}}

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

${INVESTMENT_VIEW_TEMPLATE}

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

${INVESTMENT_VIEW_TEMPLATE}

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

${INVESTMENT_VIEW_TEMPLATE}

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

${INVESTMENT_VIEW_TEMPLATE}

## トピックス
{{topics を1行ずつ: - {内容}}}

--- テンプレートここまで ---`;

const SHAREHOLDER_BENEFIT_TEMPLATE = `
--- 出力テンプレート ---

## 全体要約
{{summary}}

## 優待変更
- 変更区分: {{changeType}}
- 変更前: {{details.before}}
- 変更後: {{details.after}}
- 対象株主: {{details.eligibleShareholders}}
- 必要保有株数: {{details.requiredShares}}
- 基準日: {{details.referenceDate}}
- 開始日: {{details.startDate}}
- 継続保有条件: {{details.holdingRequirement}}
- 会社負担・業績影響: {{details.costImpact}}

## 目的
{{purpose}}

${INVESTMENT_VIEW_TEMPLATE}

## トピックス
{{topics を1行ずつ: - {内容}}}

--- テンプレートここまで ---`;

const STOCK_SPLIT_TEMPLATE = `
--- 出力テンプレート ---

## 全体要約
{{summary}}

## 分割・併合内容
- 区分: {{details.action}}
- 比率: {{details.ratio}}
- 基準日: {{details.recordDate}}
- 効力発生日: {{details.effectiveDate}}
- 実施前株式数: {{details.sharesBefore}}
- 実施後株式数: {{details.sharesAfter}}
- 発行可能株式総数: {{details.authorizedSharesChange}}
- 配当への影響: {{details.dividendImpact}}

## 目的
{{purpose}}

${INVESTMENT_VIEW_TEMPLATE}

## トピックス
{{topics を1行ずつ: - {内容}}}

--- テンプレートここまで ---`;

const CAPITAL_POLICY_TEMPLATE = `
--- 出力テンプレート ---

## 全体要約
{{summary}}

## 取引内容
- 方法: {{transaction.method}}
- 割当先・提携先: {{transaction.counterparty}}
- 調達額: {{transaction.amount}}
- 発行株式・新株予約権: {{transaction.sharesOrRights}}
- 希薄化率: {{transaction.dilution}}
- 発行・行使価額: {{transaction.price}}
- 払込期日: {{transaction.paymentDate}}

## 資金使途
{{useOfFunds を1行ずつ: - {text} [p.{page}]}}

## 業務提携
{{partnership を1行ずつ: - {text} [p.{page}]}}

${INVESTMENT_VIEW_TEMPLATE}

## トピックス
{{topics を1行ずつ: - {内容}}}

--- テンプレートここまで ---`;

const BUSINESS_UPDATE_TEMPLATE = `
--- 出力テンプレート ---

## 全体要約
{{summary}}

## 対象期間
{{period}}

## 主要KPI
{{kpis を1行ずつ: - {name}: {value}（{comparison}、{scope}） [p.{page}] ※null部分は省略}}

## 増減要因
{{drivers を1行ずつ: - {text} [p.{page}]}}

## 一過性要因
{{oneOffFactors を1行ずつ: - {text} [p.{page}]}}

${INVESTMENT_VIEW_TEMPLATE}

## トピックス
{{topics を1行ずつ: - {内容}}}

--- テンプレートここまで ---`;

const GOVERNANCE_TEMPLATE = `
--- 出力テンプレート ---

## 全体要約
{{summary}}

## 変更区分
{{changeType}}

## 人事
{{people を1行ずつ: - {name}: {previousRole} → {newRole}（{effectiveDate}） ※null部分は省略}}

## ガバナンス体制
{{governanceChanges を1行ずつ: - {text} [p.{page}]}}

## 内部統制・再発防止
{{internalControl を1行ずつ: - {text} [p.{page}]}}

${INVESTMENT_VIEW_TEMPLATE}

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
      template = SHAREHOLDER_BENEFIT_TEMPLATE;
      break;
    case 'stockSplit':
      template = STOCK_SPLIT_TEMPLATE;
      break;
    case 'capitalPolicy':
      template = CAPITAL_POLICY_TEMPLATE;
      break;
    case 'businessUpdate':
      template = BUSINESS_UPDATE_TEMPLATE;
      break;
    case 'governance':
      template = GOVERNANCE_TEMPLATE;
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
