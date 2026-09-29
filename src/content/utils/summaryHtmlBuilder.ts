/**
 * 要約表示のHTML生成ユーティリティ
 * innerHTML で管理外DOMに挿入するためのテンプレート生成
 */

import { SUMMARY_STYLES } from '../constants/styles';
import type { SummaryMetadata } from '../types/summaryMetadata';
import { parseMarkdown } from './markdownParser';
import type { ExperimentalScore, ScoreValue } from '@/lib/scoring';

/**
 * エラー表示のHTMLを生成
 */
export function buildErrorHtml(errorText: string): string {
  return `
    <div style="${SUMMARY_STYLES.errorContainer}">
      <p style="${SUMMARY_STYLES.errorText}">${errorText}</p>
    </div>
  `;
}

/**
 * メタデータ表示のHTMLを生成
 */
export function buildMetadataHtml(metadata: SummaryMetadata | null): string {
  if (!metadata) return '';

  const {
    extractionMode,
    totalPages,
    extractedPages,
    qualityWarning,
    provider,
    model,
    summaryMode,
    analysisSchemaVersion,
    experimentalScoring,
  } = metadata;
  const analysisInfo =
    provider && model && summaryMode
      ? ` | <span style="font-weight: bold;">分析:</span> ${escapeMetadataText(provider)}/${escapeMetadataText(model)}・${summaryMode === 'two-pass' ? '2パス' : '1パス'}・v${analysisSchemaVersion ?? '?'}${experimentalScoring ? '・実験スコアON' : ''}`
      : '';

  let html = `
    <div style="${SUMMARY_STYLES.metadataInfo}">
      <span style="font-weight: bold;">抽出モード:</span> ${extractionMode === 'smart' ? 'スマート抽出' : '全文抽出'} |
      <span style="font-weight: bold;">ページ:</span> ${extractedPages?.length || totalPages}/${totalPages}ページ${analysisInfo}
    </div>
  `;

  if (qualityWarning) {
    html += `
      <div style="${SUMMARY_STYLES.warningBox}">
        <strong>⚠️ 品質警告:</strong> ${qualityWarning.message}<br>
        <span style="font-size: 11px;">不足キーワード: ${qualityWarning.missingKeywords?.join(', ') || 'なし'}</span>
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
  rowData: { companyName: string; title: string }
): string {
  const metadataHtml = buildMetadataHtml(metadata);
  const fullRetryButton =
    metadata?.extractionMode === 'smart'
      ? `<button type="button" id="full-retry-btn" style="${SUMMARY_STYLES.retryButton}">全文で再要約</button>`
      : '';

  return `
    <div style="${SUMMARY_STYLES.summaryContainer}">
      <div style="${SUMMARY_STYLES.headerRow}">
        <h4 style="${SUMMARY_STYLES.headerTitle}">
          AI要約: ${rowData.companyName} - ${rowData.title}
        </h4>
        <div style="${SUMMARY_STYLES.buttonGroup}">
          ${fullRetryButton}
          <button type="button" id="resummarize-btn" style="${SUMMARY_STYLES.resummarizeButton}">再要約</button>
        </div>
      </div>
      ${metadataHtml}
      ${metadata?.score ? buildScoreHtml(metadata.score) : ''}
      <div style="${SUMMARY_STYLES.summaryText}">${parseMarkdown(summaryText)}</div>
    </div>
  `;
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
      `${escapeMetadataText(String(value.value))}${escapeMetadataText(value.unit)} ` +
      `(${escapeMetadataText(value.source.period)}・${escapeMetadataText(value.source.metric)}・` +
      `${escapeMetadataText(value.source.basis)}・${escapeMetadataText(value.source.scope)}、` +
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
