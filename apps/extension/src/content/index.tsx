import React from 'react';
import { createRoot } from 'react-dom/client';
import SummaryButton from './SummaryButton';
import '../index.css';

// TDnetの開示ページにボタンを追加
function injectSummaryButton() {
  // ページの適切な位置に要約ボタンを追加
  const targetElement = document.querySelector('.main-content') || document.body;

  const container = document.createElement('div');
  container.id = 'tdnet-digest-root';
  container.style.cssText = 'position: fixed; top: 20px; right: 20px; z-index: 10000;';

  targetElement.appendChild(container);

  const root = createRoot(container);
  root.render(
    <React.StrictMode>
      <SummaryButton />
    </React.StrictMode>
  );
}

// ページ読み込み完了時に実行
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', injectSummaryButton);
} else {
  injectSummaryButton();
}
