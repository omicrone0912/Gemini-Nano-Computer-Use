export const SYSTEM_PROMPT = `あなたは Google Chrome の画面を操作する自律型ブラウザエージェント（Gemini Nano Computer Use）です。
ユーザーの目標を達成するために、現在の画面状態（スクリーンショットと操作可能な要素一覧）を見て、次の1手だけを JSON で返してください。

【使用可能なアクション】
- click: 要素をクリックする（必須: elementId）
- type: 入力欄に文字を入力する（必須: elementId, text / 任意: clear, submit）
- select: セレクトボックスを選択する（必須: elementId, text）
- press_key: キーを押す（必須: key 例: "Enter", "Tab", "Escape"）
- scroll: 画面をスクロールする（必須: direction: "up" | "down" | "top" | "bottom"）
- navigate: 指定URLへ移動する（必須: url ※http/https のみ）
- go_back: ブラウザの「戻る」を実行
- go_forward: ブラウザの「進む」を実行
- wait: 読み込みやアニメーション完了を待つ（必須: ms: 200〜5000）
- download_page_pdf: 現在のWeb画面をPDFとしてローカル保存し、自動で読み込む（任意: filename）
- read_pdf: 読み込み済みのPDFから指定ページのテキストを取得する（任意: page ※デフォルト1）
- ask_user: ログイン・CAPTCHA・判断に迷う場合にユーザーへ尋ねる（必須: message）
- done: 目標を達成した、またはこれ以上実行できない場合に完了する（必須: message）

【厳守ルール】
1. 出力は必ず JSON オブジェクト1つのみにしてください（前後に説明文を書かない）。
2. click / type / select で指定する elementId は、必ず「操作可能な要素一覧」にある番号だけを使ってください。
3. 画面上に見当たらない情報や操作は、scroll で探すか navigate で移動してください。
4. 同じ失敗や同じ操作を繰り返さないでください。変化がない場合は別の要素やスクロール、URL遷移を試してください。
5. 目標が完了したら、速やかに action: "done" を返し、message に結果の概要を日本語で記述してください。`;

function truncate(str, maxLen) {
  if (typeof str !== 'string') return '';
  if (str.length <= maxLen) return str;
  return `${str.slice(0, maxLen - 1)}…`;
}

function formatElementLine(el) {
  const parts = [`[${el.id}]`, el.tag];
  if (el.role && el.role !== el.tag) {
    parts.push(`role=${el.role}`);
  }
  if (el.inputType) {
    parts.push(`type=${el.inputType}`);
  }
  const label = truncate(el.label || el.placeholder || el.ariaLabel || '', 60);
  if (label) {
    parts.push(`"${label.replace(/"/g, '\\"')}"`);
  }
  if (el.value !== undefined && el.value !== '') {
    const displayVal = el.inputType === 'password' ? '***' : truncate(String(el.value), 36);
    parts.push(`value="${displayVal.replace(/"/g, '\\"')}"`);
  }
  if (el.checked === true) {
    parts.push('checked');
  }
  if (el.disabled) {
    parts.push('disabled');
  }
  if (el.href) {
    parts.push(`href=${truncate(el.href, 64)}`);
  }
  if (Array.isArray(el.options) && el.options.length > 0) {
    const opts = el.options.slice(0, 8).map((o) => `${o.text}(${o.value})`).join(', ');
    parts.push(`options=[${opts}]`);
  }
  return parts.join(' ');
}

function formatHistory(history) {
  if (!Array.isArray(history) || history.length === 0) {
    return '（まだ操作履歴はありません）';
  }
  const recent = history.slice(-6);
  return recent
    .map((item) => {
      const a = item.action ?? {};
      const detailParts = [a.action];
      if (a.elementId) detailParts.push(`#${a.elementId}`);
      if (a.text !== undefined) detailParts.push(`text="${truncate(a.text, 24)}"`);
      if (a.url) detailParts.push(`url=${truncate(a.url, 48)}`);
      if (a.direction) detailParts.push(a.direction);
      if (a.key) detailParts.push(a.key);
      if (a.page) detailParts.push(`page=${a.page}`);
      const status = item.result?.ok
        ? item.result?.promptNote
          ? `成功(${truncate(item.result.promptNote, 240)})`
          : '成功'
        : `失敗(${item.result?.error || 'error'})`;
      return `- Step ${item.step}: ${detailParts.join(' ')} -> ${status}`;
    })
    .join('\n');
}

/**
 * Build a concise prompt for Gemini Nano's limited context window.
 */
export function buildStepPrompt({
  goal,
  snapshot,
  history = [],
  stepIndex = 1,
  maxSteps = 15,
  hasImage = false,
  loopWarning = '',
  pdfContext = null
}) {
  const sections = [];
  sections.push(`# 目標\n${goal}`);
  sections.push(`# 進行状況\nステップ ${stepIndex} / ${maxSteps}`);

  if (snapshot?.restricted) {
    sections.push(
      `# 現在のページ\nURL: ${snapshot.url || '(不明)'}\nタイトル: ${snapshot.title || '(制限ページ)'}\n※ このページは Chrome の保護領域（chrome:// や拡張機能ストア等）のため、ページ内の DOM 取得やクリック操作ができません。目的の Web サイトがある場合は "navigate" アクションで http/https URL へ移動してください。`
    );
  } else {
    const scrollInfo = snapshot?.scroll
      ? `scrollY=${Math.round(snapshot.scroll.y)} / max=${Math.round(snapshot.scroll.maxY)}`
      : '';
    sections.push(
      `# 現在のページ\nURL: ${snapshot?.url || '(不明)'}\nタイトル: ${truncate(snapshot?.title || '', 120)}${scrollInfo ? `\nスクロール: ${scrollInfo}` : ''}`
    );

    if (hasImage) {
      sections.push(
        '# 画面画像について\n添付されたスクリーンショットの赤枠番号バッジ [1], [2], ... は、下記の操作可能な要素一覧の [ID] と1対1で対応しています。'
      );
    }

    const elements = Array.isArray(snapshot?.elements) ? snapshot.elements.slice(0, 60) : [];
    if (elements.length > 0) {
      sections.push(`# 操作可能な要素一覧 (${elements.length}件)\n${elements.map(formatElementLine).join('\n')}`);
    } else {
      sections.push('# 操作可能な要素一覧\n（現在表示領域に操作可能な要素が見つかりませんでした。scroll または navigate を検討してください）');
    }

    const textExcerpt = truncate((snapshot?.textExcerpt || '').trim(), 1200);
    if (textExcerpt) {
      sections.push(`# ページの抜粋テキスト\n${textExcerpt}`);
    }
  }

  sections.push(`# 直近の操作履歴\n${formatHistory(history)}`);

  if (pdfContext && pdfContext.pageCount > 0) {
    const snippet = truncate(pdfContext.currentPageText || '', 1400);
    sections.push(
      `# 読み込み中の PDF\nファイル名: ${pdfContext.filename || '(名称未設定.pdf)'}\nページ: ${pdfContext.currentPage || 1} / ${pdfContext.pageCount}\n${
        snippet ? `現在ページ抜粋:\n${snippet}` : '（テキストを抽出できないスキャン/画像中心の PDF です。他ページを確認する場合は read_pdf を使ってください）'
      }`
    );
  }

  if (loopWarning) {
    sections.push(`# 注意\n${loopWarning}`);
  }

  sections.push('# 指示\n次の1手のみを JSON オブジェクトで出力してください。');
  return sections.join('\n\n');
}
