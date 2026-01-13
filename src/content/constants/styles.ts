/**
 * 要約表示のインラインスタイル定数
 * TDnetページに埋め込むため、CSSクラスではなくインラインスタイルを使用
 */

export const SUMMARY_STYLES = {
  // エラー表示
  errorContainer:
    'padding: 12px; background-color: #fef2f2; border: 1px solid #fecaca; border-radius: 6px;',
  errorText: 'margin: 0; font-size: 13px; color: #991b1b;',

  // 要約コンテナ
  summaryContainer:
    'padding: 12px; background-color: #ffffff; border: 1px solid #e5e7eb; border-radius: 6px;',
  headerRow:
    'display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;',
  headerTitle: 'margin: 0; font-size: 14px; font-weight: bold; color: #1f2937;',
  buttonGroup: 'display: flex; gap: 8px;',

  // ボタン
  retryButton:
    'padding: 4px 8px; font-size: 12px; background-color: #dbeafe; border: 1px solid #3b82f6; border-radius: 4px; cursor: pointer; color: #1e40af;',
  closeButton:
    'padding: 4px 8px; font-size: 12px; background-color: #f3f4f6; border: 1px solid #d1d5db; border-radius: 4px; cursor: pointer; color: #4b5563;',

  // メタデータ
  metadataInfo:
    'font-size: 11px; color: #6b7280; margin-bottom: 8px; padding: 6px; background-color: #f3f4f6; border-radius: 4px;',
  warningBox:
    'font-size: 12px; color: #92400e; margin-bottom: 8px; padding: 8px; background-color: #fef3c7; border: 1px solid #fbbf24; border-radius: 4px;',

  // 要約テキスト
  summaryText: 'font-size: 13px; color: #374151; line-height: 1.6; white-space: pre-wrap;',
} as const;

/**
 * 要約ボタンのスタイル定数
 */
export const BUTTON_STYLES = {
  container: (loading: boolean) => ({
    border: loading ? '1px solid #9ca3af' : '1px solid #4a84b9',
    borderRadius: '3px',
    height: '25px',
    width: '60px',
    margin: '0 auto',
    overflow: 'hidden',
    padding: '0',
    fontSize: '13px',
    fontWeight: 'bold' as const,
  }),

  button: (loading: boolean) => ({
    width: '100%',
    height: '100%',
    padding: '3px 0 0 0',
    border: 'none',
    cursor: loading ? ('not-allowed' as const) : ('pointer' as const),
    background: loading
      ? 'linear-gradient(to bottom, #d1d5db, #9ca3af)'
      : 'linear-gradient(to bottom, #75a8d0, #4a84b9)',
    fontWeight: 'bold' as const,
    color: '#ffffff',
    textDecoration: 'none',
    outline: 'none',
    display: 'block' as const,
  }),

  buttonHover: 'linear-gradient(to bottom, #577b98, #2c506f)',
  buttonNormal: 'linear-gradient(to bottom, #75a8d0, #4a84b9)',
} as const;
