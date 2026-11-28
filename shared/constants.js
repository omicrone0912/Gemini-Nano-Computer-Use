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
  'open_tab',
  'switch_tab',
  'close_tab',
  'download_page_pdf',
  'read_pdf',
  'done',
  'ask_user'
]);

export const EXECUTION_MODES = Object.freeze({
  AUTO_SAFE: 'auto_safe',
  STEP_BY_STEP: 'step_by_step'
});

export const QWEN_USAGE_MODES = Object.freeze({
  FALLBACK: 'fallback',
  ALWAYS: 'always'
});

export const DEFAULT_SETTINGS = Object.freeze({
  maxSteps: 15,
  executionMode: EXECUTION_MODES.AUTO_SAFE,
  useVision: true,
  allowBackgroundExecution: true,
  allowMultiTab: true,
  useBuiltInViewer: true,
  useQwenFallback: false,
  qwenUsageMode: QWEN_USAGE_MODES.FALLBACK,
  qwenModel: 'qwen2.5vl:3b',
  qwenEndpoint: 'http://127.0.0.1:11434',
  tabGroupTitle: 'Nano AI',
  tabGroupColor: 'blue',
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
  },
  {
    label: '画面をPDF保存＆読込',
    goal: '現在開いている画面を PDF としてダウンロードして読み込み、1ページ目の内容を確認して日本語で要約してください。'
  },
  {
    label: '複数タブで比較調査',
    goal: '作業用タブグループ内で新しいタブを開いて https://ja.wikipedia.org と https://example.com をそれぞれ確認し、両方のタイトルと概要を比較して完了してください。'
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
  HISTORY_FORWARD: 'NANO_CU_HISTORY_FORWARD',
  PRINT_TAB_TO_PDF: 'NANO_CU_PRINT_TAB_TO_PDF',
  GET_RECENT_PDF_DOWNLOADS: 'NANO_CU_GET_RECENT_PDF_DOWNLOADS',
  SHOW_DOWNLOAD_IN_FOLDER: 'NANO_CU_SHOW_DOWNLOAD_IN_FOLDER',
  INIT_WORKSPACE: 'NANO_CU_INIT_WORKSPACE',
  GET_WORKSPACE_STATE: 'NANO_CU_GET_WORKSPACE_STATE',
  OPEN_WORKSPACE_TAB: 'NANO_CU_OPEN_WORKSPACE_TAB',
  SWITCH_WORKSPACE_TAB: 'NANO_CU_SWITCH_WORKSPACE_TAB',
  CLOSE_WORKSPACE_TAB: 'NANO_CU_CLOSE_WORKSPACE_TAB',
  FOCUS_WORKSPACE_TAB: 'NANO_CU_FOCUS_WORKSPACE_TAB',
  START_BACKGROUND_RUN: 'NANO_CU_START_BACKGROUND_RUN',
  STOP_BACKGROUND_RUN: 'NANO_CU_STOP_BACKGROUND_RUN',
  GET_BACKGROUND_RUN_STATE: 'NANO_CU_GET_BACKGROUND_RUN_STATE',
  CLEAR_BACKGROUND_RUN_HISTORY: 'NANO_CU_CLEAR_BACKGROUND_RUN_HISTORY',
  RESOLVE_CONFIRMATION: 'NANO_CU_RESOLVE_CONFIRMATION',
  AGENT_EVENT: 'NANO_CU_AGENT_EVENT',
  RUN_WORKFLOW_PRESET: 'NANO_CU_RUN_WORKFLOW_PRESET',
  OPEN_MEDIA_IN_VIEWER: 'NANO_CU_OPEN_MEDIA_IN_VIEWER',
  VIEWER_CAPTURE_SNAPSHOT: 'NANO_CU_VIEWER_CAPTURE_SNAPSHOT',
  VIEWER_EXECUTE_ACTION: 'NANO_CU_VIEWER_EXECUTE_ACTION',
  SET_VIEWER_INTERCEPT_CONFIG: 'NANO_CU_SET_VIEWER_INTERCEPT_CONFIG',
  OFFSCREEN_NANO_INIT: 'NANO_CU_OFFSCREEN_NANO_INIT',
  OFFSCREEN_NANO_DECIDE: 'NANO_CU_OFFSCREEN_NANO_DECIDE',
  OFFSCREEN_NANO_ABORT: 'NANO_CU_OFFSCREEN_NANO_ABORT',
  OFFSCREEN_NANO_DESTROY: 'NANO_CU_OFFSCREEN_NANO_DESTROY'
});

export const FLOW_PRESETS_STORAGE_KEY = 'nano_cu_flow_presets_v1';
