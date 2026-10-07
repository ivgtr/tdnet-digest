import { stateLabels } from '@/lib/fact-summary';
/**
 * 要約表示のHTML生成ユーティリティ
 * innerHTML で管理外DOMに挿入するためのテンプレート生成
 */

import { SUMMARY_STYLES } from '../constants/styles';
import type { SummaryMetadata } from '../types/summaryMetadata';
import { parseMarkdown, parseSummaryMarkdown } from './markdownParser';
import type { ExperimentalScore, ScoreValue } from '@/lib/scoring';
import type { AdditionalAnalysis } from '@/lib/additional-analysis';
import type { Stage } from '../hooks/useSummarize';
import type { VerifiedFact } from '@/lib/fact-contract';

/**
 * エラー表示のHTMLを生成
 */
export function buildErrorHtml(errorText: string, fullRetry = false): string {
  return `
    <div style="${SUMMARY_STYLES.summaryContainer}">
      <div style="${SUMMARY_STYLES.headerRow}">
        <h4 style="${SUMMARY_STYLES.headerTitle}">要約できませんでした</h4>
        <button type="button" id="resummarize-btn" style="${SUMMARY_STYLES.resummarizeButton}">再要約</button>
      </div>
      <div role="alert" style="${SUMMARY_STYLES.errorContainer}">
        <p style="${SUMMARY_STYLES.errorText}">${escapeMetadataText(errorText)}</p>
        ${fullRetry ? `<div style="margin-top: 12px;"><button type="button" id="full-retry-btn" style="${SUMMARY_STYLES.retryButton}">全文で再要約</button></div>` : ''}
      </div>
      ${buildDiagnosticsHtml(null)}
    </div>
  `;
}

/**
 * メタデータ表示のHTMLを生成
 */
export function buildMetadataHtml(
  metadata: SummaryMetadata | null,
  part: 'all' | 'info' | 'warning' = 'all'
): string {
  if (!metadata) return '';

  const {
    extractionMode,
    totalPages,
    extractedPages,
    qualityWarning,
    provider,
    model,
    summaryMode,
    generationCalls,
    analysisSchemaVersion,
  } = metadata;
  const analysisInfo =
    provider && model && summaryMode
      ? ` | <span style="font-weight: bold;">要約:</span> ${escapeMetadataText(provider)}/${escapeMetadataText(model)}・根拠照合＋説明要約${generationCalls === undefined ? '' : `・API${generationCalls}回`}・事実v${analysisSchemaVersion ?? '?'}`
      : '';

  let html =
    part === 'warning'
      ? ''
      : `
    <div style="${SUMMARY_STYLES.metadataInfo}">
      <span style="font-weight: bold;">抽出モード:</span> ${extractionMode === 'smart' ? 'スマート抽出' : '全文抽出'} |
      <span style="font-weight: bold;">ページ:</span> ${extractedPages?.length || totalPages}/${totalPages}ページ${analysisInfo}
    </div>
  `;

  if (qualityWarning && part !== 'info') {
    html += `
      <div style="${SUMMARY_STYLES.warningBox}">
        <strong>⚠️ 品質警告:</strong> ${escapeMetadataText(qualityWarning.message)}<br>
        <span style="font-size: 11px;">不足キーワード: ${qualityWarning.missingKeywords?.map(escapeMetadataText).join(', ') || 'なし'}</span>
      </div>
    `;
  }

  return html;
}

function escapeMetadataText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 要約結果全体のHTMLを生成
 */
export function buildSummaryHtml(
  summaryText: string,
  metadata: SummaryMetadata | null,
  rowData: { companyName: string; title: string; pdfUrl?: string },
  score?: Stage<ExperimentalScore>,
  analysis?: Stage<AdditionalAnalysis>,
  facts: VerifiedFact[] = []
): string {
  const subjects = [...new Set(facts.map((fact) => fact.semantics.subject).filter(Boolean))];
  const companyName =
    metadata?.documentType &&
    ['earnings', 'earningsRevision', 'businessUpdate'].includes(metadata.documentType) &&
    subjects.length === 1
      ? subjects[0]!
      : rowData.companyName;
  return `
    <div style="${SUMMARY_STYLES.summaryContainer}">
      <div style="${SUMMARY_STYLES.headerRow}">
        <h4 style="${SUMMARY_STYLES.headerTitle}">
          AI要約: ${escapeMetadataText(companyName)} - ${escapeMetadataText(rowData.title)}
        </h4>
        <div style="${SUMMARY_STYLES.buttonGroup}">
          <button type="button" id="resummarize-btn" style="${SUMMARY_STYLES.resummarizeButton}">再要約</button>
        </div>
      </div>
      <p data-persistence-warning role="status" hidden style="font-size:12px;color:#92400e;margin:8px 0;"></p>
      ${buildMetadataHtml(metadata, 'warning')}
      <div style="${SUMMARY_STYLES.summaryText}">${parseSummaryMarkdown(summaryText, rowData.pdfUrl)}</div>
      <div id="score-result">${buildScoreStageHtml(score)}</div>
      <section data-additional-analysis style="${SUMMARY_STYLES.analysisSection}">
        <h5 style="${SUMMARY_STYLES.sectionTitle}">追加分析</h5>
        <p style="${SUMMARY_STYLES.sectionDescription}">確認済みの数値・会社説明から重要な論点を絞り、根拠・条件付きの読み・次の確認点を整理します。</p>
        <div style="${SUMMARY_STYLES.buttonGroup}">
          <button type="button" id="analyze-btn" style="${SUMMARY_STYLES.analyzeButton}" ${analysis?.loading ? 'disabled' : ''}>${analysisButtonLabel(analysis)}</button>
          <span id="analysis-status" role="status" aria-live="polite" style="font-size: 12px; color: #6b7280;">${analysis?.loading ? '追加分析を作成しています…' : ''}</span>
        </div>
        <div id="analysis-result" style="${SUMMARY_STYLES.summaryText}" aria-busy="${analysis?.loading === true}">${buildAnalysisStageHtml(analysis, facts, rowData.pdfUrl)}</div>
      </section>
      ${buildDiagnosticsHtml(metadata)}
    </div>
  `;
}

function buildDiagnosticsHtml(metadata: SummaryMetadata | null): string {
  return `<details data-generation-info style="${SUMMARY_STYLES.diagnostics}">
    <summary style="${SUMMARY_STYLES.disclosure}">生成情報・診断</summary>
    ${buildMetadataHtml(metadata, 'info')}
    ${metadata?.extractionMode === 'smart' ? `<div style="margin: 8px 0;"><button type="button" id="full-retry-btn" style="${SUMMARY_STYLES.retryButton}">全文で再要約</button></div>` : ''}
    <div data-diagnostic-root></div>
  </details>`;
}

export function analysisButtonLabel(analysis?: Stage<AdditionalAnalysis>): string {
  return analysis?.loading
    ? '分析中…'
    : analysis?.error
      ? '再試行'
      : analysis?.data
        ? '分析し直す'
        : '追加分析する';
}

export function buildScoreStageHtml(score?: Stage<ExperimentalScore>): string {
  return score?.loading
    ? '採点中…'
    : score?.error
      ? `採点失敗: ${escapeMetadataText(score.error)} <button type="button" id="retry-score-btn" style="${SUMMARY_STYLES.retryButton}">採点を再試行</button>`
      : score?.data
        ? buildScoreHtml(score.data) + buildPersistenceWarningHtml(score.persistenceWarning)
        : '';
}

export function buildAnalysisStageHtml(
  analysis?: Stage<AdditionalAnalysis>,
  facts: VerifiedFact[] = [],
  pdfUrl?: string
): string {
  return analysis?.loading
    ? ''
    : analysis?.error
      ? `<p role="alert" style="${SUMMARY_STYLES.warningBox} margin-top: 12px;">追加分析失敗: ${escapeMetadataText(analysis.error)}</p>`
      : analysis?.data
        ? buildAnalysisHtml(analysis.data, facts, pdfUrl) +
          buildPersistenceWarningHtml(analysis.persistenceWarning)
        : '';
}

function buildPersistenceWarningHtml(warning?: string): string {
  return warning
    ? `<p role="status" style="font-size:12px;color:#92400e;margin:8px 0;">${escapeMetadataText(warning)}</p>`
    : '';
}

function buildAnalysisHtml(
  analysis: AdditionalAnalysis,
  _facts: VerifiedFact[],
  pdfUrl?: string
): string {
  const labels = {
    fact: '確認済み事実',
    observation: '点検済み指標',
    explanation: '点検済み会社説明',
    calculation: '機械計算',
  };
  const link = (page: number) =>
    parseMarkdown(`[p.${page}](tdnet-page:${page})`, pdfUrl).replace(/^<p[^>]*>|<\/p>$/g, '');
  const issues = analysis.issues
    .map((issue) => {
      const evidence = issue.evidenceIds.map((id) => {
        const item = analysis.evidence.find((e) => e.id === id);
        if (!item) throw new Error('追加分析の根拠が表示結果にありません');
        return item;
      });
      const pages = [...new Set(evidence.flatMap((e) => e.pages))].sort((a, b) => a - b);
      return `<article style="margin:12px 0;padding:12px;border:1px solid #d5dee8;border-radius:6px;background:#fff;">
      <h6 style="font-size:14px;margin:0 0 8px;">${escapeMetadataText(issue.title)}</h6>
      <p><strong>結論（推論）:</strong> ${escapeMetadataText(issue.conclusion)}</p>
      <ul>${evidence.map((e) => `<li><strong>${labels[e.kind]}:</strong> ${escapeMetadataText(e.text)}${e.context ? ` <span style="color:#6b7280;">${escapeMetadataText(e.context)}</span>` : ''}</li>`).join('')}</ul>
      <p><strong>読み（条件付き）:</strong> ${escapeMetadataText(issue.reading)}</p>
      <p><strong>限界:</strong> ${escapeMetadataText(issue.caveat)}</p>
      <p><strong>次の確認:</strong> ${escapeMetadataText(issue.nextCheck)}</p>
      <p>根拠ページ: ${pages.map(link).join('・')}</p>
      <details><summary>根拠IDを表示</summary><ul>${evidence.map((e) => `<li>${escapeMetadataText(e.id)}: ${escapeMetadataText(e.sourceIds.join(', '))}</li>`).join('')}</ul></details>
    </article>`;
    })
    .join('');
  const c = analysis.coverage;
  return `<div><p style="font-size:12px;color:#6b7280;">結論と読みはAIの推論です。根拠との参照対応は確認していますが、推論の正しさを保証するものではありません。</p>
    ${issues || '<p>確認済み入力から、要約に追加できる論点を生成できませんでした。</p>'}
    ${c.organizationStatus !== 'ready' || c.unresolvedSources ? '<p style="color:#92400e;">説明・指標の一部が入力で未確認です。分析にない事項も原PDFを確認してください。</p>' : ''}
    <details><summary>追加分析の生成情報</summary><p>入力: 事実${c.facts}・説明${c.explanations}・指標${c.observations}・計算${c.calculations} / 根拠ページ ${c.pages.join(', ')} / 未整理原文${c.unresolvedSources}件・未確認事実${c.unverifiedFacts}件</p><p>入力識別子: ${escapeMetadataText(analysis.inputHash)}${analysis.usage ? ` / 出力${analysis.usage.outputTokens ?? '不明'}token / ${Math.round(analysis.usage.elapsedMs)}ms / ${escapeMetadataText(analysis.usage.finishReason ?? '終了理由不明')}` : ' / API使用量は未取得'}</p></details></div>`;
}

export function buildScoreHtml(score: ExperimentalScore): string {
  const item = (value: ScoreValue | null) => {
    if (!value) return '未確認';
    let pageLink = `p.${value.source.page}`;
    try {
      const url = new URL(value.source.url);
      if (url.protocol === 'https:' && Number.isInteger(value.source.page) && value.source.page > 0)
        pageLink = `<a href="${escapeMetadataText(url.href)}#page=${value.source.page}" target="_blank" rel="noopener noreferrer">p.${value.source.page}</a>`;
    } catch {
      /* invalid evidence URL is shown without a link */
    }
    return (
      `${escapeMetadataText(value.source.semantics.qualifiers.join('・'))} ${escapeMetadataText(stateLabels[value.source.semantics.state])} ${escapeMetadataText(String(value.value))}${escapeMetadataText(value.unit)} ` +
      `(${escapeMetadataText(value.source.period)}・${escapeMetadataText(value.source.metric)}・` +
      `${escapeMetadataText(value.source.basis === null ? '会計基準の指定なし' : value.source.basis)}・${escapeMetadataText(value.source.scope === null ? '範囲の指定なし' : value.source.scope)}、` +
      `${pageLink})「${escapeMetadataText(value.source.quote)}」`
    );
  };
  const rows = score.breakdown
    .map(
      (part) =>
        `<li>${escapeMetadataText(part.label)}: ` +
        `${part.impact === 'positive' ? '好材料' : part.impact === 'negative' ? '悪材料' : '中立'}（${part.strength === 'large' ? '大' : part.strength === 'medium' ? '中' : '小'}）。${escapeMetadataText(part.comparison)}。現在 ${item(part.current)}、` +
        `比較 ${item(part.previous)}、前々期 ${item(part.earlier)}` +
        (part.relatedValue
          ? `、${part.category === 'oneOff' ? '一時損益' : '規模の基準'} ${item(part.relatedValue)}`
          : '') +
        `${part.companyExplanation ? `。会社説明: ${escapeMetadataText(part.companyExplanation)}` : ''}</li>`
    )
    .join('');
  return (
    `<details style="margin:8px 0;padding:8px;background:#f0f7ff;border:1px solid #cbd5e1;">
    <summary><strong>材料スコア: ${score.value === null ? '算出不能' : `${score.value}/100`}・${escapeMetadataText(score.verdict)}</strong>` +
    ` ${escapeMetadataText([...score.positives, ...score.negatives].join(' / '))}</summary>
    <p>確認できた事実の規模・本業との関係・継続性から推論した目安です。未確認項目を推測で補いません。</p>
    <ul>${rows}</ul><p>検索: ${escapeMetadataText(score.searchStatus)}</p>
    <p>未確認: ${score.unverified.length ? score.unverified.map(escapeMetadataText).join(' / ') : 'なし'}</p>
    </details>`
  );
}
