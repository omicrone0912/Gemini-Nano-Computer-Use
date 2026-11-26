import { MSG_TYPES } from '../shared/constants.js';
import {
  classifyViewerMedia,
  detectMagicMimeType,
  inspectIllustratorBytes,
  inspectVideoContainerBytes
} from '../shared/media-viewer.js';
import { extractPdfPageSnippet, parsePdfBytes } from '../shared/pdf-parser.js';
import { getViewerMedia, saveViewerMedia } from '../shared/viewer-storage.js';

const els = {
  mediaTypeBadge: document.getElementById('mediaTypeBadge'),
  mediaFilename: document.getElementById('mediaFilename'),
  mediaMetaStats: document.getElementById('mediaMetaStats'),
  openLocalFileBtn: document.getElementById('openLocalFileBtn'),
  localFileInput: document.getElementById('localFileInput'),
  saveLocalBtn: document.getElementById('saveLocalBtn'),
  viewerStatusBanner: document.getElementById('viewerStatusBanner'),
  viewerMain: document.getElementById('viewerMain'),
  viewerDropZone: document.getElementById('viewerDropZone'),
  imageStage: document.getElementById('imageStage'),
  imgZoomOutBtn: document.getElementById('imgZoomOutBtn'),
  imgZoomResetBtn: document.getElementById('imgZoomResetBtn'),
  imgZoomInBtn: document.getElementById('imgZoomInBtn'),
  imgRotateBtn: document.getElementById('imgRotateBtn'),
  imgZoomLabel: document.getElementById('imgZoomLabel'),
  imagePreview: document.getElementById('imagePreview'),
  videoStage: document.getElementById('videoStage'),
  videoPlayPauseBtn: document.getElementById('videoPlayPauseBtn'),
  videoBack5Btn: document.getElementById('videoBack5Btn'),
  videoFwd5Btn: document.getElementById('videoFwd5Btn'),
  videoStartBtn: document.getElementById('videoStartBtn'),
  video25Btn: document.getElementById('video25Btn'),
  video50Btn: document.getElementById('video50Btn'),
  video75Btn: document.getElementById('video75Btn'),
  videoStatusText: document.getElementById('videoStatusText'),
  videoErrorBanner: document.getElementById('videoErrorBanner'),
  videoPlayer: document.getElementById('videoPlayer'),
  docStage: document.getElementById('docStage'),
  docViewPreviewBtn: document.getElementById('docViewPreviewBtn'),
  docViewTextBtn: document.getElementById('docViewTextBtn'),
  docPrevPageBtn: document.getElementById('docPrevPageBtn'),
  docPageIndicator: document.getElementById('docPageIndicator'),
  docNextPageBtn: document.getElementById('docNextPageBtn'),
  docPreviewPane: document.getElementById('docPreviewPane'),
  docPreviewFrame: document.getElementById('docPreviewFrame'),
  docTextPane: document.getElementById('docTextPane'),
  docExtractedText: document.getElementById('docExtractedText')
};

let myTabId = null;
let currentMedia = null;
let activeBlobUrls = [];
let primaryBlobUrl = null;
let imageZoom = 1;
let imageRotation = 0;
let parsedDoc = null;
let docCurrentPage = 1;
let docShowText = false;
let videoInfo = null;
let triedVideoFallback = false;
let activeVideoMime = '';
const viewerElementMap = new Map();

function formatBytes(size = 0) {
  if (!Number.isFinite(size) || size <= 0) return '0 B';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(2)} MB`;
}

function formatSeconds(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '0:00';
  const total = Math.floor(sec);
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

function revokeAllBlobs() {
  for (const url of activeBlobUrls) {
    try {
      URL.revokeObjectURL(url);
    } catch {
      // Ignore
    }
  }
  activeBlobUrls = [];
  primaryBlobUrl = null;
}

function createManagedBlobUrl(bytes, mimeType) {
  const blob = new Blob([bytes], { type: mimeType });
  const url = URL.createObjectURL(blob);
  activeBlobUrls.push(url);
  return url;
}

function showStatus(msg, isError = false) {
  if (!msg) {
    els.viewerStatusBanner.classList.add('hidden');
    return;
  }
  els.viewerStatusBanner.textContent = msg;
  els.viewerStatusBanner.className = `viewer-banner${isError ? ' error' : ''}`;
  els.viewerStatusBanner.classList.remove('hidden');
}

function hideAllStages() {
  els.viewerDropZone.classList.add('hidden');
  els.imageStage.classList.add('hidden');
  els.videoStage.classList.add('hidden');
  els.docStage.classList.add('hidden');
  els.videoErrorBanner.classList.add('hidden');
}

function applyImageTransform() {
  // Direct CSSOM property assignment (no cssText / style attribute string) for strict CSP compliance
  els.imagePreview.style.transform = `scale(${imageZoom}) rotate(${imageRotation}deg)`;
  els.imgZoomLabel.textContent = `${Math.round(imageZoom * 100)}% / ${imageRotation}°`;
}

function updateVideoStatusBar() {
  if (!els.videoPlayer) return;
  const cur = formatSeconds(els.videoPlayer.currentTime);
  const dur = formatSeconds(els.videoPlayer.duration);
  const state = els.videoPlayer.paused ? '一時停止' : '再生中';
  const codecPart = videoInfo
    ? `${videoInfo.container} / 映像:${videoInfo.videoCodec} / 音声:${videoInfo.audioCodec} ・ `
    : '';
  els.videoStatusText.textContent = `${codecPart}${state} ${cur} / ${dur}`;
}

function switchDocView(showText) {
  docShowText = Boolean(showText);
  els.docViewPreviewBtn.className = `btn btn-xs ${docShowText ? 'btn-secondary' : 'btn-primary'}`;
  els.docViewTextBtn.className = `btn btn-xs ${docShowText ? 'btn-primary' : 'btn-secondary'}`;
  els.docPreviewPane.classList.toggle('hidden', docShowText);
  els.docTextPane.classList.toggle('hidden', !docShowText);
}

function renderDocPageUi() {
  if (!parsedDoc) {
    els.docPageIndicator.textContent = '1 / 1';
    els.docPrevPageBtn.disabled = true;
    els.docNextPageBtn.disabled = true;
    return;
  }
  const total = Math.max(1, parsedDoc.pageCount);
  docCurrentPage = Math.max(1, Math.min(total, docCurrentPage));
  els.docPageIndicator.textContent = `${docCurrentPage} / ${total}`;
  els.docPrevPageBtn.disabled = docCurrentPage <= 1;
  els.docNextPageBtn.disabled = docCurrentPage >= total;

  if (primaryBlobUrl && !els.docViewPreviewBtn.disabled) {
    const frameTarget = `${primaryBlobUrl}#page=${docCurrentPage}`;
    if (els.docPreviewFrame.src !== frameTarget) {
      els.docPreviewFrame.src = frameTarget;
    }
  }

  const pageText = parsedDoc.pages?.[docCurrentPage - 1]?.text;
  els.docExtractedText.textContent =
    pageText || `（${docCurrentPage} ページ目に抽出可能なテキストが見つかりませんでした。プレビューをご確認ください）`;
}

async function renderLoadedRecord(record) {
  revokeAllBlobs();
  els.videoPlayer.pause();
  els.videoPlayer.removeAttribute('src');
  els.docPreviewFrame.src = 'about:blank';
  els.imagePreview.removeAttribute('src');
  parsedDoc = null;
  docCurrentPage = 1;
  videoInfo = null;
  triedVideoFallback = false;
  showStatus('');

  if (!record || !(record.bytes instanceof Uint8Array)) {
    hideAllStages();
    els.viewerDropZone.classList.remove('hidden');
    els.saveLocalBtn.disabled = true;
    return;
  }

  const detectedMime = detectMagicMimeType(record.bytes);
  const spec = classifyViewerMedia({
    url: record.sourceUrl,
    filename: record.filename,
    mimeType: record.mimeType || detectedMime
  });

  currentMedia = {
    ...record,
    category: spec.supported ? spec.category : record.category,
    label: spec.supported ? spec.label : 'メディア',
    mimeType: spec.supported ? spec.mimeType : detectedMime || record.mimeType || 'application/octet-stream'
  };

  document.title = `${currentMedia.filename} - Gemini Nano 簡易ビュワー`;
  els.mediaTypeBadge.textContent = currentMedia.label;
  els.mediaFilename.textContent = currentMedia.filename;
  els.mediaMetaStats.textContent = `${formatBytes(currentMedia.bytes.byteLength)}${
    currentMedia.sourceUrl ? ` ・ ${currentMedia.sourceUrl}` : ''
  }`;
  els.saveLocalBtn.disabled = false;

  hideAllStages();

  if (currentMedia.category === 'image') {
    const mime =
      detectedMime && detectedMime.startsWith('image/') ? detectedMime : currentMedia.mimeType || 'image/png';
    primaryBlobUrl = createManagedBlobUrl(currentMedia.bytes, mime);
    imageZoom = 1;
    imageRotation = 0;
    applyImageTransform();
    els.imageStage.classList.remove('hidden');
    els.imagePreview.src = primaryBlobUrl;
    return;
  }

  if (currentMedia.category === 'video') {
    videoInfo = inspectVideoContainerBytes(currentMedia.bytes, currentMedia.mimeType);
    activeVideoMime = videoInfo.preferredMimeType;
    primaryBlobUrl = createManagedBlobUrl(currentMedia.bytes, activeVideoMime);
    els.videoStage.classList.remove('hidden');
    updateVideoStatusBar();
    els.videoPlayer.src = primaryBlobUrl;
    return;
  }

  if (currentMedia.category === 'illustrator') {
    const aiInfo = inspectIllustratorBytes(currentMedia.bytes);
    els.docStage.classList.remove('hidden');

    if (aiInfo.isPdfCompatible) {
      const pdfBytes =
        aiInfo.pdfOffset > 0 ? currentMedia.bytes.subarray(aiInfo.pdfOffset) : currentMedia.bytes;
      primaryBlobUrl = createManagedBlobUrl(pdfBytes, 'application/pdf');
      els.docViewPreviewBtn.disabled = false;
      switchDocView(false);
      try {
        parsedDoc = await parsePdfBytes(pdfBytes);
        els.mediaMetaStats.textContent = `${formatBytes(currentMedia.bytes.byteLength)} ・ PDF互換Illustrator (${parsedDoc.pageCount}P)`;
      } catch {
        parsedDoc = null;
      }
      renderDocPageUi();
    } else {
      primaryBlobUrl = createManagedBlobUrl(currentMedia.bytes, 'application/postscript');
      els.docViewPreviewBtn.disabled = true;
      switchDocView(true);
      els.docPageIndicator.textContent = '1 / 1 (EPS/PS)';
      els.docPrevPageBtn.disabled = true;
      els.docNextPageBtn.disabled = true;
      els.docExtractedText.textContent =
        aiInfo.extractedText || 'PostScript 形式の .ai ファイルです（抽出テキストなし）。';
    }
    return;
  }

  // Default: PDF document
  primaryBlobUrl = createManagedBlobUrl(currentMedia.bytes, 'application/pdf');
  els.docStage.classList.remove('hidden');
  els.docViewPreviewBtn.disabled = false;
  switchDocView(false);
  try {
    parsedDoc = await parsePdfBytes(currentMedia.bytes);
    els.mediaMetaStats.textContent = `${formatBytes(currentMedia.bytes.byteLength)} ・ PDF v${parsedDoc.version} (${parsedDoc.pageCount}P)`;
  } catch (error) {
    showStatus(`PDF テキスト解析に失敗しました（プレビュー表示は続行）: ${error?.message || error}`, true);
  }
  renderDocPageUi();
}

async function openLocalFile(file) {
  if (!file) return;
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  const spec = classifyViewerMedia({ filename: file.name, mimeType: file.type });
  if (!spec.supported) {
    showStatus(`非対応のファイル形式です: ${file.name}`, true);
    return;
  }
  const saved = await saveViewerMedia({
    filename: file.name,
    mimeType: spec.mimeType,
    category: spec.category,
    ext: spec.ext,
    bytes
  });
  await renderLoadedRecord(saved);
}

// Image viewer controls
els.imgZoomOutBtn.addEventListener('click', () => {
  imageZoom = Math.max(0.25, Number((imageZoom - 0.25).toFixed(2)));
  applyImageTransform();
});
els.imgZoomResetBtn.addEventListener('click', () => {
  imageZoom = 1;
  imageRotation = 0;
  applyImageTransform();
});
els.imgZoomInBtn.addEventListener('click', () => {
  imageZoom = Math.min(4, Number((imageZoom + 0.25).toFixed(2)));
  applyImageTransform();
});
els.imgRotateBtn.addEventListener('click', () => {
  imageRotation = (imageRotation + 90) % 360;
  applyImageTransform();
});
els.imagePreview.addEventListener('load', () => {
  if (currentMedia) {
    els.mediaMetaStats.textContent = `${els.imagePreview.naturalWidth}×${els.imagePreview.naturalHeight}px ・ ${formatBytes(
      currentMedia.bytes.byteLength
    )}${currentMedia.sourceUrl ? ` ・ ${currentMedia.sourceUrl}` : ''}`;
  }
});

// Video viewer controls
function seekVideoByRatio(ratio) {
  const dur = els.videoPlayer.duration;
  if (Number.isFinite(dur) && dur > 0) {
    els.videoPlayer.currentTime = Math.max(0, Math.min(dur, dur * ratio));
    updateVideoStatusBar();
  }
}
els.videoPlayPauseBtn.addEventListener('click', async () => {
  if (els.videoPlayer.paused) {
    await els.videoPlayer.play().catch(() => {});
  } else {
    els.videoPlayer.pause();
  }
  updateVideoStatusBar();
});
els.videoBack5Btn.addEventListener('click', () => {
  els.videoPlayer.currentTime = Math.max(0, (els.videoPlayer.currentTime || 0) - 5);
  updateVideoStatusBar();
});
els.videoFwd5Btn.addEventListener('click', () => {
  const dur = els.videoPlayer.duration || Infinity;
  els.videoPlayer.currentTime = Math.min(dur, (els.videoPlayer.currentTime || 0) + 5);
  updateVideoStatusBar();
});
els.videoStartBtn.addEventListener('click', () => {
  els.videoPlayer.currentTime = 0;
  updateVideoStatusBar();
});
els.video25Btn.addEventListener('click', () => seekVideoByRatio(0.25));
els.video50Btn.addEventListener('click', () => seekVideoByRatio(0.5));
els.video75Btn.addEventListener('click', () => seekVideoByRatio(0.75));
els.videoPlayer.addEventListener('loadedmetadata', updateVideoStatusBar);
els.videoPlayer.addEventListener('timeupdate', updateVideoStatusBar);
els.videoPlayer.addEventListener('play', updateVideoStatusBar);
els.videoPlayer.addEventListener('pause', updateVideoStatusBar);
els.videoPlayer.addEventListener('error', () => {
  if (!triedVideoFallback && currentMedia && videoInfo && videoInfo.fallbackMimeType !== activeVideoMime) {
    triedVideoFallback = true;
    activeVideoMime = videoInfo.fallbackMimeType;
    primaryBlobUrl = createManagedBlobUrl(currentMedia.bytes, activeVideoMime);
    els.videoPlayer.src = primaryBlobUrl;
    return;
  }
  els.videoErrorBanner.textContent = `この動画コーデック（${
    videoInfo?.videoCodec || '不明'
  } / ${videoInfo?.container || '動画'}）は現在の Chrome 環境で直接再生できない可能性があります。「ローカルに保存」から外部プレイヤーで開くこともできます。`;
  els.videoErrorBanner.classList.remove('hidden');
});

// Document (PDF / AI) controls
els.docViewPreviewBtn.addEventListener('click', () => switchDocView(false));
els.docViewTextBtn.addEventListener('click', () => switchDocView(true));
els.docPrevPageBtn.addEventListener('click', () => {
  if (docCurrentPage <= 1) return;
  docCurrentPage -= 1;
  renderDocPageUi();
});
els.docNextPageBtn.addEventListener('click', () => {
  if (!parsedDoc || docCurrentPage >= parsedDoc.pageCount) return;
  docCurrentPage += 1;
  renderDocPageUi();
});

// Header & dropzone file actions
els.openLocalFileBtn.addEventListener('click', () => {
  els.localFileInput.value = '';
  els.localFileInput.click();
});
els.localFileInput.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (file) {
    await openLocalFile(file);
  }
});
els.saveLocalBtn.addEventListener('click', async () => {
  if (!currentMedia || !primaryBlobUrl) return;
  if (chrome.downloads?.download) {
    await chrome.downloads.download({
      url: primaryBlobUrl,
      filename: currentMedia.filename || 'media',
      saveAs: true
    });
  } else {
    const a = document.createElement('a');
    a.href = primaryBlobUrl;
    a.download = currentMedia.filename || 'media';
    a.click();
  }
});

els.viewerMain.addEventListener('dragover', (e) => {
  e.preventDefault();
  els.viewerMain.classList.add('drag-over');
});
els.viewerMain.addEventListener('dragleave', () => {
  els.viewerMain.classList.remove('drag-over');
});
els.viewerMain.addEventListener('drop', async (e) => {
  e.preventDefault();
  els.viewerMain.classList.remove('drag-over');
  const file = e.dataTransfer?.files?.[0];
  if (file) {
    await openLocalFile(file);
  }
});

// AI observation & remote control bridge
function collectViewerElements() {
  viewerElementMap.clear();
  const candidates = Array.from(document.querySelectorAll('button:not(.hidden), input:not([type="hidden"]):not(.hidden)'));
  const list = [];
  let counter = 1;
  for (const el of candidates) {
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || el.closest('.hidden')) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width < 4 || rect.height < 4) continue;
    const id = counter;
    counter += 1;
    viewerElementMap.set(id, el);
    list.push({
      id,
      tag: el.tagName.toLowerCase(),
      label: el.innerText?.trim() || el.title || '',
      disabled: Boolean(el.disabled),
      rect: {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      }
    });
  }
  return list;
}

function captureCurrentMediaFrameDataUrl(maxWidth = 768) {
  try {
    if (currentMedia?.category === 'image' && els.imagePreview.complete && els.imagePreview.naturalWidth > 0) {
      const iw = els.imagePreview.naturalWidth;
      const ih = els.imagePreview.naturalHeight;
      const rotated = imageRotation % 180 !== 0;
      const srcW = rotated ? ih : iw;
      const srcH = rotated ? iw : ih;
      const scale = srcW > maxWidth ? maxWidth / srcW : 1;
      const cw = Math.max(1, Math.round(srcW * scale));
      const ch = Math.max(1, Math.round(srcH * scale));
      const canvas = document.createElement('canvas');
      canvas.width = cw;
      canvas.height = ch;
      const ctx = canvas.getContext('2d');
      ctx.translate(cw / 2, ch / 2);
      ctx.rotate((imageRotation * Math.PI) / 180);
      ctx.drawImage(els.imagePreview, -(iw * scale) / 2, -(ih * scale) / 2, iw * scale, ih * scale);
      return canvas.toDataURL('image/jpeg', 0.85);
    }

    if (
      currentMedia?.category === 'video' &&
      els.videoPlayer.readyState >= 2 &&
      els.videoPlayer.videoWidth > 0
    ) {
      const vw = els.videoPlayer.videoWidth;
      const vh = els.videoPlayer.videoHeight;
      const scale = vw > maxWidth ? maxWidth / vw : 1;
      const cw = Math.max(1, Math.round(vw * scale));
      const ch = Math.max(1, Math.round(vh * scale));
      const canvas = document.createElement('canvas');
      canvas.width = cw;
      canvas.height = ch;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(els.videoPlayer, 0, 0, cw, ch);
      return canvas.toDataURL('image/jpeg', 0.85);
    }
  } catch {
    // Ignore canvas draw failure
  }
  return null;
}

function buildViewerSnapshot(maxImageWidth = 768) {
  const elements = collectViewerElements();
  let details = '';
  let viewerPdfContext = null;

  if (!currentMedia) {
    details = '簡易ビュワー待機中: ファイルはまだ開かれていません。';
  } else if (currentMedia.category === 'image') {
    details = `画像ファイル: ${currentMedia.filename} (${currentMedia.label}, ${els.imagePreview.naturalWidth}×${els.imagePreview.naturalHeight}px)`;
  } else if (currentMedia.category === 'video') {
    details = `動画ファイル: ${currentMedia.filename} (${els.videoStatusText.textContent})`;
  } else if (parsedDoc) {
    const snippet = extractPdfPageSnippet(parsedDoc, docCurrentPage, 1600);
    viewerPdfContext = {
      filename: currentMedia.filename,
      pageCount: parsedDoc.pageCount,
      currentPage: snippet.pageNumber,
      currentPageText: snippet.text
    };
    details = `${currentMedia.label}: ${currentMedia.filename} (${snippet.pageNumber}/${parsedDoc.pageCount}P)\n${snippet.text || ''}`;
  } else {
    details = `${currentMedia.label}: ${currentMedia.filename}\n${(els.docExtractedText.textContent || '').slice(0, 1200)}`;
  }

  return {
    snapshot: {
      restricted: false,
      url: location.href,
      title: document.title,
      viewport: {
        width: window.innerWidth || 1280,
        height: window.innerHeight || 800,
        devicePixelRatio: window.devicePixelRatio || 1
      },
      scroll: {
        x: window.scrollX || 0,
        y: window.scrollY || 0,
        maxY: 0
      },
      elements,
      textExcerpt: details.slice(0, 1200)
    },
    viewerImageDataUrl: captureCurrentMediaFrameDataUrl(maxImageWidth),
    viewerPdfContext
  };
}

async function executeViewerAction(action) {
  if (!action) return { ok: false, error: 'アクションが空です。' };

  if (action.action === 'click') {
    const el = viewerElementMap.get(action.elementId);
    if (!el) {
      return { ok: false, error: `ビュワー内の要素 #${action.elementId} が見つかりません。` };
    }
    el.click();
    await new Promise((r) => setTimeout(r, 150));
    return { ok: true, detail: `簡易ビュワーの「${el.innerText?.trim() || `#${action.elementId}`}」を実行しました。` };
  }

  if (action.action === 'read_pdf') {
    if (!parsedDoc) {
      return {
        ok: false,
        error: 'このファイルからページ付きテキストを取得できませんでした。'
      };
    }
    const reqPage = Math.max(1, Math.min(parsedDoc.pageCount || 1, Number(action.page) || 1));
    docCurrentPage = reqPage;
    renderDocPageUi();
    const snippet = extractPdfPageSnippet(parsedDoc, reqPage, 1600);
    return {
      ok: true,
      detail: `簡易ビュワーで「${currentMedia?.filename || '文書'}」の ${reqPage} / ${parsedDoc.pageCount} ページを表示しました。`,
      promptNote: snippet.text
        ? `${currentMedia?.filename || '文書'} P.${reqPage}: ${snippet.text}`
        : `${currentMedia?.filename || '文書'} P.${reqPage} にテキストがありません。`
    };
  }

  if (action.action === 'scroll') {
    const target = !els.docTextPane.classList.contains('hidden') ? els.docExtractedText : window;
    const delta = action.direction === 'up' ? -420 : 420;
    if (action.direction === 'top') {
      target.scrollTo({ top: 0, behavior: 'smooth' });
    } else if (action.direction === 'bottom') {
      target.scrollTo({ top: 999999, behavior: 'smooth' });
    } else {
      target.scrollBy({ top: delta, behavior: 'smooth' });
    }
    return { ok: true, detail: `簡易ビュワー内を ${action.direction || 'down'} スクロールしました。` };
  }

  if (action.action === 'press_key') {
    if (currentMedia?.category === 'video') {
      if (action.key === ' ') {
        els.videoPlayPauseBtn.click();
      } else if (action.key === 'ArrowRight') {
        els.videoFwd5Btn.click();
      } else if (action.key === 'ArrowLeft') {
        els.videoBack5Btn.click();
      }
      return { ok: true, detail: `動画ビュワーへキー "${action.key}" を送信しました。` };
    }
    if (parsedDoc) {
      if (action.key === 'ArrowRight' || action.key === 'ArrowDown') {
        els.docNextPageBtn.click();
      } else if (action.key === 'ArrowLeft' || action.key === 'ArrowUp') {
        els.docPrevPageBtn.click();
      }
      return { ok: true, detail: `文書ビュワーへキー "${action.key}" を送信しました。` };
    }
  }

  return { ok: false, error: `簡易ビュワー未対応のアクション: ${action.action}` };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return false;
  if (message.targetTabId !== undefined && myTabId !== null && message.targetTabId !== myTabId) {
    return false;
  }

  if (message.type === MSG_TYPES.VIEWER_CAPTURE_SNAPSHOT) {
    try {
      const payload = buildViewerSnapshot(message.maxImageWidth || 768);
      sendResponse({ ok: true, ...payload });
    } catch (error) {
      sendResponse({ ok: false, error: error?.message || String(error) });
    }
    return false;
  }

  if (message.type === MSG_TYPES.VIEWER_EXECUTE_ACTION) {
    executeViewerAction(message.action)
      .then((res) => sendResponse(res))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  return false;
});

// Boot
async function bootViewer() {
  try {
    const tab = await chrome.tabs?.getCurrent?.();
    if (tab?.id) myTabId = tab.id;
  } catch {
    // Ignore
  }

  const params = new URLSearchParams(location.search);
  const mediaId = params.get('id');
  if (mediaId) {
    try {
      const record = await getViewerMedia(mediaId);
      if (record) {
        await renderLoadedRecord(record);
      } else {
        showStatus('指定されたメディアデータが見つかりませんでした（有効期限切れまたは削除済み）。', true);
      }
    } catch (error) {
      showStatus(`メディアの読み込みに失敗しました: ${error?.message || error}`, true);
    }
  }
}

bootViewer();
