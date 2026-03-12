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
 *
 * 戻り値:
 * - getPromptForDocumentType() は { system, user } を返す
 *   system: 役割定義 + ルール + 出力形式
 *   user: 抽出テキストのみ
 */

import type { DocumentType, EarningsContext, EarningsPeriod } from './document-type';
import { getJsonSchema, getEarningsRatingRulesText } from './summary-schema';

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
3. 本文にない項目は出力から省略してください（「null」「本文に記載なし」「該当なし」等と書かない）
4. ただし、売上高・経常利益・当期純利益などの重要指標が本文に見つからない場合のみ「取得不能」と明記してください
5. 前年同期比や前期比は本文に明記されている場合のみ記載してください。記載がない場合は括弧部分ごと省略してください（例: 「- 売上高: 10,856百万円」のみ出力）
6. 前年同期比/前期比の増減率が本文にある場合は必ず記載し、省略しないでください
7. 勘定科目名は本文の表記をそのまま使用してください（例: 売上収益、事業利益、経常収益など）。赤字の場合は金額を「△」で始め、括弧内に「赤字」または「損失」を付記してください
8. 日付は「YYYY年M月D日」形式で統一してください（例: 2026年1月14日、元号表記がある場合も西暦に変換）

【数値表記ルール】
- 金額単位は本文の表記をそのまま使用してください（同一セクション内で統一）
- 増減率は小数点第1位まで記載してください（例: +12.3%、△5.0%）
- 通期予想が「未定」の場合はそのまま「未定」と記載してください
- レンジ予想は「下限〜上限」形式で記載してください

【出力形式ルール】
- 出力形式に記載されたセクション（## 見出し）を指定順序で出力してください
- 指定されたセクション以外は追加しないでください
- 見出しは「## 」（半角シャープ2つ + 半角スペース）で統一してください
- 本文に該当情報がないセクションは見出しごと省略してください
- セクション内の個別項目で情報がない場合はその行を丸ごと省略してください（「null」と書かない）
- {…} で囲まれたプレースホルダは実際の値に置き換えてください`;

/**
 * トピックス共通ルール（全文書タイプ共通）
 */
const COMMON_TOPICS_RULES = `
- トピックスは「タイトル:」を付けずに、内容を直接記載してください
- トピックスは全体要約で触れていない具体的な情報のみを記載してください
- 以下の観点を優先的に拾ってください:
  - セグメント別で全体と異なる傾向（好調/不調セグメント）
  - 一時的な要因（特別損益、為替影響、のれん償却、訴訟関連等）
  - 先行指標（受注残、パイプライン、月次動向、新規出店等）
  - 前回開示からの変化点やサプライズ要素`;

/**
 * 決算評価の判定ルールを生成（出力形式の前に配置する内部ルール）
 *
 * 重要: これは出力フォーマットではなく、LLMへの判定指示。
 * 基準表自体は出力に含めないよう明示する。
 *
 * 評価は経常利益に一本化し、実績/予想の2グループで構成する。
 */
function buildRatingRules(ctx: EarningsContext): string {
  const isQuarterly = ctx.period !== 'fullYear';

  const progressOrLanding = isQuarterly
    ? `■ 進捗: 経常利益の進捗率 − 標準進捗率の差で判定
★5: +10pt以上 / ★4: +5〜+10pt / ★3: ±5pt / ★2: △5〜△10pt / ★1: △10pt超 / 通期予想が未定・ゼロ・赤字→「★—」`
    : `■ 着地: 経常利益の実績 vs 会社予想の乖離率で判定
★5: +15%以上or黒字転換 / ★4: +5〜+15% / ★3: ±5% / ★2: △5〜△15% / ★1: △15%未満or赤字転落 / 会社予想なし→「—（取得不能）」`;

  const forecastRevision = isQuarterly
    ? `■ 予想修正: 通期予想の従来予想からの修正方向
↑上方修正（従来予想比+XX.X%を付記） / →修正なし / ↓下方修正（従来予想比△XX.X%を付記） / —予想未定`
    : `■ 配当: 増配/減配/据置の方向
↑増配（XX円→YY円） / →据置 / ↓減配 / —未定or記載なし`;

  return `
【内部判定ルール】以下は判定用の基準です。出力には判定結果（★の数と根拠数値）のみを記載してください。基準表は出力しないでください。

■ 対前年: 経常利益の増減率で判定（実績・予想共通）
★5: +30%以上or黒字転換 / ★4: +10〜+30% / ★3: +3〜+10% / ★2: △3〜+3% / ★1: △3%未満or赤字転落

${progressOrLanding}

${forecastRevision}

※数値が本文にない場合は「—（取得不能）」、赤字で増減率が無意味な場合は「★—（赤字のため評価対象外）」
※必ず本文の数値に基づいて判断し、印象で評価しないこと`;
}

/**
 * 決算評価の出力テンプレート（出力形式の中に配置）
 *
 * 経常利益ベースの【実績】【通期予想/来期予想】2グループ構造。
 */
function buildEvaluationTemplate(ctx: EarningsContext): string {
  const isQuarterly = ctx.period !== 'fullYear';
  const actualComparisonLabel = isQuarterly ? '前年同期比' : '前期比';

  if (isQuarterly) {
    const standardRate = getStandardProgressRate(ctx.period);
    return `
## 決算評価（経常利益ベース）
【実績】
- 対前年:  ★★★★☆（${actualComparisonLabel}+XX.X%）
- 進捗:   ★★★★☆（進捗率XX.X% / 標準${standardRate}%）

【通期予想】
- 対前年:  ★★★☆☆（前期比+XX.X%）
- 予想修正: ↑ 上方修正（従来予想比+XX.X%）`;
  }

  return `
## 決算評価（経常利益ベース）
【実績】
- 対前年:  ★★★★☆（${actualComparisonLabel}+XX.X%）
- 着地:   ★★★★★（対会社予想+XX.X%）

【来期予想】（本文に記載がある場合のみ）
- 対前年:  ★★★☆☆（前期比+XX.X%）
- 配当:   ↑ 増配（XX円 → YY円）`;
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

  const summarySection = buildSummarySection();
  const performanceSection = buildPerformanceSection(comparisonLabel, periodLabel);
  const progressSection = isQuarterly ? buildProgressSection(ctx) : '';
  const forecastSection = buildForecastSection(ctx);
  const revisionAndDividendSection = buildRevisionAndDividendSection();
  const topicsSection = buildTopicsSection();

  return [
    ROLE_DEFINITION,
    COMMON_RULES,
    accountingNote,
    buildRatingRules(ctx),
    buildEarningsSpecificRules(ctx),
    `\n--- 出力形式 ---`,
    buildEvaluationTemplate(ctx),
    summarySection,
    performanceSection,
    progressSection,
    forecastSection,
    revisionAndDividendSection,
    topicsSection,
    `\n--- 出力形式ここまで ---`,
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
- {勘定科目}: {金額}（${comparisonLabel}{増減率}）  ※増減率が本文にない場合は括弧ごと省略し「- {勘定科目}: {金額}」のみ
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
- 経常利益: {進捗率}（前年同期{前年進捗率}、標準進捗率${standardRate}%）
※通期予想が未定・算出不可の場合はセクションごと省略。前年進捗率が不明なら「前年同期...」部分を省略`;
}

function buildForecastSection(ctx: EarningsContext): string {
  if (ctx.period !== 'fullYear') {
    return `
## 通期予想
- {勘定科目}: {金額}（前期比{増減率}）  ※増減率が本文にない場合は括弧ごと省略
- ...`;
  }
  return `
## 来期予想（本文に記載がある場合のみ）
- {勘定科目}: {金額}（前期比{増減率}）  ※増減率が本文にない場合は括弧ごと省略
- ...`;
}

function buildRevisionAndDividendSection(): string {
  return `
## 修正・配当
- 業績予想の修正: {修正がある場合: 修正対象と変更内容を簡潔に。ない場合は「修正なし」と記載}
※以下の配当項目は本文に記載がある場合のみ出力（記載がなければ行ごと省略）:
- 中間配当: {金額}
- 期末配当: {金額}
- 年間配当: {金額}
- 配当予想の修正: {修正がある場合: 旧予想→新予想を中間/期末/年間ごとに記載}`;
}

function buildSummarySection(): string {
  return `
## 全体要約
{${PROMPT_CONFIG.SUMMARY_STYLE.earnings}で、業績の傾向、通期見通し、修正/配当の有無を含めて記載}`;
}

function buildTopicsSection(): string {
  return `
## トピックス
- {全体要約で触れていない具体的な数値・事実を簡潔に記載}`;
}

function buildEarningsSpecificRules(ctx: EarningsContext): string {
  const isQuarterly = ctx.period !== 'fullYear';
  const progressRules = isQuarterly
    ? `
- 進捗率は経常利益について「当期実績 ÷ 通期予想 × 100」で算出してください
- 1行形式で記載し、計算式・計算過程・説明文は書かないでください
- 前年同期の進捗率が本文から得られない場合は省略可
- 通期予想が未定・ゼロ・赤字予想の場合は「算出不可（理由）」と記載してください`
    : '';

  return `
【決算短信の注意事項】
- ★評価は★（黒星）と☆（白星）を並べて5段階で表記してください（例: ★★★★☆=4点、★★☆☆☆=2点）。数字やMarkdown記法（**太字**等）は使わないでください。括弧は全角（）を使用してください
- 黒字転換/赤字転落/赤字拡大/赤字縮小は本文に明記がある場合のみ記載し、増減率の後ろに補足として付記してください${progressRules}
- トピックスは最大${PROMPT_CONFIG.MAX_TOPICS.earnings}点までにしてください
${COMMON_TOPICS_RULES}`;
}

/**
 * 業績修正用プロンプト
 */
function buildEarningsRevisionPrompt(): string {
  return `${ROLE_DEFINITION}${COMMON_RULES}

【業績修正の注意事項】
- トピックスは最大${PROMPT_CONFIG.MAX_TOPICS.earningsRevision}点までにしてください
${COMMON_TOPICS_RULES}

--- 出力形式 ---
## 全体要約
{${PROMPT_CONFIG.SUMMARY_STYLE.earningsRevision}で、修正の方向性と主要因、配当への影響を含めて記載}

## 修正内容
- {勘定科目}: 前回予想{金額} → 修正後{金額}（{増減率}）
- {勘定科目}: 前回予想{金額} → 修正後{金額}（{増減率}）
- ...

## 修正理由
{修正理由を2-3行で簡潔に}

## 配当予想の修正
- 修正内容: {中間/期末/年間の 旧予想→新予想を記載}
- 修正理由: {配当修正の理由を1-2行で簡潔に}

## トピックス
- {全体要約で触れていない具体的な数値・事実を簡潔に記載}
--- 出力形式ここまで ---`;
}

/**
 * 配当用プロンプト
 */
function buildDividendPrompt(): string {
  return `${ROLE_DEFINITION}${COMMON_RULES}

【配当の注意事項】
- 増配/減配/据置は本文に明記されている場合のみ記載してください
- トピックスは最大${PROMPT_CONFIG.MAX_TOPICS.dividend}点までにしてください
${COMMON_TOPICS_RULES}

--- 出力形式 ---
## 全体要約
{${PROMPT_CONFIG.SUMMARY_STYLE.dividend}で、配当水準の変化と理由、修正有無を含めて記載}

## 配当内容
- 中間配当: {金額}
- 期末配当: {金額}
- 年間配当: {金額}
- 配当性向: {パーセント}
- 予想修正: {修正がある場合: 旧予想→新予想を中間/期末/年間ごとに記載}
- 前期比較: 年間配当{前期金額} → {今期金額}（{増減額}、増配/減配/据置）

## 配当方針
{配当方針や株主還元方針を1-2行で簡潔に}

## トピックス
- {全体要約で触れていない具体的な数値・事実を簡潔に記載}
--- 出力形式ここまで ---`;
}

/**
 * M&A用プロンプト
 */
function buildMAPrompt(): string {
  return `${ROLE_DEFINITION}${COMMON_RULES}

【M&Aの注意事項】
- トピックスは最大${PROMPT_CONFIG.MAX_TOPICS.ma}点までにしてください
${COMMON_TOPICS_RULES}

--- 出力形式 ---
## 全体要約
{${PROMPT_CONFIG.SUMMARY_STYLE.ma}で、取引の狙い、規模、業績影響の有無を含めて記載}

## 取引概要
- 対象会社: {会社名}
- 取引内容: {株式取得/譲渡/その他}
- スキーム: {子会社化/持分法適用/合併/事業譲渡/その他}
- 取得比率: {パーセント}
- 取得価額: {金額}
- 契約締結日: {日付}
- 取得予定日: {日付}

## 目的
{取引の目的を2-3行で簡潔に}

## 業績・連結への影響
- 売上への影響: {金額または説明}
- 利益への影響: {金額または説明}
- 連結範囲の変更: {変更内容}

## トピックス
- {全体要約で触れていない具体的な数値・事実を簡潔に記載}
--- 出力形式ここまで ---`;
}

/**
 * 自己株式取得用プロンプト
 */
function buildShareRepurchasePrompt(): string {
  return `${ROLE_DEFINITION}${COMMON_RULES}

【自己株式取得の注意事項】
- トピックスは最大${PROMPT_CONFIG.MAX_TOPICS.shareRepurchase}点までにしてください
${COMMON_TOPICS_RULES}

--- 出力形式 ---
## 全体要約
{${PROMPT_CONFIG.SUMMARY_STYLE.shareRepurchase}で、取得枠の規模、目的、消却有無を含めて記載}

## 取得内容
- 取得株数: {株数}（発行済株式総数に対する割合: {パーセント}）
- 取得価額: {金額}
- 取得期間: {期間}
- 取得方法: {市場買付/その他}
- 消却予定: {消却予定の有無と時期}

## 目的
{取得の目的を1-2行で簡潔に}

## トピックス
- {全体要約で触れていない具体的な数値・事実を簡潔に記載}
--- 出力形式ここまで ---`;
}

/**
 * その他の文書用プロンプト
 */
function buildOtherPrompt(): string {
  return `${ROLE_DEFINITION}${COMMON_RULES}

【その他文書の注意事項】
- トピックスは最大${PROMPT_CONFIG.MAX_TOPICS.other}点までにしてください
${COMMON_TOPICS_RULES}

--- 出力形式 ---
## 全体要約
{${PROMPT_CONFIG.SUMMARY_STYLE.other}で、影響の有無と重要点を含めて記載}

## 開示内容
{開示の主要内容を箇条書きで}
- 対象範囲: {会社/子会社/事業/その他}
- 期限・予定: {日付/期間}

## 業績・株価への影響
- 影響内容: {業績や株価への影響を記載}

## トピックス
- {全体要約で触れていない具体的な数値・事実を簡潔に記載}
--- 出力形式ここまで ---`;
}

/**
 * 文書タイプ別プロンプトマップ
 */
const PROMPTS: Record<DocumentType, string> = {
  earnings: buildEarningsPrompt({
    period: 'q2',
    accountingStandard: 'jpGaap',
    isConsolidated: true,
  }),
  earningsRevision: buildEarningsRevisionPrompt(),
  dividend: buildDividendPrompt(),
  ma: buildMAPrompt(),
  shareRepurchase: buildShareRepurchasePrompt(),
  other: buildOtherPrompt(),
};

/**
 * 文書タイプに応じたプロンプトを取得
 *
 * @param documentType 文書タイプ
 * @param extractedText 抽出されたテキスト
 * @param earningsContext 決算コンテキスト（決算短信の場合のみ）
 * @returns { system, user } — systemプロンプトとuserメッセージ
 */
export function getPromptForDocumentType(
  documentType: DocumentType,
  extractedText: string,
  earningsContext?: EarningsContext
): { system: string; user: string } {
  const systemPrompt =
    documentType === 'earnings' && earningsContext
      ? buildEarningsPrompt(earningsContext)
      : PROMPTS[documentType];
  return {
    system: systemPrompt,
    user: `以下の開示文書を上記の出力形式に従って要約してください。\n\n${extractedText}`,
  };
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

// ── 2パス要約: パス1（情報抽出）用プロンプト ──

/**
 * パス1の共通抽出ルール
 */
const EXTRACTION_ROLE = `あなたはTDnet適時開示情報の情報抽出アシスタントです。
以下の開示文書から情報を抽出し、指定されたJSON形式で出力してください。`;

const EXTRACTION_RULES = `
【最優先ルール - 絶対遵守】
1. 本文に記載されている情報のみを使用してください（捏造厳禁）
2. 数値は本文から正確に抽出してください（計算が必要な場合は本文に計算根拠がある場合のみ）
3. JSON以外は一切出力しないでください（説明文・コードブロック記法も不要）

【重要ルール】
4. 前年同期比/前期比の増減率が本文にある場合は必ず記載し、省略しないでください
5. 勘定科目名は本文の表記をそのまま使用してください（例: 売上収益、事業利益、経常収益など）
6. 赤字の場合は金額を「△」で始め、括弧内に「赤字」または「損失」を付記してください
7. 日付は「YYYY年M月D日」形式で統一してください
8. 金額単位は本文の表記をそのまま使用してください
9. 増減率は小数点第1位まで記載してください（例: +12.3%、△5.0%）
10. 該当情報がない項目はnullを設定してください（空文字""ではなくnull）
11. 配列フィールドで該当情報がない場合は空配列[]を設定してください
12. items配列内のchangeフィールド: 増減率が本文にない場合はnullを設定してください（"null"という文字列ではなくJSON null値）`;

const EXTRACTION_TOPICS_RULES = `
【トピックス抽出の重点事項】
topicsには以下の観点を最優先で拾ってください（具体的な数値を含めること）:
- セグメント別・事業別の業績で全体と異なる傾向があるもの（好調/不調セグメントの売上・利益と前年比）
- 受注残高・受注増減・パイプライン・月次動向・新規出店等の先行指標
- 一時的な要因（特別損益、為替影響、のれん償却、訴訟関連等）
- 前回開示からの変化点やサプライズ要素
- 事業別の前年比で特異な動きがあるもの
※抽象的な記述は禁止。必ず本文中の具体的な数値・事実を含めること
※全体要約（summary）で触れていない情報のみを記載すること`;

/**
 * 決算短信用の追加抽出ルール
 */
function buildEarningsExtractionNote(ctx: EarningsContext): string {
  const isQuarterly = ctx.period !== 'fullYear';
  const accountingNote = buildAccountingNote(ctx);
  const ratingRules = getEarningsRatingRulesText(ctx);

  const progressNote = isQuarterly
    ? `
【進捗率について】
- 進捗率は経常利益について「当期実績 ÷ 通期予想 × 100」で算出してください
- 通期予想が未定・ゼロ・赤字予想の場合は「算出不可（理由）」と記載してください`
    : '';

  return `${accountingNote}

【決算評価の判定ルール】
以下の基準に従って★評価を判定してください。
★は★（黒星）と☆（白星）を並べて5段階で表記してください（例: ★★★★☆=4点、★★☆☆☆=2点）。
括弧は全角（）を使用してください。
${ratingRules}${progressNote}`;
}

/**
 * パス1（情報抽出）用プロンプトを取得
 *
 * @param documentType 文書タイプ
 * @param extractedText 抽出されたテキスト
 * @param earningsContext 決算コンテキスト（決算短信の場合のみ）
 * @returns { system, user } — systemプロンプトとuserメッセージ
 */
export function getExtractionPrompt(
  documentType: DocumentType,
  extractedText: string,
  earningsContext?: EarningsContext
): { system: string; user: string } {
  const schema = getJsonSchema(documentType, earningsContext);

  const extraRules =
    documentType === 'earnings' && earningsContext
      ? buildEarningsExtractionNote(earningsContext)
      : '';

  const maxTopics =
    documentType === 'earnings'
      ? PROMPT_CONFIG.MAX_TOPICS.earnings
      : PROMPT_CONFIG.MAX_TOPICS[documentType];

  const systemPrompt = [
    EXTRACTION_ROLE,
    EXTRACTION_RULES,
    extraRules,
    EXTRACTION_TOPICS_RULES,
    `\n- topicsは最大${maxTopics}点までにしてください`,
    `\n【出力JSON形式】\n${schema}`,
  ]
    .filter(Boolean)
    .join('\n');

  return {
    system: systemPrompt,
    user: `以下の開示文書から情報を抽出してください。\n\n${extractedText}`,
  };
}
