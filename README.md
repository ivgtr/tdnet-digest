# TDnet Digest

TDnetの適時開示一覧に「要約」ボタンを追加するChrome拡張です。PDFを開く前に、開示の要点と根拠ページを一覧上で確認できます。

![適時開示一覧から決算短信の要約を表示する操作イメージ](media/tdnet-digest-demo.gif)

画面内の開示情報は架空です。[動画版（MP4）](media/tdnet-digest-demo.mp4)もあります。[サンプル画面](demo/index.html)はダウンロードしてブラウザで開くと操作できます。

## できること

開示資料のPDFからテキストを抽出し、設定したLLMで要約します。決算短信では、資料に記載された前年同期比や業績予想の修正も根拠ページ付きで確認できます。

## 使い始める

利用には自分で契約したLLMのAPIキーが必要です。PDFから抽出したテキストを設定先に送信し、選んだモデルに応じてAPI料金が発生します。[料金の目安](docs/api-cost.md)を確認してください。

**インストール：** [Releases](https://github.com/ivgtr/tdnet-digest/releases)からZIPをダウンロードして解凍します。Chromeの `chrome://extensions/` でデベロッパーモードを有効にし、「パッケージ化されていない拡張機能を読み込む」から解凍したフォルダを選びます。

**APIを設定：** 拡張機能の「設定を開く」からLLMプロバイダー、モデル、APIキーを設定して保存します。

**要約する：** [TDnetの開示一覧](https://www.release.tdnet.info/)を開き、確認したい開示の「要約」を押します。

要約の内容は原文と照らし合わせてください。

## 開発・評価

[開発ガイド](docs/development.md)と[評価ガイド](evaluation/README.md)を参照してください。
