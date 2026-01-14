# tdnet-digest

**tdnet-digest** は、TDnet（適時開示情報閲覧サービス）の開示詳細ページに「要約」ボタンを追加し、
開示本文（PDFファイル）を LLM に投げて要約を返す Chrome 拡張です。

- TDnet の適時開示を、ページ上でそのまま AI 要約
- 別タブ遷移やコピペなしで「要点」「ポイントだけ」を即確認
- 利用する LLM / API キー（例: OpenAI 互換 API）はユーザー側で設定

日本株の決算・IR を毎日追う投資家・トレーダー向けに、
「全文を読む前にざっくり中身と重要度を把握する」ためのツールです。

## 📦 インストール方法

### GitHub Releasesからインストール

1. [Releases ページ](https://github.com/ivgtr/tdnet-digest/releases) にアクセス
2. 最新版の **Assets** から `tdnet-digest-vX.Y.Z.zip` をダウンロード
3. 任意の場所に解凍
4. Chrome で `chrome://extensions/` を開く
5. 右上の「**デベロッパーモード**」を **ON** にする
6. 「**パッケージ化されていない拡張機能を読み込む**」をクリック
7. 解凍したフォルダを選択

⚠️ **注意**: 開発者モードでインストールするため、Chrome起動時に警告が表示されますが、正常な動作です。

### 手動ビルド

```bash
# リポジトリをクローン
git clone https://github.com/ivgtr/tdnet-digest.git
cd tdnet-digest

# 依存関係をインストール
npm install

# ビルド
npm run build

# dist/ フォルダをChromeの拡張機能として読み込む
```

## 🚀 開発

### 開発コマンド

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

## 📄 ライセンス

MIT
