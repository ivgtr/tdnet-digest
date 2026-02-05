/**
 * 文書タイプ別プロンプト
 *
 * LLMに送信する要約プロンプトを文書タイプごとに定義する。
 * 捏造対策: 「本文にある場合のみ計算／なければ取得不能」を明記。
 *
 * 構造:
 * - ROLE_DEFINITION: 役割定義（全プロンプト共通）
 * - COMMON_RULES: 共通ルール（全プロンプト共通）
 * - PROMPT_CONFIG: 設定値（トピックス数、要約文数など）
 * - 各文書タイプ別の OUTPUT_FORMAT と SPECIFIC_RULES
 */

import type { DocumentType, EarningsContext, EarningsPeriod } from './document-type';

/**
 * プロンプト設定値
 */
const PROMPT_CONFIG = {
  /** トピックス最大項目数 */
  MAX_TOPICS: {
    earnings: 8,
    earningsRevision: 4,
    dividend: 4,
    ma: 4,
    shareRepurchase: 4,
    other: 4,
  },
  /** 全体要約の推奨スタイル */
  SUMMARY_STYLE: {
    earnings: '簡潔な文章体（2-5段落程度）',
    earningsRevision: '簡潔な文章体（1-3段落程度）',
    dividend: '簡潔な文章体（1-3段落程度）',
    ma: '簡潔な文章体（1-3段落程度）',
    shareRepurchase: '簡潔な文章体（1-3段落程度）',
    other: '簡潔な文章体（1-3段落程度）',
  },
} as const;

/**
 * 役割定義（全プロンプト共通）
 */
const ROLE_DEFINITION = `あなたはTDnet適時開示情報の要約アシスタントです。
投資家が知りたい重要な情報を簡潔にまとめてください。`;

/**
 * 共通ルール（全プロンプト共通）
 */
const COMMON_RULES = `
【最優先ルール - 絶対遵守】
1. 本文に記載されている情報のみを使用してください（捏造厳禁）
2. 数値は本文から正確に抽出してください（計算が必要な場合は本文に計算根拠がある場合のみ）

【重要ルール】
3. 本文にない項目は出力から省略してください（わざわざ「本文に記載なし」と書く必要はありません）
4. ただし、売上高・経常利益・当期純利益などの重要指標が本文に見つからない場合のみ「取得不能」と明記してください
5. 前年同期比や前期比は本文に明記されている場合のみ記載してください
6. 前年同期比/前期比の増減率が本文にある場合は必ず記載し、省略しないでください
7. 勘定科目名は本文の表記をそのまま使用してください（例: 売上収益、事業利益、経常収益など）。赤字の場合は金額を「△」で始め、括弧内に「赤字」または「損失」を付記してください
8. 日付は「YYYY年M月D日」形式で統一してください（例: 2026年1月14日、元号表記がある場合も西暦に変換）

【数値表記ルール】
- 金額単位は本文の表記をそのまま使用してください（同一セクション内で統一）
- 増減率は小数点第1位まで記載してください（例: +12.3%、△5.0%）
- 通期予想が「未定」の場合はそのまま「未定」と記載してください
- レンジ予想は「下限〜上限」形式で記載してください`;

/**
 * トピックス共通ルール（全文書タイプ共通）
 */
const COMMON_TOPICS_RULES = `
- トピックスは「タイトル:」を付けずに、内容を直接記載してください
- トピックスは全体要約で触れていない具体的な情報のみを記載してください`;

/**
 * 決算短信用プロンプト - 出力形式
 */
const EARNINGS_OUTPUT_FORMAT = `
以下の決算短信から、投資家向けの要約を作成してください。

出力形式:
## 業績サマリー（実績）
- 売上高: [金額]（前年同期比[増減率]）
- 営業利益: [金額]（前年同期比[増減率]）
- 経常利益: [金額]（前年同期比[増減率]）
- 当期純利益: [金額]（前年同期比[増減率]）

## 進捗率（通期予想に対して）
- 経常利益: XX.X%（前年同期YY.Y%、標準進捗率ZZ%）

## 通期予想
- 売上高: [金額]（前期比[増減率]）
- 営業利益: [金額]（前期比[増減率]）
- 経常利益: [金額]（前期比[増減率]）
- 当期純利益: [金額]（前期比[増減率]）

## 業績予想の修正
- 業績予想の修正: 有/無（有の場合: 修正対象と変更内容を簡潔に）

## 配当
- 中間配当: [金額]
- 期末配当: [金額]
- 年間配当: [金額]
- 配当予想の修正: 有/無（有の場合: 旧予想→新予想を中間/期末/年間ごとに記載）

## 全体要約
[${PROMPT_CONFIG.SUMMARY_STYLE.earnings}で、以下の内容を含めてください：業績の傾向、通期見通し、修正/配当の有無]

## トピックス
- [全体要約だけでは分からない具体情報を簡潔に記載]`;

/**
 * 決算短信用プロンプト - 固有の注意事項
 */
const EARNINGS_SPECIFIC_RULES = `
追加の注意事項:
- 進捗率は経常利益について「当期実績 ÷ 通期予想 × 100」で算出してください
- 前年同期の進捗率が本文から得られない場合は省略可
- 通期予想が未定・ゼロ・赤字予想の場合は「算出不可（理由）」と記載してください
- 黒字転換/赤字転落/赤字拡大/赤字縮小は本文に明記がある場合のみ記載し、増減率の後ろに補足として付記してください
- トピックスは最大${PROMPT_CONFIG.MAX_TOPICS.earnings}点までにしてください
${COMMON_TOPICS_RULES}`;

/**
 * 決算短信用プロンプト（完成版）
 */
const EARNINGS_PROMPT = `${ROLE_DEFINITION}${COMMON_RULES}${EARNINGS_OUTPUT_FORMAT}${EARNINGS_SPECIFIC_RULES}`;

/**
 * 決算評価の判定ルールを生成（出力形式の前に配置する内部ルール）
 *
 * 重要: これは出力フォーマットではなく、LLMへの判定指示。
 * 基準表自体は出力に含めないよう明示する。
 */
function buildRatingRules(ctx: EarningsContext): string {
  const isQuarterly = ctx.period !== 'fullYear';

  const progressOrLanding = isQuarterly
    ? `■ 進捗（経常利益の進捗率 − 標準進捗率の差）
★5: +10pt以上 / ★4: +5〜+10pt / ★3: ±5pt / ★2: △5〜△10pt / ★1: △10pt超
通期予想が未定/ゼロ/赤字の場合は「★—」`
    : `■ 着地（主要利益の前期比）
★5: +30%以上or黒字転換 / ★4: +10〜+30% / ★3: +3〜+10% / ★2: △3〜+3% / ★1: △3%未満or赤字転落`;

  return `
【決算評価の判定ルール — 出力しないでください】
以下の基準で★を判定し、「## 決算評価」セクションに判定結果のみ出力してください。
この基準表・計算ルール自体は絶対に出力に含めないでください。

■ 成長性（売上高の増減率）
★5: +20%以上 / ★4: +10〜+20% / ★3: +3〜+10% / ★2: △3〜+3% / ★1: △3%未満

■ 収益性（主要利益の増減率）
★5: +30%以上or黒字転換 / ★4: +10〜+30% / ★3: +3〜+10% / ★2: △3〜+3% / ★1: △3%未満or赤字転落

${progressOrLanding}

■ 予想修正
↑上方修正あり / →修正なし / ↓下方修正あり / —予想未定

※数値が本文にない場合は「—（取得不能）」、赤字で増減率が無意味な場合は「★—（赤字のため評価対象外）」
※必ず本文の数値に基づいて判断し、印象で評価しないこと`;
}

/**
 * 決算評価の出力テンプレート（出力形式の中に配置）
 */
function buildEvaluationTemplate(ctx: EarningsContext): string {
  const isQuarterly = ctx.period !== 'fullYear';
  const comparisonLabel = isQuarterly ? '前年同期比' : '前期比';

  const standardRate = getStandardProgressRate(ctx.period);
  const progressOrLanding = isQuarterly
    ? `- 進捗:   ★★★★☆（経常利益 進捗率XX.X% / 標準${standardRate}%）`
    : `- 着地:   ★★★★☆（主要利益 前期比+XX.X%）`;

  return `
## 決算評価
- 成長性:  ★★★★☆（売上高 ${comparisonLabel}+XX.X%）
- 収益性:  ★★★★★（主要利益 ${comparisonLabel}+XX.X%）
${progressOrLanding}
- 予想修正: → 修正なし
※★評価は★（黒星）と☆（白星）を並べて5段階で表記してください（例: ★★★★☆=4点、★★☆☆☆=2点）。数字やMarkdown記法（**太字**等）は使わないでください。括弧は全角（）を使用してください。`;
}

/**
 * 決算短信プロンプトを動的に生成
 *
 * EarningsContext に応じて四半期/通期、会計基準ごとに
 * 最適なプロンプトテキストを組み立てる。
 */
function buildEarningsPrompt(ctx: EarningsContext): string {
  const isQuarterly = ctx.period !== 'fullYear';
  const comparisonLabel = isQuarterly ? '前年同期比' : '前期比';
  const periodLabel = buildPeriodLabel(ctx);
  const accountingNote = buildAccountingNote(ctx);

  const performanceSection = buildPerformanceSection(comparisonLabel, periodLabel);
  const progressSection = isQuarterly ? buildProgressSection(ctx) : '';
  const forecastSection = buildForecastSection(ctx);
  const revisionSection = buildRevisionSection();
  const dividendSection = buildDividendSection();
  const summarySection = buildSummarySection();
  const topicsSection = buildTopicsSection();

  return [
    ROLE_DEFINITION,
    COMMON_RULES,
    accountingNote,
    buildRatingRules(ctx),
    `\n以下の決算短信から、投資家向けの要約を作成してください。\n\n出力形式:`,
    buildEvaluationTemplate(ctx),
    performanceSection,
    progressSection,
    forecastSection,
    revisionSection,
    dividendSection,
    summarySection,
    topicsSection,
    buildEarningsSpecificRules(),
  ]
    .filter(Boolean)
    .join('\n');
}

function buildPeriodLabel(ctx: EarningsContext): string {
  const consolidatedLabel = ctx.isConsolidated ? '連結' : '個別';
  switch (ctx.period) {
    case 'q1':
      return `第1四半期${consolidatedLabel}実績`;
    case 'q2':
      return `第2四半期${consolidatedLabel}実績`;
    case 'q3':
      return `第3四半期${consolidatedLabel}実績`;
    case 'fullYear':
      return `通期${consolidatedLabel}実績`;
  }
}

function buildAccountingNote(ctx: EarningsContext): string {
  switch (ctx.accountingStandard) {
    case 'ifrs':
      return `\n【会計基準に関する注記】
この文書はIFRS（国際会計基準）に基づいています。
- 「経常利益」に相当する勘定科目がない場合があります（「税引前利益」や「事業利益」で代替）
- 本文の勘定科目名（売上収益、事業利益、税引前利益、当期利益等）をそのまま使用してください`;
    case 'usGaap':
      return `\n【会計基準に関する注記】
この文書は米国基準に基づいています。
- 本文の勘定科目名をそのまま使用してください`;
    case 'jpGaap':
      return '';
  }
}

function buildPerformanceSection(
  comparisonLabel: string,
  periodLabel: string
): string {
  return `
## 業績サマリー（${periodLabel}）
- [本文の勘定科目]: [金額]（${comparisonLabel}[増減率]）
- [本文の勘定科目]: [金額]（${comparisonLabel}[増減率]）
- ...（本文に記載されている主要な勘定科目をすべて記載）`;
}

/**
 * 決算期区分から標準進捗率を算出
 *
 * Q1→25%, Q2→50%, Q3→75%
 * fullYear では呼ばれない想定だが安全のため 100 を返す。
 */
function getStandardProgressRate(period: EarningsPeriod): number {
  switch (period) {
    case 'q1':
      return 25;
    case 'q2':
      return 50;
    case 'q3':
      return 75;
    case 'fullYear':
      return 100;
  }
}

function buildProgressSection(ctx: EarningsContext): string {
  const standardRate = getStandardProgressRate(ctx.period);

  return `
## 進捗率（通期予想に対して）
- 経常利益: XX.X%（前年同期YY.Y%、標準進捗率${standardRate}%）
※1行形式で記載し、計算式・計算過程・説明文は書かないでください
※前年同期の進捗率が本文から得られない場合は省略可
※通期予想が未定・ゼロ・赤字予想の場合は「算出不可（理由）」と記載してください`;
}

function buildForecastSection(ctx: EarningsContext): string {
  if (ctx.period !== 'fullYear') {
    return `
## 通期予想
- [本文の勘定科目]: [金額]（前期比[増減率]）
- ...`;
  }
  return `
## 来期予想（本文に記載がある場合のみ）
- [本文の勘定科目]: [金額]（前期比[増減率]）
- ...`;
}

function buildRevisionSection(): string {
  return `
## 業績予想の修正
- 業績予想の修正: 有/無（有の場合: 修正対象と変更内容を簡潔に）`;
}

function buildDividendSection(): string {
  return `
## 配当
- 中間配当: [金額]
- 期末配当: [金額]
- 年間配当: [金額]
- 配当予想の修正: 有/無（有の場合: 旧予想→新予想を中間/期末/年間ごとに記載）`;
}

function buildSummarySection(): string {
  return `
## 全体要約
[${PROMPT_CONFIG.SUMMARY_STYLE.earnings}で、以下の内容を含めてください：業績の傾向、通期見通し、修正/配当の有無]`;
}

function buildTopicsSection(): string {
  return `
## トピックス
- [全体要約だけでは分からない具体情報を簡潔に記載]`;
}

function buildEarningsSpecificRules(): string {
  return `
追加の注意事項:
- 黒字転換/赤字転落/赤字拡大/赤字縮小は本文に明記がある場合のみ記載し、増減率の後ろに補足として付記してください
- トピックスは最大${PROMPT_CONFIG.MAX_TOPICS.earnings}点までにしてください
${COMMON_TOPICS_RULES}`;
}

/**
 * 業績修正用プロンプト - 出力形式
 */
const EARNINGS_REVISION_OUTPUT_FORMAT = `
以下の業績予想修正に関する開示情報から、投資家向けの要約を作成してください。

出力形式:
## 業績予想の修正
- 業績予想の修正: 有/無

## 修正内容
- 売上高: 前回予想[金額] → 修正後[金額]（[増減率]）
- 営業利益: 前回予想[金額] → 修正後[金額]（[増減率]）
- 経常利益: 前回予想[金額] → 修正後[金額]（[増減率]）
- 当期純利益: 前回予想[金額] → 修正後[金額]（[増減率]）

## 修正理由
[修正理由を2-3行で簡潔に]

## 配当予想の修正
- 配当予想の修正: 有/無
- 修正内容: [有の場合: 中間/期末/年間の 旧予想→新予想を記載]
- 修正理由: [配当修正の理由を1-2行で簡潔に]

## 全体要約
[${PROMPT_CONFIG.SUMMARY_STYLE.earningsRevision}で、以下の内容を含めてください：修正の方向性と主要因、配当への影響]

## トピックス
- [全体要約だけでは分からない具体情報を簡潔に]`;

/**
 * 業績修正用プロンプト - 固有の注意事項
 */
const EARNINGS_REVISION_SPECIFIC_RULES = `
追加の注意事項:
- トピックスは最大${PROMPT_CONFIG.MAX_TOPICS.earningsRevision}点までにしてください
${COMMON_TOPICS_RULES}`;

/**
 * 業績修正用プロンプト（完成版）
 */
const EARNINGS_REVISION_PROMPT = `${ROLE_DEFINITION}${COMMON_RULES}${EARNINGS_REVISION_OUTPUT_FORMAT}${EARNINGS_REVISION_SPECIFIC_RULES}`;

/**
 * 配当用プロンプト - 出力形式
 */
const DIVIDEND_OUTPUT_FORMAT = `
以下の配当に関する開示情報から、投資家向けの要約を作成してください。

出力形式:
## 配当内容（今期）
- 中間配当: [金額]
- 期末配当: [金額]
- 年間配当: [金額]
- 配当性向: [パーセント]

## 配当の変更
- 予想修正: 有/無（有の場合: 旧予想→新予想を中間/期末/年間ごとに記載）
- 前期比較: 年間配当[前期金額] → [今期金額]（[増減額]、増配/減配/据置）

## 配当方針
[配当方針や株主還元方針を1-2行で簡潔に]

## 全体要約
[${PROMPT_CONFIG.SUMMARY_STYLE.dividend}で、以下の内容を含めてください：配当水準の変化と理由、修正有無]

## トピックス
- [全体要約だけでは分からない具体情報を簡潔に]`;

/**
 * 配当用プロンプト - 固有の注意事項
 */
const DIVIDEND_SPECIFIC_RULES = `
追加の注意事項:
- 増配/減配/据置は本文に明記されている場合のみ記載してください
- トピックスは最大${PROMPT_CONFIG.MAX_TOPICS.dividend}点までにしてください
${COMMON_TOPICS_RULES}`;

/**
 * 配当用プロンプト（完成版）
 */
const DIVIDEND_PROMPT = `${ROLE_DEFINITION}${COMMON_RULES}${DIVIDEND_OUTPUT_FORMAT}${DIVIDEND_SPECIFIC_RULES}`;

/**
 * M&A用プロンプト - 出力形式
 */
const MA_OUTPUT_FORMAT = `
以下のM&A（株式取得・譲渡等）に関する開示情報から、投資家向けの要約を作成してください。

出力形式:
## 取引概要
- 対象会社: [会社名]
- 取引内容: [株式取得/譲渡/その他]
- スキーム: [子会社化/持分法適用/合併/事業譲渡/その他]
- 取得比率: [パーセント]
- 取得価額: [金額]

## 目的
[取引の目的を2-3行で簡潔に]

## 業績への影響
- 業績への影響: 有/無
- 売上への影響: [金額または説明]
- 利益への影響: [金額または説明]

## 連結範囲
- 連結範囲の変更: 有/無（有の場合: 変更内容）

## スケジュール
- 契約締結日: [日付]
- 株式取得予定日: [日付]

## 全体要約
[${PROMPT_CONFIG.SUMMARY_STYLE.ma}で、以下の内容を含めてください：取引の狙い、規模、業績影響の有無]

## トピックス
- [全体要約だけでは分からない具体情報を簡潔に]`;

/**
 * M&A用プロンプト - 固有の注意事項
 */
const MA_SPECIFIC_RULES = `
追加の注意事項:
- トピックスは最大${PROMPT_CONFIG.MAX_TOPICS.ma}点までにしてください
${COMMON_TOPICS_RULES}`;

/**
 * M&A用プロンプト（完成版）
 */
const MA_PROMPT = `${ROLE_DEFINITION}${COMMON_RULES}${MA_OUTPUT_FORMAT}${MA_SPECIFIC_RULES}`;

/**
 * 自己株式取得用プロンプト - 出力形式
 */
const SHARE_REPURCHASE_OUTPUT_FORMAT = `
以下の自己株式取得に関する開示情報から、投資家向けの要約を作成してください。

出力形式:
## 取得内容
- 取得株数: [株数]（発行済株式総数に対する割合: [パーセント]）
- 取得価額: [金額]
- 取得期間: [期間]
- 取得方法: [市場買付/その他]

## 目的
[取得の目的を1-2行で簡潔に]

## 消却予定
[消却予定の有無と時期]

## 全体要約
[${PROMPT_CONFIG.SUMMARY_STYLE.shareRepurchase}で、以下の内容を含めてください：取得枠の規模、目的、消却有無]

## トピックス
- [全体要約だけでは分からない具体情報を簡潔に]`;

/**
 * 自己株式取得用プロンプト - 固有の注意事項
 */
const SHARE_REPURCHASE_SPECIFIC_RULES = `
追加の注意事項:
- トピックスは最大${PROMPT_CONFIG.MAX_TOPICS.shareRepurchase}点までにしてください
${COMMON_TOPICS_RULES}`;

/**
 * 自己株式取得用プロンプト（完成版）
 */
const SHARE_REPURCHASE_PROMPT = `${ROLE_DEFINITION}${COMMON_RULES}${SHARE_REPURCHASE_OUTPUT_FORMAT}${SHARE_REPURCHASE_SPECIFIC_RULES}`;

/**
 * その他の文書用プロンプト - 出力形式
 */
const OTHER_OUTPUT_FORMAT = `
以下の開示情報から、投資家向けの要約を作成してください。

出力形式:
## 開示内容
[開示の主要内容を箇条書きで]

## 業績・株価への影響
- 業績・株価への影響: 有/無
- 影響内容: [業績や株価への影響を記載（本文に記載がある場合のみ）]

## 対象範囲・スケジュール
- 対象範囲: [会社/子会社/事業/その他]
- 期限・予定: [日付/期間]

## その他重要事項
[その他投資判断に重要な情報]

## 全体要約
[${PROMPT_CONFIG.SUMMARY_STYLE.other}で、以下の内容を含めてください：影響の有無と重要点]

## トピックス
- [全体要約だけでは分からない具体情報を簡潔に]`;

/**
 * その他の文書用プロンプト - 固有の注意事項
 */
const OTHER_SPECIFIC_RULES = `
追加の注意事項:
- トピックスは最大${PROMPT_CONFIG.MAX_TOPICS.other}点までにしてください
${COMMON_TOPICS_RULES}`;

/**
 * その他の文書用プロンプト（完成版）
 */
const OTHER_PROMPT = `${ROLE_DEFINITION}${COMMON_RULES}${OTHER_OUTPUT_FORMAT}${OTHER_SPECIFIC_RULES}`;

/**
 * 文書タイプ別プロンプトマップ
 */
const PROMPTS: Record<DocumentType, string> = {
  earnings: EARNINGS_PROMPT,
  earningsRevision: EARNINGS_REVISION_PROMPT,
  dividend: DIVIDEND_PROMPT,
  ma: MA_PROMPT,
  shareRepurchase: SHARE_REPURCHASE_PROMPT,
  other: OTHER_PROMPT,
};

/**
 * 文書タイプに応じたプロンプトを取得
 *
 * @param documentType 文書タイプ
 * @param extractedText 抽出されたテキスト
 * @param earningsContext 決算コンテキスト（決算短信の場合のみ）
 * @returns LLMに送信するプロンプト（システムプロンプト + 抽出テキスト）
 */
export function getPromptForDocumentType(
  documentType: DocumentType,
  extractedText: string,
  earningsContext?: EarningsContext
): string {
  const systemPrompt =
    documentType === 'earnings' && earningsContext
      ? buildEarningsPrompt(earningsContext)
      : PROMPTS[documentType];
  return `${systemPrompt}\n\n---\n\n${extractedText}`;
}

/**
 * システムプロンプトのみを取得（デバッグ用）
 *
 * @param documentType 文書タイプ
 * @returns システムプロンプト
 */
export function getSystemPrompt(documentType: DocumentType): string {
  return PROMPTS[documentType];
}
