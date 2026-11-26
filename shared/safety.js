const BLOCKED_SCHEMES = ['javascript:', 'data:', 'file:', 'chrome:', 'chrome-extension:', 'about:', 'vbscript:'];

const SENSITIVE_KEYWORDS = [
  '購入',
  '決済',
  '注文',
  '確定',
  '支払',
  '申し込',
  '申込',
  '送信',
  '削除',
  '消去',
  '退会',
  '解約',
  '破棄',
  'buy',
  'purchase',
  'checkout',
  'place order',
  'confirm order',
  'pay now',
  'pay',
  'delete',
  'remove',
  'unsubscribe',
  'cancel subscription',
  'submit',
  'send'
];

/**
 * Validate and normalize navigation URLs.
 * Only http:// and https:// are permitted.
 */
export function validateNavigationUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
    return { valid: false, reason: 'URL が空です。' };
  }

  const trimmed = rawUrl.trim();
  const lower = trimmed.toLowerCase();

  for (const scheme of BLOCKED_SCHEMES) {
    if (lower.startsWith(scheme)) {
      return {
        valid: false,
        reason: `セキュリティ保護のため "${scheme}" スキームへの遷移はブロックされています。`
      };
    }
  }

  let candidate = trimmed;
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(candidate)) {
    if (/^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}(?:[/:?#].*)?$/.test(candidate)) {
      candidate = `https://${candidate}`;
    } else {
      return { valid: false, reason: '有効な http/https URL ではありません。' };
    }
  }

  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return {
        valid: false,
        reason: `許可されていないプロトコル (${parsed.protocol}) です。http/https のみ許可されます。`
      };
    }
    return { valid: true, url: parsed.toString() };
  } catch {
    return { valid: false, reason: 'URL の形式が不正です。' };
  }
}

function findElementById(snapshot, elementId) {
  if (!snapshot || !Array.isArray(snapshot.elements) || !elementId) {
    return null;
  }
  return snapshot.elements.find((el) => el.id === elementId) ?? null;
}

function buildElementTextSummary(element) {
  if (!element) return '';
  return [
    element.label,
    element.placeholder,
    element.ariaLabel,
    element.value,
    element.href
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

/**
 * Assess risk level of a planned action before executing it.
 * Returns { level: 'blocked' | 'confirm' | 'safe', reason: string, normalizedUrl?: string }
 */
export function assessActionRisk(action, snapshot, options = {}) {
  if (!action || typeof action !== 'object') {
    return { level: 'blocked', reason: '無効なアクションです。' };
  }

  if (
    options.allowMultiTab === false &&
    (action.action === 'open_tab' || action.action === 'switch_tab' || action.action === 'close_tab')
  ) {
    return {
      level: 'blocked',
      reason: '複数タブでの作業が許可されていないため、タブ操作はブロックされました。'
    };
  }

  if (action.action === 'navigate' || action.action === 'open_tab') {
    const check = validateNavigationUrl(action.url);
    if (!check.valid) {
      return { level: 'blocked', reason: check.reason };
    }
    return { level: 'safe', reason: '', normalizedUrl: check.url };
  }

  const target = findElementById(snapshot, action.elementId);

  if (action.action === 'type') {
    if (target?.inputType === 'password') {
      return {
        level: 'confirm',
        reason: 'パスワード入力欄への入力操作です。誤入力や意図しないアカウント操作を防ぐため確認が必要です。'
      };
    }
    if (action.submit) {
      return {
        level: 'confirm',
        reason: '入力と同時にフォーム送信 (submit: true) を実行しようとしています。'
      };
    }
  }

  if (action.action === 'click' && target) {
    const combined = buildElementTextSummary(target);
    const matchedKeyword = SENSITIVE_KEYWORDS.find((kw) => combined.includes(kw));
    const isSubmitButton = target.tag === 'button' && target.inputType === 'submit';

    if (matchedKeyword || isSubmitButton) {
      const label = target.label || target.placeholder || `#${target.id}`;
      return {
        level: 'confirm',
        reason: `「${label}」のクリックは送信・購入・削除などの重要な確定操作の可能性があるため確認が必要です。`
      };
    }
  }

  return { level: 'safe', reason: '' };
}

export function getActionSignature(action) {
  if (!action) return '';
  return JSON.stringify({
    action: action.action,
    elementId: action.elementId ?? null,
    text: action.text ?? null,
    key: action.key ?? null,
    direction: action.direction ?? null,
    url: action.url ?? null,
    tabIndex: action.tabIndex ?? null
  });
}

/**
 * Detect if the same action is repeating consecutively in recent history.
 */
export function detectActionLoop(history, nextAction, threshold = 3) {
  if (!Array.isArray(history) || history.length < threshold - 1 || !nextAction) {
    return false;
  }
  const targetSig = getActionSignature(nextAction);
  let consecutive = 1;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const item = history[i];
    if (getActionSignature(item?.action) === targetSig) {
      consecutive += 1;
      if (consecutive >= threshold) {
        return true;
      }
    } else {
      break;
    }
  }
  return false;
}
