import React from 'react';
import { createRoot } from 'react-dom/client';
import SummaryButton from './SummaryButton';
import { extractRowData } from './utils/rowDataExtractor';
import { addHeaderColumn, getRowCellClass, updateLastCellClass } from './utils/tdnetDomHelper';

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

  // ヘッダーに「AI要約」列を追加
  addHeaderColumn(iframeDoc);

  // テーブル内の各行にボタンを追加
  const mainTable = iframeDoc.querySelector('#main-list-table');
  if (!mainTable) {
    console.log('TDnet Digest: main table not found');
    return;
  }

  const rows = mainTable.querySelectorAll('tbody > tr');
  rows.forEach((row) => {
    // 既にボタンが追加されている、または要約結果の行はスキップ
    if (
      row.querySelector('.tdnet-digest-button-cell') ||
      row.classList.contains('tdnet-digest-summary-row')
    ) {
      return;
    }

    // 行データを抽出
    const rowData = extractRowData(row);
    if (!rowData) return;

    // 既存の最後のセル（更新履歴）の -R を -M に変更
    updateLastCellClass(row);

    // ボタン用のtdを作成
    const buttonCell = iframeDoc.createElement('td');
    const cellClass = getRowCellClass(row);
    buttonCell.className = `${cellClass} tdnet-digest-button-cell`;
    buttonCell.setAttribute('nowrap', '');
    buttonCell.setAttribute('align', 'center');
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
