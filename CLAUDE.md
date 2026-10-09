# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## プロジェクト概要

TDnet適時開示情報を閲覧中にLLMで要約を表示するChrome拡張機能。
TDnetの開示一覧ページのiframe内テーブルにReactベースの要約ボタンを注入し、Background ScriptがPDFを取得→Offscreen Documentでテキスト抽出→複数LLMプロバイダー（OpenAI/Anthropic/Google/OpenRouter/カスタム）で要約を生成する。

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

# テスト
npm test

# フォーマット
npm run format
```

## テスト方針

テストの追加・整理・再実行は [開発ガイドのテスト戦略](docs/development.md#テスト戦略) に従う。語彙の網羅は部品、責務の接続は代表例、実PDFは固定コーパスで証明する。同じ反例を全経路や全旧指紋へ複製しない。追加時には新しい分岐・境界と担当テストを示し、重複例を置き換えられるか確認する。実API・画面検証の実施条件と停止境界は [評価ガイド](evaluation/README.md#検証の選択と停止条件) を正本とする。

## ファイル構成

```
src/
├── background/
│   └── index.ts                 # Service Worker（メッセージ処理・PDF取得・LLM要約）
├── offscreen/
│   └── index.ts                 # Offscreen Document（PDF.jsテキスト抽出・セクション検出）
├── content/
│   ├── index.tsx                # Content Script（iframe監視・ボタン注入）
│   ├── SummaryButton.tsx        # 要約ボタンReactコンポーネント
│   ├── constants/
│   │   └── styles.ts            # インラインスタイル定数
│   ├── hooks/
│   │   ├── useSummarize.ts      # 要約処理フック
│   │   └── useSummaryRow.ts     # 要約行DOM操作フック
│   ├── types/
│   │   └── summaryMetadata.ts   # 型のre-export
│   └── utils/
│       ├── markdownParser.ts     # Markdown→HTML変換（インラインスタイル・コード/リンク検証）
│       ├── rowDataExtractor.ts  # テーブル行データ抽出
│       ├── summaryHtmlBuilder.ts # 要約表示HTML生成
│       └── tdnetDomHelper.ts    # TDnet固有DOM操作
├── popup/
│   ├── index.tsx                # Popup UIエントリー
│   └── Popup.tsx                # ポップアップコンポーネント
├── options/
│   ├── index.tsx                # Options UIエントリー
│   └── Options.tsx              # 設定ページコンポーネント
├── lib/
│   ├── document-type.ts         # 文書タイプ判別（決算短信/業績修正/配当/M&A等）
│   ├── earnings-refinement.ts   # 決算評価・進捗率の決定論的補正と一時損益の精査
│   ├── fact-summary.ts          # 現行の構造化事実・原文照合・表示文
│   ├── additional-analysis.ts   # ボタン操作時の追加分析
│   ├── pdf-lines.ts             # PDF文字の行単位の組立
│   ├── format-prompts.ts        # 旧2パス評価用プロンプト
│   ├── llm-client.ts            # 統一LLMクライアント（OpenAI/Anthropic互換API）
│   ├── llm-providers.ts         # LLMプロバイダー・モデル定義
│   ├── prompts.ts               # 文書タイプ別プロンプト（11種類）
│   ├── section-detector.ts      # セクション検出・ページスコアリング・品質ゲート
│   ├── structured-output.ts     # JSON検証・プロバイダー能力・1回修復指示
│   ├── analysis-version.ts      # 分析仕様バージョン・キャッシュ指紋
│   ├── scoring.ts               # 既定OFFの検算済み事実による実験的スコア推論
│   ├── score-extraction.ts      # 採点入力の抽出とPDFページ照合
│   ├── disclosure-search.ts     # 過去開示PDF候補のWeb検索と取得
│   └── summary-schema.ts        # 旧2パス評価用スキーマ
├── types/
│   └── summaryMetadata.ts       # 共通型定義（ExtractionMode, SummaryMetadata等）
└── index.css                    # Tailwind CSS（Popup/Optionsのみ）
```

## アーキテクチャ

### ビルドシステム（@crxjs/vite-plugin）

- **プラグイン**: `@crxjs/vite-plugin`を使用してChrome拡張をビルド
  - Content ScriptのES Modules問題を自動解決
  - Dynamic importとweb_accessible_resourcesを自動設定
  - Loaderパターンでコードを注入

- **Manifest**: `manifest.config.ts`（ルートディレクトリ）
  - TypeScriptで定義し、package.jsonからバージョンを取得
  - 固定`key`で拡張機能IDを安定させ、更新・再配置時も`chrome.storage`を引き継ぐ
  - ビルド時に自動的にmanifest.jsonを生成

- **エントリーポイント**:
  - `popup.html` / `options.html`: 拡張機能のUI（React + Tailwind CSS）
  - `offscreen.html`: Offscreen Document（PDF処理用）
  - `src/content/index.tsx`: Content Script（インラインスタイルのみ使用）
  - `src/background/index.ts`: Background Service Worker（Manifest V3）

- **ビルド出力**: `dist/`ディレクトリ

### Content Script (`src/content/`)

- **注入先**: `https://www.release.tdnet.info/*`（manifest.config.tsで定義）
- **スタイリング**: すべてインラインスタイルで実装（Tailwind CSSは使用しない）
  - `constants/styles.ts`にスタイル定数を集約
  - TDNETのデザインシステムに合わせた色とスタイル
  - ボタンは青色グラデーション（`#75a8d0` → `#4a84b9`）
  - セルクラス: `oddnew-R` / `evennew-R` で背景色を交互に表示
- **モジュール構成**:
  - `index.tsx`: iframe監視、MutationObserver設定、拡張機能有効/無効の制御
  - `SummaryButton.tsx`: 要約ボタンのReactコンポーネント
  - `hooks/useSummarize.ts`: Background Scriptへのメッセージ送信・結果管理
  - `hooks/useSummaryRow.ts`: 要約行のDOM挿入・削除
  - `utils/rowDataExtractor.ts`: テーブル行から会社名・タイトル・PDF URLを抽出
  - `utils/summaryHtmlBuilder.ts`: 要約結果・エラー・メタデータのHTML生成
  - `utils/markdownParser.ts`: LLM出力のMarkdownをインラインスタイル付きHTMLへ変換し、コードとリンクを検証
  - `utils/tdnetDomHelper.ts`: ヘッダー列追加、セルクラス更新
- **動作**:
  - 開示情報一覧ページのiframe内（`#main_list`）のテーブルを監視
  - ヘッダー行に「AI要約」列を追加（既存の最後の列を`-M`に変更し、新しい列を`-R`に）
  - テーブルの各行（開示情報）の最後に要約ボタンを注入
  - ボタンクリック時に行データ（時刻、コード、会社名、表題、PDF URL）を抽出
  - 要約結果は同じ行のすぐ下に新しい行として挿入（colspanで全列を使用）
  - 要約結果をPDF URLと事実要約の指紋（仕様版・プロバイダー・モデル・抽出方式）単位で`chrome.storage.local`にキャッシュ。採点と追加分析は結果ID別キーに保存
  - キャッシュ済みボタンは表示/非表示を切り替え、再要約時はキャッシュを更新
  - メタデータ表示（抽出ページ数、抽出モード、分析条件、品質警告）
  - smartモード時に全文再要約ボタンを表示
- **通信**: `chrome.runtime.sendMessage`でBackground Scriptに要約リクエスト送信
- **iframe再読み込み対応**:
  - `iframe.addEventListener('load')`でiframe再読み込みを検知
  - MutationObserverを再設定して新しいcontentDocumentを監視
  - 公開日変更やページ移動時も正しく動作

### Background Service Worker (`src/background/index.ts`)

- **役割**: Content Scriptからの`summarize`メッセージを受信し、PDF取得→Offscreen Documentで抽出→LLM要約を実行
- **設定取得**: `chrome.storage.sync`からプロバイダー/API URL/Key/Model/抽出モードを取得
- **PDF取得**: TDnetからPDFファイルを`fetch()`でArrayBufferとして取得
- **Offscreen Document管理**:
  - `setupOffscreenDocument()`: Offscreen Documentの作成・管理
  - 既存のOffscreen Documentがあれば再利用、なければ新規作成
- **PDF処理の委譲**:
  - ArrayBufferをArrayに変換して`chrome.runtime.sendMessage()`でOffscreen Documentに送信
  - 抽出モード（smart/full）と文書タイトルをOffscreen Documentに伝達
- **LLM要約**:
  - `src/lib/document-type.ts`で文書タイトルから文書タイプを自動判別
  - `src/lib/prompts.ts`で文書タイプ別プロンプトを構築
  - `src/lib/llm-client.ts`でLLM APIを呼び出し（OpenAI/Anthropic互換）
  - 現行の要約は文字抽出から構造化事実を通常1回生成し、物理ページ・本文引用または表の根拠セルIDから、数値・単位・期間と表の行列を原文照合する
  - 確認済み事実の表はコードが直接表示する。別の要求で不足する事業別/受注/CF等の観測指標と短い説明を共通文脈参照で生成し、項目ごとに独立点検する。通常3要求、候補修復は最大1回、全体最大4要求・300秒。補足生成・点検は各60秒・8,192出力tokenまで。未整理部分は見出し・ページ・原文トグルを残し、確認済み表の表示を止めない。未確認を確認済みとして保存しない
  - 数値と比較の表示は原文数量参照からコードで作り、要約文章の意味点検はモデルで行う。原文の転載を説明要約の代替として返さない
  - 採点は要約表示後、追加分析はボタン操作時に、それぞれ独立した要求で実行する
  - APIエラーの詳細抽出（ネストされたエラーメッセージの再帰的取得）

### 共通ライブラリ (`src/lib/`)

- **`document-type.ts`**: 文書タイトルから11種類の文書タイプを判別
  - 決算短信、業績修正、株主優待、配当、自己株式取得、株式分割・併合、資本政策、M&A・組織再編、月次・事業進捗、ガバナンス、その他
- **`llm-client.ts`**: 統一LLMクライアント
  - OpenAI互換API（OpenAI/Google/OpenRouter/カスタム）とAnthropic APIを統一的に呼び出し
  - `buildApiError()`: エラーレスポンスからの詳細メッセージ抽出
- **`llm-providers.ts`**: LLMプロバイダー定義
  - OpenAI、Anthropic、Google、OpenRouter、カスタムの5種類
  - 各プロバイダーのデフォルトURL、デフォルトモデル、モデルリスト
- **`fact-summary.ts`**: 候補v4・確定事実v6の根拠付き事実抽出。`summary-presentation.ts` / `summary-renderer.ts` は冒頭と本文を分け、全文の原文引用を確定事実と区別して保持・表示する。`fact-validation.ts` が原文字・構造・数量全断片・主体/範囲・期間・限定/条件・状態を照合し、採点は確定IDだけを参照する。詳細と対応境界は docs/development.md の承認済み設計・実装記録を正本とする
- **`additional-analysis.ts`**: 確定事実・点検済み説明/指標・コード計算を使う論点型追加分析v4。数字・期間を含む本文全体は未検証の推論として区別し、根拠参照不備は論点単位で隔離する。`analysis-input.ts` が根拠を構成し、`analysis-calculations.ts` が比較可能な金額だけを計算する。[設計・検証境界](docs/additional-analysis.md)を参照
- **`prompts.ts`**: 旧要約経路の文書タイプ別プロンプト。現行の要約では使用しない
- **`format-prompts.ts`**: 2パス要約のパス2用プロンプト
  - パス1の構造化データを文書タイプ別の固定テンプレートへ整形
  - `null`の項目やセクションを表示しないルールを定義
- **`summary-schema.ts`**: 2パス要約のパス1用JSONスキーマ
  - 文書タイプと決算期に応じた抽出項目・決算評価ルールを定義
- **`structured-output.ts`**: 旧パス1のJSON検証と修復、現行経路でのJSONモード判定
  - 必須項目、enum、件数上限、根拠ページ範囲を検証
  - プロバイダー能力を過大評価せず、対応時だけJSON objectモードを使用
- **`analysis-version.ts`**: 分析仕様バージョンとキャッシュ指紋
  - プロンプト仕様や利用モデルが異なる結果を別キャッシュとして管理
- **`scoring.ts`**: 実験的スコア
  - ページ本文で照合した数値と事実に限り、規模・本業への影響・継続性を踏まえた点数の目安を推論。比較不能な項目を推測で補わない
  - 要約の下部に点数・判定・理由を表示し、展開詳細に内訳と根拠を出す。既定OFF
- **`score-extraction.ts` / `disclosure-search.ts`**: 採点入力と比較資料
  - 通常のPDFを先に確認し、不足時のみ設定中のAPIのWeb検索で過去PDF候補を探す
  - 検索結果だけでは採点せず、取得したPDF本文・対象期間・指標・根拠ページを照合する
  - 表の値は要約と同じ位置情報・根拠セルIDで照合し、元PDFの採点値は検証済み要約事実と対応させる
- **`section-detector.ts`**: PDF抽出の知的フィルタリング
  - セクション検出（5種類の見出しパターン）
  - ページスコアリング（キーワード出現回数ベース）
  - 品質ゲート（同義語ベースのキーワードチェック）
  - 文書タイプ別の削減パラメータ（`EXTRACTION_PARAMS`）

### Offscreen Document (`src/offscreen/index.ts`)

- **目的**: Service WorkerではDOM APIが使えないため、PDF.jsでPDF処理を行う専用環境
- **PDF.js Worker設定**:
  - Viteの`?url`インポートで`pdfjs-dist/build/pdf.worker.min.mjs`を参照
  - `GlobalWorkerOptions.workerSrc`に`chrome.runtime.getURL()`で取得したURLを設定
  - Viteが自動的にWorkerファイルをバンドル（ハッシュ化されたファイル名で最適化）
- **CMap**: 同版 `pdfjs-dist/cmaps` のpacked資産とLICENSEをViteプラグインがbuild/watchごとに同梱し、Offscreenから `chrome.runtime.getURL('cmaps/')` で読む。外部CDNや追加権限は不要
- **抽出モード**:
  - **smartモード**: セクション検出→重要セクションフィルタ→品質ゲート→リトライ（最大2回、topK増加）
  - **fullモード（デフォルト・推奨）**: 全ページのテキストを返却。低コストモデルを前提に抽出量より精度を優先
- **テキスト抽出処理**:
  - Background Scriptから受信したArrayをUint8Arrayに変換
  - pdf.jsの`getDocument()`でPDFを読み込み
  - `pdf-layout.ts` でページ内ID・文字座標・大きさを保持し、行本文も生成
  - テキストクリーニング（空白正規化、ページ番号除去等）
  - 抽出結果とメタデータ（ページ数、品質警告等）をBackground Scriptに返送
- **エラーハンドリング**: PDF読み込み失敗やページ抽出エラーを適切にハンドリング

### Options/Popup UI (`src/options/`, `src/popup/`)

- **Options** (`Options.tsx`):
  - LLMプロバイダー選択（OpenAI/Anthropic/Google/OpenRouter/カスタム）
  - APIキー入力（パスワードフィールド）
  - モデル選択（プロバイダー別プリセット or カスタム入力）
  - 抽出モード選択（デフォルトはfullモード、smartモードも選択可能）
  - 実験的スコア（デフォルトOFF、要約表示後の自動採点）
  - カスタムプロバイダーのURL入力
  - 保存済みモデルがリストにない場合の自動カスタムモード切り替え通知
  - 設定をJSONファイルでエクスポート/インポート
  - 要約・採点・追加分析キャッシュの一覧表示・個別削除・全削除
  - 設定は`chrome.storage.sync`、3種類のキャッシュは`chrome.storage.local`に別キーで保存
- **Popup** (`Popup.tsx`):
  - 拡張機能の有効/無効を切り替えるトグルスイッチ
  - API設定の状態表示（設定済み/未設定）
  - プロバイダー・モデル名の表示
  - 設定ページへのリンク
  - `extensionEnabled`を`chrome.storage.sync`に保存し、Content Scriptに通知

## 技術スタック

- **フレームワーク**: React 18 + TypeScript（strict mode）
- **スタイリング**:
  - Popup/Options: Tailwind CSS 4.0-beta
  - Content Script: インラインスタイルのみ（TDNETページの表示崩れを防ぐため）
- **ビルド**: Vite 6 + @crxjs/vite-plugin + @vitejs/plugin-react
- **Chrome拡張**: Manifest V3（Service Worker + Offscreen Document使用）
- **PDF処理**: pdfjs-dist（Offscreen Documentで実行）
- **Markdown処理**: marked（Content ScriptでLLM出力をHTMLへ変換）
- **パスエイリアス**: `@/`は`./src/`を指す（vite.config.ts）
- **アイコン**: `public/logo.png`（全サイズで使用）
- **Node要件**: >=20.0.0

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

- **セキュリティ**: Content Scriptの注入先は`https://www.release.tdnet.info/*`のみ。必須ホスト権限はTDnetと標準のLLM APIに限定する。カスタムAPIは対象ホスト、実験的スコアの過去資料はJPX・EIR・IR Pocketの各ホストへの任意権限を設定時に求める。検索候補は取得前にホスト・パス・証券コードを確認し、取得後にPDF形式・サイズ・発行会社・期間・根拠ページを確認する。

- **LLM出力のHTML化**:
  - `markdownParser.ts`のカスタムレンダラーを経由し、Content Script向けのインラインスタイルを付与する
  - コード、言語名、リンク属性はHTMLエスケープし、リンク先は`http:`/`https:`のみに制限する
  - Markdown変換処理を変更する場合は、上記のエスケープとURLスキーム制限を維持する

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
