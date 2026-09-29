# 評価ガイド

`evaluation/` には、文書分類の回帰テスト用データ、公開 TDnet PDF の参照情報、実 PDF を使うローカル評価スクリプトを置いています。

## データと評価範囲

| ファイル                             | 内容                                                          |
| ------------------------------------ | ------------------------------------------------------------- |
| `fixtures/classification-cases.json` | 合成タイトル36件の期待分類と、一部の決算コンテキスト          |
| `fixtures/real-pdf-cases.json`       | 公開 PDF 18件の公式 URL、期待分類、抽出確認語                 |
| `scripts/check-real-pdfs.mjs`        | ローカル PDF のページ抽出、空ページ、確認語のチェック         |
| `scripts/run-real-llm.ts`            | 指定した1件を2パスで要約し、JSON 検証結果と出力をローカル保存 |

通常の `npm test` はタイトル分類などの回帰テストです。PDF 本文の読解精度や投資判断の有用性を測るものではありません。実 PDF のスクリプトも空ページと指定語の有無を確認するもので、要約の正確性を自動採点しません。人手の正解データはまだありません。

## 実 PDF の確認

`fixtures/real-pdf-cases.json` の URL から PDF を取得し、各ファイルを `<ID>.pdf` という名前で同じディレクトリに保存します。PDF 自体と抽出テキストは Git 管理しません。

```bash
npm run test:real-pdf -- /path/to/pdf-directory
```

成功時は `/path/to/pdf-directory/text/` にページ境界付きテキストが生成されます。PDF が欠けている場合は結果表に `missing` と表示され、コマンドは失敗します。

## LLM によるローカル評価

LLM API を呼び出すため、利用するサービスの料金が発生します。`.env.example` を `.env` にコピーし、プロバイダー、モデル、API キー、対象ケース ID、PDF ディレクトリを設定します。

```bash
cp .env.example .env
npm run test:real-llm
```

対象は1回につき1件です。`TDNET_DIGEST_API_KEY` の代わりに、選択したプロバイダーに対応する `OPENAI_API_KEY`、`ANTHROPIC_API_KEY`、`OPENROUTER_API_KEY`、`GOOGLE_API_KEY` も使用できます。実行結果は Git 管理外の `evaluation/results/local/` に保存されます。API キー、非公開資料、個人情報をコミットしないでください。

結果を比較する際は、同じ抽出テキスト、モデル、設定を使い、数値・単位・比較期間・根拠ページを原文と照合してください。PDF にない市場コンセンサスや現在株価を正解として補わないでください。
