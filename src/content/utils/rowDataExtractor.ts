/**
 * TDnetテーブル行からRowDataを抽出するユーティリティ
 */

export interface RowData {
  time: string;
  code: string;
  companyName: string;
  title: string;
  pdfUrl: string;
}

/**
 * テーブル行からRowDataを抽出
 * @param row テーブル行要素
 * @returns RowData または null（必須要素が見つからない場合）
 */
export function extractRowData(row: Element): RowData | null {
  const timeCell = row.querySelector('.kjTime');
  const codeCell = row.querySelector('.kjCode');
  const nameCell = row.querySelector('.kjName');
  const titleCell = row.querySelector('.kjTitle');
  const linkElement = titleCell?.querySelector('a');

  // 必須要素が全て存在するかチェック
  if (!timeCell || !codeCell || !nameCell || !titleCell || !linkElement) {
    return null;
  }

  return {
    time: timeCell.textContent?.trim() || '',
    code: codeCell.textContent?.trim() || '',
    companyName: nameCell.textContent?.trim() || '',
    title: linkElement.textContent?.trim() || '',
    pdfUrl: linkElement.getAttribute('href') || '',
  };
}
