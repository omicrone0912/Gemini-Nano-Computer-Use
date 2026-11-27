import { AgentController } from '../shared/agent-controller.js';
import { DEFAULT_SETTINGS, MSG_TYPES } from '../shared/constants.js';
import {
  classifyViewerMedia,
  detectMagicMimeType,
  isSupportedViewerUrl
} from '../shared/media-viewer.js';
import {
  base64ToUint8Array,
  extractPdfPageSnippet,
  parsePdfBytes,
  sanitizePdfFilename
} from '../shared/pdf-parser.js';
import { SYSTEM_PROMPT } from '../shared/prompt-builder.js';
import {
  clearRunProgressState,
  loadRunProgressState,
  saveRunProgressState
} from '../shared/session-state.js';
import { TabWorkspaceManager } from '../shared/tab-workspace.js';
import { saveViewerMedia } from '../shared/viewer-storage.js';
import { compileWorkflowToPlaybook, validateWorkflowPreset } from '../shared/workflow-flow.js';

const workspace = new TabWorkspaceManager(chrome);
let creatingOffscreen = null;
let bgController = null;
let pendingConfirmResolver = null;
let viewerInterceptConfig = {
  enabled: true,
  fgRunActive: false
};

const bgState = {
  running: false,
  goal: '',
  settings: { ...DEFAULT_SETTINGS },
  events: [],
  pendingConfirmation: null,
  lastOutcome: null,
  loadedPdf: null,
  loadedPlaybook: null
};

function isViewerUrl(url = '') {
  if (!url) return false;
  try {
    return url.startsWith(chrome.runtime.getURL('viewer/viewer.html'));
  } catch {
    return false;
  }
}

function isRestrictedUrl(url = '') {
  if (!url) return true;
  if (isViewerUrl(url)) return false;
  const lower = url.toLowerCase();
  return (
    lower.startsWith('chrome://') ||
    lower.startsWith('chrome-extension://') ||
    lower.startsWith('edge://') ||
    lower.startsWith('about:') ||
    lower.startsWith('view-source:') ||
    lower.startsWith('https://chromewebstore.google.com/') ||
    lower.startsWith('https://chrome.google.com/webstore')
  );
}

async function setupSidePanelBehavior() {
  try {
    if (chrome.sidePanel?.setPanelBehavior) {
      await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
    }
  } catch (error) {
    console.warn('sidePanel.setPanelBehavior failed:', error);
  }
}

chrome.runtime.onInstalled.addListener(() => {
  setupSidePanelBehavior();
});

chrome.runtime.onStartup.addListener(() => {
  setupSidePanelBehavior();
});

setupSidePanelBehavior();

function waitForTabComplete(tabId, timeoutMs = 12000) {
  return new Promise((resolve) => {
    let settled = false;

    const finish = (timedOut = false) => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      clearTimeout(timer);
      resolve({ ok: true, timedOut });
    };

    const onUpdated = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        finish(false);
      }
    };

    const timer = setTimeout(() => finish(true), timeoutMs);
    chrome.tabs.onUpdated.addListener(onUpdated);

    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) {
        finish(false);
        return;
      }
      if (tab?.status === 'complete') {
        // Give SPA frameworks a brief moment after initial navigation trigger
        setTimeout(() => finish(false), 300);
      }
    });
  });
}

async function ensureContentScript(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (isViewerUrl(tab?.url)) {
    return {
      ok: true,
      restricted: false,
      isViewer: true,
      url: tab?.url || '',
      title: tab?.title || 'Gemini Nano 簡易ビュワー'
    };
  }
  if (isRestrictedUrl(tab?.url)) {
    return {
      ok: true,
      restricted: true,
      url: tab?.url || '',
      title: tab?.title || '制限ページ'
    };
  }

  try {
    const pingRes = await chrome.tabs.sendMessage(tabId, { type: MSG_TYPES.PING });
    if (pingRes?.ok) {
      return { ok: true, restricted: false, url: tab.url, title: tab.title };
    }
  } catch {
    // Content script not yet loaded in this tab; inject dynamically below
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content/dom-inspector.js']
    });
    return { ok: true, restricted: false, injected: true, url: tab.url, title: tab.title };
  } catch (error) {
    return {
      ok: true,
      restricted: true,
      url: tab?.url || '',
      title: tab?.title || '',
      reason: error?.message || String(error)
    };
  }
}

async function captureTabImage(windowId) {
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(windowId, {
      format: 'jpeg',
      quality: 78
    });
    return { ok: true, dataUrl };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
}

async function navigateTab(tabId, url) {
  await chrome.tabs.update(tabId, { url });
  const waited = await waitForTabComplete(tabId, 12000);
  const tab = await chrome.tabs.get(tabId);
  return {
    ok: true,
    url: tab?.url || url,
    title: tab?.title || '',
    timedOut: waited.timedOut
  };
}

async function historyStep(tabId, direction) {
  if (direction === 'back') {
    await chrome.tabs.goBack(tabId);
  } else {
    await chrome.tabs.goForward(tabId);
  }
  await waitForTabComplete(tabId, 10000);
  const tab = await chrome.tabs.get(tabId);
  return { ok: true, url: tab?.url || '', title: tab?.title || '' };
}

async function printTabToPdf(tabId, requestedFilename = '', saveAs = false) {
  const tab = await chrome.tabs.get(tabId);
  if (isRestrictedUrl(tab?.url)) {
    return {
      ok: false,
      error: 'chrome:// や拡張機能ストア等の保護されたページは PDF 化できません。通常の Web ページを開いてお試しください。'
    };
  }

  const target = { tabId };
  let attached = false;

  try {
    await chrome.debugger.attach(target, '1.3');
    attached = true;

    const pdfResult = await chrome.debugger.sendCommand(target, 'Page.printToPDF', {
      printBackground: true,
      preferCSSPageSize: true,
      displayHeaderFooter: false
    });

    if (!pdfResult?.data) {
      throw new Error('Chrome から PDF データを取得できませんでした。');
    }

    const filename = sanitizePdfFilename(requestedFilename || tab?.title || 'webpage', 'page');
    const dataUrl = `data:application/pdf;base64,${pdfResult.data}`;
    const downloadId = await chrome.downloads.download({
      url: dataUrl,
      filename,
      saveAs: Boolean(saveAs)
    });

    return {
      ok: true,
      downloadId,
      filename,
      pdfBase64: pdfResult.data,
      sourceUrl: tab?.url || '',
      title: tab?.title || ''
    };
  } catch (error) {
    const rawMsg = error?.message || String(error);
    if (rawMsg.toLowerCase().includes('another debugger')) {
      return {
        ok: false,
        error: 'このタブでは DevTools または他のデバッガが開いているため PDF 化できません。DevTools を閉じてから再実行してください。'
      };
    }
    return { ok: false, error: rawMsg };
  } finally {
    if (attached) {
      try {
        await chrome.debugger.detach(target);
      } catch {
        // Ignore if already detached
      }
    }
  }
}

async function getRecentPdfDownloads() {
  const items = await chrome.downloads.search({
    state: 'complete',
    orderBy: ['-startTime'],
    limit: 30
  });
  const pdfs = items
    .filter((item) => {
      const name = String(item.filename || '').toLowerCase();
      const mime = String(item.mime || '').toLowerCase();
      return name.endsWith('.pdf') || mime === 'application/pdf';
    })
    .slice(0, 10)
    .map((item) => ({
      id: item.id,
      filename: item.filename,
      basename: String(item.filename || '').split(/[\\/]/).pop() || 'document.pdf',
      fileSize: item.fileSize || 0,
      startTime: item.startTime,
      url: item.url
    }));
  return { ok: true, items: pdfs };
}

function parseContentDispositionFilename(headerVal = '') {
  if (!headerVal) return '';
  const utfMatch = headerVal.match(/filename\*\s*=\s*(?:utf-8'')?([^;\s]+)/i);
  if (utfMatch?.[1]) {
    try {
      return decodeURIComponent(utfMatch[1].replace(/^["']|["']$/g, ''));
    } catch {
      return utfMatch[1].replace(/^["']|["']$/g, '');
    }
  }
  const plainMatch = headerVal.match(/filename\s*=\s*"([^"]+)"|filename\s*=\s*([^;\s]+)/i);
  return (plainMatch?.[1] || plainMatch?.[2] || '').trim();
}

function inferFilenameFromUrl(url = '', fallbackExt = 'bin') {
  try {
    const parsed = new URL(url);
    for (const p of ['filename', 'file', 'name', 'download']) {
      const val = parsed.searchParams.get(p);
      if (val) return val.split(/[\\/]/).pop();
    }
    const base = decodeURIComponent(parsed.pathname || '').split('/').pop();
    if (base) return base;
  } catch {
    // Ignore
  }
  return `media.${fallbackExt || 'bin'}`;
}

async function fetchBinaryViaDebugger(url) {
  if (!/^https?:/i.test(url)) {
    return { ok: false, error: 'HTTP/HTTPS URL のみ CDP 取得できます。' };
  }

  let tempTab = null;
  let attached = false;
  let onEvent = null;

  try {
    tempTab = await chrome.tabs.create({ url: 'about:blank', active: false });
    const target = { tabId: tempTab.id };
    await chrome.debugger.attach(target, '1.3');
    attached = true;

    const result = await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (val, isErr = false) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        if (isErr) reject(val);
        else resolve(val);
      };

      const timeoutId = setTimeout(() => {
        finish(new Error('メディアデータの取得がタイムアウトしました。'), true);
      }, 25000);

      onEvent = async (source, method, params) => {
        if (source.tabId !== tempTab.id || method !== 'Fetch.requestPaused' || settled) {
          return;
        }
        const { requestId, responseStatusCode, responseHeaders = [], request } = params;
        if (responseStatusCode >= 300 && responseStatusCode < 400) {
          chrome.debugger.sendCommand(target, 'Fetch.continueResponse', { requestId }).catch(() => {});
          return;
        }

        const headerMap = new Map();
        for (const h of responseHeaders) {
          headerMap.set(String(h.name || '').toLowerCase(), String(h.value || ''));
        }
        const contentType = (headerMap.get('content-type') || '').split(';')[0].trim().toLowerCase();
        const dispFilename = parseContentDispositionFilename(headerMap.get('content-disposition') || '');

        if (contentType.includes('text/html') || contentType.includes('application/xhtml')) {
          chrome.debugger.sendCommand(target, 'Fetch.failRequest', { requestId, errorReason: 'Aborted' }).catch(() => {});
          finish({ ok: false, isHtml: true, contentType });
          return;
        }

        try {
          const bodyRes = await chrome.debugger.sendCommand(target, 'Fetch.getResponseBody', { requestId });
          await chrome.debugger
            .sendCommand(target, 'Fetch.failRequest', { requestId, errorReason: 'Aborted' })
            .catch(() => {});

          const bytes = bodyRes.base64Encoded
            ? base64ToUint8Array(bodyRes.body || '')
            : new TextEncoder().encode(bodyRes.body || '');

          finish({
            ok: true,
            bytes,
            mimeType: contentType,
            filename: dispFilename,
            finalUrl: request?.url || url
          });
        } catch (err) {
          finish(err, true);
        }
      };

      chrome.debugger.onEvent.addListener(onEvent);
      chrome.debugger
        .sendCommand(target, 'Fetch.enable', {
          patterns: [{ urlPattern: '*', requestStage: 'Response' }]
        })
        .then(() => chrome.tabs.update(tempTab.id, { url }))
        .catch((err) => finish(err, true));
    });

    return result;
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  } finally {
    if (onEvent) {
      chrome.debugger.onEvent.removeListener(onEvent);
    }
    if (attached && tempTab?.id) {
      await chrome.debugger.detach({ tabId: tempTab.id }).catch(() => {});
    }
    if (tempTab?.id) {
      await chrome.tabs.remove(tempTab.id).catch(() => {});
    }
  }
}

async function openMediaInViewerTab({
  url = '',
  filename = '',
  mimeType = '',
  bytes = null,
  bytesBase64 = '',
  fetchViaDebugger = false,
  inWorkspace = false
} = {}) {
  let rawBytes = bytes instanceof Uint8Array ? bytes : null;
  let resolvedMime = mimeType;
  let resolvedFilename = filename;
  let finalUrl = url;

  if (!rawBytes && bytesBase64) {
    rawBytes = base64ToUint8Array(bytesBase64);
  } else if (!rawBytes && fetchViaDebugger && /^https?:/i.test(url)) {
    const fetched = await fetchBinaryViaDebugger(url);
    if (!fetched?.ok) {
      return fetched || { ok: false, error: 'ファイルの取得に失敗しました。' };
    }
    rawBytes = fetched.bytes;
    resolvedMime = fetched.mimeType || resolvedMime;
    resolvedFilename = fetched.filename || resolvedFilename;
    finalUrl = fetched.finalUrl || finalUrl;
  }

  if (!rawBytes || rawBytes.byteLength === 0) {
    return { ok: false, error: 'メディアデータが空のため簡易ビュワーで開けませんでした。' };
  }

  const magicMime = detectMagicMimeType(rawBytes);
  const spec = classifyViewerMedia({
    url: finalUrl,
    filename: resolvedFilename,
    mimeType: magicMime || resolvedMime
  });

  if (!resolvedFilename) {
    resolvedFilename = inferFilenameFromUrl(finalUrl, spec.ext || 'bin');
  }
  if (spec.ext && !resolvedFilename.includes('.')) {
    resolvedFilename = `${resolvedFilename}.${spec.ext}`;
  }

  const saved = await saveViewerMedia({
    filename: resolvedFilename,
    sourceUrl: finalUrl,
    mimeType: spec.supported ? spec.mimeType : magicMime || resolvedMime || 'application/octet-stream',
    category: spec.supported ? spec.category : 'document',
    ext: spec.ext,
    bytes: rawBytes
  });

  const viewerUrl = chrome.runtime.getURL(`viewer/viewer.html?id=${encodeURIComponent(saved.id)}`);
  let viewerTab = null;

  if (inWorkspace && workspace.managedTabIds.length > 0) {
    if (workspace.multiTabEnabled) {
      const openRes = await workspace.openTab(viewerUrl);
      viewerTab = openRes.tab;
    } else {
      viewerTab = await chrome.tabs.create({
        windowId: workspace.windowId ?? undefined,
        url: viewerUrl,
        active: !workspace.backgroundMode
      });
      if (!workspace.managedTabIds.includes(viewerTab.id)) {
        workspace.managedTabIds.push(viewerTab.id);
      }
      workspace.currentTabId = viewerTab.id;
    }
  } else {
    viewerTab = await chrome.tabs.create({ url: viewerUrl, active: true });
  }

  await waitForTabComplete(viewerTab.id, 6000);
  await new Promise((r) => setTimeout(r, 180));

  const detail = `「${saved.filename}」(${spec.label || saved.ext}) を別タブの簡易ビュワーで開きました。`;
  return {
    ok: true,
    tabId: viewerTab.id,
    viewerUrl,
    mediaId: saved.id,
    filename: saved.filename,
    detail,
    promptNote: `${detail} このビュワータブ内の画像・動画フレーム・PDF/AI抽出テキストをそのまま参照および操作できます。`
  };
}

async function ensureOffscreenDocument() {
  if (typeof chrome.runtime.getContexts === 'function') {
    const existing = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT']
    });
    if (existing.length > 0) {
      return;
    }
  }

  if (creatingOffscreen) {
    await creatingOffscreen;
    return;
  }

  creatingOffscreen = chrome.offscreen.createDocument({
    url: 'offscreen/offscreen.html',
    reasons: ['DOM_PARSER', 'BLOBS'],
    justification: 'Keep Gemini Nano session active and annotate screenshots in the background.'
  });

  try {
    await creatingOffscreen;
  } finally {
    creatingOffscreen = null;
  }
}

function setActionBadge(text, color = '#2563eb') {
  try {
    chrome.action?.setBadgeText?.({ text: text || '' });
    if (text) {
      chrome.action?.setBadgeBackgroundColor?.({ color });
    }
  } catch {
    // Ignore badge API errors
  }
}

let keepAliveTimer = null;

function startKeepAlive() {
  if (keepAliveTimer) return;
  keepAliveTimer = setInterval(() => {
    try {
      chrome.runtime?.getPlatformInfo?.(() => {});
    } catch {
      // Ignore keepalive failure
    }
  }, 20000);
}

function stopKeepAlive() {
  if (keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
}

function persistBgStateSnapshot(wsOverride = null) {
  const runPersist = async () => {
    const ws = wsOverride ?? (await workspace.getWorkspaceContext().catch(() => null));
    await saveRunProgressState(chrome.storage?.local, {
      running: bgState.running,
      mode: 'background',
      goal: bgState.goal,
      settings: bgState.settings,
      events: bgState.events,
      pendingConfirmation: bgState.pendingConfirmation,
      lastOutcome: bgState.lastOutcome,
      loadedPlaybook: bgState.loadedPlaybook,
      workspace: ws
    });
  };
  runPersist().catch(() => {});
}

async function hydrateBgStateIfNeeded() {
  if (bgState.running || bgState.events.length > 0 || bgState.lastOutcome || bgState.loadedPlaybook) {
    return null;
  }
  const saved = await loadRunProgressState(chrome.storage?.local);
  if (!saved || saved.mode === 'foreground') {
    return null;
  }
  bgState.goal = saved.goal || '';
  bgState.settings = saved.settings ? { ...DEFAULT_SETTINGS, ...saved.settings } : { ...DEFAULT_SETTINGS };
  bgState.events = Array.isArray(saved.events) ? saved.events : [];
  bgState.loadedPlaybook = saved.loadedPlaybook || null;
  bgState.running = false;
  bgState.pendingConfirmation = null;
  bgState.lastOutcome =
    saved.lastOutcome ||
    (saved.running
      ? {
          status: 'stopped',
          message: 'Chrome がバックグラウンド処理を休止したため実行が中断されました（途中までの履歴を復元しました）。'
        }
      : null);
  return saved;
}

function recordAndBroadcastEvent(event, extra = {}) {
  // Keep recent events bounded and drop large preview URLs from older entries
  const compactEvent = { ...event };
  bgState.events.push(compactEvent);
  if (bgState.events.length > 80) {
    bgState.events.shift();
  }
  if (bgState.events.length > 10) {
    for (let i = 0; i < bgState.events.length - 10; i += 1) {
      if (bgState.events[i].previewDataUrl) {
        delete bgState.events[i].previewDataUrl;
      }
    }
  }

  if (event.type === 'step_started') {
    setActionBadge(`${event.step}/${event.maxSteps}`, '#2563eb');
  } else if (event.type === 'run_finished') {
    bgState.lastOutcome = { status: event.status, message: event.message };
    bgState.running = false;
    stopKeepAlive();
    setActionBadge(event.status === 'completed' ? 'OK' : '', '#16a34a');
    if (event.status !== 'completed') {
      setActionBadge('', '#2563eb');
    }
  }

  persistBgStateSnapshot(extra.workspace || null);

  chrome.runtime
    .sendMessage({
      type: MSG_TYPES.AGENT_EVENT,
      event: compactEvent,
      ...extra
    })
    .catch(() => {
      // Side panel might be closed; ignore missing receiver
    });
}

function getBgPdfContext() {
  if (!bgState.loadedPdf?.parsed) return null;
  const snippet = extractPdfPageSnippet(bgState.loadedPdf.parsed, bgState.loadedPdf.currentPage, 1600);
  return {
    filename: bgState.loadedPdf.filename,
    pageCount: bgState.loadedPdf.parsed.pageCount,
    currentPage: snippet.pageNumber,
    currentPageText: snippet.text
  };
}

function createOffscreenNanoAdapter() {
  let cachedInit = { multimodal: false, apiVariant: 'OffscreenLanguageModel' };
  return {
    async initialize({
      useVision,
      systemPrompt,
      provider = 'auto',
      useQwenFallback = false,
      qwenModel,
      qwenEndpoint
    }) {
      await ensureOffscreenDocument();
      const res = await chrome.runtime.sendMessage({
        target: 'offscreen',
        type: MSG_TYPES.OFFSCREEN_NANO_INIT,
        useVision,
        systemPrompt: systemPrompt || SYSTEM_PROMPT,
        provider,
        useQwenFallback,
        qwenModel,
        qwenEndpoint
      });
      if (!res?.ok) {
        throw new Error(res?.error || 'Offscreen AI の初期化に失敗しました。');
      }
      cachedInit = { multimodal: Boolean(res.multimodal), apiVariant: res.apiVariant };
      return cachedInit;
    },
    async decideAction({ promptText, image, referenceImages = [], signal }) {
      if (signal?.aborted) {
        const err = new Error('Aborted');
        err.name = 'AbortError';
        throw err;
      }
      const onAbort = () => {
        chrome.runtime.sendMessage({ target: 'offscreen', type: MSG_TYPES.OFFSCREEN_NANO_ABORT }).catch(() => {});
      };
      signal?.addEventListener?.('abort', onAbort, { once: true });
      try {
        const res = await chrome.runtime.sendMessage({
          target: 'offscreen',
          type: MSG_TYPES.OFFSCREEN_NANO_DECIDE,
          promptText,
          rawScreenshotDataUrl: image?.rawScreenshotDataUrl || null,
          snapshot: image?.snapshot || null,
          maxImageWidth: image?.maxImageWidth || 768,
          referenceImages: Array.isArray(referenceImages) ? referenceImages : []
        });
        if (!res?.ok) {
          if (res?.aborted) {
            const err = new Error('Aborted');
            err.name = 'AbortError';
            throw err;
          }
          throw new Error(res?.error || 'Offscreen 推論に失敗しました。');
        }
        return {
          action: res.action,
          usage: res.usage,
          previewDataUrl: res.previewDataUrl || null
        };
      } finally {
        signal?.removeEventListener?.('abort', onAbort);
      }
    }
  };
}

async function observeWorkspaceTab({ useVision, maxElements, maxImageWidth }) {
  const tab = await workspace.getCurrentTab();
  if (!tab?.id) {
    throw new Error('作業グループ内に操作可能なタブが見つかりません。');
  }

  const ensureRes = await ensureContentScript(tab.id);
  let snapshot;
  let image = null;
  let previewDataUrl = null;
  let pdfContext = getBgPdfContext();

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
      previewDataUrl = viewerSnap.viewerImageDataUrl;
      if (useVision) {
        image = {
          rawScreenshotDataUrl: viewerSnap.viewerImageDataUrl,
          snapshot: { elements: [] },
          maxImageWidth
        };
      }
    } else if (useVision && tab.active) {
      const capRes = await captureTabImage(tab.windowId);
      if (capRes?.ok && capRes.dataUrl) {
        image = { rawScreenshotDataUrl: capRes.dataUrl, snapshot, maxImageWidth };
        previewDataUrl = capRes.dataUrl;
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
    // Capture visible tab ONLY when target tab is active so background tasks never capture the user's active tab
    if (useVision && tab.active) {
      const capRes = await captureTabImage(tab.windowId);
      if (capRes?.ok && capRes.dataUrl) {
        image = { rawScreenshotDataUrl: capRes.dataUrl, snapshot, maxImageWidth };
        previewDataUrl = capRes.dataUrl;
      }
    }
  }

  const workspaceContext = await workspace.getWorkspaceContext();
  return {
    tab,
    snapshot,
    image,
    previewDataUrl,
    pdfContext,
    workspaceContext,
    playbookContext: bgState.loadedPlaybook
  };
}

async function executeWorkspaceAction(action) {
  const tab = await workspace.getCurrentTab();
  if (!tab?.id) {
    return { ok: false, error: '操作対象のタブが見つかりません。' };
  }

  const useViewer = viewerInterceptConfig.enabled && bgState.settings.useBuiltInViewer !== false;

  switch (action.action) {
    case 'navigate': {
      if (useViewer && isSupportedViewerUrl(action.url)) {
        const opened = await openMediaInViewerTab({
          url: action.url,
          fetchViaDebugger: true,
          inWorkspace: true
        });
        if (opened?.ok) {
          return {
            ok: true,
            detail: opened.detail,
            promptNote: opened.promptNote,
            workspace: await workspace.getWorkspaceContext()
          };
        }
      }
      return navigateTab(tab.id, action.url);
    }
    case 'go_back':
      return historyStep(tab.id, 'back');
    case 'go_forward':
      return historyStep(tab.id, 'forward');
    case 'wait':
      await new Promise((r) => setTimeout(r, action.ms || 1000));
      return { ok: true, detail: `${action.ms || 1000}ms 待機しました。` };
    case 'open_tab': {
      if (useViewer && isSupportedViewerUrl(action.url)) {
        const opened = await openMediaInViewerTab({
          url: action.url,
          fetchViaDebugger: true,
          inWorkspace: true
        });
        if (opened?.ok) {
          return {
            ok: true,
            detail: opened.detail,
            promptNote: opened.promptNote,
            workspace: await workspace.getWorkspaceContext()
          };
        }
      }
      const res = await workspace.openTab(action.url);
      await waitForTabComplete(res.tab.id, 10000);
      const updatedWs = await workspace.getWorkspaceContext();
      return {
        ok: true,
        detail: `タブグループに新しいタブ (${action.url}) を開きました。`,
        workspace: updatedWs
      };
    }
    case 'switch_tab': {
      const res = await workspace.switchTab({ tabIndex: action.tabIndex });
      return {
        ok: true,
        detail: `タブ #${action.tabIndex} (${res.tab?.title || res.tab?.url || ''}) へ切り替えました。`,
        workspace: res.workspace
      };
    }
    case 'close_tab': {
      const res = await workspace.closeTab({ tabIndex: action.tabIndex });
      return {
        ok: true,
        detail: '作業タブを閉じました。',
        workspace: res.workspace
      };
    }
    case 'download_page_pdf': {
      const pdfRes = await printTabToPdf(tab.id, action.filename || '', false);
      if (!pdfRes?.ok) {
        return { ok: false, error: pdfRes?.error || 'PDF 化に失敗しました。' };
      }
      const bytes = base64ToUint8Array(pdfRes.pdfBase64);
      const parsed = await parsePdfBytes(bytes);
      bgState.loadedPdf = {
        filename: pdfRes.filename,
        parsed,
        currentPage: 1,
        pdfBase64: pdfRes.pdfBase64,
        downloadId: pdfRes.downloadId ?? null
      };
      const snippet = extractPdfPageSnippet(parsed, 1, 900);
      return {
        ok: true,
        detail: `「${pdfRes.filename}」(${parsed.pageCount}ページ) を保存・読み込みしました。`,
        promptNote: snippet.text
          ? `保存済PDF「${pdfRes.filename}」(${parsed.pageCount}P) 1ページ目抜粋: ${snippet.text}`
          : `保存済PDF「${pdfRes.filename}」(${parsed.pageCount}P) を読み込みました。`,
        pdfUpdate: {
          filename: pdfRes.filename,
          pdfBase64: pdfRes.pdfBase64,
          downloadId: pdfRes.downloadId ?? null
        }
      };
    }
    case 'read_pdf': {
      if (isViewerUrl(tab.url)) {
        return chrome.runtime.sendMessage({
          type: MSG_TYPES.VIEWER_EXECUTE_ACTION,
          targetTabId: tab.id,
          action
        });
      }
      if (!bgState.loadedPdf?.parsed) {
        return {
          ok: false,
          error: '現在 PDF が読み込まれていません。先に download_page_pdf を実行するか PDF を読み込んでください。'
        };
      }
      const total = bgState.loadedPdf.parsed.pageCount || 1;
      const reqPage = Math.max(1, Math.min(total, Number(action.page) || 1));
      bgState.loadedPdf.currentPage = reqPage;
      const snippet = extractPdfPageSnippet(bgState.loadedPdf.parsed, reqPage, 1600);
      return {
        ok: true,
        detail: `「${bgState.loadedPdf.filename}」の ${reqPage} / ${total} ページ目を読み込みました。`,
        promptNote: snippet.text
          ? `PDF「${bgState.loadedPdf.filename}」P.${reqPage}: ${snippet.text}`
          : `PDF「${bgState.loadedPdf.filename}」P.${reqPage} にテキストが見つかりませんでした。`
      };
    }
    default:
      if (isViewerUrl(tab.url)) {
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

async function startBackgroundRun({ tabId, goal, settings = {}, initialPdf = null, initialPlaybook = null }) {
  if (bgState.running) {
    return { ok: false, error: 'すでにバックグラウンドでタスクを実行中です。' };
  }

  const merged = { ...DEFAULT_SETTINGS, ...settings };
  const initialTab = await chrome.tabs.get(tabId);

  const nanoAdapter = createOffscreenNanoAdapter();
  try {
    await nanoAdapter.initialize({
      useVision: merged.useVision,
      systemPrompt: SYSTEM_PROMPT,
      provider: merged.provider || 'auto',
      useQwenFallback: Boolean(merged.useQwenFallback),
      qwenModel: merged.qwenModel,
      qwenEndpoint: merged.qwenEndpoint
    });
  } catch (error) {
    return {
      ok: false,
      fallbackToForeground: true,
      error: error?.message || String(error)
    };
  }

  const wsContext = await workspace.initialize({
    initialTab,
    multiTabEnabled: merged.allowMultiTab,
    backgroundMode: merged.allowBackgroundExecution,
    groupTitle: merged.tabGroupTitle,
    groupColor: merged.tabGroupColor
  });

  bgState.running = true;
  startKeepAlive();
  bgState.goal = goal;
  bgState.settings = merged;
  bgState.events = [];
  bgState.pendingConfirmation = null;
  bgState.lastOutcome = null;
  bgState.loadedPlaybook = initialPlaybook || null;
  persistBgStateSnapshot(wsContext);

  if (initialPdf?.pdfBase64) {
    try {
      const bytes = base64ToUint8Array(initialPdf.pdfBase64);
      const parsed = await parsePdfBytes(bytes);
      bgState.loadedPdf = {
        filename: initialPdf.filename || 'document.pdf',
        parsed,
        currentPage: initialPdf.currentPage || 1,
        pdfBase64: initialPdf.pdfBase64,
        downloadId: initialPdf.downloadId ?? null
      };
    } catch {
      bgState.loadedPdf = null;
    }
  } else {
    bgState.loadedPdf = null;
  }

  bgController = new AgentController({
    nanoClient: nanoAdapter,
    observe: observeWorkspaceTab,
    executeAction: executeWorkspaceAction,
    requestConfirmation: (details) => {
      bgState.pendingConfirmation = details;
      setActionBadge('!', '#d97706');
      recordAndBroadcastEvent({
        type: 'confirmation_requested',
        details,
        timestamp: Date.now()
      });
      return new Promise((resolve) => {
        pendingConfirmResolver = (res) => {
          bgState.pendingConfirmation = null;
          pendingConfirmResolver = null;
          persistBgStateSnapshot();
          resolve(res);
        };
      });
    },
    onEvent: async (event) => {
      const ws = await workspace.getWorkspaceContext().catch(() => null);
      recordAndBroadcastEvent(event, { workspace: ws });
    }
  });

  // Fire-and-forget execution loop in Service Worker
  bgController
    .run({ goal, settings: merged })
    .finally(async () => {
      stopKeepAlive();
      bgState.running = false;
      bgState.pendingConfirmation = null;
      pendingConfirmResolver = null;
      bgController = null;
      persistBgStateSnapshot();
    });

  return { ok: true, workspace: wsContext };
}

chrome.tabs.onCreated.addListener(async (tab) => {
  try {
    const adopted = await workspace.adoptChildTab(tab);
    if (adopted) {
      const ws = await workspace.getWorkspaceContext();
      chrome.runtime
        .sendMessage({
          type: MSG_TYPES.AGENT_EVENT,
          event: { type: 'workspace_updated', timestamp: Date.now() },
          workspace: ws
        })
        .catch(() => {});
    }
  } catch {
    // Ignore tab adoption failures
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  try {
    const changed = await workspace.handleTabRemoved(tabId);
    if (changed) {
      const ws = await workspace.getWorkspaceContext();
      chrome.runtime
        .sendMessage({
          type: MSG_TYPES.AGENT_EVENT,
          event: { type: 'workspace_updated', timestamp: Date.now() },
          workspace: ws
        })
        .catch(() => {});
    }
  } catch {
    // Ignore tab removal sync failures
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (
    !message ||
    typeof message.type !== 'string' ||
    message.target === 'offscreen' ||
    message.type === MSG_TYPES.AGENT_EVENT
  ) {
    return false;
  }

  (async () => {
    try {
      switch (message.type) {
        case MSG_TYPES.ENSURE_CONTENT_SCRIPT: {
          const result = await ensureContentScript(message.tabId);
          sendResponse(result);
          break;
        }
        case MSG_TYPES.CAPTURE_TAB: {
          const result = await captureTabImage(message.windowId);
          sendResponse(result);
          break;
        }
        case MSG_TYPES.NAVIGATE_TAB: {
          const result = await navigateTab(message.tabId, message.url);
          sendResponse(result);
          break;
        }
        case MSG_TYPES.HISTORY_BACK: {
          const result = await historyStep(message.tabId, 'back');
          sendResponse(result);
          break;
        }
        case MSG_TYPES.HISTORY_FORWARD: {
          const result = await historyStep(message.tabId, 'forward');
          sendResponse(result);
          break;
        }
        case MSG_TYPES.PRINT_TAB_TO_PDF: {
          const result = await printTabToPdf(message.tabId, message.filename, message.saveAs);
          sendResponse(result);
          break;
        }
        case MSG_TYPES.GET_RECENT_PDF_DOWNLOADS: {
          const result = await getRecentPdfDownloads();
          sendResponse(result);
          break;
        }
        case MSG_TYPES.SHOW_DOWNLOAD_IN_FOLDER: {
          if (typeof message.downloadId === 'number') {
            chrome.downloads.show(message.downloadId);
          }
          sendResponse({ ok: true });
          break;
        }
        case MSG_TYPES.INIT_WORKSPACE: {
          const initialTab = await chrome.tabs.get(message.tabId);
          const ws = await workspace.initialize({
            initialTab,
            multiTabEnabled: Boolean(message.multiTabEnabled),
            backgroundMode: Boolean(message.backgroundMode),
            groupTitle: message.groupTitle || 'Nano AI',
            groupColor: message.groupColor || 'blue'
          });
          sendResponse({ ok: true, workspace: ws });
          break;
        }
        case MSG_TYPES.GET_WORKSPACE_STATE: {
          const ws = await workspace.getWorkspaceContext();
          sendResponse({ ok: true, workspace: ws });
          break;
        }
        case MSG_TYPES.OPEN_WORKSPACE_TAB: {
          const res = await workspace.openTab(message.url);
          await waitForTabComplete(res.tab.id, 10000);
          const ws = await workspace.getWorkspaceContext();
          sendResponse({ ok: true, tab: res.tab, workspace: ws });
          break;
        }
        case MSG_TYPES.SWITCH_WORKSPACE_TAB: {
          const res = await workspace.switchTab({
            tabIndex: message.tabIndex,
            tabId: message.tabId
          });
          sendResponse(res);
          break;
        }
        case MSG_TYPES.CLOSE_WORKSPACE_TAB: {
          const res = await workspace.closeTab({
            tabIndex: message.tabIndex,
            tabId: message.tabId
          });
          sendResponse(res);
          break;
        }
        case MSG_TYPES.FOCUS_WORKSPACE_TAB: {
          const ws = await workspace.focusTab(message.tabId);
          sendResponse({ ok: true, workspace: ws });
          break;
        }
        case MSG_TYPES.START_BACKGROUND_RUN: {
          const res = await startBackgroundRun({
            tabId: message.tabId,
            goal: message.goal,
            settings: message.settings,
            initialPdf: message.initialPdf || null,
            initialPlaybook: message.initialPlaybook || null
          });
          sendResponse(res);
          break;
        }
        case MSG_TYPES.STOP_BACKGROUND_RUN: {
          if (pendingConfirmResolver) {
            pendingConfirmResolver({ approved: false, stop: true });
          }
          bgController?.stop();
          bgState.pendingConfirmation = null;
          stopKeepAlive();
          setActionBadge('', '#2563eb');
          persistBgStateSnapshot();
          sendResponse({ ok: true });
          break;
        }
        case MSG_TYPES.RESOLVE_CONFIRMATION: {
          if (pendingConfirmResolver) {
            pendingConfirmResolver(message.decision || { approved: false, stop: true });
            sendResponse({ ok: true });
          } else {
            sendResponse({ ok: false, error: '保留中の確認はありません。' });
          }
          break;
        }
        case MSG_TYPES.GET_BACKGROUND_RUN_STATE: {
          const hydrated = await hydrateBgStateIfNeeded();
          const ws = (await workspace.getWorkspaceContext().catch(() => null)) || hydrated?.workspace || null;
          sendResponse({
            ok: true,
            state: {
              running: bgState.running,
              mode: 'background',
              goal: bgState.goal,
              settings: bgState.settings,
              events: bgState.events,
              pendingConfirmation: bgState.pendingConfirmation,
              lastOutcome: bgState.lastOutcome,
              loadedPdfMeta: bgState.loadedPdf
                ? {
                    filename: bgState.loadedPdf.filename,
                    pdfBase64: bgState.loadedPdf.pdfBase64,
                    downloadId: bgState.loadedPdf.downloadId,
                    currentPage: bgState.loadedPdf.currentPage
                  }
                : null,
              loadedPlaybook: bgState.loadedPlaybook
            },
            workspace: ws
          });
          break;
        }
        case MSG_TYPES.CLEAR_BACKGROUND_RUN_HISTORY: {
          if (!bgState.running) {
            bgState.events = [];
            bgState.lastOutcome = null;
            bgState.pendingConfirmation = null;
            setActionBadge('', '#2563eb');
          }
          await clearRunProgressState(chrome.storage?.local);
          sendResponse({ ok: true });
          break;
        }
        case MSG_TYPES.RUN_WORKFLOW_PRESET: {
          const preset = validateWorkflowPreset(message.preset);
          const compiledPlaybook = compileWorkflowToPlaybook(preset);
          const stored = await chrome.storage.local.get('nano_cu_settings_v1').catch(() => ({}));
          const settings = { ...DEFAULT_SETTINGS, ...(stored?.nano_cu_settings_v1 || {}), ...(message.settings || {}) };

          let targetTab = null;
          if (preset.startUrl) {
            targetTab = await chrome.tabs.create({
              url: preset.startUrl,
              active: !settings.allowBackgroundExecution
            });
            await waitForTabComplete(targetTab.id, 10000);
          } else {
            const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
            targetTab = active;
          }

          if (!targetTab?.id) {
            sendResponse({ ok: false, error: '実行対象のタブが見つかりません。' });
            break;
          }

          const goal =
            compiledPlaybook.goal ||
            `フローチャートプリセット「${preset.name}」の条件分岐とステップに従って実行してください。`;

          const res = await startBackgroundRun({
            tabId: targetTab.id,
            goal,
            settings,
            initialPlaybook: compiledPlaybook
          });
          sendResponse(res);
          break;
        }
        case MSG_TYPES.OPEN_MEDIA_IN_VIEWER: {
          const res = await openMediaInViewerTab({
            url: message.url || '',
            filename: message.filename || '',
            mimeType: message.mimeType || '',
            bytesBase64: message.bytesBase64 || '',
            fetchViaDebugger: Boolean(message.fetchViaDebugger),
            inWorkspace: Boolean(message.inWorkspace)
          });
          sendResponse(res);
          break;
        }
        case MSG_TYPES.SET_VIEWER_INTERCEPT_CONFIG: {
          if (typeof message.enabled === 'boolean') {
            viewerInterceptConfig.enabled = message.enabled;
          }
          if (typeof message.fgRunActive === 'boolean') {
            viewerInterceptConfig.fgRunActive = message.fgRunActive;
          }
          sendResponse({ ok: true, config: viewerInterceptConfig });
          break;
        }
        default:
          sendResponse({ ok: false, error: `Unknown message type: ${message.type}` });
          break;
      }
    } catch (error) {
      sendResponse({ ok: false, error: error?.message || String(error) });
    }
  })();

  return true;
});

// Intercept direct downloads of supported viewer media while extension or agent is active
chrome.downloads?.onDeterminingFilename?.addListener((item, suggest) => {
  // Never intercept downloads initiated by this extension itself (e.g. Save Locally / Print PDF / Templates)
  if (!item || item.byExtensionId === chrome.runtime.id) {
    suggest();
    return false;
  }

  const targetUrl = item.finalUrl || item.url || '';
  if (!viewerInterceptConfig.enabled || !/^https?:/i.test(targetUrl)) {
    suggest();
    return false;
  }

  const spec = classifyViewerMedia({
    url: targetUrl,
    filename: item.filename || '',
    mimeType: item.mime || ''
  });
  if (!spec.supported) {
    suggest();
    return false;
  }

  (async () => {
    try {
      let panelOpen = false;
      if (!bgState.running && !viewerInterceptConfig.fgRunActive && typeof chrome.runtime.getContexts === 'function') {
        const panels = await chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL'] }).catch(() => []);
        panelOpen = panels.length > 0;
      }

      if (!bgState.running && !viewerInterceptConfig.fgRunActive && !panelOpen) {
        suggest();
        return;
      }

      await chrome.downloads.cancel(item.id).catch(() => {});
      await chrome.downloads.erase({ id: item.id }).catch(() => {});
      suggest();

      await openMediaInViewerTab({
        url: targetUrl,
        filename: item.filename || '',
        mimeType: item.mime || spec.mimeType,
        fetchViaDebugger: true,
        inWorkspace: bgState.running || viewerInterceptConfig.fgRunActive
      });
    } catch {
      try {
        suggest();
      } catch {
        // Ignore
      }
    }
  })();

  return true;
});
