# Gemini Nano Computer Use (Chrome Extension)

Google Chrome に内蔵されたローカル AI モデル **Gemini Nano**（Built-in AI / Prompt API `LanguageModel`）を使って、現在開いているタブの画面を認識・自律操作する **Computer Use** Chrome 拡張機能です。

外部 API キーやクラウドサーバーへの送信を行わず、ブラウザ単体で **Observe → Think → Guard → Act** のループを実行します。

## 主な特徴

- **完全ローカル推論（Gemini Nano / 代替 Qwen 2.5 VL 対応）**
  - `LanguageModel` API（マルチモーダル対応時はスクリーンショット画像＋DOM、非対応環境では DOM テキストのみへ自動フォールバック）を利用します。
  - **Qwen 2.5 VL（ローカル Ollama）フォールバック & 1ステップ導入**: Gemini Nano が使えない環境向けに、上部のトグルをオンにするだけでローカルの **Qwen 2.5 VL (`3b` / `7b`)** へ切り替えられます。Ollama 起動済みならサイドパネル上からワンクリックでモデルを取得でき、未導入時も `install-qwen25vl.bat`（[scripts/install-qwen25vl.bat](scripts/install-qwen25vl.bat) / PowerShell ワンライナー）により 1 ステップで導入完了できます。
  - `responseConstraint`（JSON Schema 制約）＋堅牢な JSON 抽出パーサーにより、安定したアクション出力を実現しています。
- **Set-of-Mark（画面注釈）＋ DOM インスペクターのハイブリッド認識**
  - ページ内の可視インタラクティブ要素（Open Shadow DOM 含む）に番号 ID `[1]`, `[2]`, ... を付与し、タブのスクリーンショットにも赤枠バッジを描画してモデルへ渡します。
  - React / Vue 等のフレームワークで制御された入力欄でも動作するよう、ネイティブセッター経由の入力・イベント発火に対応しています。
- **安全機構（Human-in-the-Loop）**
  - パスワード入力、フォーム送信、購入・決済・削除・退会などのキーワードを含む要素のクリック時は実行前に確認カードを表示します。
  - `javascript:`, `file:`, `chrome:`, `data:` などの危険スキームへの遷移はブロックされます。
  - 「自動（危険操作のみ確認）」と「ステップ実行（毎回確認）」を切り替えられ、いつでも「緊急停止」可能です。
- **Side Panel UI**
  - 各ステップの思考内容・アクション・実行結果・注釈付きスクリーンショットのサムネイル（クリックで拡大）をタイムラインで確認できます。
- **PDF ダウンロード・ローカル読み込み・PDF 閲覧**
  - **画面の PDF ダウンロード＆自動読み込み**: 現在開いているタブを Chrome DevTools Protocol (`Page.printToPDF`) で PDF 化してローカル保存し、即座に拡張機能内へ読み込めます（手動ボタン・AI アクション `download_page_pdf` の両方に対応）。
  - **ローカル PDF の読み込み**: ファイル選択やドラッグ＆ドロップで手元の PDF を拡張機能へ直接読み込めます（外部アップロードなし）。
  - **PDF 閲覧 & テキスト抽出**: サイドパネル内の Chrome ネイティブ PDF プレビュー（`blob:` URL 表示・新しいタブで閲覧対応）と、純粋 JS ローカル PDF パーサー（`/FlateDecode`・`/ToUnicode` CMap 対応）によるページ別テキスト抽出・コピー、AI アクション `read_pdf` による要約が可能です。
- **内蔵メディア＆文書簡易ビュワー（別タブ表示 & AI 閲覧対応）**
  - **ローカルダウンロード回避の自動インターセプト**: 操作中に対象リンクをクリックしたり直接ダウンロードが始まった際、ローカルディスクへの保存で AI が参照不能になるのを防ぎ、拡張機能内の簡易ビュワー（別タブ `viewer/viewer.html`）へバイナリを読み込んで表示します。
  - **対応形式**: 画像（JPEG系 `.jpg`/`.jpeg`/`.jfif`、`.png`、`.bmp`、`.webp`、`.gif`）、Adobe Illustrator（`.ai`：PDF互換ストリーム表示＋旧 PostScript テキスト抽出）、動画（`.mp4` [H.264 / H.265]、`.mov`）、文書（`.pdf`）。
  - **AI による視覚＋テキスト参照**: 簡易ビュワータブ上で画像・動画の現在フレーム・PDF/AI 抽出テキストを Gemini Nano がそのまま観察し、ページ送り・動画シーク・拡大回転・ローカル保存ボタン等を操作できます。
- **バックグラウンド実行 & 複数タブ作業（タブグループ自動作成）**
  - **バックグラウンド実行**: Offscreen Document (`offscreen/offscreen.html`) と Service Worker を連携させ、サイドパネルを閉じたり別タブを閲覧している間もタスクを継続実行できます（ツールバーアイコンに進捗バッジを表示し、サイドパネルを再開すると状態・履歴を再同期）。
  - **複数タブ作業と自動タブグループ化**: 複数タブでの作業を許可すると、Chrome のタブグループ（既定: `Nano AI`）を自動作成し、新規タブ (`open_tab`)・タブ切替 (`switch_tab`)・タブ終了 (`close_tab`)・リンクから開いた子タブをすべて同じタブグループ内で完結して管理します。
- **手順書（SOP）アップロード ＆ AI 可読テンプレートダウンロード**
  - **Office 文書（`.docx` / `.pptx` / `.xlsx`）＆ 画像抽出対応**: Word・PowerPoint・Excel 等の手順書をアップロードすると、テキストとともに貼り付けられたスクリーンショット画像をローカルで抽出し、Gemini Nano が視覚的に参照しながら操作できます（`.md` / `.txt` / `.json` / `.pdf` にも対応）。
  - **Word (`.docx`) / Markdown テンプレートダウンロード**: スクリーンショットをそのまま貼り付けられる Word テンプレート（`gemini-nano-playbook-template.docx`）と Markdown テンプレート（`gemini-nano-playbook-template.md`）をワンクリックでダウンロードできます。
  - **Gemini Web 版用 変換スキル (`SKILL.md`) ダウンロード**: 既存のフォーマット化されていない手順書を Google Gemini（Web 版）に読み込ませるだけで Gemini Nano 用の構造化手順書へ変換できる変換スキル（[docs/SKILL.md](docs/SKILL.md)）をサイドパネル内リンクからダウンロード／コピーできます。
  - **厳格手順書モード**: 手順書が適用されている場合は手順書の記載通りに実行し、要素が見つからない・画面が異なる・判断に迷う不明点が出た場合は推測で進めず必ず `ask_user` で人間に指示を仰ぎます。
- **フローチャート設計タブ & Nano Flow Studio（Google Workspace Studio 風エディタ）**
  - **フロー設計タブ**: サイドパネル上の「フロー設計」タブでローカル保存済みプリセットを一覧・プレビューし、ワンクリックで適用（呼出）または即実行できます（AI 操作画面の上部セレクトからもワンクリック呼出可能）。
  - **Studio 専用ページ (`studio/studio.html`)**: 「Studio で詳細設計（別ページ）」から開く 3 ペインのビジュアルフローチャートエディタで、左パレットからの**ドラッグ＆ドロップ配置**、キャンバス上の**空き領域ドラッグによる複数選択＆まとめて移動**、**Ctrl+クリック2回接続**（ポート選択＆線クリック切断・自動整列も対応）、およびキーボードショートカット（`Ctrl+C` コピー / `Ctrl+X` 切り取り / `Ctrl+V` カーソル位置へ貼り付け / `Ctrl+A` 全選択 / `Ctrl+Z` 元に戻す / `Ctrl+S` プリセット保存 / `Ctrl+L` 自動整列）を使って直感的にフローを構築し、`chrome.storage.local` にプリセット保存／JSON エクスポートできます。

## プライバシー・ローカル完結設計（外部情報漏洩防止）

この拡張機能は、入力したプロンプトや閲覧中の画面情報・操作履歴・読み込んだ PDF データが外部サーバーへ送信されたり、AI モデルの学習に利用されたりしない設計になっています。

- **完全オンデバイス／ローカルループバック推論**: 推論には Google Chrome 内蔵の `LanguageModel` API（Gemini Nano）またはローカル PC 上の Ollama（Qwen 2.5 VL）のみを使用し、外部 AI API への送信やテレメトリ収集は一切行いません。
- **CSP による外部通信の強制遮断**: [manifest.json](manifest.json) の `content_security_policy.extension_pages` に `connect-src http://127.0.0.1:11434 http://localhost:11434` のみを許可し、外部インターネットサーバーへの通信をブラウザレベルで禁止しています（画面注釈表示やローカルメディアプレビュー用の `data:` / `blob:` のみ許可）。
- **追加権限について**: 画面の PDF 生成 (`Page.printToPDF`) とローカル保存・履歴参照のために `debugger` と `downloads` 権限、バックグラウンド推論とタブグループ管理のために `offscreen` と `tabGroups` 権限を使用しますが、すべての処理はブラウザ内およびローカルディスク上で完結します。
- **ローカル限定ストレージとメモリ管理**: 設定はクラウド同期されない `chrome.storage.local` のみに保存します。操作中の DOM 情報・スクリーンショット・プロンプト履歴はメモリ上のみで扱い、各ステップ終了時に推論セッションを `destroy()` で破棄します。
- **機密情報の保護**: `type="password"` の入力値はプロンプト生成時に `***` へマスクされ、パスワード入力・フォーム送信・購入・削除などの操作前には確認カードでユーザー承認を求めます。

> **補足・例外について**
> - 初回セットアップ時のみ、Chrome 本体が Gemini Nano モデルファイルをローカルへダウンロードする通信が発生します（完了後はオフラインでも推論可能です）。
> - AI がユーザー指示に従って Web ページを操作（`navigate` や検索・クリック等）する際は、**操作対象の Web サイト自体**に対して通常のブラウザ操作と同等の通信が発生します。
> - Chrome ブラウザ本体の使用統計データ／クラッシュレポート設定は、Chrome 側の設定に従います。

## ディレクトリ構成

```text
├── manifest.json                 # Manifest V3 定義
├── package.json                  # ES Modules & node --test 設定
├── background/
│   └── service-worker.js         # Side Panel 制御・バックグラウンド実行・PDF生成・タブ管理
├── offscreen/
│   ├── offscreen.html            # バックグラウンド推論用 Offscreen Document
│   └── offscreen.js              # Offscreen 内 Gemini Nano & Canvas 注釈ランナー
├── content/
│   └── dom-inspector.js          # 可視要素収集・クリック/入力/スクロール実行・視覚ハイライト
├── sidepanel/
│   ├── sidepanel.html            # サイドパネル UI
│   ├── sidepanel.css             # スタイル（ライト/ダークモード対応）
│   ├── sidepanel.js              # UI 制御とエージェント統合
│   └── annotator.js              # Set-of-Mark 番号バッジ描画
├── studio/
│   ├── studio.html               # Google Workspace Studio 風ビジュアルフローエディタ
│   ├── studio.css                # Studio スタイル（ドットグリッド＆分岐カード）
│   └── studio.js                 # フロー編集・分岐管理・ローカルプリセット保存
├── viewer/
│   ├── viewer.html               # 画像・動画・PDF・Illustrator (.ai) 簡易ビュワー
│   ├── viewer.css                # ビュワースタイル（ライト/ダークモード対応）
│   └── viewer.js                 # メディア再生・PDF/AI 解析・AI観察ブリッジ
├── shared/
│   ├── constants.js              # アクション定義・デフォルト設定・Chrome フラグ情報
│   ├── action-schema.js          # JSON Schema 定義 & アクションパーサー
│   ├── safety.js                 # URL 検証・危険操作検出・ループ検出
│   ├── prompt-builder.js         # システム/ステッププロンプト生成
│   ├── nano-client.js            # Chrome Prompt API (Gemini Nano) ラッパー
│   ├── qwen-client.js            # ローカル Ollama (Qwen 2.5 VL) クライアント＆1ステップ導入生成
│   ├── pdf-parser.js             # 純粋 JS ローカル PDF 解析・テキスト抽出
│   ├── office-parser.js          # 純粋 JS Office (.docx/.pptx/.xlsx) 画像抽出＆Wordテンプレ生成
│   ├── playbook.js               # 手順書パーサー＆AI可読テンプレート定義
│   ├── workflow-flow.js          # フローチャート分岐エンジン＆ローカルプリセットストア
│   ├── tab-workspace.js          # 複数タブ＆タブグループ管理
│   └── agent-controller.js       # Observe -> Think -> Guard -> Act 制御ループ
├── scripts/
│   └── generate-icons.mjs        # 拡張機能 PNG アイコン生成スクリプト
├── docs/
│   └── SKILL.md                  # Gemini (Web版) 用の未整形手順書→構造化手順書変換スキル
└── tests/                        # Node 標準テストランナーによるユニットテスト
```

## 事前準備（Chrome 内蔵 Gemini Nano の有効化）

デスクトップ版 Google Chrome（最新バージョン推奨）と、Gemini Nano を動作させるための十分な RAM / GPU / ストレージ空き容量が必要です。
環境によっては `chrome://flags` で以下のフラグを有効化し、Chrome を再起動してください。

1. `chrome://flags/#prompt-api-for-gemini-nano` → **Enabled**
2. `chrome://flags/#prompt-api-for-gemini-nano-with-multimodal-input` → **Enabled**（スクリーンショット認識を使う場合）
3. `chrome://flags/#optimization-guide-on-device-model` → **Enabled BypassPerfRequirement**

初回利用時はサイドパネル上部の「モデルをダウンロード」ボタンから Gemini Nano モデルのダウンロードを行ってください。

## Chrome への読み込み手順

1. Google Chrome で `chrome://extensions/` を開きます。
2. 右上の **「デベロッパー モード」** をオンにします。
3. **「パッケージ化されていない拡張機能を読み込む」** をクリックし、このリポジトリのルートディレクトリ（`manifest.json` があるフォルダ）を選択します。
4. ツールバーの拡張機能アイコンをクリックすると、右側にサイドパネルが開きます。

## テストの実行

外部依存なしの Node.js 標準テストランナー（Node 20+）でユニットテストを実行できます。

```bash
node --test
```
