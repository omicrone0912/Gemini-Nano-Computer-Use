import { MSG_TYPES } from '../shared/constants.js';
import { sanitizePdfFilename } from '../shared/pdf-parser.js';

function isRestrictedUrl(url = '') {
  if (!url) return true;
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

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') {
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
