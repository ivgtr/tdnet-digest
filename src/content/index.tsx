import React from 'react';
import { createRoot } from 'react-dom/client';
import SummaryButton from './SummaryButton';

interface RowData {
  time: string;
  code: string;
  companyName: string;
  title: string;
  pdfUrl: string;
}

// 拡張機能が有効かどうかのフラグ
let extensionEnabled = true;

// iframe内のテーブルにボタンを追加
function injectSummaryButtons() {
  // 拡張機能が無効の場合はボタンを注入しない
  if (!extensionEnabled) {
    console.log('TDnet Digest: Extension is disabled');
    return;
  }
  // iframeを取得
  const iframe = document.querySelector('#main_list') as HTMLIFrameElement;
  if (!iframe) {
    console.log('TDnet Digest: iframe not found');
    return;
  }

  const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
  if (!iframeDoc) {
    console.log('TDnet Digest: iframe document not accessible');
    return;
  }

  // ヘッダーに「要約」列を追加
  const headerTable = iframeDoc.querySelector('#list-head');
  if (headerTable) {
    const headerRow = headerTable.querySelector('tr');
    if (headerRow && !headerRow.querySelector('.tdnet-digest-header')) {
      // 既存の最後の列（更新履歴）の header-R を header-M に変更
      const lastHeaderCell = headerRow.querySelector('td:last-child') as HTMLElement;
      if (lastHeaderCell && lastHeaderCell.classList.contains('header-R')) {
        lastHeaderCell.classList.remove('header-R');
        lastHeaderCell.classList.add('header-M');
        lastHeaderCell.style.borderRadius = '0';
      }

      const headerCell = iframeDoc.createElement('td');
      headerCell.className = 'header-R tdnet-digest-header';
      headerCell.setAttribute('nowrap', '');
      headerCell.setAttribute('align', 'center');
      headerCell.style.width = '80px';
      headerCell.textContent = 'AI要約';
      headerRow.appendChild(headerCell);
    }
  }

  // テーブル内の各行にボタンを追加
  const mainTable = iframeDoc.querySelector('#main-list-table');
  if (!mainTable) {
    console.log('TDnet Digest: main table not found');
    return;
  }

  const rows = mainTable.querySelectorAll('tbody > tr');
  rows.forEach((row) => {
    // 既にボタンが追加されている、または要約結果の行はスキップ
    if (row.querySelector('.tdnet-digest-button-cell') || row.classList.contains('tdnet-digest-summary-row')) {
      return;
    }

    // 行データを抽出
    const timeCell = row.querySelector('.kjTime');
    const codeCell = row.querySelector('.kjCode');
    const nameCell = row.querySelector('.kjName');
    const titleCell = row.querySelector('.kjTitle');
    const linkElement = titleCell?.querySelector('a');

    if (!timeCell || !codeCell || !nameCell || !titleCell || !linkElement) {
      return;
    }

    const rowData: RowData = {
      time: timeCell.textContent?.trim() || '',
      code: codeCell.textContent?.trim() || '',
      companyName: nameCell.textContent?.trim() || '',
      title: linkElement.textContent?.trim() || '',
      pdfUrl: linkElement.getAttribute('href') || '',
    };

    // 既存の最後のセル（更新履歴）の -R を -M に変更
    const lastCell = row.querySelector('td:last-child');
    if (lastCell) {
      const lastCellClass = lastCell.className;
      if (lastCellClass.includes('oddnew-R')) {
        lastCell.className = lastCellClass.replace('oddnew-R', 'oddnew-M');
      } else if (lastCellClass.includes('evennew-R')) {
        lastCell.className = lastCellClass.replace('evennew-R', 'evennew-M');
      }
    }

    // ボタン用のtdを作成
    const buttonCell = iframeDoc.createElement('td');
    // 最初のセルのクラス名から行のタイプ（oddnew/evennew）を判定
    const firstCell = row.querySelector('td:first-child');
    const firstCellClass = firstCell?.className || '';
    let cellClass = '';
    if (firstCellClass.includes('oddnew')) {
      cellClass = 'oddnew-R';
    } else if (firstCellClass.includes('evennew')) {
      cellClass = 'evennew-R';
    }
    buttonCell.className = `${cellClass} tdnet-digest-button-cell`;
    buttonCell.setAttribute('nowrap', '');
    buttonCell.setAttribute('align', 'center');
    // セルの幅を設定
    buttonCell.style.width = '80px';

    // Reactコンポーネントをレンダリング
    const container = iframeDoc.createElement('div');
    buttonCell.appendChild(container);
    row.appendChild(buttonCell);

    const root = createRoot(container);
    root.render(
      <React.StrictMode>
        <SummaryButton rowData={rowData} row={row as HTMLTableRowElement} iframeDoc={iframeDoc} />
      </React.StrictMode>
    );
  });

  console.log('TDnet Digest: Buttons injected successfully');
}

// 既存のボタンとヘッダーを削除
function removeAllButtons() {
  const iframe = document.querySelector('#main_list') as HTMLIFrameElement;
  if (!iframe) return;

  const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
  if (!iframeDoc) return;

  // ヘッダーの「AI要約」列を削除
  const headerCell = iframeDoc.querySelector('.tdnet-digest-header');
  if (headerCell) {
    headerCell.remove();
  }

  // 全てのボタンセルを削除
  const buttonCells = iframeDoc.querySelectorAll('.tdnet-digest-button-cell');
  buttonCells.forEach((cell) => cell.remove());

  // 全ての要約行を削除
  const summaryRows = iframeDoc.querySelectorAll('.tdnet-digest-summary-row');
  summaryRows.forEach((row) => row.remove());

  console.log('TDnet Digest: All buttons removed');
}

// MutationObserverの参照を保持
let currentObserver: MutationObserver | null = null;

// iframe内のコンテンツ監視を設定
function setupIframeObserver(iframe: HTMLIFrameElement) {
  // 既存のObserverがあれば解除
  if (currentObserver) {
    currentObserver.disconnect();
    currentObserver = null;
  }

  // 新しいObserverを設定
  const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
  if (iframeDoc && iframeDoc.body) {
    currentObserver = new MutationObserver(() => {
      injectSummaryButtons();
    });

    currentObserver.observe(iframeDoc.body, {
      childList: true,
      subtree: true,
    });
    console.log('TDnet Digest: Observer set up for iframe content');
  }
}

// iframe読み込みを待機
function waitForIframe() {
  const iframe = document.querySelector('#main_list') as HTMLIFrameElement;
  if (!iframe) {
    setTimeout(waitForIframe, 100);
    return;
  }

  // iframeのloadイベントを監視（再読み込みごとに発火）
  iframe.addEventListener('load', () => {
    console.log('TDnet Digest: iframe loaded');
    injectSummaryButtons();
    setupIframeObserver(iframe);
  });

  // 初回の読み込みが完了している場合
  if (iframe.contentDocument?.readyState === 'complete') {
    console.log('TDnet Digest: iframe already loaded');
    injectSummaryButtons();
    setupIframeObserver(iframe);
  }
}

// 初期設定を読み込み
chrome.storage.sync.get(['extensionEnabled'], (result) => {
  extensionEnabled = result.extensionEnabled !== false; // デフォルトはtrue

  // ページ読み込み完了時に実行
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', waitForIframe);
  } else {
    waitForIframe();
  }
});

// Popupからのメッセージを受信
chrome.runtime.onMessage.addListener((request, _sender, _sendResponse) => {
  if (request.action === 'toggleExtension') {
    extensionEnabled = request.enabled;

    if (extensionEnabled) {
      // 有効化された場合はボタンを追加
      injectSummaryButtons();
    } else {
      // 無効化された場合はボタンを削除
      removeAllButtons();
    }
  }
});
