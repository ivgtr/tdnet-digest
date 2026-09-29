# 評価ガイド

`evaluation/` には、文書分類の回帰テスト用データ、公開 TDnet PDF の参照情報、実 PDF を使うローカル評価スクリプトを置いています。

## データと評価範囲

| ファイル                             | 内容                                                          |
| ------------------------------------ | ------------------------------------------------------------- |
| `fixtures/classification-cases.json` | 合成タイトル36件の期待分類と、一部の決算コンテキスト          |
| `fixtures/real-pdf-cases.json`       | 公開 PDF 18件の公式 URL、期待分類、抽出確認語                 |
| `scripts/check-real-pdfs.mjs`        | ローカル PDF のページ抽出、空ページ、確認語のチェック         |
| `scripts/run-real-llm.ts`            | 指定した1件を2パスで要約し、JSON 検証結果と出力をローカル保存 |
| `fixtures/fact-summary-cases.json` | 決算・業績修正・提携の事実要約に必要な値と物理ページ |
| `scripts/run-fact-summary.ts` | 現行の1回構造化要約と原文照合を実PDFで評価 |

通常の `npm test` はタイトル分類や原文照合などの回帰テストです。投資判断の有用性は測りません。従来の実 PDF スクリプトは空ページと指定語の有無を確認します。事実要約の3件については、主要数値・単位・期間・物理ページの期待値を別のfixtureに記録しています。

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

## 現行の事実要約を3件で評価

`fixtures/fact-summary-cases.json` の3件のPDFを記載URLから取得し、`evaluation/fixtures/real-pdfs/<ID>.pdf` に保存します。`.env` に `TDNET_DIGEST_PROVIDER`、`TDNET_DIGEST_MODEL`、`TDNET_DIGEST_API_KEY` を設定して実行します。

```bash
npm run test:fact-summary
```

1件だけ実行する場合は `npm run test:fact-summary -- earnings-20260813` のようにIDを渡します。ページ抽出は拡張と同じ行の組立処理を使い、構造化結果を原文と照合します。必須の数値・単位・対象期間・物理ページが一致しない場合は失敗します。結果はGit管理外の `evaluation/results/local/` に保存します。`run-real-llm.ts` は旧2パスの比較用です。
