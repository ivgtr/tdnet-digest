# tdnet-digest 開発環境セットアップ

## 技術スタック

- **React 18.3.1** - UI フレームワーク
- **TypeScript 5.7.2** - 型安全な開発
- **Tailwind CSS v4.1.17** - スタイリング
- **Vite 6.4.1** - 高速ビルドツール (Rollup 使用)
- **Turborepo 2.3.3** - モノレポ管理
- **ESLint 9.17.0** - コード品質チェック
- **Prettier 3.4.2** - コードフォーマット
- **Chrome Extensions Manifest V3** - 拡張機能仕様

## プロジェクト構造

```
tdnet-digest/
├── apps/
│   └── extension/              # Chrome拡張機能
│       ├── src/
│       │   ├── background/     # Service Worker
│       │   ├── content/        # コンテンツスクリプト
│       │   ├── popup/          # ポップアップUI
│       │   ├── options/        # 設定ページ
│       │   └── components/     # 共通コンポーネント
│       ├── public/
│       │   ├── manifest.json   # 拡張機能マニフェスト
│       │   └── icons/          # アイコン
│       ├── popup.html          # ポップアップHTML
│       ├── options.html        # 設定ページHTML
│       └── dist/               # ビルド出力
├── packages/
│   └── config/                 # 共有設定
│       ├── eslint.config.js
│       └── prettier.config.js
├── package.json                # ルート設定
└── turbo.json                  # Turborepo設定
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

または拡張機能のみ:

```bash
cd apps/extension
npm run dev
```

### 3. プロダクションビルド

```bash
npm run build
```

ビルド成果物は `apps/extension/dist/` に出力されます。

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

1. Chrome で `chrome://extensions/` を開く
2. 右上の「デベロッパーモード」を有効化
3. 「パッケージ化されていない拡張機能を読み込む」をクリック
4. `apps/extension/dist` ディレクトリを選択

## 開発時の注意点

### アイコンの追加

現在、アイコンファイルはプレースホルダーです。以下のサイズのPNGファイルを `apps/extension/public/icons/` に追加してください:

- `icon-16.png` (16x16)
- `icon-32.png` (32x32)
- `icon-48.png` (48x48)
- `icon-128.png` (128x128)

### PDFテキスト抽出

`src/background/index.ts` の `extractTextFromPDF` 関数は現在未実装です。
pdf.js などのライブラリを使用してPDFからテキストを抽出する実装が必要です。

```bash
npm install pdfjs-dist -w @tdnet-digest/extension
```

### 環境変数

API設定は Chrome の storage API に保存されます。開発時は拡張機能の設定ページから設定してください。

## スクリプト一覧

| コマンド | 説明 |
|---------|------|
| `npm run dev` | 全パッケージの開発ビルド (watch) |
| `npm run build` | 全パッケージのプロダクションビルド |
| `npm run lint` | ESLintでコードチェック |
| `npm run format` | Prettierでコードフォーマット |
| `npm run type-check` | TypeScriptの型チェック |

## トラブルシューティング

### ビルドエラーが発生する

```bash
# node_modules を削除して再インストール
rm -rf node_modules apps/*/node_modules packages/*/node_modules
npm install
```

### 拡張機能が動作しない

1. `npm run build` で最新のビルドを作成
2. Chrome拡張機能ページで「更新」ボタンをクリック
3. Chromeの開発者ツールでエラーログを確認

### Tailwind CSSのスタイルが適用されない

`src/index.css` に `@import "tailwindcss";` が含まれていることを確認してください。

## 次のステップ

1. PDF抽出機能の実装 (pdf.js の統合)
2. アイコンファイルの作成
3. エラーハンドリングの改善
4. テストの追加
5. CI/CDの設定

## バージョン情報

設定済みの主要ライブラリのバージョン:

- React: 18.3.1
- TypeScript: 5.7.2
- Vite: 6.4.1
- Tailwind CSS: 4.1.17
- Turborepo: 2.3.3
- ESLint: 9.17.0
- Prettier: 3.4.2

バージョンの一貫性を保つため、`package.json` で固定バージョンを使用しています。
