# 開発ガイド

## セットアップと確認

Node.js 20以上を使用します。依存関係とコマンドは [package.json](../package.json) を正本とします。

```bash
npm install
npm run dev         # 変更を監視してビルド
npm run build       # 配布用ビルド
npm run type-check
npm run lint
npm test
```

ビルド後、Chrome の `chrome://extensions/` でデベロッパーモードを有効にし、`dist/` を「パッケージ化されていない拡張機能を読み込む」から選択します。拡張機能のコードを変更した後は、必要に応じて拡張機能と TDnet のページを再読み込みしてください。

## 主な構成

| 場所                         | 役割                                         |
| ---------------------------- | -------------------------------------------- |
| `src/content/`               | TDnet の一覧へのボタン・要約表示の挿入       |
| `src/background/`            | PDF の取得、設定・キャッシュ、LLM 呼び出し   |
| `src/offscreen/`             | PDF.js によるテキスト抽出                    |
| `src/lib/`                   | 文書分類、プロンプト、出力検証、評価ロジック |
| `src/options/`, `src/popup/` | 設定画面と有効・無効の切り替え               |
| `manifest.config.ts`         | 権限と拡張機能のエントリーポイント           |

Content Script は TDnet の iframe 内を操作します。ページ側の CSS に影響しないよう、挿入する UI はインラインスタイルを使います。PDF.js は Service Worker から直接実行せず、Offscreen Document で動かします。

API の設定は拡張機能の設定画面から行います。実 PDF を使うローカル評価の手順とデータの扱いは [評価ガイド](../evaluation/README.md) を参照してください。
