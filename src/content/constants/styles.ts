/**
 * 要約表示のインラインスタイル定数
 * TDnetページに埋め込むため、CSSクラスではなくインラインスタイルを使用
 */

const fontFamily = "Arial, 'Noto Sans JP', sans-serif";

// 同じ操作はReact側とHTMLテンプレート側で同じ見た目にする。
export const ACTION_BUTTON_STYLE = {
  boxSizing: 'border-box' as const,
  minHeight: '32px',
  padding: '6px 12px',
  fontFamily,
  fontSize: '12px',
  fontWeight: 'bold' as const,
  lineHeight: '18px',
  whiteSpace: 'nowrap' as const,
  flexShrink: 0,
  border: '1px solid #cbd5e1',
  borderRadius: '4px',
  background: '#f3f4f6',
  color: '#374151',
  cursor: 'pointer',
};
export const FOCUS_STYLE = { outline: '2px solid #1d4ed8', outlineOffset: '2px' };
const actionButton = Object.entries(ACTION_BUTTON_STYLE)
  .map(
    ([key, value]) => `${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}:${value}`
  )
  .join(';');

export const SUMMARY_STYLES = {
  // エラー表示
  errorContainer:
    'padding: 12px; background-color: #fef2f2; border: 1px solid #fecaca; border-radius: 6px;',
  errorText: 'margin: 0; font-size: 13px; color: #991b1b;',

  // 要約コンテナ
  summaryContainer: `box-sizing: border-box; min-width: 0; padding: 12px; background-color: #ffffff; border: 1px solid #e5e7eb; border-radius: 6px; font-family: ${fontFamily}; overflow-wrap: anywhere;`,
  headerRow:
    'display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 8px 12px; margin-bottom: 12px;',
  headerTitle:
    'flex: 1 1 240px; min-width: 0; margin: 0; font-size: 14px; line-height: 1.6; font-weight: bold; color: #1f2937; overflow-wrap: anywhere;',
  buttonGroup: 'display: flex; flex-wrap: wrap; align-items: center; gap: 8px;',

  // 青は追加の実行、灰色は補助操作。黄色は警告だけに使う。
  retryButton: actionButton,
  resummarizeButton: actionButton,
  analyzeButton: `${actionButton}; background: #e8f2fc; border-color: #4a84b9; color: #1e40af;`,
  analysisSection:
    'margin-top: 16px; padding: 12px 0; border-top: 1px solid #e5e7eb; border-bottom: 1px solid #e5e7eb;',
  sectionTitle: 'margin: 0; font-size: 13px; line-height: 1.6; font-weight: bold; color: #1f2937;',
  sectionDescription: 'margin: 6px 0 12px; font-size: 12px; line-height: 1.6; color: #6b7280;',
  diagnostics: 'margin-top: 12px; font-size: 12px; line-height: 1.6;',
  disclosure: 'padding: 4px 0; cursor: pointer; color: #374151; font-weight: bold;',

  // メタデータ
  metadataInfo:
    'font-size: 12px; line-height: 1.6; color: #6b7280; margin: 8px 0; padding: 8px; background-color: #f3f4f6; border-radius: 4px; overflow-wrap: anywhere;',
  warningBox:
    'font-size: 12px; color: #92400e; margin-bottom: 8px; padding: 8px; background-color: #fef3c7; border: 1px solid #fbbf24; border-radius: 4px;',

  // 要約テキスト
  summaryText: 'font-size: 13px; color: #374151; line-height: 1.6;',
} as const;

/**
 * 要約ボタンのスタイル定数
 */
export const BUTTON_STYLES = {
  container: (loading: boolean) => ({
    border: loading ? '1px solid #9ca3af' : '1px solid #4a84b9',
    borderRadius: '3px',
    height: '32px',
    width: '60px',
    margin: '0 auto',
    boxSizing: 'border-box' as const,
    padding: '0',
    fontSize: '12px',
    fontWeight: 'bold' as const,
  }),

  button: (loading: boolean) => ({
    width: '100%',
    height: '100%',
    padding: '0',
    fontFamily,
    fontSize: '12px',
    lineHeight: '18px',
    whiteSpace: 'nowrap' as const,
    borderRadius: '2px',
    border: 'none',
    cursor: loading ? ('not-allowed' as const) : ('pointer' as const),
    background: loading
      ? 'linear-gradient(to bottom, #d1d5db, #9ca3af)'
      : 'linear-gradient(to bottom, #75a8d0, #4a84b9)',
    fontWeight: 'bold' as const,
    color: '#ffffff',
    textDecoration: 'none',
    display: 'block' as const,
  }),

  buttonHover: 'linear-gradient(to bottom, #577b98, #2c506f)',
  buttonNormal: 'linear-gradient(to bottom, #75a8d0, #4a84b9)',

  containerCached: (visible: boolean) => ({
    border: visible ? '1px solid #cbd5e1' : '1px solid #4a84b9',
    borderRadius: '3px',
    height: '32px',
    width: '60px',
    margin: '0 auto',
    boxSizing: 'border-box' as const,
    padding: '0',
    fontSize: '12px',
    fontWeight: 'bold' as const,
  }),

  buttonCached: (visible: boolean) => ({
    width: '100%',
    height: '100%',
    padding: '0',
    fontFamily,
    fontSize: '12px',
    lineHeight: '18px',
    whiteSpace: 'nowrap' as const,
    borderRadius: '2px',
    border: 'none',
    cursor: 'pointer' as const,
    background: visible ? '#f3f4f6' : 'linear-gradient(to bottom, #75a8d0, #4a84b9)',
    fontWeight: 'bold' as const,
    color: visible ? '#374151' : '#ffffff',
    textDecoration: 'none',
    display: 'block' as const,
  }),

  buttonCachedHover: '#e5e7eb',
  buttonCachedShowHover: 'linear-gradient(to bottom, #577b98, #2c506f)',
} as const;
