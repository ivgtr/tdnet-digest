# tdnet-digest

<img width="542" height="307" alt="image" src="https://github.com/user-attachments/assets/86ada69f-3329-400e-bae9-a00fae210ccb" />

TDnetの適時開示一覧で、PDFの内容をその場で要約するChrome拡張です。開示行の「要約」を押すと、要点と根拠ページを表示します。PDFから抽出したテキストを、設定したLLMに送信します。

## インストールと使い方

1. [Releases](https://github.com/ivgtr/tdnet-digest/releases)から最新版のZIPをダウンロードして解凍します。
2. Chromeの `chrome://extensions/` でデベロッパーモードを有効にし、「パッケージ化されていない拡張機能を読み込む」から解凍したフォルダを選びます。
3. 拡張機能の設定画面でLLMプロバイダー、モデル、APIキーを設定し、[TDnet](https://www.release.tdnet.info/)の開示一覧で「要約」を押します。

APIの利用料金は自分で契約したサービスに発生します。[料金の目安](docs/api-cost.md)を参照してください。要約は原文を確認するための補助として利用してください。

## 開発

手元でビルドする場合は[開発ガイド](docs/development.md)、評価方法は[評価ガイド](evaluation/README.md)を参照してください。
