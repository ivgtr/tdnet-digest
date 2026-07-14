/**
 * 要約表示のHTML生成ユーティリティ
 * innerHTML で管理外DOMに挿入するためのテンプレート生成
 */

import { SUMMARY_STYLES } from '../constants/styles';
import type { SummaryMetadata } from '../types/summaryMetadata';
import { parseMarkdown } from './markdownParser';

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
  } = metadata;
  const analysisInfo =
    provider && model && summaryMode
      ? ` | <span style="font-weight: bold;">分析:</span> ${escapeMetadataText(provider)}/${escapeMetadataText(model)}・${summaryMode === 'two-pass' ? '2パス' : '1パス'}・v${analysisSchemaVersion ?? '?'}`
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
      <div style="${SUMMARY_STYLES.summaryText}">${parseMarkdown(summaryText)}</div>
    </div>
  `;
}
