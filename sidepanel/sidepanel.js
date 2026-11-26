import { AgentController } from '../shared/agent-controller.js';
import {
  CHROME_AI_FLAGS,
  DEFAULT_SETTINGS,
  MSG_TYPES,
  SAMPLE_TASKS
} from '../shared/constants.js';
import { NanoClient } from '../shared/nano-client.js';
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
  samplesRow: document.getElementById('samplesRow'),
  executionModeSelect: document.getElementById('executionModeSelect'),
  maxStepsInput: document.getElementById('maxStepsInput'),
  useVisionCheckbox: document.getElementById('useVisionCheckbox'),
  runBtn: document.getElementById('runBtn'),
  stopBtn: document.getElementById('stopBtn'),
  clearLogBtn: document.getElementById('clearLogBtn'),
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
  modalPreviewImg: document.getElementById('modalPreviewImg')
};

const nanoClient = new NanoClient(globalThis);
const stepCards = new Map();
let activeController = null;
let availabilityState = null;

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

function renderSampleChips() {
  els.samplesRow.innerHTML = '';
  for (const sample of SAMPLE_TASKS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sample-chip';
    btn.textContent = sample.label;
    btn.addEventListener('click', () => {
      els.goalInput.value = sample.goal;
    });
    els.samplesRow.appendChild(btn);
  }
}

async function loadSettings() {
  try {
    const stored = await chrome.storage.local.get(SETTINGS_STORAGE_KEY);
    const saved = { ...DEFAULT_SETTINGS, ...(stored?.[SETTINGS_STORAGE_KEY] || {}) };
    els.executionModeSelect.value = saved.executionMode;
    els.maxStepsInput.value = String(saved.maxSteps);
    els.useVisionCheckbox.checked = Boolean(saved.useVision);
  } catch {
    // Ignore storage error
  }
}

async function saveSettings() {
  const settings = collectSettings();
  try {
    await chrome.storage.local.set({ [SETTINGS_STORAGE_KEY]: settings });
  } catch {
    // Ignore storage error
  }
}

function collectSettings() {
  const maxSteps = Math.max(1, Math.min(50, Number(els.maxStepsInput.value) || DEFAULT_SETTINGS.maxSteps));
  return {
    ...DEFAULT_SETTINGS,
    executionMode: els.executionModeSelect.value,
    maxSteps,
    useVision: Boolean(els.useVisionCheckbox.checked)
  };
}

function setDownloadProgress(percent, visible = true) {
  els.downloadProgressWrap.classList.toggle('hidden', !visible);
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  els.downloadProgressBar.style.width = `${clamped}%`;
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
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id) {
    throw new Error('操作対象のアクティブなタブが見つかりませんでした。');
  }
  return tab;
}

async function observeCurrentTab({ useVision, maxElements, maxImageWidth }) {
  const tab = await getActiveTab();
  const ensureRes = await chrome.runtime.sendMessage({
    type: MSG_TYPES.ENSURE_CONTENT_SCRIPT,
    tabId: tab.id
  });

  let snapshot;
  if (ensureRes?.restricted) {
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
  }

  let image = null;
  let previewDataUrl = null;

  if (useVision) {
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

  return { tab, snapshot, image, previewDataUrl };
}

async function executeTabAction(action) {
  const tab = await getActiveTab();

  switch (action.action) {
    case 'navigate':
      return chrome.runtime.sendMessage({
        type: MSG_TYPES.NAVIGATE_TAB,
        tabId: tab.id,
        url: action.url
      });
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
    default:
      return chrome.tabs.sendMessage(tab.id, {
        type: MSG_TYPES.EXECUTE_DOM_ACTION,
        action
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

function handleAgentEvent(event) {
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
      break;
    }
    default:
      break;
  }
}

function setRunningUi(isRunning) {
  els.runBtn.classList.toggle('hidden', isRunning);
  els.stopBtn.classList.toggle('hidden', !isRunning);
  els.goalInput.disabled = isRunning;
  els.executionModeSelect.disabled = isRunning;
  els.maxStepsInput.disabled = isRunning;
  els.useVisionCheckbox.disabled = isRunning;
}

async function startRun() {
  const goal = els.goalInput.value.trim();
  if (!goal) {
    els.resultBanner.className = 'result-banner error';
    els.resultBanner.textContent = 'AI に実行させたいタスクを入力してください。';
    els.resultBanner.classList.remove('hidden');
    return;
  }

  await saveSettings();
  const settings = collectSettings();

  setRunningUi(true);
  activeController = new AgentController({
    nanoClient,
    observe: observeCurrentTab,
    executeAction: executeTabAction,
    requestConfirmation: requestUserConfirmation,
    onEvent: handleAgentEvent
  });

  try {
    await activeController.run({ goal, settings });
  } finally {
    activeController = null;
    setRunningUi(false);
    els.confirmCard.classList.add('hidden');
  }
}

function clearTimeline() {
  stepCards.clear();
  els.resultBanner.classList.add('hidden');
  els.stepCounter.textContent = '待機中';
  els.timelineList.innerHTML =
    '<div class="empty-state">タスクを入力して「実行開始」を押すと、Gemini Nano が現在のタブ画面を観察しながら操作を実行します。</div>';
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
  activeController?.stop();
});
els.clearLogBtn.addEventListener('click', clearTimeline);

els.executionModeSelect.addEventListener('change', saveSettings);
els.maxStepsInput.addEventListener('change', saveSettings);
els.useVisionCheckbox.addEventListener('change', saveSettings);

els.closeImageModalBtn.addEventListener('click', () => els.imageModal.classList.add('hidden'));
els.imageModalBackdrop.addEventListener('click', () => els.imageModal.classList.add('hidden'));

// Boot
renderSetupFlags();
renderSampleChips();
await loadSettings();
await refreshAvailability();
