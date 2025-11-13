# tdnet-digest 開発環境セットアップ

## 技術スタック

- **React 18.3.1** - UI フレームワーク
- **TypeScript 5.7.2** - 型安全な開発
- **Tailwind CSS v4.1.17** - スタイリング（Popup/Optionsのみ）
- **Vite 6.4.1** - 高速ビルドツール
- **@crxjs/vite-plugin** - Chrome拡張専用Viteプラグイン
- **pdfjs-dist 4.10.38** - PDF処理（Offscreen Documentで実行）
- **ESLint 9.17.0** - コード品質チェック
- **Prettier 3.4.2** - コードフォーマット
- **Chrome Extensions Manifest V3** - 拡張機能仕様（Service Worker + Offscreen Document）

## プロジェクト構造

```
tdnet-digest/
├── src/
│   ├── background/     # Service Worker
│   ├── offscreen/      # Offscreen Document（PDF処理）
│   ├── content/        # コンテンツスクリプト（インラインスタイル）
│   ├── popup/          # ポップアップUI
│   ├── options/        # 設定ページ
│   └── index.css       # Tailwind CSS（Popup/Optionsのみ）
├── public/
│   └── logo.png        # アイコン（全サイズで使用）
├── popup.html          # ポップアップHTML
├── options.html        # 設定ページHTML
├── offscreen.html      # Offscreen DocumentHTML
├── manifest.config.ts  # マニフェスト定義（TypeScript）
├── dist/               # ビルド出力 (git無視)
├── vite.config.ts      # Vite設定
├── tsconfig.json       # TypeScript設定
├── eslint.config.js    # ESLint設定
├── prettier.config.js  # Prettier設定
└── package.json        # 依存関係とスクリプト
```

## セットアップ手順

### 1. 依存関係のインストール

```bash
npm install
```

### 2. 開発ビルド (watch モード)

```bash
npm run dev
```

ファイルを変更すると自動的に再ビルドされます。

### 3. プロダクションビルド

```bash
npm run build
```

ビルド成果物は `dist/` に出力されます。

### 4. コード品質チェック

```bash
# 型チェック
npm run type-check

# Lint
npm run lint

# フォーマット
npm run format
```

## Chrome拡張機能の読み込み

1. `npm run build` でビルド
2. Chrome で `chrome://extensions/` を開く
3. 右上の「デベロッパーモード」を有効化
4. 「パッケージ化されていない拡張機能を読み込む」をクリック
5. `dist` ディレクトリを選択

## 開発時の注意点

### アイコン

`public/logo.png` が全サイズ（16/32/48/128px）で使用されます。create-crxjsのお作法に準拠した構造です。

### Content Scriptのスタイリング

**重要**: Content Scriptでは必ずインラインスタイルを使用してください。

- Tailwind CSSをimportすると、TDNETページ全体に影響を与えます
- TDNETの既存デザイン（色、サイズ、ボーダー）に合わせること
- ボタンの色: 青色グラデーション（`#75a8d0` → `#4a84b9`）

### TDNETのiframe構造

開示情報一覧はiframe（`#main_list`）内にあります：

- `iframe.contentDocument`を経由してDOM操作
- iframe再読み込み時はMutationObserverを再設定
- `<tr>`要素にクラスはないため、`<td>`のクラスから行タイプを判定

### PDFテキスト抽出

**Offscreen Documents APIを使用して実装済み**

Service WorkerではDOM APIが使えないため、PDF.jsの実行にOffscreen Documentを使用しています：

- **実装場所**: `src/offscreen/index.ts`
- **Worker設定**: Viteの`?url`インポートで`pdfjs-dist/build/pdf.worker.min.mjs`を自動バンドル
- **処理フロー**:
  1. Background ScriptがPDFをフェッチ（ArrayBuffer）
  2. `chrome.runtime.sendMessage()`でOffscreen Documentに送信
  3. Offscreen DocumentでPDF.jsを使ってテキスト抽出
  4. 抽出したテキストをBackground Scriptに返送
- **テキストクリーニング**: 連続空白除去、改行正規化、ページ番号除去などを実行

### API設定

API設定はChrome の storage APIに保存されます。開発時は拡張機能の設定ページから設定してください。

### ビルドとリロード

- `manifest.config.ts`を変更した場合は`npm run build`が必要
- Chrome拡張自体のリロードは手動で行う必要があります
- @crxjs/vite-pluginがHMRをサポートしていますが、完全ではありません

## スクリプト一覧

| コマンド | 説明 |
|---------|------|
| `npm run dev` | 開発ビルド (watch モード) |
| `npm run build` | プロダクションビルド |
| `npm run lint` | ESLintでコードチェック |
| `npm run format` | Prettierでコードフォーマット |
| `npm run type-check` | TypeScriptの型チェック |

## トラブルシューティング

### ビルドエラーが発生する

```bash
# node_modules を削除して再インストール
rm -rf node_modules package-lock.json
npm install
```

### 拡張機能が動作しない

1. `npm run build` で最新のビルドを作成
2. Chrome拡張機能ページで「更新」ボタンをクリック
3. Chromeの開発者ツールでエラーログを確認

### Tailwind CSSのスタイルが適用されない（Popup/Optionsのみ）

- `src/index.css` に `@import "tailwindcss";` が含まれていることを確認
- Content Scriptでは意図的にTailwind CSSを使用していません

### Content Scriptが表示されない

1. iframe再読み込み（公開日変更、ページ移動）が発生していないか確認
2. `chrome.storage.sync`で拡張機能が有効になっているか確認（Popupのトグル）
3. ブラウザのコンソールでエラーログを確認

## 次のステップ

1. エラーハンドリングの改善
2. 要約結果のキャッシュ機能
3. テストの追加
4. CI/CDの設定
5. OCR対応（画像PDFの処理）

## バージョン情報

設定済みの主要ライブラリのバージョン:

- React: 18.3.1
- TypeScript: 5.7.2
- Vite: 6.4.1
- @crxjs/vite-plugin: 2.0.7
- pdfjs-dist: 4.10.38
- Tailwind CSS: 4.1.17
- ESLint: 9.17.0
- Prettier: 3.4.2

バージョンの一貫性を保つため、`package.json`で固定バージョンを使用しています。

## 実装の特徴

### @crxjs/vite-plugin による自動化

- Content ScriptのES Modules問題を自動解決
- Loaderパターンでコードを注入
- Dynamic importとweb_accessible_resourcesを自動設定
- manifest.config.tsからmanifest.jsonを自動生成

### TDNETデザインへの統合

- XBRLボタンと同様の青色グラデーション
- セルの背景色を交互に表示（oddnew/evennew）
- ヘッダーとセルのクラスを適切に設定（-L/-M/-R）
