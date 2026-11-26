import { AgentController } from '../shared/agent-controller.js';
import {
  CHROME_AI_FLAGS,
  DEFAULT_SETTINGS,
  MSG_TYPES,
  SAMPLE_TASKS
} from '../shared/constants.js';
import { NanoClient } from '../shared/nano-client.js';
import {
  base64ToUint8Array,
  extractPdfPageSnippet,
  parsePdfBytes
} from '../shared/pdf-parser.js';
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
  modalPreviewImg: document.getElementById('modalPreviewImg'),
  tabAgentBtn: document.getElementById('tabAgentBtn'),
  tabPdfBtn: document.getElementById('tabPdfBtn'),
  agentPanel: document.getElementById('agentPanel'),
  pdfPanel: document.getElementById('pdfPanel'),
  activePdfBar: document.getElementById('activePdfBar'),
  activePdfName: document.getElementById('activePdfName'),
  gotoPdfTabBtn: document.getElementById('gotoPdfTabBtn'),
  unloadPdfQuickBtn: document.getElementById('unloadPdfQuickBtn'),
  capturePagePdfBtn: document.getElementById('capturePagePdfBtn'),
  openPdfFileBtn: document.getElementById('openPdfFileBtn'),
  pdfFileInput: document.getElementById('pdfFileInput'),
  pdfDropZone: document.getElementById('pdfDropZone'),
  pdfStatusBanner: document.getElementById('pdfStatusBanner'),
  pdfMetaCard: document.getElementById('pdfMetaCard'),
  pdfMetaFilename: document.getElementById('pdfMetaFilename'),
  pdfMetaStats: document.getElementById('pdfMetaStats'),
  unloadPdfBtn: document.getElementById('unloadPdfBtn'),
  openPdfTabBtn: document.getElementById('openPdfTabBtn'),
  summarizePdfAiBtn: document.getElementById('summarizePdfAiBtn'),
  pdfViewPreviewBtn: document.getElementById('pdfViewPreviewBtn'),
  pdfViewTextBtn: document.getElementById('pdfViewTextBtn'),
  pdfPreviewPane: document.getElementById('pdfPreviewPane'),
  pdfTextPane: document.getElementById('pdfTextPane'),
  pdfViewerEmpty: document.getElementById('pdfViewerEmpty'),
  pdfViewerFrame: document.getElementById('pdfViewerFrame'),
  pdfPrevPageBtn: document.getElementById('pdfPrevPageBtn'),
  pdfPageIndicator: document.getElementById('pdfPageIndicator'),
  pdfNextPageBtn: document.getElementById('pdfNextPageBtn'),
  pdfAllPagesBtn: document.getElementById('pdfAllPagesBtn'),
  pdfCopyTextBtn: document.getElementById('pdfCopyTextBtn'),
  pdfExtractedText: document.getElementById('pdfExtractedText'),
  refreshRecentPdfBtn: document.getElementById('refreshRecentPdfBtn'),
  recentPdfList: document.getElementById('recentPdfList')
};

const nanoClient = new NanoClient(globalThis);
const stepCards = new Map();
const sessionPdfCache = new Map();
let activeController = null;
let availabilityState = null;
let loadedPdf = null;
let pdfShowAllPages = false;
let activeMainTab = 'agent';

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

  const pdfContext = getLoadedPdfContext();
  return { tab, snapshot, image, previewDataUrl, pdfContext };
}

function formatByteSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function switchMainTab(tabName) {
  activeMainTab = tabName === 'pdf' ? 'pdf' : 'agent';
  const isPdf = activeMainTab === 'pdf';
  els.tabAgentBtn.classList.toggle('active', !isPdf);
  els.tabPdfBtn.classList.toggle('active', isPdf);
  els.agentPanel.classList.toggle('hidden', isPdf);
  els.pdfPanel.classList.toggle('hidden', !isPdf);
  if (isPdf) {
    refreshRecentPdfDownloads();
  }
}

function switchPdfSubView(mode) {
  const isText = mode === 'text';
  els.pdfViewPreviewBtn.classList.toggle('active', !isText);
  els.pdfViewTextBtn.classList.toggle('active', isText);
  els.pdfPreviewPane.classList.toggle('hidden', isText);
  els.pdfTextPane.classList.toggle('hidden', !isText);
}

function showPdfStatus(message, kind = 'completed') {
  if (!message) {
    els.pdfStatusBanner.classList.add('hidden');
    return;
  }
  els.pdfStatusBanner.className = `result-banner ${kind}`;
  els.pdfStatusBanner.textContent = message;
  els.pdfStatusBanner.classList.remove('hidden');
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

function cacheSessionPdf(key, filename, bytes, downloadId = null) {
  if (!key) return;
  if (sessionPdfCache.size >= 5) {
    const oldestKey = sessionPdfCache.keys().next().value;
    sessionPdfCache.delete(oldestKey);
  }
  sessionPdfCache.set(key, { filename, bytes, downloadId });
}

function renderLoadedPdfUi() {
  if (!loadedPdf) {
    els.activePdfBar.classList.add('hidden');
    els.pdfMetaCard.classList.add('hidden');
    els.pdfViewerFrame.classList.add('hidden');
    els.pdfViewerFrame.src = 'about:blank';
    els.pdfViewerEmpty.classList.remove('hidden');
    els.pdfExtractedText.textContent = 'PDF が読み込まれていません。';
    els.pdfPageIndicator.textContent = '0 / 0';
    els.pdfPrevPageBtn.disabled = true;
    els.pdfNextPageBtn.disabled = true;
    return;
  }

  const { filename, blobUrl, parsed, currentPage } = loadedPdf;
  const totalPages = Math.max(1, parsed.pageCount);

  els.activePdfBar.classList.remove('hidden');
  els.activePdfName.textContent = `${filename} (${totalPages}ページ)`;

  els.pdfMetaCard.classList.remove('hidden');
  els.pdfMetaFilename.textContent = filename;
  const charCount = parsed.fullText.length;
  els.pdfMetaStats.textContent = `PDF v${parsed.version} ・ ${totalPages}ページ ・ ${formatByteSize(parsed.byteLength)} ・ 抽出文字数 ${charCount}字`;

  els.pdfViewerEmpty.classList.add('hidden');
  els.pdfViewerFrame.classList.remove('hidden');
  const frameUrl = `${blobUrl}#page=${currentPage}`;
  if (els.pdfViewerFrame.src !== frameUrl) {
    els.pdfViewerFrame.src = frameUrl;
  }

  els.pdfPageIndicator.textContent = pdfShowAllPages ? `全 ${totalPages}P` : `${currentPage} / ${totalPages}`;
  els.pdfPrevPageBtn.disabled = pdfShowAllPages || currentPage <= 1;
  els.pdfNextPageBtn.disabled = pdfShowAllPages || currentPage >= totalPages;
  els.pdfAllPagesBtn.textContent = pdfShowAllPages ? 'ページ別表示' : '全ページ表示';

  if (pdfShowAllPages) {
    els.pdfExtractedText.textContent = parsed.fullText || '（テキストを抽出できませんでした。プレビュータブをご確認ください）';
  } else {
    const pageObj = parsed.pages[currentPage - 1];
    els.pdfExtractedText.textContent =
      pageObj?.text || `（${currentPage} ページ目に抽出可能なテキストが見つかりませんでした。画像ベースの PDF の可能性があります）`;
  }
}

function unloadPdf() {
  if (loadedPdf?.blobUrl) {
    URL.revokeObjectURL(loadedPdf.blobUrl);
  }
  loadedPdf = null;
  pdfShowAllPages = false;
  renderLoadedPdfUi();
}

async function loadPdfFromBytes(bytes, filename, downloadId = null) {
  const parsed = await parsePdfBytes(bytes);
  if (loadedPdf?.blobUrl) {
    URL.revokeObjectURL(loadedPdf.blobUrl);
  }
  const blob = new Blob([bytes], { type: 'application/pdf' });
  const blobUrl = URL.createObjectURL(blob);

  loadedPdf = {
    filename: filename || 'document.pdf',
    bytes,
    blobUrl,
    parsed,
    currentPage: 1,
    downloadId
  };
  pdfShowAllPages = false;
  if (downloadId !== null) {
    cacheSessionPdf(`dl:${downloadId}`, loadedPdf.filename, bytes, downloadId);
  }
  cacheSessionPdf(`name:${loadedPdf.filename}`, loadedPdf.filename, bytes, downloadId);
  renderLoadedPdfUi();
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
  await refreshRecentPdfDownloads();
  return { ...res, parsed };
}

async function refreshRecentPdfDownloads() {
  try {
    const res = await chrome.runtime.sendMessage({ type: MSG_TYPES.GET_RECENT_PDF_DOWNLOADS });
    if (!res?.ok || !Array.isArray(res.items) || res.items.length === 0) {
      els.recentPdfList.innerHTML = '<div class="empty-state">PDF のダウンロード履歴はまだありません。</div>';
      return;
    }

    els.recentPdfList.innerHTML = '';
    for (const item of res.items) {
      const row = document.createElement('div');
      row.className = 'recent-pdf-item';

      const info = document.createElement('div');
      info.className = 'recent-pdf-info';

      const nameEl = document.createElement('span');
      nameEl.className = 'recent-pdf-name';
      nameEl.textContent = item.basename;
      nameEl.title = item.filename || item.basename;

      const metaEl = document.createElement('span');
      metaEl.className = 'recent-pdf-meta';
      const timeLabel = item.startTime ? new Date(item.startTime).toLocaleString('ja-JP') : '';
      metaEl.textContent = `${formatByteSize(item.fileSize)} ${timeLabel ? `・ ${timeLabel}` : ''}`;

      info.appendChild(nameEl);
      info.appendChild(metaEl);

      const actions = document.createElement('div');
      actions.className = 'recent-pdf-actions';

      const cached = sessionPdfCache.get(`dl:${item.id}`) || sessionPdfCache.get(`name:${item.basename}`);
      if (cached) {
        const loadBtn = document.createElement('button');
        loadBtn.type = 'button';
        loadBtn.className = 'btn btn-primary btn-xs';
        loadBtn.textContent = '読込';
        loadBtn.addEventListener('click', async () => {
          await loadPdfFromBytes(cached.bytes, cached.filename, item.id);
          showPdfStatus(`「${cached.filename}」を読み込みました。`, 'completed');
        });
        actions.appendChild(loadBtn);
      }

      const folderBtn = document.createElement('button');
      folderBtn.type = 'button';
      folderBtn.className = 'btn btn-secondary btn-xs';
      folderBtn.textContent = 'フォルダ';
      folderBtn.addEventListener('click', () => {
        chrome.runtime.sendMessage({
          type: MSG_TYPES.SHOW_DOWNLOAD_IN_FOLDER,
          downloadId: item.id
        });
      });
      actions.appendChild(folderBtn);

      row.appendChild(info);
      row.appendChild(actions);
      els.recentPdfList.appendChild(row);
    }
  } catch {
    // Ignore history refresh failure
  }
}

async function handleLocalPdfFile(file) {
  if (!file) return;
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  const parsed = await loadPdfFromBytes(bytes, file.name);
  showPdfStatus(`「${file.name}」(${parsed.pageCount}ページ) をローカル読み込みしました。`, 'completed');
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
      if (!loadedPdf) {
        return {
          ok: false,
          error: '現在 PDF が読み込まれていません。先に download_page_pdf を実行するか、ユーザーに PDF 読込を依頼してください。'
        };
      }
      const reqPage = Math.max(1, Math.min(loadedPdf.parsed.pageCount || 1, Number(action.page) || 1));
      loadedPdf.currentPage = reqPage;
      pdfShowAllPages = false;
      renderLoadedPdfUi();
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

// PDF workspace listeners
els.tabAgentBtn.addEventListener('click', () => switchMainTab('agent'));
els.tabPdfBtn.addEventListener('click', () => switchMainTab('pdf'));
els.gotoPdfTabBtn.addEventListener('click', () => switchMainTab('pdf'));
els.unloadPdfQuickBtn.addEventListener('click', unloadPdf);
els.unloadPdfBtn.addEventListener('click', () => {
  unloadPdf();
  showPdfStatus('PDF の読み込みを解除しました。', 'stopped');
});

els.pdfViewPreviewBtn.addEventListener('click', () => switchPdfSubView('preview'));
els.pdfViewTextBtn.addEventListener('click', () => switchPdfSubView('text'));

els.capturePagePdfBtn.addEventListener('click', async () => {
  els.capturePagePdfBtn.disabled = true;
  showPdfStatus('現在の画面を PDF 化してダウンロードしています...', 'completed');
  try {
    const res = await captureAndLoadCurrentTabPdf();
    showPdfStatus(
      `「${res.filename}」(${res.parsed.pageCount}ページ) をダウンロードして読み込みました。`,
      'completed'
    );
  } catch (error) {
    showPdfStatus(`PDF 保存エラー: ${error?.message || error}`, 'error');
  } finally {
    els.capturePagePdfBtn.disabled = false;
  }
});

els.openPdfFileBtn.addEventListener('click', () => {
  els.pdfFileInput.value = '';
  els.pdfFileInput.click();
});

els.pdfFileInput.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    await handleLocalPdfFile(file);
  } catch (error) {
    showPdfStatus(`PDF 読み込みエラー: ${error?.message || error}`, 'error');
  }
});

els.pdfDropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  els.pdfDropZone.classList.add('drag-over');
});
els.pdfDropZone.addEventListener('dragleave', () => {
  els.pdfDropZone.classList.remove('drag-over');
});
els.pdfDropZone.addEventListener('drop', async (e) => {
  e.preventDefault();
  els.pdfDropZone.classList.remove('drag-over');
  const file = e.dataTransfer?.files?.[0];
  if (!file) return;
  try {
    await handleLocalPdfFile(file);
  } catch (error) {
    showPdfStatus(`PDF 読み込みエラー: ${error?.message || error}`, 'error');
  }
});

els.openPdfTabBtn.addEventListener('click', () => {
  if (!loadedPdf?.blobUrl) return;
  chrome.tabs.create({ url: `${loadedPdf.blobUrl}#page=${loadedPdf.currentPage}` });
});

els.summarizePdfAiBtn.addEventListener('click', () => {
  if (!loadedPdf) return;
  els.goalInput.value = `現在読み込んでいる PDF「${loadedPdf.filename}」（全${loadedPdf.parsed.pageCount}ページ）の内容を read_pdf なども使って確認し、要点を日本語でわかりやすくまとめて完了してください。`;
  switchMainTab('agent');
});

els.pdfPrevPageBtn.addEventListener('click', () => {
  if (!loadedPdf || loadedPdf.currentPage <= 1) return;
  loadedPdf.currentPage -= 1;
  renderLoadedPdfUi();
});

els.pdfNextPageBtn.addEventListener('click', () => {
  if (!loadedPdf || loadedPdf.currentPage >= loadedPdf.parsed.pageCount) return;
  loadedPdf.currentPage += 1;
  renderLoadedPdfUi();
});

els.pdfAllPagesBtn.addEventListener('click', () => {
  pdfShowAllPages = !pdfShowAllPages;
  renderLoadedPdfUi();
});

els.pdfCopyTextBtn.addEventListener('click', async () => {
  if (!loadedPdf) return;
  try {
    await navigator.clipboard.writeText(els.pdfExtractedText.textContent || '');
    showPdfStatus('表示中の抽出テキストをクリップボードにコピーしました。', 'completed');
  } catch {
    showPdfStatus('クリップボードへのコピーに失敗しました。', 'error');
  }
});

els.refreshRecentPdfBtn.addEventListener('click', refreshRecentPdfDownloads);

// Boot
renderSetupFlags();
renderSampleChips();
renderLoadedPdfUi();
await loadSettings();
await refreshAvailability();
