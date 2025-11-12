# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## プロジェクト概要

TDnet適時開示情報を閲覧中にLLMで要約を表示するChrome拡張機能。
TDnetの開示詳細ページにReactベースの要約ボタンを注入し、背景スクリプトがPDFを取得してOpenAI互換APIで要約を生成する。

## 開発コマンド

```bash
# 開発モード（ファイル監視+自動ビルド）
npm run dev

# プロダクションビルド
npm run build

# 型チェック
npm run type-check

# Lint
npm run lint

# フォーマット
npm run format
```

## アーキテクチャ

### ビルドシステム（Vite）

- **エントリーポイント**: 複数のエントリーポイントをViteでビルド
  - `popup.html` / `options.html`: 拡張機能のUI（React + Tailwind CSS）
  - `src/content/index.tsx`: Content Script（TDnetページに注入されるReactコンポーネント）
  - `src/background/index.ts`: Background Service Worker（Manifest V3）

- **ビルド出力**: `dist/`ディレクトリ
  - `popup/index.js`, `options/index.js`
  - `content/index.js`, `content/style.css`
  - `background/index.js`
  - `manifest.json`（`public/manifest.json`からコピー）

- **カスタムプラグイン**: `vite.config.ts`内の`copyManifestPlugin()`がmanifest.jsonをdistにコピー

### Content Script (`src/content/`)

- **注入先**: `https://www.release.tdnet.info/*`（manifest.jsonで定義）
- **動作**:
  - 開示情報一覧ページのiframe内（`#main_list`）のテーブルを監視
  - ヘッダー行に「AI要約」列を追加
  - テーブルの各行（開示情報）の最後に要約ボタンを注入
  - ボタンクリック時に行データ（時刻、コード、会社名、表題、PDF URL）を抽出
  - 要約結果は同じ行のすぐ下に新しい行として挿入（colspanで全列を使用）
- **通信**: `chrome.runtime.sendMessage`でBackground Scriptに要約リクエスト送信
- **ページネーション対応**: MutationObserverでiframe内のDOM変更を監視し、ページ切り替え時も自動でボタンを再注入

### Background Service Worker (`src/background/index.ts`)

- **役割**: Content Scriptからの`summarize`メッセージを受信し、PDF取得→LLM要約を実行
- **設定取得**: `chrome.storage.sync`からAPI URL/Key/Modelを取得
- **未実装**: `extractTextFromPDF()`関数はプレースホルダー。pdf.jsライブラリの統合が必要

### Options/Popup UI (`src/options/`, `src/popup/`)

- **Options**: APIエンドポイント、APIキー、モデル名を設定し`chrome.storage.sync`に保存
- **Popup**: 現在はスタブ実装（`popup.html`は存在するが機能は最小限）

## 技術スタック

- **フレームワーク**: React 18 + TypeScript
- **スタイリング**: Tailwind CSS 4.0-beta
- **ビルド**: Vite 6 + @vitejs/plugin-react
- **Chrome拡張**: Manifest V3（Service Worker使用）
- **パスエイリアス**: `@/`は`./src/`を指す（vite.config.ts）

## 開発時の注意点

- **PDF抽出機能は未実装**: `src/background/index.ts`の`extractTextFromPDF()`を実装する必要がある。pdf.jsライブラリの追加が必要。
- **セキュリティ**: この拡張機能は`https://www.release.tdnet.info/*`ドメインでのみ動作するように制限されている。他のドメインでの動作は不要。
- **iframe内DOM操作**: TDnetの一覧ページはiframe構造のため、`iframe.contentDocument`を経由してDOM操作を行う必要がある。
- **テーブル構造**: 開示情報は`#main-list-table`内の`tr`要素として存在。各セルにはCSSクラス（`kjTime`, `kjCode`, `kjName`, `kjTitle`等）が付与されている。
- **Chrome拡張のロード**: `dist/`ディレクトリをChromeの拡張機能管理ページで「パッケージ化されていない拡張機能を読み込む」から読み込む。
- **ホットリロード**: `npm run dev`でファイル監視されるが、Chrome拡張自体のリロードは手動で行う必要がある。
