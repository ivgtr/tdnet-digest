/**
 * 要約表示のHTML生成ユーティリティ
 * innerHTML で管理外DOMに挿入するためのテンプレート生成
 */

import { SUMMARY_STYLES } from '../constants/styles';
import type { SummaryMetadata } from '../types/summaryMetadata';

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

  const { extractionMode, totalPages, extractedPages, qualityWarning } = metadata;

  let html = `
    <div style="${SUMMARY_STYLES.metadataInfo}">
      <span style="font-weight: bold;">抽出モード:</span> ${extractionMode === 'smart' ? 'スマート抽出' : '全文抽出'} |
      <span style="font-weight: bold;">ページ:</span> ${extractedPages?.length || totalPages}/${totalPages}ページ
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
      ? `<button id="full-retry-btn" style="${SUMMARY_STYLES.retryButton}">全文で再要約</button>`
      : '';

  return `
    <div style="${SUMMARY_STYLES.summaryContainer}">
      <div style="${SUMMARY_STYLES.headerRow}">
        <h4 style="${SUMMARY_STYLES.headerTitle}">
          AI要約: ${rowData.companyName} - ${rowData.title}
        </h4>
        <div style="${SUMMARY_STYLES.buttonGroup}">
          ${fullRetryButton}
          <button id="close-summary-btn" style="${SUMMARY_STYLES.closeButton}">閉じる</button>
        </div>
      </div>
      ${metadataHtml}
      <div style="${SUMMARY_STYLES.summaryText}">${summaryText}</div>
    </div>
  `;
}
