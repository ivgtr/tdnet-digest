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
│   ├── format-prompts.ts        # 2パス要約の整形用プロンプト
│   ├── llm-client.ts            # 統一LLMクライアント（OpenAI/Anthropic互換API）
│   ├── llm-providers.ts         # LLMプロバイダー・モデル定義
│   ├── prompts.ts               # 文書タイプ別プロンプト（11種類）
│   ├── section-detector.ts      # セクション検出・ページスコアリング・品質ゲート
│   ├── structured-output.ts     # JSON検証・プロバイダー能力・1回修復指示
│   ├── analysis-version.ts      # 分析仕様バージョン・キャッシュ指紋
│   ├── scoring.ts               # 既定OFFの実験的スコア固定換算
│   └── summary-schema.ts        # 2パス要約の情報抽出用JSONスキーマ
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
  - 要約結果をPDF URLと分析指紋（仕様版・プロバイダー・モデル・抽出方式・パス方式）単位で`chrome.storage.local`にキャッシュ
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
  - デフォルトの2パス要約では、パス1でJSONスキーマに沿って情報抽出し、パス2で低temperature（0.3）の固定テンプレートへ整形
  - パス1のJSONを実行時検証し、失敗時はPDFを再送せず1回修復。再失敗時は1パス要約へフォールバック
  - 設定により従来の1パス要約も選択可能
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
- **`prompts.ts`**: 文書タイプ別プロンプト
  - 11種類の文書タイプごとに最適化されたプロンプトを定義
  - 1パス要約用プロンプトと、2パス要約の情報抽出用プロンプトを構築
  - 根拠ページ、時間軸別評価、利益の質、捏造対策ルールを明記
- **`format-prompts.ts`**: 2パス要約のパス2用プロンプト
  - パス1の構造化データを文書タイプ別の固定テンプレートへ整形
  - `null`の項目やセクションを表示しないルールを定義
- **`summary-schema.ts`**: 2パス要約のパス1用JSONスキーマ
  - 文書タイプと決算期に応じた抽出項目・決算評価ルールを定義
- **`structured-output.ts`**: パス1のJSON検証と修復
  - 必須項目、enum、件数上限、根拠ページ範囲を検証
  - プロバイダー能力を過大評価せず、対応時だけJSON objectモードを使用
- **`analysis-version.ts`**: 分析仕様バージョンとキャッシュ指紋
  - プロンプト仕様や利用モデルが異なる結果を別キャッシュとして管理
- **`scoring.ts`**: 実験的スコア
  - 検証済みの短期・中期・長期スタンスを文書タイプ別の固定重みで換算
  - LLMに点数を生成させず、既存の評価理由を根拠として表示。既定OFF
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
- **抽出モード**:
  - **smartモード**: セクション検出→重要セクションフィルタ→品質ゲート→リトライ（最大2回、topK増加）
  - **fullモード（デフォルト・推奨）**: 全ページのテキストを返却。低コストモデルを前提に抽出量より精度を優先
- **テキスト抽出処理**:
  - Background Scriptから受信したArrayをUint8Arrayに変換
  - pdf.jsの`getDocument()`でPDFを読み込み
  - Y座標ベースの行グループ化でPDFレイアウトを保持
  - テキストクリーニング（空白正規化、ページ番号除去等）
  - 抽出結果とメタデータ（ページ数、品質警告等）をBackground Scriptに返送
- **エラーハンドリング**: PDF読み込み失敗やページ抽出エラーを適切にハンドリング

### Options/Popup UI (`src/options/`, `src/popup/`)

- **Options** (`Options.tsx`):
  - LLMプロバイダー選択（OpenAI/Anthropic/Google/OpenRouter/カスタム）
  - APIキー入力（パスワードフィールド）
  - モデル選択（プロバイダー別プリセット or カスタム入力）
  - 抽出モード選択（デフォルトはfullモード、smartモードも選択可能）
  - 要約モード選択（デフォルトは2パス、1パスも選択可能）
  - 実験的スコア（デフォルトOFF、2パスのみ）
  - カスタムプロバイダーのURL入力
  - 保存済みモデルがリストにない場合の自動カスタムモード切り替え通知
  - 設定をJSONファイルでエクスポート/インポート
  - 要約キャッシュの一覧表示・個別削除・全削除
  - 設定は`chrome.storage.sync`、要約キャッシュは`chrome.storage.local`に保存
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

- **セキュリティ**: この拡張機能は`https://www.release.tdnet.info/*`ドメインでのみ動作するように制限されている。他のドメインでの動作は不要。

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
