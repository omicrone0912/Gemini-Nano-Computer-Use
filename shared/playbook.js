export const PLAYBOOK_TEMPLATE_FILENAME = 'gemini-nano-playbook-template.md';

export const PLAYBOOK_TEMPLATE_MARKDOWN = `# 手順書タイトル: （例）対象サイトの情報確認とPDF保存

## 目的
この手順書で達成したい最終ゴールを1〜2文で簡潔に書きます。
例: 対象ページを開いて指定キーワードを検索し、上位結果の要点をまとめたうえで画面をPDF保存する。

## 開始URL
https://example.com

## 前提条件・実行ルール
- 実行前にユーザー確認が必要な操作（購入・送信・削除・パスワード入力）は勝手に確定せず停止または確認する。
- 画面が切り替わらない場合は [wait] で待機するか [scroll] で要素を探す。
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
 * Parse Markdown / plain text / JSON / extracted PDF text into a normalized playbook object.
 */
export function parsePlaybookContent(rawInput, filename = 'playbook.md') {
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

  return {
    filename: String(filename || 'playbook.md'),
    title,
    goal: goalSection || '',
    startUrl,
    steps,
    rawText: normalizedText,
    charCount: normalizedText.length
  };
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
