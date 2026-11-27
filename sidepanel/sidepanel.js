import { AgentController } from '../shared/agent-controller.js';
import {
  CHROME_AI_FLAGS,
  DEFAULT_SETTINGS,
  FLOW_PRESETS_STORAGE_KEY,
  MSG_TYPES
} from '../shared/constants.js';
import { NanoClient } from '../shared/nano-client.js';
import { isSupportedViewerUrl } from '../shared/media-viewer.js';
import {
  base64ToUint8Array,
  extractPdfPageSnippet,
  parsePdfBytes,
  uint8ArrayToBase64
} from '../shared/pdf-parser.js';
import {
  generateDocxPlaybookTemplate,
  parseOfficePlaybookBytes
} from '../shared/office-parser.js';
import {
  PLAYBOOK_CONVERTER_SKILL_FILENAME,
  PLAYBOOK_CONVERTER_SKILL_MARKDOWN,
  PLAYBOOK_DOCX_TEMPLATE_FILENAME,
  parsePlaybookContent
} from '../shared/playbook.js';
import {
  buildReplayPlan,
  clearRunProgressState,
  loadPanelSessionState,
  loadRunProgressState,
  savePanelSessionState,
  saveRunProgressState
} from '../shared/session-state.js';
import {
  WorkflowPresetStore,
  buildPreviewStepsFromGraph,
  compileWorkflowToPlaybook
} from '../shared/workflow-flow.js';
import { annotateScreenshot } from './annotator.js';

const SETTINGS_STORAGE_KEY = 'nano_cu_settings_v1';

const els = {
  refreshStatusBtn: document.getElementById('refreshStatusBtn'),
  statusDot: document.getElementById('statusDot'),
  statusText: document.getElementById('statusText'),
  downloadModelBtn: document.getElementById('downloadModelBtn'),
  toggleGuideBtn: document.getElementById('toggleGuideBtn'),
  downloadProgressWrap: document.getElementById('downloadProgressWrap'),
  downloadProgressBar: document.getElementById('downloadProgressBar'),
  downloadProgressLabel: document.getElementById('downloadProgressLabel'),
  setupGuide: document.getElementById('setupGuide'),
  flagsList: document.getElementById('flagsList'),
  goalInput: document.getElementById('goalInput'),
  executionModeSelect: document.getElementById('executionModeSelect'),
  maxStepsInput: document.getElementById('maxStepsInput'),
  useVisionCheckbox: document.getElementById('useVisionCheckbox'),
  allowBackgroundCheckbox: document.getElementById('allowBackgroundCheckbox'),
  allowMultiTabCheckbox: document.getElementById('allowMultiTabCheckbox'),
  useBuiltInViewerCheckbox: document.getElementById('useBuiltInViewerCheckbox'),
  advancedSettingsBadge: document.getElementById('advancedSettingsBadge'),
  runBtn: document.getElementById('runBtn'),
  stopBtn: document.getElementById('stopBtn'),
  clearLogBtn: document.getElementById('clearLogBtn'),
  workspaceBar: document.getElementById('workspaceBar'),
  workspaceGroupBadge: document.getElementById('workspaceGroupBadge'),
  workspaceModeLabel: document.getElementById('workspaceModeLabel'),
  workspaceTabsList: document.getElementById('workspaceTabsList'),
  confirmCard: document.getElementById('confirmCard'),
  confirmBadge: document.getElementById('confirmBadge'),
  confirmTitle: document.getElementById('confirmTitle'),
  confirmReason: document.getElementById('confirmReason'),
  confirmActionDetail: document.getElementById('confirmActionDetail'),
  customReplyWrap: document.getElementById('customReplyWrap'),
  customReplyInput: document.getElementById('customReplyInput'),
  confirmApproveBtn: document.getElementById('confirmApproveBtn'),
  confirmSkipBtn: document.getElementById('confirmSkipBtn'),
  confirmStopBtn: document.getElementById('confirmStopBtn'),
  resultBanner: document.getElementById('resultBanner'),
  stepCounter: document.getElementById('stepCounter'),
  timelineList: document.getElementById('timelineList'),
  imageModal: document.getElementById('imageModal'),
  imageModalBackdrop: document.getElementById('imageModalBackdrop'),
  closeImageModalBtn: document.getElementById('closeImageModalBtn'),
  modalPreviewImg: document.getElementById('modalPreviewImg'),
  playbookSection: document.getElementById('playbookSection'),
  playbookSummaryBadge: document.getElementById('playbookSummaryBadge'),
  uploadPlaybookBtn: document.getElementById('uploadPlaybookBtn'),
  downloadPlaybookDocxBtn: document.getElementById('downloadPlaybookDocxBtn'),
  downloadSkillPromptLink: document.getElementById('downloadSkillPromptLink'),
  copySkillPromptBtn: document.getElementById('copySkillPromptBtn'),
  playbookFileInput: document.getElementById('playbookFileInput'),
  playbookDropZone: document.getElementById('playbookDropZone'),
  playbookStatusBanner: document.getElementById('playbookStatusBanner'),
  playbookMetaCard: document.getElementById('playbookMetaCard'),
  playbookMetaTitle: document.getElementById('playbookMetaTitle'),
  clearPlaybookBtn: document.getElementById('clearPlaybookBtn'),
  playbookMetaStats: document.getElementById('playbookMetaStats'),
  applyPlaybookGoalBtn: document.getElementById('applyPlaybookGoalBtn'),
  playbookImagesGrid: document.getElementById('playbookImagesGrid'),
  playbookPreviewText: document.getElementById('playbookPreviewText'),
  tabAgentBtn: document.getElementById('tabAgentBtn'),
  tabFlowBtn: document.getElementById('tabFlowBtn'),
  agentPanel: document.getElementById('agentPanel'),
  flowPanel: document.getElementById('flowPanel'),
  quickPresetSelect: document.getElementById('quickPresetSelect'),
  quickApplyPresetBtn: document.getElementById('quickApplyPresetBtn'),
  openStudioBtn: document.getElementById('openStudioBtn'),
  refreshPresetsBtn: document.getElementById('refreshPresetsBtn'),
  flowPresetList: document.getElementById('flowPresetList'),
  flowPreviewCard: document.getElementById('flowPreviewCard'),
  flowPreviewTitle: document.getElementById('flowPreviewTitle'),
  flowPreviewEditBtn: document.getElementById('flowPreviewEditBtn'),
  flowMiniDiagram: document.getElementById('flowMiniDiagram')
};

const nanoClient = new NanoClient(globalThis);
const presetStore = new WorkflowPresetStore(chrome.storage?.local);
const stepCards = new Map();
let flowPresets = [];
let selectedFlowPresetId = null;
let activeController = null;
let backgroundRunActive = false;
let fgWorkspaceActive = false;
let activeBgConfirmCleanup = null;
let availabilityState = null;
let loadedPdf = null;
let loadedPlaybook = null;
let activeMainTab = 'agent';
let fgRunEvents = [];
let bootRestoring = true;
const bufferedLiveEvents = [];
let panelSaveTimer = null;

async function persistPanelState() {
  try {
    await savePanelSessionState(chrome.storage?.local, {
      goal: els.goalInput?.value || '',
      selectedPresetId: els.quickPresetSelect?.value || '',
      activeMainTab,
      playbookSectionOpen: Boolean(els.playbookSection?.open),
      loadedPlaybook
    });
  } catch {
    // Ignore session save error
  }
}

function schedulePersistPanelState() {
  if (panelSaveTimer) {
    clearTimeout(panelSaveTimer);
  }
  panelSaveTimer = setTimeout(() => {
    panelSaveTimer = null;
    persistPanelState();
  }, 250);
}

function renderSetupFlags() {
  els.flagsList.innerHTML = '';
  for (const flag of CHROME_AI_FLAGS) {
    const li = document.createElement('li');
    li.className = 'flag-item';
    li.innerHTML = `
      <div class="flag-item-top">
        <span class="flag-name">${flag.name} (${flag.recommended})</span>
        <button class="btn btn-secondary btn-xs copy-flag-btn" type="button">URLコピー</button>
      </div>
      <div class="flag-url">${flag.url}</div>
    `;
    li.querySelector('.copy-flag-btn').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(flag.url);
      } catch {
        // Ignore clipboard denial
      }
    });
    els.flagsList.appendChild(li);
  }
}

function updateAdvancedSettingsBadge() {
  if (!els.advancedSettingsBadge) return;
  const flags = [
    els.useVisionCheckbox?.checked,
    els.allowBackgroundCheckbox?.checked,
    els.allowMultiTabCheckbox?.checked,
    els.useBuiltInViewerCheckbox?.checked
  ];
  const onCount = flags.filter(Boolean).length;
  els.advancedSettingsBadge.textContent = onCount === flags.length ? 'すべてON' : `${onCount}/${flags.length} ON`;
}

async function loadSettings() {
  try {
    const stored = await chrome.storage.local.get(SETTINGS_STORAGE_KEY);
    const saved = { ...DEFAULT_SETTINGS, ...(stored?.[SETTINGS_STORAGE_KEY] || {}) };
    els.executionModeSelect.value = saved.executionMode;
    els.maxStepsInput.value = String(saved.maxSteps);
    els.useVisionCheckbox.checked = saved.useVision !== false;
    els.allowBackgroundCheckbox.checked = saved.allowBackgroundExecution !== false;
    els.allowMultiTabCheckbox.checked = saved.allowMultiTab !== false;
    els.useBuiltInViewerCheckbox.checked = saved.useBuiltInViewer !== false;
  } catch {
    // Ignore storage error
  }
  updateAdvancedSettingsBadge();
}

async function syncViewerInterceptConfig(extra = {}) {
  try {
    await chrome.runtime.sendMessage({
      type: MSG_TYPES.SET_VIEWER_INTERCEPT_CONFIG,
      enabled: Boolean(els.useBuiltInViewerCheckbox?.checked),
      ...extra
    });
  } catch {
    // Ignore sync error
  }
}

async function saveSettings() {
  updateAdvancedSettingsBadge();
  const settings = collectSettings();
  try {
    await chrome.storage.local.set({ [SETTINGS_STORAGE_KEY]: settings });
  } catch {
    // Ignore storage error
  }
  await syncViewerInterceptConfig();
}

function collectSettings() {
  const maxSteps = Math.max(1, Math.min(50, Number(els.maxStepsInput.value) || DEFAULT_SETTINGS.maxSteps));
  return {
    ...DEFAULT_SETTINGS,
    executionMode: els.executionModeSelect.value,
    maxSteps,
    useVision: Boolean(els.useVisionCheckbox.checked),
    allowBackgroundExecution: Boolean(els.allowBackgroundCheckbox.checked),
    allowMultiTab: Boolean(els.allowMultiTabCheckbox.checked),
    useBuiltInViewer: Boolean(els.useBuiltInViewerCheckbox.checked)
  };
}

function setDownloadProgress(percent, visible = true) {
  els.downloadProgressWrap.classList.toggle('hidden', !visible);
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  els.downloadProgressBar.value = clamped;
  els.downloadProgressLabel.textContent = `${clamped}%`;
}

async function refreshAvailability() {
  els.statusDot.className = 'status-dot';
  els.statusText.textContent = 'Gemini Nano の利用可否を確認中...';
  els.downloadModelBtn.classList.add('hidden');

  availabilityState = await nanoClient.checkAvailability();
  const { status, multimodal, message } = availabilityState;

  if (status === 'available') {
    els.statusDot.classList.add('ok');
    els.statusText.textContent = message;
    els.setupGuide.classList.add('hidden');
    if (!multimodal) {
      els.useVisionCheckbox.checked = false;
    }
  } else if (status === 'downloadable' || status === 'downloading') {
    els.statusText.textContent = message;
    els.downloadModelBtn.classList.remove('hidden');
  } else {
    els.statusDot.classList.add('error');
    els.statusText.textContent = message;
    els.setupGuide.classList.remove('hidden');
  }
  updateAdvancedSettingsBadge();
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id) {
    throw new Error('操作対象のアクティブなタブが見つかりませんでした。');
  }
  return tab;
}

async function getTargetTab() {
  if (fgWorkspaceActive) {
    const wsRes = await chrome.runtime.sendMessage({ type: MSG_TYPES.GET_WORKSPACE_STATE });
    if (wsRes?.ok && wsRes.workspace?.currentTabId) {
      const tab = await chrome.tabs.get(wsRes.workspace.currentTabId).catch(() => null);
      if (tab?.id) {
        return { tab, workspaceContext: wsRes.workspace };
      }
    }
  }
  const tab = await getActiveTab();
  return { tab, workspaceContext: null };
}

function renderWorkspaceBar(workspace) {
  if (!workspace || !Array.isArray(workspace.tabs) || workspace.tabs.length === 0) {
    els.workspaceBar.classList.add('hidden');
    return;
  }
  if (!workspace.multiTabEnabled && !workspace.backgroundMode) {
    els.workspaceBar.classList.add('hidden');
    return;
  }

  els.workspaceBar.classList.remove('hidden');
  els.workspaceGroupBadge.textContent =
    workspace.groupId !== null && workspace.groupId !== undefined
      ? `タブグループ: ${workspace.groupTitle || 'Nano AI'}`
      : '単一タブ作業';
  els.workspaceModeLabel.textContent = workspace.backgroundMode ? 'バックグラウンド実行' : 'フォアグラウンド実行';

  els.workspaceTabsList.innerHTML = '';
  for (const item of workspace.tabs) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = `workspace-tab-chip${item.isCurrent ? ' current' : ''}`;
    chip.textContent = `#${item.index} ${item.title || item.url || 'タブ'}`;
    chip.title = `${item.title || ''}\n${item.url || ''}`;
    chip.addEventListener('click', () => {
      chrome.runtime.sendMessage({
        type: MSG_TYPES.FOCUS_WORKSPACE_TAB,
        tabId: item.tabId
      });
    });
    els.workspaceTabsList.appendChild(chip);
  }
}

async function observeCurrentTab({ useVision, maxElements, maxImageWidth }) {
  const { tab, workspaceContext } = await getTargetTab();
  const ensureRes = await chrome.runtime.sendMessage({
    type: MSG_TYPES.ENSURE_CONTENT_SCRIPT,
    tabId: tab.id
  });

  let snapshot;
  let image = null;
  let previewDataUrl = null;
  let pdfContext = getLoadedPdfContext();

  if (ensureRes?.isViewer) {
    const viewerSnap = await chrome.runtime
      .sendMessage({
        type: MSG_TYPES.VIEWER_CAPTURE_SNAPSHOT,
        targetTabId: tab.id,
        maxImageWidth
      })
      .catch(() => null);
    snapshot = viewerSnap?.snapshot || {
      restricted: false,
      url: tab.url || '',
      title: tab.title || 'Gemini Nano 簡易ビュワー',
      elements: [],
      textExcerpt: '簡易ビュワーを読み込み中です。'
    };
    if (viewerSnap?.viewerPdfContext) {
      pdfContext = viewerSnap.viewerPdfContext;
    }
    if (viewerSnap?.viewerImageDataUrl) {
      try {
        const annotated = await annotateScreenshot(viewerSnap.viewerImageDataUrl, { elements: [] }, maxImageWidth);
        if (useVision) image = annotated.blob;
        previewDataUrl = annotated.previewDataUrl;
      } catch {
        previewDataUrl = viewerSnap.viewerImageDataUrl;
      }
    } else if (useVision && tab.active) {
      const capRes = await chrome.runtime.sendMessage({
        type: MSG_TYPES.CAPTURE_TAB,
        windowId: tab.windowId
      });
      if (capRes?.ok && capRes.dataUrl) {
        try {
          const annotated = await annotateScreenshot(capRes.dataUrl, snapshot, maxImageWidth);
          image = annotated.blob;
          previewDataUrl = annotated.previewDataUrl;
        } catch {
          // Ignore
        }
      }
    }
  } else if (ensureRes?.restricted) {
    snapshot = {
      restricted: true,
      url: ensureRes.url || tab.url || '',
      title: ensureRes.title || tab.title || '制限ページ',
      elements: []
    };
  } else {
    const snapRes = await chrome.tabs.sendMessage(tab.id, {
      type: MSG_TYPES.CAPTURE_SNAPSHOT,
      options: { maxElements }
    });
    if (!snapRes?.ok) {
      throw new Error(snapRes?.error || 'ページ状態の取得に失敗しました。');
    }
    snapshot = snapRes.snapshot;

    if (useVision && tab.active) {
      const capRes = await chrome.runtime.sendMessage({
        type: MSG_TYPES.CAPTURE_TAB,
        windowId: tab.windowId
      });
      if (capRes?.ok && capRes.dataUrl) {
        try {
          const annotated = await annotateScreenshot(capRes.dataUrl, snapshot, maxImageWidth);
          image = annotated.blob;
          previewDataUrl = annotated.previewDataUrl;
        } catch {
          // Fallback silently to DOM-only observation if annotation fails
        }
      }
    }
  }

  return {
    tab,
    snapshot,
    image,
    previewDataUrl,
    pdfContext,
    workspaceContext,
    playbookContext: loadedPlaybook
  };
}

function getLoadedPdfContext() {
  if (!loadedPdf) return null;
  const snippet = extractPdfPageSnippet(loadedPdf.parsed, loadedPdf.currentPage, 1600);
  return {
    filename: loadedPdf.filename,
    pageCount: loadedPdf.parsed.pageCount,
    currentPage: snippet.pageNumber,
    currentPageText: snippet.text
  };
}

async function loadPdfFromBytes(bytes, filename, downloadId = null) {
  const parsed = await parsePdfBytes(bytes);
  loadedPdf = {
    filename: filename || 'document.pdf',
    bytes,
    parsed,
    currentPage: 1,
    downloadId
  };
  return parsed;
}

async function captureAndLoadCurrentTabPdf(requestedFilename = '') {
  const tab = await getActiveTab();
  const res = await chrome.runtime.sendMessage({
    type: MSG_TYPES.PRINT_TAB_TO_PDF,
    tabId: tab.id,
    filename: requestedFilename,
    saveAs: false
  });
  if (!res?.ok) {
    throw new Error(res?.error || '画面の PDF 化に失敗しました。');
  }
  const bytes = base64ToUint8Array(res.pdfBase64);
  const parsed = await loadPdfFromBytes(bytes, res.filename, res.downloadId ?? null);
  return { ...res, parsed };
}

function isViewerTabUrl(url = '') {
  try {
    return Boolean(url && url.startsWith(chrome.runtime.getURL('viewer/viewer.html')));
  } catch {
    return false;
  }
}

async function executeTabAction(action) {
  const { tab } = await getTargetTab();
  const useViewer = Boolean(els.useBuiltInViewerCheckbox?.checked);

  switch (action.action) {
    case 'navigate': {
      if (useViewer && isSupportedViewerUrl(action.url)) {
        const opened = await chrome.runtime.sendMessage({
          type: MSG_TYPES.OPEN_MEDIA_IN_VIEWER,
          url: action.url,
          fetchViaDebugger: true,
          inWorkspace: fgWorkspaceActive
        });
        if (opened?.ok) {
          if (fgWorkspaceActive) {
            const wsRes = await chrome.runtime.sendMessage({ type: MSG_TYPES.GET_WORKSPACE_STATE });
            if (wsRes?.ok) renderWorkspaceBar(wsRes.workspace);
          }
          return { ok: true, detail: opened.detail, promptNote: opened.promptNote };
        }
      }
      return chrome.runtime.sendMessage({
        type: MSG_TYPES.NAVIGATE_TAB,
        tabId: tab.id,
        url: action.url
      });
    }
    case 'go_back':
      return chrome.runtime.sendMessage({
        type: MSG_TYPES.HISTORY_BACK,
        tabId: tab.id
      });
    case 'go_forward':
      return chrome.runtime.sendMessage({
        type: MSG_TYPES.HISTORY_FORWARD,
        tabId: tab.id
      });
    case 'wait':
      await new Promise((r) => setTimeout(r, action.ms || 1000));
      return { ok: true, detail: `${action.ms || 1000}ms 待機しました。` };
    case 'open_tab': {
      if (useViewer && isSupportedViewerUrl(action.url)) {
        const opened = await chrome.runtime.sendMessage({
          type: MSG_TYPES.OPEN_MEDIA_IN_VIEWER,
          url: action.url,
          fetchViaDebugger: true,
          inWorkspace: fgWorkspaceActive
        });
        if (opened?.ok) {
          if (fgWorkspaceActive) {
            const wsRes = await chrome.runtime.sendMessage({ type: MSG_TYPES.GET_WORKSPACE_STATE });
            if (wsRes?.ok) renderWorkspaceBar(wsRes.workspace);
          }
          return { ok: true, detail: opened.detail, promptNote: opened.promptNote };
        }
      }
      const res = await chrome.runtime.sendMessage({
        type: MSG_TYPES.OPEN_WORKSPACE_TAB,
        url: action.url
      });
      if (!res?.ok) {
        return { ok: false, error: res?.error || '新しいタブを開けませんでした。' };
      }
      renderWorkspaceBar(res.workspace);
      return { ok: true, detail: `タブグループに新しいタブ (${action.url}) を開きました。` };
    }
    case 'switch_tab': {
      const res = await chrome.runtime.sendMessage({
        type: MSG_TYPES.SWITCH_WORKSPACE_TAB,
        tabIndex: action.tabIndex
      });
      if (!res?.ok) {
        return { ok: false, error: res?.error || 'タブを切り替えられませんでした。' };
      }
      renderWorkspaceBar(res.workspace);
      return { ok: true, detail: `タブ #${action.tabIndex} へ切り替えました。` };
    }
    case 'close_tab': {
      const res = await chrome.runtime.sendMessage({
        type: MSG_TYPES.CLOSE_WORKSPACE_TAB,
        tabIndex: action.tabIndex
      });
      if (!res?.ok) {
        return { ok: false, error: res?.error || 'タブを閉じられませんでした。' };
      }
      renderWorkspaceBar(res.workspace);
      return { ok: true, detail: '作業タブを閉じました。' };
    }
    case 'download_page_pdf': {
      const pdfRes = await captureAndLoadCurrentTabPdf(action.filename || '');
      const snippet = extractPdfPageSnippet(pdfRes.parsed, 1, 900);
      return {
        ok: true,
        detail: `「${pdfRes.filename}」(${pdfRes.parsed.pageCount}ページ) を保存・読み込みしました。`,
        promptNote: snippet.text
          ? `保存済PDF「${pdfRes.filename}」(${pdfRes.parsed.pageCount}P) 1ページ目抜粋: ${snippet.text}`
          : `保存済PDF「${pdfRes.filename}」(${pdfRes.parsed.pageCount}P) を読み込みました。`
      };
    }
    case 'read_pdf': {
      if (isViewerTabUrl(tab.url)) {
        return chrome.runtime.sendMessage({
          type: MSG_TYPES.VIEWER_EXECUTE_ACTION,
          targetTabId: tab.id,
          action
        });
      }
      if (!loadedPdf) {
        return {
          ok: false,
          error: '現在 PDF が読み込まれていません。先に download_page_pdf を実行するか、ユーザーに PDF 読込を依頼してください。'
        };
      }
      const reqPage = Math.max(1, Math.min(loadedPdf.parsed.pageCount || 1, Number(action.page) || 1));
      loadedPdf.currentPage = reqPage;
      const snippet = extractPdfPageSnippet(loadedPdf.parsed, reqPage, 1600);
      return {
        ok: true,
        detail: `「${loadedPdf.filename}」の ${reqPage} / ${loadedPdf.parsed.pageCount} ページ目を読み込みました。`,
        promptNote: snippet.text
          ? `PDF「${loadedPdf.filename}」P.${reqPage}: ${snippet.text}`
          : `PDF「${loadedPdf.filename}」P.${reqPage} にテキストが見つかりませんでした。`
      };
    }
    default:
      if (isViewerTabUrl(tab.url)) {
        return chrome.runtime.sendMessage({
          type: MSG_TYPES.VIEWER_EXECUTE_ACTION,
          targetTabId: tab.id,
          action
        });
      }
      return chrome.tabs.sendMessage(tab.id, {
        type: MSG_TYPES.EXECUTE_DOM_ACTION,
        action: action.action === 'click' ? { ...action, useBuiltInViewer: useViewer } : action
      });
  }
}

function requestUserConfirmation(details) {
  return new Promise((resolve) => {
    els.confirmCard.classList.remove('hidden');
    els.confirmBadge.textContent = details.kind === 'danger' ? '注意' : details.kind === 'ask_user' ? '質問' : '確認';
    els.confirmTitle.textContent = details.title || '操作の確認';
    els.confirmReason.textContent = details.reason || '';
    els.confirmActionDetail.textContent = JSON.stringify(details.action, null, 2);

    const allowReply = Boolean(details.allowCustomReply);
    els.customReplyWrap.classList.toggle('hidden', !allowReply);
    els.customReplyInput.value = '';
    els.confirmSkipBtn.classList.toggle('hidden', allowReply);

    const cleanup = () => {
      els.confirmCard.classList.add('hidden');
      els.confirmApproveBtn.removeEventListener('click', onApprove);
      els.confirmSkipBtn.removeEventListener('click', onSkip);
      els.confirmStopBtn.removeEventListener('click', onStop);
    };

    const onApprove = () => {
      const userReply = els.customReplyInput.value;
      cleanup();
      resolve({ approved: true, userReply });
    };

    const onSkip = () => {
      cleanup();
      resolve({ approved: false, skip: true });
    };

    const onStop = () => {
      cleanup();
      resolve({ approved: false, stop: true });
    };

    els.confirmApproveBtn.addEventListener('click', onApprove);
    els.confirmSkipBtn.addEventListener('click', onSkip);
    els.confirmStopBtn.addEventListener('click', onStop);
  });
}

function getOrCreateStepCard(step) {
  if (stepCards.has(step)) {
    return stepCards.get(step);
  }
  const empty = els.timelineList.querySelector('.empty-state');
  if (empty) empty.remove();

  const card = document.createElement('article');
  card.className = 'step-card';
  card.innerHTML = `
    <div class="step-card-header">
      <span class="step-title">Step ${step}</span>
      <span class="step-pill">観察中...</span>
    </div>
    <p class="step-thought hidden"></p>
    <div class="step-action hidden"></div>
    <div class="step-result hidden"></div>
  `;
  els.timelineList.appendChild(card);
  stepCards.set(step, card);
  card.scrollIntoView({ behavior: 'smooth', block: 'end' });
  return card;
}

function handleAgentEvent(event, { replaying = false } = {}) {
  if (!replaying && activeController && !backgroundRunActive) {
    fgRunEvents.push({ ...event });
    if (fgRunEvents.length > 80) {
      fgRunEvents.shift();
    }
    saveRunProgressState(chrome.storage?.local, {
      running: event.type !== 'run_finished',
      mode: 'foreground',
      goal: els.goalInput.value,
      settings: collectSettings(),
      events: fgRunEvents,
      pendingConfirmation: null,
      lastOutcome: event.type === 'run_finished' ? { status: event.status, message: event.message } : null,
      loadedPlaybook,
      workspace: null
    }).catch(() => {});
  }

  switch (event.type) {
    case 'run_started': {
      els.resultBanner.classList.add('hidden');
      els.stepCounter.textContent = '初期化中...';
      break;
    }
    case 'model_download_progress': {
      setDownloadProgress(event.percent, true);
      break;
    }
    case 'session_ready': {
      setDownloadProgress(100, false);
      els.stepCounter.textContent = event.multimodal ? '画像＋DOM モード' : 'DOM テキストモード';
      break;
    }
    case 'step_started': {
      els.stepCounter.textContent = `Step ${event.step} / ${event.maxSteps}`;
      getOrCreateStepCard(event.step);
      break;
    }
    case 'observation_captured': {
      const card = getOrCreateStepCard(event.step);
      const pill = card.querySelector('.step-pill');
      pill.textContent = '推論中...';
      if (event.previewDataUrl) {
        let img = card.querySelector('.step-thumb');
        if (!img) {
          img = document.createElement('img');
          img.className = 'step-thumb';
          img.alt = `Step ${event.step} の画面`;
          img.addEventListener('click', () => {
            els.modalPreviewImg.src = event.previewDataUrl;
            els.imageModal.classList.remove('hidden');
          });
          card.appendChild(img);
        }
        img.src = event.previewDataUrl;
      }
      break;
    }
    case 'action_planned': {
      const card = getOrCreateStepCard(event.step);
      const thoughtEl = card.querySelector('.step-thought');
      const actionEl = card.querySelector('.step-action');
      const pill = card.querySelector('.step-pill');

      thoughtEl.textContent = event.action.thought || '';
      thoughtEl.classList.remove('hidden');

      actionEl.textContent = event.summary || event.action.action;
      actionEl.classList.remove('hidden');
      pill.textContent = '実行中...';
      break;
    }
    case 'step_completed': {
      const card = getOrCreateStepCard(event.step);
      const pill = card.querySelector('.step-pill');
      const resultEl = card.querySelector('.step-result');
      const ok = Boolean(event.result?.ok);

      pill.className = `step-pill ${ok ? 'ok' : 'err'}`;
      pill.textContent = ok ? `完了 (${event.durationMs}ms)` : '未完了';

      const msg = event.result?.detail || event.result?.error || (ok ? '成功' : '失敗');
      resultEl.textContent = msg;
      resultEl.classList.remove('hidden');

      if (event.result?.workspace) {
        renderWorkspaceBar(event.result.workspace);
      }
      if (event.result?.pdfUpdate?.pdfBase64) {
        const bytes = base64ToUint8Array(event.result.pdfUpdate.pdfBase64);
        loadPdfFromBytes(bytes, event.result.pdfUpdate.filename, event.result.pdfUpdate.downloadId ?? null).catch(() => {});
      }
      break;
    }
    case 'confirmation_requested': {
      showBackgroundConfirmationCard(event.details);
      break;
    }
    case 'step_error': {
      const card = getOrCreateStepCard(event.step);
      const pill = card.querySelector('.step-pill');
      const resultEl = card.querySelector('.step-result');
      pill.className = 'step-pill err';
      pill.textContent = '推論エラー';
      resultEl.textContent = event.error;
      resultEl.classList.remove('hidden');
      break;
    }
    case 'run_finished': {
      els.resultBanner.className = `result-banner ${event.status}`;
      els.resultBanner.textContent = event.message || '終了しました。';
      els.resultBanner.classList.remove('hidden');
      els.stepCounter.textContent = '完了';
      if (backgroundRunActive) {
        backgroundRunActive = false;
        setRunningUi(false);
        activeBgConfirmCleanup?.();
      }
      break;
    }
    default:
      break;
  }
}

function showBackgroundConfirmationCard(details) {
  if (!details) return;
  activeBgConfirmCleanup?.();

  els.confirmCard.classList.remove('hidden');
  els.confirmBadge.textContent = details.kind === 'danger' ? '注意' : details.kind === 'ask_user' ? '質問' : '確認';
  els.confirmTitle.textContent = details.title || '操作の確認';
  els.confirmReason.textContent = details.reason || '';
  els.confirmActionDetail.textContent = JSON.stringify(details.action, null, 2);

  const allowReply = Boolean(details.allowCustomReply);
  els.customReplyWrap.classList.toggle('hidden', !allowReply);
  els.customReplyInput.value = '';
  els.confirmSkipBtn.classList.toggle('hidden', allowReply);

  const cleanup = () => {
    els.confirmCard.classList.add('hidden');
    els.confirmApproveBtn.removeEventListener('click', onApprove);
    els.confirmSkipBtn.removeEventListener('click', onSkip);
    els.confirmStopBtn.removeEventListener('click', onStop);
    activeBgConfirmCleanup = null;
  };

  const sendDecision = (decision) => {
    cleanup();
    chrome.runtime.sendMessage({
      type: MSG_TYPES.RESOLVE_CONFIRMATION,
      decision
    });
  };

  const onApprove = () => sendDecision({ approved: true, userReply: els.customReplyInput.value });
  const onSkip = () => sendDecision({ approved: false, skip: true });
  const onStop = () => sendDecision({ approved: false, stop: true });

  els.confirmApproveBtn.addEventListener('click', onApprove);
  els.confirmSkipBtn.addEventListener('click', onSkip);
  els.confirmStopBtn.addEventListener('click', onStop);
  activeBgConfirmCleanup = cleanup;
}

function setRunningUi(isRunning) {
  els.runBtn.classList.toggle('hidden', isRunning);
  els.stopBtn.classList.toggle('hidden', !isRunning);
  els.goalInput.disabled = isRunning;
  els.executionModeSelect.disabled = isRunning;
  els.maxStepsInput.disabled = isRunning;
  els.useVisionCheckbox.disabled = isRunning;
  els.allowBackgroundCheckbox.disabled = isRunning;
  els.allowMultiTabCheckbox.disabled = isRunning;
  els.useBuiltInViewerCheckbox.disabled = isRunning;
}

async function startRun() {
  let goal = els.goalInput.value.trim();
  if (!goal && loadedPlaybook) {
    goal = loadedPlaybook.goal
      ? `${loadedPlaybook.goal}\n（適用手順書「${loadedPlaybook.title}」に従って実行してください）`
      : `アップロードされた手順書「${loadedPlaybook.title}」の実行ステップと完了条件に従って操作を実行してください。`;
    els.goalInput.value = goal;
  }
  if (!goal) {
    els.resultBanner.className = 'result-banner error';
    els.resultBanner.textContent = 'AI に実行させたいタスクを入力するか、手順書をアップロードしてください。';
    els.resultBanner.classList.remove('hidden');
    return;
  }

  await saveSettings();
  await persistPanelState();
  const settings = collectSettings();
  const tab = await getActiveTab();
  clearTimelineUiOnly();

  if (settings.allowBackgroundExecution) {
    setRunningUi(true);
    backgroundRunActive = true;

    const initialPdf = loadedPdf
      ? {
          filename: loadedPdf.filename,
          pdfBase64: uint8ArrayToBase64(loadedPdf.bytes),
          downloadId: loadedPdf.downloadId,
          currentPage: loadedPdf.currentPage
        }
      : null;

    const bgRes = await chrome.runtime.sendMessage({
      type: MSG_TYPES.START_BACKGROUND_RUN,
      tabId: tab.id,
      goal,
      settings,
      initialPdf,
      initialPlaybook: loadedPlaybook
    });

    if (bgRes?.ok) {
      renderWorkspaceBar(bgRes.workspace);
      return;
    }

    backgroundRunActive = false;
    if (!bgRes?.fallbackToForeground) {
      setRunningUi(false);
      els.resultBanner.className = 'result-banner error';
      els.resultBanner.textContent = bgRes?.error || 'バックグラウンド実行を開始できませんでした。';
      els.resultBanner.classList.remove('hidden');
      return;
    }
  }

  // Foreground execution (or automatic fallback when Offscreen LanguageModel is unavailable)
  setRunningUi(true);
  fgRunEvents = [];
  if (settings.allowMultiTab) {
    try {
      const wsRes = await chrome.runtime.sendMessage({
        type: MSG_TYPES.INIT_WORKSPACE,
        tabId: tab.id,
        multiTabEnabled: true,
        backgroundMode: false,
        groupTitle: settings.tabGroupTitle,
        groupColor: settings.tabGroupColor
      });
      if (wsRes?.ok) {
        fgWorkspaceActive = true;
        renderWorkspaceBar(wsRes.workspace);
      }
    } catch {
      fgWorkspaceActive = false;
    }
  } else {
    fgWorkspaceActive = false;
    els.workspaceBar.classList.add('hidden');
  }

  activeController = new AgentController({
    nanoClient,
    observe: observeCurrentTab,
    executeAction: executeTabAction,
    requestConfirmation: requestUserConfirmation,
    onEvent: handleAgentEvent
  });

  await syncViewerInterceptConfig({ fgRunActive: true });
  try {
    await activeController.run({ goal, settings });
  } finally {
    await syncViewerInterceptConfig({ fgRunActive: false });
    activeController = null;
    fgWorkspaceActive = false;
    setRunningUi(false);
    els.confirmCard.classList.add('hidden');
  }
}

function clearTimelineUiOnly() {
  stepCards.clear();
  els.resultBanner.classList.add('hidden');
  els.stepCounter.textContent = '待機中';
  els.timelineList.innerHTML =
    '<div class="empty-state">タスクを入力して「実行開始」を押すと、Gemini Nano が現在のタブ画面を観察しながら操作を実行します。</div>';
}

function clearTimeline() {
  clearTimelineUiOnly();
  if (!backgroundRunActive && !activeController) {
    fgRunEvents = [];
    chrome.runtime.sendMessage({ type: MSG_TYPES.CLEAR_BACKGROUND_RUN_HISTORY }).catch(() => {});
    clearRunProgressState(chrome.storage?.local).catch(() => {});
  }
}

// Event listeners
els.refreshStatusBtn.addEventListener('click', refreshAvailability);
els.toggleGuideBtn.addEventListener('click', () => {
  els.setupGuide.classList.toggle('hidden');
});

els.downloadModelBtn.addEventListener('click', async () => {
  els.downloadModelBtn.disabled = true;
  setDownloadProgress(0, true);
  try {
    await nanoClient.initialize({
      useVision: els.useVisionCheckbox.checked,
      onDownloadProgress: (percent) => setDownloadProgress(percent, true)
    });
    setDownloadProgress(100, false);
    await refreshAvailability();
  } catch (error) {
    els.statusDot.className = 'status-dot error';
    els.statusText.textContent = `ダウンロード失敗: ${error?.message || error}`;
  } finally {
    els.downloadModelBtn.disabled = false;
  }
});

els.runBtn.addEventListener('click', startRun);
els.stopBtn.addEventListener('click', () => {
  if (backgroundRunActive) {
    chrome.runtime.sendMessage({ type: MSG_TYPES.STOP_BACKGROUND_RUN });
  } else {
    activeController?.stop();
  }
});
els.clearLogBtn.addEventListener('click', clearTimeline);

els.executionModeSelect.addEventListener('change', saveSettings);
els.maxStepsInput.addEventListener('change', saveSettings);
els.useVisionCheckbox.addEventListener('change', saveSettings);
els.allowBackgroundCheckbox.addEventListener('change', saveSettings);
els.allowMultiTabCheckbox.addEventListener('change', saveSettings);
els.useBuiltInViewerCheckbox.addEventListener('change', saveSettings);

els.goalInput.addEventListener('input', schedulePersistPanelState);
els.goalInput.addEventListener('change', persistPanelState);
els.playbookSection.addEventListener('toggle', persistPanelState);

window.addEventListener('pagehide', () => {
  if (panelSaveTimer) {
    clearTimeout(panelSaveTimer);
    panelSaveTimer = null;
  }
  persistPanelState();
  if (activeController && !backgroundRunActive && fgRunEvents.length > 0) {
    saveRunProgressState(chrome.storage?.local, {
      running: false,
      mode: 'foreground',
      goal: els.goalInput.value,
      settings: collectSettings(),
      events: fgRunEvents,
      pendingConfirmation: null,
      lastOutcome: {
        status: 'stopped',
        message: 'サイドパネルを閉じたためフォアグラウンド実行を中断しました（途中までの履歴を保持しています）。'
      },
      loadedPlaybook,
      workspace: null
    }).catch(() => {});
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (!message || message.type !== MSG_TYPES.AGENT_EVENT) {
    return false;
  }
  if (bootRestoring) {
    bufferedLiveEvents.push(message);
    return false;
  }
  if (message.workspace) {
    renderWorkspaceBar(message.workspace);
  }
  if (message.event && (backgroundRunActive || message.event.type !== 'workspace_updated')) {
    handleAgentEvent(message.event);
  }
  return false;
});

async function restorePanelAndRunState() {
  let lastReplayedTs = 0;
  try {
    const panelSaved = await loadPanelSessionState(chrome.storage?.local);
    if (panelSaved) {
      if (panelSaved.loadedPlaybook) {
        loadedPlaybook = panelSaved.loadedPlaybook;
        renderLoadedPlaybookUi();
      }
      if (typeof panelSaved.playbookSectionOpen === 'boolean') {
        els.playbookSection.open = panelSaved.playbookSectionOpen;
      }
      if (typeof panelSaved.goal === 'string' && panelSaved.goal) {
        els.goalInput.value = panelSaved.goal;
      }
      if (
        panelSaved.selectedPresetId &&
        Array.from(els.quickPresetSelect.options).some((o) => o.value === panelSaved.selectedPresetId)
      ) {
        els.quickPresetSelect.value = panelSaved.selectedPresetId;
      }
      if (panelSaved.activeMainTab === 'flow') {
        switchMainTab('flow', { skipPersist: true });
      }
    }

    const [bgRes, persistedRun] = await Promise.all([
      chrome.runtime.sendMessage({ type: MSG_TYPES.GET_BACKGROUND_RUN_STATE }).catch(() => null),
      loadRunProgressState(chrome.storage?.local)
    ]);

    const swState = bgRes?.ok && bgRes.state ? { ...bgRes.state, workspace: bgRes.workspace || null } : null;
    const swHasData = Boolean(
      swState && (swState.running || (Array.isArray(swState.events) && swState.events.length > 0) || swState.lastOutcome)
    );
    const chosenRunState = swHasData ? swState : persistedRun;
    const plan = buildReplayPlan(chosenRunState);

    if (plan.loadedPlaybook && (plan.running || !loadedPlaybook)) {
      loadedPlaybook = plan.loadedPlaybook;
      renderLoadedPlaybookUi();
    }

    if (plan.workspace) {
      renderWorkspaceBar(plan.workspace);
    }

    if (plan.shouldRestore) {
      clearTimelineUiOnly();
      if (plan.goal && (!els.goalInput.value.trim() || plan.running)) {
        els.goalInput.value = plan.goal;
      }
      backgroundRunActive = Boolean(plan.running && plan.mode !== 'foreground');
      setRunningUi(backgroundRunActive);

      for (const ev of plan.eventsToReplay) {
        handleAgentEvent(ev, { replaying: true });
        if (typeof ev.timestamp === 'number' && ev.timestamp > lastReplayedTs) {
          lastReplayedTs = ev.timestamp;
        }
      }

      if (plan.pendingConfirmation) {
        showBackgroundConfirmationCard(plan.pendingConfirmation);
      } else if (!plan.running && plan.lastOutcome && els.resultBanner.classList.contains('hidden')) {
        els.resultBanner.className = `result-banner ${plan.lastOutcome.status || 'stopped'}`;
        els.resultBanner.textContent = plan.lastOutcome.message || '終了しました。';
        els.resultBanner.classList.remove('hidden');
        els.stepCounter.textContent = plan.lastOutcome.status === 'completed' ? '完了' : '終了';
      }
    }
  } catch {
    // Ignore restore failure on cold start
  } finally {
    bootRestoring = false;
    while (bufferedLiveEvents.length > 0) {
      const msg = bufferedLiveEvents.shift();
      if (msg.workspace) {
        renderWorkspaceBar(msg.workspace);
      }
      if (msg.event && (backgroundRunActive || msg.event.type !== 'workspace_updated')) {
        const ts = typeof msg.event.timestamp === 'number' ? msg.event.timestamp : 0;
        if (ts === 0 || ts > lastReplayedTs) {
          handleAgentEvent(msg.event);
        }
      }
    }
  }
}

els.closeImageModalBtn.addEventListener('click', () => els.imageModal.classList.add('hidden'));
els.imageModalBackdrop.addEventListener('click', () => els.imageModal.classList.add('hidden'));

function showPlaybookStatus(message, kind = 'completed') {
  if (!message) {
    els.playbookStatusBanner.classList.add('hidden');
    return;
  }
  els.playbookStatusBanner.className = `result-banner ${kind}`;
  els.playbookStatusBanner.textContent = message;
  els.playbookStatusBanner.classList.remove('hidden');
}

function renderLoadedPlaybookUi() {
  if (!loadedPlaybook) {
    els.playbookSummaryBadge.textContent = '未設定';
    els.playbookSummaryBadge.classList.remove('loaded');
    els.playbookMetaCard.classList.add('hidden');
    els.playbookImagesGrid.classList.add('hidden');
    els.playbookImagesGrid.innerHTML = '';
    els.playbookPreviewText.textContent = '';
    return;
  }

  const imageCount = Array.isArray(loadedPlaybook.images) ? loadedPlaybook.images.length : 0;
  els.playbookSummaryBadge.textContent = loadedPlaybook.title || loadedPlaybook.filename;
  els.playbookSummaryBadge.classList.add('loaded');
  els.playbookMetaCard.classList.remove('hidden');
  els.playbookMetaTitle.textContent = `${loadedPlaybook.title} (${loadedPlaybook.filename})`;
  els.playbookMetaStats.textContent = `抽出ステップ ${loadedPlaybook.steps.length}件 ・ 添付画像 ${imageCount}枚 ・ ${loadedPlaybook.charCount}文字${
    loadedPlaybook.startUrl ? ` ・ 開始URL: ${loadedPlaybook.startUrl}` : ''
  }`;
  els.playbookPreviewText.textContent = loadedPlaybook.rawText;

  els.playbookImagesGrid.innerHTML = '';
  if (imageCount > 0) {
    els.playbookImagesGrid.classList.remove('hidden');
    for (const imgInfo of loadedPlaybook.images) {
      const card = document.createElement('div');
      card.className = 'playbook-img-card';
      card.title = `${imgInfo.name}${imgInfo.stepHint ? ` (${imgInfo.stepHint})` : ''}`;

      const thumb = document.createElement('img');
      thumb.src = imgInfo.dataUrl;
      thumb.alt = imgInfo.name;

      const cap = document.createElement('span');
      cap.className = 'playbook-img-caption';
      cap.textContent = `#${imgInfo.index} ${imgInfo.name}`;

      card.appendChild(thumb);
      card.appendChild(cap);
      card.addEventListener('click', () => {
        els.modalPreviewImg.src = imgInfo.dataUrl;
        els.imageModal.classList.remove('hidden');
      });
      els.playbookImagesGrid.appendChild(card);
    }
  } else {
    els.playbookImagesGrid.classList.add('hidden');
  }
}

function resizeDataUrlToJpeg(dataUrl, maxWidth = 640) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const scale = img.naturalWidth > maxWidth ? maxWidth / img.naturalWidth : 1;
        const w = Math.max(1, Math.round(img.naturalWidth * scale));
        const h = Math.max(1, Math.round(img.naturalHeight * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', 0.82));
      } catch {
        resolve(dataUrl);
      }
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

async function handlePlaybookFile(file) {
  if (!file) return;
  const lowerName = file.name.toLowerCase();
  let rawText = '';
  let images = [];

  if (lowerName.endsWith('.docx') || lowerName.endsWith('.pptx') || lowerName.endsWith('.xlsx')) {
    const buf = await file.arrayBuffer();
    const parsedOffice = await parseOfficePlaybookBytes(new Uint8Array(buf), file.name);
    rawText = parsedOffice.text;
    images = await Promise.all(
      (parsedOffice.images || []).slice(0, 10).map(async (img) => ({
        ...img,
        dataUrl: await resizeDataUrlToJpeg(img.dataUrl, 640),
        mimeType: 'image/jpeg'
      }))
    );
  } else if (lowerName.endsWith('.pdf') || file.type === 'application/pdf') {
    const buf = await file.arrayBuffer();
    const parsedPdf = await parsePdfBytes(new Uint8Array(buf));
    if (!parsedPdf.hasExtractableText) {
      throw new Error('この PDF からは手順テキストを抽出できませんでした。Word (.docx) または Markdown (.md) 形式をご利用ください。');
    }
    rawText = parsedPdf.fullText;
  } else {
    rawText = await file.text();
  }

  loadedPlaybook = parsePlaybookContent(rawText, file.name, { images });
  els.playbookSection.open = true;
  renderLoadedPlaybookUi();
  await persistPanelState();
  showPlaybookStatus(
    `手順書「${loadedPlaybook.title}」を読み込みました（添付画像 ${loadedPlaybook.images.length}枚・厳格手順書モード有効）。`,
    'completed'
  );
}

async function downloadBlobFile(blob, filename, label) {
  const blobUrl = URL.createObjectURL(blob);
  try {
    if (chrome.downloads?.download) {
      await chrome.downloads.download({
        url: blobUrl,
        filename,
        saveAs: false
      });
    } else {
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = filename;
      a.click();
    }
    showPlaybookStatus(`${label}「${filename}」をダウンロードしました。`, 'completed');
  } catch (error) {
    showPlaybookStatus(`テンプレートのダウンロードに失敗しました: ${error?.message || error}`, 'error');
  } finally {
    setTimeout(() => URL.revokeObjectURL(blobUrl), 5000);
  }
}

async function downloadDocxPlaybookTemplate() {
  const docxBytes = generateDocxPlaybookTemplate();
  const blob = new Blob([docxBytes], {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  });
  await downloadBlobFile(blob, PLAYBOOK_DOCX_TEMPLATE_FILENAME, 'Word (.docx) テンプレート');
}

async function downloadSkillPrompt(e) {
  e?.preventDefault();
  const blob = new Blob([PLAYBOOK_CONVERTER_SKILL_MARKDOWN], { type: 'text/markdown;charset=utf-8' });
  await downloadBlobFile(blob, PLAYBOOK_CONVERTER_SKILL_FILENAME, 'Gemini変換用プロンプト');
}

// Playbook listeners
els.uploadPlaybookBtn.addEventListener('click', () => {
  els.playbookFileInput.value = '';
  els.playbookFileInput.click();
});

els.playbookFileInput.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    await handlePlaybookFile(file);
  } catch (error) {
    showPlaybookStatus(`手順書読み込みエラー: ${error?.message || error}`, 'error');
  }
});

els.downloadPlaybookDocxBtn.addEventListener('click', downloadDocxPlaybookTemplate);
els.downloadSkillPromptLink.addEventListener('click', downloadSkillPrompt);
els.copySkillPromptBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(PLAYBOOK_CONVERTER_SKILL_MARKDOWN);
    showPlaybookStatus('Gemini変換用プロンプト (SKILL.md) をクリップボードにコピーしました。', 'completed');
  } catch {
    showPlaybookStatus('クリップボードへのコピーに失敗しました。', 'error');
  }
});

els.clearPlaybookBtn.addEventListener('click', () => {
  loadedPlaybook = null;
  renderLoadedPlaybookUi();
  persistPanelState();
  showPlaybookStatus('手順書の適用を解除しました。', 'stopped');
});

els.applyPlaybookGoalBtn.addEventListener('click', () => {
  if (!loadedPlaybook) return;
  els.goalInput.value = loadedPlaybook.goal
    ? `${loadedPlaybook.goal}\n（手順書「${loadedPlaybook.title}」に従って実行してください）`
    : `手順書「${loadedPlaybook.title}」のステップに従って実行してください。`;
  persistPanelState();
  els.goalInput.focus();
  els.goalInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
});

els.playbookDropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  els.playbookDropZone.classList.add('drag-over');
});
els.playbookDropZone.addEventListener('dragleave', () => {
  els.playbookDropZone.classList.remove('drag-over');
});
els.playbookDropZone.addEventListener('drop', async (e) => {
  e.preventDefault();
  els.playbookDropZone.classList.remove('drag-over');
  const file = e.dataTransfer?.files?.[0];
  if (!file) return;
  try {
    await handlePlaybookFile(file);
  } catch (error) {
    showPlaybookStatus(`手順書読み込みエラー: ${error?.message || error}`, 'error');
  }
});

// Flowchart & Local Preset Logic
function switchMainTab(tabName, { skipPersist = false } = {}) {
  const isFlow = tabName === 'flow';
  activeMainTab = isFlow ? 'flow' : 'agent';
  els.tabAgentBtn.classList.toggle('active', !isFlow);
  els.tabFlowBtn.classList.toggle('active', isFlow);
  els.agentPanel.classList.toggle('hidden', isFlow);
  els.flowPanel.classList.toggle('hidden', !isFlow);
  if (isFlow) {
    loadFlowPresets();
  }
  if (!skipPersist) {
    persistPanelState();
  }
}

function openStudioPage(presetId = '') {
  const baseUrl = chrome.runtime.getURL('studio/studio.html');
  const url = presetId ? `${baseUrl}?presetId=${encodeURIComponent(presetId)}` : baseUrl;
  chrome.tabs.create({ url });
}

function applyPresetToPlaybook(preset, switchTab = true) {
  if (!preset) return;
  const compiled = compileWorkflowToPlaybook(preset);
  loadedPlaybook = compiled;
  renderLoadedPlaybookUi();
  els.goalInput.value =
    compiled.goal ||
    `フローチャートプリセット「${preset.name}」の条件分岐とステップに従って実行してください。`;
  els.quickPresetSelect.value = preset.id;
  persistPanelState();
  showPlaybookStatus(`プリセット「${preset.name}」を厳格手順書として適用しました。`, 'completed');
  if (switchTab) {
    switchMainTab('agent');
  }
}

async function runPresetNow(preset) {
  if (!preset) return;
  applyPresetToPlaybook(preset, true);
  if (preset.startUrl) {
    const active = await getActiveTab().catch(() => null);
    if (active?.id && (!active.url || active.url !== preset.startUrl)) {
      await chrome.runtime.sendMessage({
        type: MSG_TYPES.NAVIGATE_TAB,
        tabId: active.id,
        url: preset.startUrl
      });
    }
  }
  await startRun();
}

function renderMiniNodes(nodes, container) {
  for (const node of nodes) {
    const item = document.createElement('div');
    item.className = `mini-node mini-node-${node.type}`;

    const header = document.createElement('div');
    const tag = node.type === 'condition' ? 'IF' : node.type === 'ask_user' ? '確認' : node.type === 'done' ? '完了' : node.actionType;
    header.textContent = `[${tag}] ${node.label || ''}${node.conditionValue ? ` (${node.conditionValue})` : ''}`;
    item.appendChild(header);

    if (node.type === 'condition') {
      const branches = document.createElement('div');
      branches.className = 'mini-branches';

      const yesBox = document.createElement('div');
      yesBox.className = 'mini-branch mini-branch-yes';
      const yesTitle = document.createElement('div');
      yesTitle.className = 'mini-branch-title';
      yesTitle.textContent = 'YES';
      yesBox.appendChild(yesTitle);
      if (node.yesBranch.length === 0) {
        const empty = document.createElement('div');
        empty.textContent = '（次へ）';
        yesBox.appendChild(empty);
      } else {
        renderMiniNodes(node.yesBranch, yesBox);
      }

      const noBox = document.createElement('div');
      noBox.className = 'mini-branch mini-branch-no';
      const noTitle = document.createElement('div');
      noTitle.className = 'mini-branch-title';
      noTitle.textContent = 'NO';
      noBox.appendChild(noTitle);
      if (node.noBranch.length === 0) {
        const empty = document.createElement('div');
        empty.textContent = '（次へ）';
        noBox.appendChild(empty);
      } else {
        renderMiniNodes(node.noBranch, noBox);
      }

      branches.appendChild(yesBox);
      branches.appendChild(noBox);
      item.appendChild(branches);
    }
    container.appendChild(item);
  }
}

function renderFlowPreview() {
  const preset = flowPresets.find((p) => p.id === selectedFlowPresetId) || flowPresets[0];
  if (!preset) {
    els.flowPreviewCard.classList.add('hidden');
    return;
  }
  selectedFlowPresetId = preset.id;
  els.flowPreviewCard.classList.remove('hidden');
  els.flowPreviewTitle.textContent = `プレビュー: ${preset.name}`;
  els.flowMiniDiagram.innerHTML = '';
  const previewNodes = buildPreviewStepsFromGraph(preset);
  renderMiniNodes(previewNodes, els.flowMiniDiagram);
}

function renderFlowPresetViews() {
  const prevSelectVal = els.quickPresetSelect.value;
  els.quickPresetSelect.innerHTML = '<option value="">（なし / 直接指示）</option>';
  els.flowPresetList.innerHTML = '';

  for (const preset of flowPresets) {
    const opt = document.createElement('option');
    opt.value = preset.id;
    opt.textContent = preset.name;
    els.quickPresetSelect.appendChild(opt);

    const card = document.createElement('div');
    card.className = `flow-preset-card${selectedFlowPresetId === preset.id ? ' selected' : ''}`;
    card.addEventListener('click', () => {
      selectedFlowPresetId = preset.id;
      renderFlowPresetViews();
    });

    const title = document.createElement('div');
    title.className = 'flow-preset-title';
    title.textContent = preset.name;

    const desc = document.createElement('div');
    desc.className = 'flow-preset-desc';
    desc.textContent =
      preset.description || `${preset.nodes.length}ステップ${preset.startUrl ? ` ・ ${preset.startUrl}` : ''}`;

    const actions = document.createElement('div');
    actions.className = 'flow-preset-actions';

    const applyBtn = document.createElement('button');
    applyBtn.type = 'button';
    applyBtn.className = 'btn btn-secondary btn-xs';
    applyBtn.textContent = '呼出（適用）';
    applyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      applyPresetToPlaybook(preset, true);
    });

    const runBtn = document.createElement('button');
    runBtn.type = 'button';
    runBtn.className = 'btn btn-primary btn-xs';
    runBtn.textContent = 'ワンクリック実行';
    runBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      runPresetNow(preset);
    });

    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'btn btn-ghost btn-xs';
    editBtn.textContent = 'Studio編集';
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openStudioPage(preset.id);
    });

    actions.appendChild(applyBtn);
    actions.appendChild(runBtn);
    actions.appendChild(editBtn);

    card.appendChild(title);
    card.appendChild(desc);
    card.appendChild(actions);
    els.flowPresetList.appendChild(card);
  }

  if (prevSelectVal && flowPresets.some((p) => p.id === prevSelectVal)) {
    els.quickPresetSelect.value = prevSelectVal;
  }
  renderFlowPreview();
}

async function loadFlowPresets() {
  try {
    flowPresets = await presetStore.list();
    if (!selectedFlowPresetId && flowPresets[0]) {
      selectedFlowPresetId = flowPresets[0].id;
    }
    renderFlowPresetViews();
  } catch {
    // Ignore preset load error
  }
}

els.tabAgentBtn.addEventListener('click', () => switchMainTab('agent'));
els.tabFlowBtn.addEventListener('click', () => switchMainTab('flow'));
els.openStudioBtn.addEventListener('click', () => openStudioPage(selectedFlowPresetId || ''));
els.flowPreviewEditBtn.addEventListener('click', () => openStudioPage(selectedFlowPresetId || ''));
els.refreshPresetsBtn.addEventListener('click', loadFlowPresets);

els.quickApplyPresetBtn.addEventListener('click', () => {
  const id = els.quickPresetSelect.value;
  if (!id) {
    loadedPlaybook = null;
    renderLoadedPlaybookUi();
    persistPanelState();
    return;
  }
  const preset = flowPresets.find((p) => p.id === id);
  if (preset) {
    applyPresetToPlaybook(preset, false);
  }
});

chrome.storage?.onChanged?.addListener((changes, areaName) => {
  if (areaName === 'local' && changes[FLOW_PRESETS_STORAGE_KEY]) {
    loadFlowPresets();
  }
});

// Boot
renderSetupFlags();
renderLoadedPlaybookUi();
await loadSettings();
await syncViewerInterceptConfig();
await loadFlowPresets();
await restorePanelAndRunState();
await refreshAvailability();
