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

### ビルドシステム（@crxjs/vite-plugin）

- **プラグイン**: `@crxjs/vite-plugin`を使用してChrome拡張をビルド
  - Content ScriptのES Modules問題を自動解決
  - Dynamic importとweb_accessible_resourcesを自動設定
  - Loaderパターンでコードを注入

- **Manifest**: `manifest.config.ts`（ルートディレクトリ）
  - TypeScriptで定義し、package.jsonからバージョンを取得
  - ビルド時に自動的にmanifest.jsonを生成

- **エントリーポイント**:
  - `popup.html` / `options.html`: 拡張機能のUI（React + Tailwind CSS）
  - `offscreen.html`: Offscreen Document（PDF処理用）
  - `src/content/index.tsx`: Content Script（インラインスタイルのみ使用）
  - `src/background/index.ts`: Background Service Worker（Manifest V3）

- **ビルド出力**: `dist/`ディレクトリ
  - `assets/index.tsx-loader-*.js`: Content Scriptのローダー
  - `assets/index.tsx-*.js`: 実際のContent Scriptコード（web_accessible_resources）
  - `assets/pdf.worker.min-*.mjs`: PDF.js Worker（Viteが自動バンドル）
  - `service-worker-loader.js`: Background Service Worker
  - `offscreen.html`: Offscreen Document
  - `manifest.json`: 自動生成
  - `logo.png`: 全サイズで使用される単一アイコン

### Content Script (`src/content/`)

- **注入先**: `https://www.release.tdnet.info/*`（manifest.config.tsで定義）
- **スタイリング**: すべてインラインスタイルで実装（Tailwind CSSは使用しない）
  - TDNETのデザインシステムに合わせた色とスタイル
  - ボタンは青色グラデーション（`#75a8d0` → `#4a84b9`）
  - セルクラス: `oddnew-R` / `evennew-R` で背景色を交互に表示
- **動作**:
  - 開示情報一覧ページのiframe内（`#main_list`）のテーブルを監視
  - ヘッダー行に「AI要約」列を追加（既存の最後の列を`-M`に変更し、新しい列を`-R`に）
  - テーブルの各行（開示情報）の最後に要約ボタンを注入
  - ボタンクリック時に行データ（時刻、コード、会社名、表題、PDF URL）を抽出
  - 要約結果は同じ行のすぐ下に新しい行として挿入（colspanで全列を使用）
- **通信**: `chrome.runtime.sendMessage`でBackground Scriptに要約リクエスト送信
- **iframe再読み込み対応**:
  - `iframe.addEventListener('load')`でiframe再読み込みを検知
  - MutationObserverを再設定して新しいcontentDocumentを監視
  - 公開日変更やページ移動時も正しく動作

### Background Service Worker (`src/background/index.ts`)

- **役割**: Content Scriptからの`summarize`メッセージを受信し、PDF取得→Offscreen Documentで抽出→LLM要約を実行
- **設定取得**: `chrome.storage.sync`からAPI URL/Key/Modelを取得
- **PDF取得**: TDnetからPDFファイルを`fetch()`でArrayBufferとして取得
- **Offscreen Document管理**:
  - `setupOffscreenDocument()`: Offscreen Documentの作成・管理
  - 既存のOffscreen Documentがあれば再利用、なければ新規作成
- **PDF処理の委譲**:
  - ArrayBufferをArrayに変換して`chrome.runtime.sendMessage()`でOffscreen Documentに送信
  - Offscreen DocumentでPDF.jsを使ってテキスト抽出
  - 抽出されたテキストをLLM APIに送信して要約生成

### Offscreen Document (`src/offscreen/index.ts`)

- **目的**: Service WorkerではDOM APIが使えないため、PDF.jsでPDF処理を行う専用環境
- **PDF.js Worker設定**:
  - Viteの`?url`インポートで`pdfjs-dist/build/pdf.worker.min.mjs`を参照
  - `GlobalWorkerOptions.workerSrc`に`chrome.runtime.getURL()`で取得したURLを設定
  - Viteが自動的にWorkerファイルをバンドル（ハッシュ化されたファイル名で最適化）
- **テキスト抽出処理**:
  - Background Scriptから受信したArrayをUint8Arrayに変換
  - pdf.jsの`getDocument()`でPDFを読み込み
  - 全ページからテキストを抽出し、クリーニング処理を実行
  - 抽出結果をBackground Scriptに返送
- **エラーハンドリング**: PDF読み込み失敗やページ抽出エラーを適切にハンドリング

### Options/Popup UI (`src/options/`, `src/popup/`)

- **Options**: APIエンドポイント、APIキー、モデル名を設定し`chrome.storage.sync`に保存
- **Popup**:
  - 拡張機能の有効/無効を切り替えるトグルスイッチ
  - API設定の状態表示（設定済み/未設定）
  - 設定ページへのリンク
  - `extensionEnabled`を`chrome.storage.sync`に保存し、Content Scriptに通知

## 技術スタック

- **フレームワーク**: React 18 + TypeScript
- **スタイリング**:
  - Popup/Options: Tailwind CSS 4.0-beta
  - Content Script: インラインスタイルのみ（TDNETページの表示崩れを防ぐため）
- **ビルド**: Vite 6 + @crxjs/vite-plugin + @vitejs/plugin-react
- **Chrome拡張**: Manifest V3（Service Worker + Offscreen Document使用）
- **PDF処理**: pdfjs-dist（Offscreen Documentで実行）
- **パスエイリアス**: `@/`は`./src/`を指す（vite.config.ts）
- **アイコン**: `public/logo.png`（全サイズで使用）

## 開発時の注意点

- **Offscreen Documents API**:
  - Manifest V3のService WorkerではDOM APIが使えないため、PDF.jsの実行にOffscreen Documentを使用
  - `offscreen`パーミッションが`manifest.config.ts`で設定されている
  - Offscreen Documentは1拡張機能につき1つのみ作成可能
  - `chrome.runtime.getContexts()`で既存のOffscreen Documentをチェックしてから作成

- **PDF.js Worker設定**:
  - Viteの`?url`サフィックスを使って`pdfjs-dist/build/pdf.worker.min.mjs`をインポート
  - Viteが自動的にWorkerファイルをバンドルし、ハッシュ化されたファイル名で出力
  - `GlobalWorkerOptions.workerSrc`の設定は必須（設定しないとエラーになる）
  - Chrome拡張機能では`chrome.runtime.getURL()`で相対パスを絶対URLに変換

- **セキュリティ**: この拡張機能は`https://www.release.tdnet.info/*`ドメインでのみ動作するように制限されている。他のドメインでの動作は不要。

- **iframe内DOM操作**:
  - TDnetの一覧ページはiframe構造のため、`iframe.contentDocument`を経由してDOM操作を行う必要がある
  - iframe再読み込み時はMutationObserverを再設定する必要がある
  - `<tr>` 要素にはクラスがないため、`<td>`要素のクラスから行タイプを判定する

- **TDNETのテーブル構造**:
  - 開示情報は`#main-list-table`内の`tr`要素として存在
  - 各セルにはCSSクラス（`kjTime`, `kjCode`, `kjName`, `kjTitle`等）が付与
  - セルクラス: `oddnew-L/M/R`（奇数行）、`evennew-L/M/R`（偶数行）
  - ヘッダークラス: `header-L/M/R`（左端/中間/右端）

- **スタイリングの注意**:
  - Content ScriptでTailwind CSSを使用すると、TDNETページ全体に影響を与える
  - 必ずインラインスタイルのみを使用すること
  - TDNETの既存デザイン（色、サイズ、ボーダー）に合わせること

- **Chrome拡張のロード**:
  - `dist/`ディレクトリをChromeの拡張機能管理ページで「パッケージ化されていない拡張機能を読み込む」から読み込む
  - manifest.config.tsを変更した場合は`npm run build`が必要

- **ホットリロード**:
  - `npm run dev`でファイル監視されるが、Chrome拡張自体のリロードは手動で行う必要がある
  - @crxjs/vite-pluginがHMRをサポートしているが、完全ではない
