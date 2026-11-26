import { ACTION_TYPES } from './constants.js';

/**
 * Flat JSON Schema for Chrome Prompt API `responseConstraint`.
 * Avoids `oneOf`/`anyOf` for reliable constrained decoding in Gemini Nano.
 */
export const ACTION_RESPONSE_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    thought: {
      type: 'string',
      description: '現在の画面状況の認識と、次にこの操作を選ぶ簡潔な理由（日本語）'
    },
    action: {
      type: 'string',
      enum: [...ACTION_TYPES],
      description: '次に実行するアクション種別'
    },
    elementId: {
      type: 'integer',
      description: 'click / type / select で操作対象にする要素番号ID'
    },
    text: {
      type: 'string',
      description: 'type で入力する文字列、または select で選択する選択肢の値/表示ラベル'
    },
    key: {
      type: 'string',
      description: 'press_key で押すキー名（例: Enter, Tab, Escape, ArrowDown）'
    },
    direction: {
      type: 'string',
      enum: ['up', 'down', 'top', 'bottom'],
      description: 'scroll の方向'
    },
    url: {
      type: 'string',
      description: 'navigate で遷移する http/https URL'
    },
    ms: {
      type: 'integer',
      description: 'wait の待機時間（ミリ秒: 200〜5000）'
    },
    submit: {
      type: 'boolean',
      description: 'type 実行後に Enter / 送信を行うかどうか'
    },
    clear: {
      type: 'boolean',
      description: 'type 実行前に既存の入力値を消去するかどうか'
    },
    message: {
      type: 'string',
      description: 'done または ask_user 時にユーザーへ伝えるメッセージ'
    }
  },
  required: ['thought', 'action']
});

const ACTION_ALIASES = Object.freeze({
  input: 'type',
  fill: 'type',
  write: 'type',
  enter_text: 'type',
  goto: 'navigate',
  open: 'navigate',
  open_url: 'navigate',
  back: 'go_back',
  forward: 'go_forward',
  finish: 'done',
  complete: 'done',
  stop: 'done',
  key: 'press_key',
  keypress: 'press_key',
  press: 'press_key',
  ask: 'ask_user'
});

const VALID_DIRECTIONS = new Set(['up', 'down', 'top', 'bottom']);

/**
 * Extract the outermost JSON object from raw model output,
 * stripping markdown fences or stray prefix/suffix commentary.
 */
export function extractJsonObjectString(rawText) {
  if (typeof rawText !== 'string') {
    throw new Error('モデル出力が文字列ではありません。');
  }

  let trimmed = rawText.trim();
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch && fenceMatch[1]) {
    trimmed = fenceMatch[1].trim();
  }

  const startIndex = trimmed.indexOf('{');
  if (startIndex === -1) {
    throw new Error('JSON オブジェクトが見つかりませんでした。');
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = startIndex; i < trimmed.length; i += 1) {
    const ch = trimmed[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return trimmed.slice(startIndex, i + 1);
      }
    }
  }

  throw new Error('JSON オブジェクトの終端が閉じていません。');
}

function toOptionalPositiveInt(value) {
  if (value === null || value === undefined || value === '') {
    return undefined;
  }
  const num = typeof value === 'number' ? value : Number(String(value).replace(/^#/, '').trim());
  if (!Number.isFinite(num) || num <= 0) {
    return undefined;
  }
  return Math.trunc(num);
}

/**
 * Parse and validate an action object returned by Gemini Nano.
 */
export function parseActionResponse(rawText) {
  const jsonText = extractJsonObjectString(rawText);
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (error) {
    throw new Error(`JSON のパースに失敗しました: ${error.message}`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('アクション出力は JSON オブジェクトである必要があります。');
  }

  const rawAction = String(parsed.action ?? '').trim().toLowerCase();
  const normalizedAction = ACTION_ALIASES[rawAction] ?? rawAction;

  if (!ACTION_TYPES.includes(normalizedAction)) {
    throw new Error(`未対応のアクション種別です: "${rawAction || '(empty)'}"`);
  }

  const thought =
    typeof parsed.thought === 'string' && parsed.thought.trim()
      ? parsed.thought.trim()
      : `${normalizedAction} を実行します。`;

  const action = {
    thought,
    action: normalizedAction
  };

  const elementId = toOptionalPositiveInt(parsed.elementId ?? parsed.element_id ?? parsed.id);
  if (elementId !== undefined) {
    action.elementId = elementId;
  }

  if (parsed.text !== undefined && parsed.text !== null) {
    action.text = String(parsed.text);
  }

  if (parsed.key !== undefined && parsed.key !== null && String(parsed.key).trim()) {
    action.key = String(parsed.key).trim();
  }

  if (parsed.direction !== undefined && parsed.direction !== null) {
    const dir = String(parsed.direction).trim().toLowerCase();
    action.direction = VALID_DIRECTIONS.has(dir) ? dir : 'down';
  }

  if (parsed.url !== undefined && parsed.url !== null && String(parsed.url).trim()) {
    action.url = String(parsed.url).trim();
  }

  if (parsed.ms !== undefined && parsed.ms !== null) {
    const msNum = Number(parsed.ms);
    if (Number.isFinite(msNum)) {
      action.ms = Math.min(5000, Math.max(200, Math.round(msNum)));
    }
  }

  if (typeof parsed.submit === 'boolean') {
    action.submit = parsed.submit;
  }

  if (typeof parsed.clear === 'boolean') {
    action.clear = parsed.clear;
  } else if (normalizedAction === 'type') {
    action.clear = true;
  }

  if (parsed.message !== undefined && parsed.message !== null && String(parsed.message).trim()) {
    action.message = String(parsed.message).trim();
  }

  // Action-specific required fields & sensible defaults
  switch (normalizedAction) {
    case 'click':
      if (!action.elementId) {
        throw new Error('click アクションには正の整数 elementId が必要です。');
      }
      break;
    case 'type':
      if (!action.elementId) {
        throw new Error('type アクションには正の整数 elementId が必要です。');
      }
      if (action.text === undefined) {
        throw new Error('type アクションには text が必要です。');
      }
      break;
    case 'select':
      if (!action.elementId) {
        throw new Error('select アクションには正の整数 elementId が必要です。');
      }
      if (action.text === undefined || !action.text.trim()) {
        throw new Error('select アクションには選択肢の text が必要です。');
      }
      break;
    case 'press_key':
      if (!action.key) {
        action.key = 'Enter';
      }
      break;
    case 'scroll':
      if (!action.direction) {
        action.direction = 'down';
      }
      break;
    case 'navigate':
      if (!action.url) {
        throw new Error('navigate アクションには url が必要です。');
      }
      break;
    case 'wait':
      if (!action.ms) {
        action.ms = 1000;
      }
      break;
    case 'done':
      if (!action.message) {
        action.message = action.thought;
      }
      break;
    case 'ask_user':
      if (!action.message) {
        action.message = 'ユーザーの確認または追加指示が必要です。';
      }
      break;
    default:
      break;
  }

  return action;
}
