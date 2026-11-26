export const ACTION_TYPES = Object.freeze([
  'click',
  'type',
  'select',
  'press_key',
  'scroll',
  'navigate',
  'go_back',
  'go_forward',
  'wait',
  'done',
  'ask_user'
]);

export const EXECUTION_MODES = Object.freeze({
  AUTO_SAFE: 'auto_safe',
  STEP_BY_STEP: 'step_by_step'
});

export const DEFAULT_SETTINGS = Object.freeze({
  maxSteps: 15,
  executionMode: EXECUTION_MODES.AUTO_SAFE,
  useVision: true,
  maxElements: 60,
  maxImageWidth: 768,
  actionDelayMs: 650
});

export const CHROME_AI_FLAGS = Object.freeze([
  {
    name: 'Prompt API for Gemini Nano',
    url: 'chrome://flags/#prompt-api-for-gemini-nano',
    recommended: 'Enabled'
  },
  {
    name: 'Prompt API for Gemini Nano with Multimodal Input',
    url: 'chrome://flags/#prompt-api-for-gemini-nano-with-multimodal-input',
    recommended: 'Enabled'
  },
  {
    name: 'Enables optimization guide on device',
    url: 'chrome://flags/#optimization-guide-on-device-model',
    recommended: 'Enabled BypassPerfRequirement'
  }
]);

export const SAMPLE_TASKS = Object.freeze([
  {
    label: 'Wikipediaで検索',
    goal: 'https://ja.wikipedia.org を開いて「生成AI」を検索し、記事の概要を確認したら完了してください。'
  },
  {
    label: 'ページ要約・確認',
    goal: '現在開いているページの内容と主要な操作要素を確認し、何が書かれているか日本語でまとめて完了してください。'
  },
  {
    label: 'ページ下部へスクロール',
    goal: '現在のページを下方向にスクロールしてフッター付近のリンク一覧を確認し、内容を報告して完了してください。'
  }
]);

export const MSG_TYPES = Object.freeze({
  PING: 'NANO_CU_PING',
  CAPTURE_SNAPSHOT: 'NANO_CU_CAPTURE_SNAPSHOT',
  EXECUTE_DOM_ACTION: 'NANO_CU_EXECUTE_DOM_ACTION',
  ENSURE_CONTENT_SCRIPT: 'NANO_CU_ENSURE_CONTENT_SCRIPT',
  CAPTURE_TAB: 'NANO_CU_CAPTURE_TAB',
  NAVIGATE_TAB: 'NANO_CU_NAVIGATE_TAB',
  HISTORY_BACK: 'NANO_CU_HISTORY_BACK',
  HISTORY_FORWARD: 'NANO_CU_HISTORY_FORWARD'
});
