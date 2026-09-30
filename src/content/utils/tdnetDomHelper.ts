/**
 * TDnet固有のDOM操作ヘルパー関数
 */

/**
 * テーブル行のセルクラス名を取得（oddnew-R or evennew-R）
 * @param row テーブル行要素
 * @returns セルクラス名
 */
export function getRowCellClass(row: Element): string {
  const firstCell = row.querySelector('td:first-child');
  const firstCellClass = firstCell?.className || '';

  if (firstCellClass.includes('oddnew')) {
    return 'oddnew-R';
  } else if (firstCellClass.includes('evennew')) {
    return 'evennew-R';
  }
  return '';
}

/**
 * 行の最後のセルのクラス名を -R から -M に変更
 * @param row テーブル行要素
 */
export function updateLastCellClass(row: Element): void {
  const lastCell = row.querySelector('td:last-child');
  if (!lastCell) return;

  const lastCellClass = lastCell.className;
  if (lastCellClass.includes('oddnew-R')) {
    lastCell.className = lastCellClass.replace('oddnew-R', 'oddnew-M');
  } else if (lastCellClass.includes('evennew-R')) {
    lastCell.className = lastCellClass.replace('evennew-R', 'evennew-M');
  }
}

/**
 * ヘッダー行に「AI要約」列を追加
 * @param iframeDoc iframe内のDocument
 */
export function addHeaderColumn(iframeDoc: Document): void {
  const headerTable = iframeDoc.querySelector('#list-head');
  if (!headerTable) return;

  const headerRow = headerTable.querySelector('tr');
  if (!headerRow || headerRow.querySelector('.tdnet-digest-header')) return;

  // 既存の最後の列（更新履歴）の header-R を header-M に変更
  const lastHeaderCell = headerRow.querySelector('td:last-child') as HTMLElement;
  if (lastHeaderCell?.classList.contains('header-R')) {
    lastHeaderCell.classList.remove('header-R');
    lastHeaderCell.classList.add('header-M');
    lastHeaderCell.style.borderRadius = '0';
  }

  // 新しいヘッダーセルを追加
  const headerCell = iframeDoc.createElement('td');
  headerCell.className = 'header-R tdnet-digest-header';
  headerCell.setAttribute('nowrap', '');
  headerCell.setAttribute('align', 'center');
  headerCell.style.width = '80px';
  headerCell.textContent = 'AI要約';
  headerRow.appendChild(headerCell);
}
