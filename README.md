# Gemini Nano Computer Use (Chrome Extension)

Google Chrome に内蔵されたローカル AI モデル **Gemini Nano**（Built-in AI / Prompt API `LanguageModel`）を使って、現在開いているタブの画面を認識・自律操作する **Computer Use** Chrome 拡張機能です。

外部 API キーやクラウドサーバーへの送信を行わず、ブラウザ単体で **Observe → Think → Guard → Act** のループを実行します。

## 主な特徴

- **完全ローカル推論（Gemini Nano / Prompt API）**
  - `LanguageModel` API（マルチモーダル対応時はスクリーンショット画像＋DOM、非対応環境では DOM テキストのみへ自動フォールバック）を利用します。
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

## ディレクトリ構成

```text
├── manifest.json                 # Manifest V3 定義
├── package.json                  # ES Modules & node --test 設定
├── background/
│   └── service-worker.js         # Side Panel 制御・タブ撮影・スクリプト注入・ナビゲーション
├── content/
│   └── dom-inspector.js          # 可視要素収集・クリック/入力/スクロール実行・視覚ハイライト
├── sidepanel/
│   ├── sidepanel.html            # サイドパネル UI
│   ├── sidepanel.css             # スタイル（ライト/ダークモード対応）
│   ├── sidepanel.js              # UI 制御とエージェント統合
│   └── annotator.js              # Set-of-Mark 番号バッジ描画
├── shared/
│   ├── constants.js              # アクション定義・デフォルト設定・Chrome フラグ情報
│   ├── action-schema.js          # JSON Schema 定義 & アクションパーサー
│   ├── safety.js                 # URL 検証・危険操作検出・ループ検出
│   ├── prompt-builder.js         # システム/ステッププロンプト生成
│   ├── nano-client.js            # Chrome Prompt API (Gemini Nano) ラッパー
│   └── agent-controller.js       # Observe -> Think -> Guard -> Act 制御ループ
├── scripts/
│   └── generate-icons.mjs        # 拡張機能 PNG アイコン生成スクリプト
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
