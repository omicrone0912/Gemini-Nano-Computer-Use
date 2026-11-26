export const PLAYBOOK_TEMPLATE_FILENAME = 'gemini-nano-playbook-template.md';
export const PLAYBOOK_DOCX_TEMPLATE_FILENAME = 'gemini-nano-playbook-template.docx';
export const PLAYBOOK_CONVERTER_SKILL_FILENAME = 'SKILL.md';

export const PLAYBOOK_CONVERTER_SKILL_MARKDOWN = `---
name: gemini-nano-playbook-converter
description: 既存の未整形な手順書（Word / PDF / Excel / PowerPoint / テキスト / スクリーンショット付き資料）を、Chrome拡張機能「Gemini Nano Computer Use」が厳格手順書モードで正確に読み取り・自律実行できる構造化 Markdown 手順書へ変換するスキル。
---

# Gemini Nano 用 手順書構造化スキル

あなたは業務手順書（SOP）の構造化スペシャリストです。
ユーザーから渡された未整形の手順書（メモ・チャットログ・社内Wiki・PDF・Word/Excel/PowerPoint・スクリーンショット画像など）を読み取り、**Chrome 拡張機能「Gemini Nano Computer Use」がそのまま読み込んで自律実行できる構造化 Markdown 手順書**へ変換してください。

## 1. Gemini Nano 向けに最適化するための絶対ルール

1. **コンテキスト長の上限を守る（最重要）**
   - 変換後の手順書全体は **800〜1,800文字目安、最大2,000文字以内** に収めてください（拡張機能はプロンプト構築時に約2,200文字を超えると末尾を省略します）。
   - 前置き・挨拶・冗長な背景説明は省き、ブラウザ操作に必要な情報だけを簡潔かつ具体的に残してください。

2. **1ステップ = 1操作（原子分解）**
   - 1つの番号付きステップに複数操作を詰め込まないでください。
   - 悪い例: \`1. ログイン画面を開いてIDとパスワードを入力し、ログインボタンを押す。\`
   - 良い例:
     - \`1. [navigate] https://example.com/login へ移動する。\`
     - \`2. [type] メールアドレス入力欄にユーザー指定のIDを入力する。\`
     - \`3. [ask_user] パスワード入力または2段階認証が必要なため、ユーザーに入力・確認を依頼する。\`

3. **厳格手順書モード（推測・捏造の禁止）**
   - 元の手順書に記載がない URL・ID/パスワード・金額・選択肢・画面要素名をAIが勝手に捏造しないでください。
   - ログイン・2FA・CAPTCHA、送信・購入・削除・承認などの不可逆操作、入力値が動的に変わる箇所、画面が想定と異なる場合は、必ず \`[ask_user]\` を指定してください。

4. **スクリーンショット・Office/PDF 添付画像の活用**
   - 元資料にスクリーンショットが含まれる場合、画像内の**ボタン名・リンク文言・入力欄ラベル・タブ名**を正確に読み取り、ステップ文言へそのまま転記してください。
   - 画像とステップの対応関係がある場合は、該当ステップ末尾に \`[参考画像: ログイン画面]\` のように記載してください（Word \`.docx\` 運用時、画像付近のステップ番号 \`1.\`, \`2.\` と紐付きます）。

5. **条件分岐の記述方法**
   - 分岐がある場合は、曖昧な表現を避け \`IF（条件）: YES → ○○ / NO → △△\` の形式で明記してください。

## 2. 使用可能なアクションタグ一覧（16種類）

各ステップの先頭には、必ず次のいずれか1つのアクションタグを \`[タグ名]\` 形式で付与してください。

- \`[navigate]\`: 指定 URL（\`http://\` または \`https://\`）へ移動する
- \`[click]\`: ボタン・リンク・タブ・メニュー等をクリックする
- \`[type]\`: テキスト入力欄へ文字を入力する（送信キーの有無も明記）
- \`[select]\`: ドロップダウン（\`<select>\`）から項目を選択する
- \`[press_key]\`: キーを押下する（例: \`Enter\`, \`Tab\`, \`Escape\`）
- \`[scroll]\`: 画面をスクロールする（方向 \`up\` / \`down\` / \`top\` / \`bottom\` を明記）
- \`[wait]\`: 画面遷移や描画完了を待機する（例: \`1000ms\`）
- \`[go_back]\`: ブラウザの「戻る」を実行する
- \`[go_forward]\`: ブラウザの「進む」を実行する
- \`[open_tab]\`: 作業用タブグループ内に新しいタブを開く
- \`[switch_tab]\`: 作業用タブグループ内の別タブへ切り替える
- \`[close_tab]\`: 作業用タブを閉じる
- \`[download_page_pdf]\`: 現在の Web 画面を PDF として保存・自動読込する
- \`[read_pdf]\`: 読み込み済み PDF の指定ページ内容を確認する
- \`[ask_user]\`: 判断に迷う場合・認証・送信/購入/削除の確認・値不明時に人間に指示を仰ぐ
- \`[done]\`: 完了条件を満たしたことを確認し、結果を報告して終了する

## 3. 出力テンプレート（見出し名・形式を厳守）

拡張機能のパーサーが正しくセクションを抽出できるよう、**必ず以下の見出し構造**で出力してください。

\`\`\`markdown
# 手順書タイトル: （処理内容がひと目でわかる簡潔なタイトル）

## 目的
（この手順で達成したいゴールを1〜2文で簡潔に記述）

## 開始URL
https://example.com/start

## 前提条件・実行ルール（必守）
- AI は必ずこの手順書に記載された順序・操作・条件の通りに実行する。手順書にない独自判断や推測操作は行わない。
- 手順書に書かれていない状況・見つからない要素・参考画像と異なる画面・不明点が出た場合は、必ず [ask_user] で人間に指示を仰ぐ。
- 実行前にユーザー確認が必要な操作（ログイン・送信・購入・削除・承認）は勝手に確定せず [ask_user] で確認する。

## 実行ステップ
1. [navigate] 開始URL（https://example.com/start）へ移動する。
2. [wait] 画面読み込み完了まで 1000ms 待機する。
3. [click] 「検索」または対象メニューをクリックする。
4. IF（エラーメッセージまたはログイン画面が表示されている場合）: YES → [ask_user] ユーザーへ対応を仰ぐ / NO → 次のステップへ進む。
5. [type] 入力欄「キーワード」に対象文字列を入力する。
6. [done] 完了条件を満たしたことを確認し、結果を日本語で報告する。

## 確認ポイント（完了条件）
- 目的の画面または結果が表示され、必要な情報が取得できていること。

## 例外時の対応
- 目的の要素が画面内に見つからない場合は、最大2回まで [scroll] で上下を確認し、見つからなければ [ask_user] で確認する。
- 参考画像と画面構成が異なる場合やエラー表示が出た場合は、[ask_user] で人間に指示を仰ぐ。

## 出力形式（完了メッセージ）
- 実行結果:
- 取得した情報・確認事項:
\`\`\`

## 4. 変換時の出力ルール

1. 変換結果の手順書本体は、そのまま \`.md\` 保存や Word（\`.docx\`）へ貼り付けられるよう **1つの \`\`\`markdown コードブロック内** に出力してください。
2. 元手順書に URL 不足・入力値未確定・曖昧な表現があった場合は、コードブロックの**外側**に \`### 変換メモ（確認推奨点）\` を設け、人間が確認・補完すべき箇所を箇条書きで提示してください。

## 5. 変換例（Before → After）

### Before（未整形の手順メモ）
> 毎週月曜日に社内ポータル開いて「売上」で検索して今月の売上一覧ページを開いてPDF保存する。もしログアウトされてたら自分で入らないで人に聞くこと。

### After（構造化出力）
\`\`\`markdown
# 手順書タイトル: 社内ポータル今月売上一覧のPDF保存

## 目的
社内ポータルで「売上」を検索して今月の売上一覧ページを開き、画面を PDF として保存・確認する。

## 開始URL
https://portal.example.com

## 前提条件・実行ルール（必守）
- AI は必ずこの手順書に記載された順序・操作・条件の通りに実行する。
- ログアウト状態または不明点がある場合は、推測で進めず必ず [ask_user] で人間に指示を仰ぐ。

## 実行ステップ
1. [navigate] 開始URL（https://portal.example.com）へ移動する。
2. IF（ログイン画面または「ログイン」ボタンが表示されている場合）: YES → [ask_user] ログアウト状態のため手動ログインを依頼する / NO → 次のステップへ進む。
3. [type] 検索入力欄に「売上」と入力する。
4. [press_key] Enter キーを押下して検索を実行する。
5. [click] 検索結果から「今月の売上一覧」リンクをクリックする。
6. [wait] 一覧ページの表示完了まで 1000ms 待機する。
7. [download_page_pdf] 現在の売上一覧画面を PDF として保存・自動読込する。
8. [done] PDF 保存の完了と対象期間を確認し、結果を日本語で報告する。

## 確認ポイント（完了条件）
- 今月の売上一覧ページが開かれていること。
- 売上一覧画面の PDF 保存が完了していること。

## 例外時の対応
- 一覧リンクが見つからない場合は [scroll] で探索し、見つからなければ [ask_user] で指示を仰ぐ。

## 出力形式（完了メッセージ）
- 確認したページタイトル:
- 保存した PDF ファイル名:
\`\`\`
`;

export const PLAYBOOK_TEMPLATE_MARKDOWN = `# 手順書タイトル: （例）対象サイトの情報確認とPDF保存

## 目的
この手順書で達成したい最終ゴールを1〜2文で簡潔に書きます。
例: 対象ページを開いて指定キーワードを検索し、上位結果の要点をまとめたうえで画面をPDF保存する。

## 開始URL
https://example.com

## 前提条件・実行ルール（必守）
- AI は必ずこの手順書に記載された順序・操作・条件の通りに実行する。手順書にない独自判断や推測操作は行わない。
- 手順書に書かれていない状況・見つからない要素・参考画像と異なる画面・不明点が出た場合は、必ず [ask_user] で人間に指示を仰ぐ。
- 実行前にユーザー確認が必要な操作（購入・送信・削除・パスワード入力）は勝手に確定せず停止または確認する。
- 複数タブを使う場合は作業用タブグループ内で操作する。

## 実行ステップ
1. [navigate] 開始URL（https://example.com）へ移動する。
2. [type] 検索入力欄を見つけて「検索キーワード」を入力し、必要に応じて送信する。
3. [click] 目的のリンクまたは検索結果をクリックして詳細ページを開く。
4. [wait] ページの読み込み完了まで 1000ms 待機する。
5. [download_page_pdf] 現在の画面を PDF としてダウンロードし、内容を自動読み込みする。
6. [done] 確認ポイントを満たしたことを確認し、結果を日本語で要約して完了する。

## 確認ポイント（完了条件）
- 目的のページが表示され、必要な情報（タイトル・本文の要点）が取得できていること。
- 必要な場合は PDF 保存が完了していること。

## 例外時の対応
- 目的の要素が画面内に見つからない場合は、最大2回まで [scroll] で探索する。
- ログイン画面や CAPTCHA が出現した場合は、[ask_user] でユーザーへ操作を引き継ぐ。

## 出力形式（完了メッセージ）
- ページタイトル:
- 取得した要点（箇条書き3点以内）:
- 保存したファイル名（ある場合）:
`;

function extractSection(markdown, headingKeywords) {
  const lines = markdown.split(/\r?\n/);
  let collecting = false;
  const collected = [];

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,3})\s+(.+)$/);
    if (headingMatch) {
      if (collecting) break;
      const level = headingMatch[1].length;
      const heading = headingMatch[2].trim();
      if (level >= 2 && headingKeywords.some((kw) => heading.includes(kw))) {
        collecting = true;
      }
      continue;
    }
    if (collecting) {
      collected.push(line);
    }
  }
  return collected.join('\n').trim();
}

function normalizeJsonPlaybook(parsedJson, filename) {
  if (!parsedJson || typeof parsedJson !== 'object' || Array.isArray(parsedJson)) {
    throw new Error('JSON 手順書はオブジェクト形式である必要があります。');
  }

  const lines = [];
  const title = parsedJson.title || parsedJson.name || filename;
  lines.push(`# 手順書タイトル: ${title}`);

  if (parsedJson.goal || parsedJson.objective || parsedJson.description) {
    lines.push('', '## 目的', String(parsedJson.goal || parsedJson.objective || parsedJson.description));
  }

  if (parsedJson.startUrl || parsedJson.url) {
    lines.push('', '## 開始URL', String(parsedJson.startUrl || parsedJson.url));
  }

  if (Array.isArray(parsedJson.rules) && parsedJson.rules.length > 0) {
    lines.push('', '## 前提条件・実行ルール');
    for (const rule of parsedJson.rules) {
      lines.push(`- ${String(rule)}`);
    }
  }

  if (Array.isArray(parsedJson.steps) && parsedJson.steps.length > 0) {
    lines.push('', '## 実行ステップ');
    parsedJson.steps.forEach((step, idx) => {
      if (typeof step === 'string') {
        lines.push(`${idx + 1}. ${step}`);
      } else if (step && typeof step === 'object') {
        const actionTag = step.action ? `[${step.action}] ` : '';
        const desc = step.description || step.instruction || step.text || JSON.stringify(step);
        lines.push(`${idx + 1}. ${actionTag}${desc}`);
      }
    });
  }

  if (Array.isArray(parsedJson.completionCriteria) && parsedJson.completionCriteria.length > 0) {
    lines.push('', '## 確認ポイント（完了条件）');
    for (const c of parsedJson.completionCriteria) {
      lines.push(`- ${String(c)}`);
    }
  }

  return lines.join('\n').trim();
}

/**
 * Parse Markdown / plain text / JSON / extracted PDF or Office text into a normalized playbook object.
 */
export function parsePlaybookContent(rawInput, filename = 'playbook.md', { images = [] } = {}) {
  const raw = String(rawInput ?? '').trim();
  if (!raw) {
    throw new Error('手順書の内容が空です。文字が含まれるファイルを指定してください。');
  }

  let normalizedText = raw;
  const lowerName = String(filename || '').toLowerCase();

  if (lowerName.endsWith('.json') || (raw.startsWith('{') && raw.endsWith('}'))) {
    try {
      const parsedJson = JSON.parse(raw);
      normalizedText = normalizeJsonPlaybook(parsedJson, filename);
    } catch (error) {
      if (lowerName.endsWith('.json')) {
        throw new Error(`JSON 手順書のパースに失敗しました: ${error.message}`);
      }
    }
  }

  const lines = normalizedText.split(/\r?\n/);
  let title = '';
  for (const line of lines) {
    const h1 = line.match(/^#\s+(.+)$/);
    if (h1) {
      title = h1[1].replace(/^手順書タイトル[:：]\s*/, '').trim();
      break;
    }
  }
  if (!title) {
    title = String(filename || '手順書').replace(/\.[^.]+$/, '');
  }

  const goalSection = extractSection(normalizedText, ['目的', 'ゴール', 'Goal', 'Objective']);
  const startUrlSection = extractSection(normalizedText, ['開始URL', '対象URL', 'URL', 'Start']);
  const startUrlMatch = startUrlSection.match(/https?:\/\/[^\s)>\]]+/i);
  const startUrl = startUrlMatch ? startUrlMatch[0] : '';

  const stepsSection = extractSection(normalizedText, ['実行ステップ', '手順', 'ステップ', 'Steps']);
  const stepSource = stepsSection || normalizedText;
  const steps = stepSource
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^(?:\d+[.)]|[-*])\s+/.test(l))
    .map((l) => l.replace(/^(?:\d+[.)]|[-*])\s+/, '').trim());

  const normalizedImages = Array.isArray(images)
    ? images.map((img, idx) => ({
        index: img.index ?? idx + 1,
        name: img.name || `image-${idx + 1}.png`,
        mimeType: img.mimeType || 'image/png',
        dataUrl: img.dataUrl,
        byteLength: img.byteLength || 0,
        stepHint: img.stepHint || ''
      }))
    : [];

  return {
    filename: String(filename || 'playbook.md'),
    title,
    goal: goalSection || '',
    startUrl,
    steps,
    images: normalizedImages,
    strictMode: true,
    rawText: normalizedText,
    charCount: normalizedText.length
  };
}

/**
 * Select up to `maxImages` reference screenshots from the playbook relevant to `stepIndex`.
 */
export function selectRelevantPlaybookImages(playbook, stepIndex = 1, maxImages = 2) {
  const images = Array.isArray(playbook?.images) ? playbook.images : [];
  if (images.length === 0 || maxImages <= 0) return [];
  if (images.length <= maxImages) return images;

  const stepTokenRe = new RegExp(`(?:^|\\b|step\\s*)${stepIndex}(?:[.)\\s:]|$)`, 'i');
  const matched = images.filter((img) => stepTokenRe.test(img.stepHint || ''));
  if (matched.length >= maxImages) {
    return matched.slice(0, maxImages);
  }

  const chosen = [...matched];
  for (const img of images) {
    if (chosen.length >= maxImages) break;
    if (!chosen.includes(img)) {
      chosen.push(img);
    }
  }
  return chosen;
}

/**
 * Format a loaded playbook concisely for Gemini Nano's prompt context.
 */
export function formatPlaybookForPrompt(playbook, maxChars = 2400) {
  if (!playbook || !playbook.rawText) {
    return '';
  }
  const text = String(playbook.rawText).trim();
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars - 16)}\n…（以降省略）`;
}
