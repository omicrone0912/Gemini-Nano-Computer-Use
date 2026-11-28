export const PANEL_STATE_STORAGE_KEY = 'nano_cu_panel_state_v1';
export const RUN_STATE_STORAGE_KEY = 'nano_cu_run_state_v1';

export function compactPlaybookForStorage(playbook, { includeImages = true } = {}) {
  if (!playbook || typeof playbook !== 'object') return null;
  const images =
    includeImages && Array.isArray(playbook.images)
      ? playbook.images.slice(0, 10).map((img, idx) => ({
          index: img.index ?? idx + 1,
          name: String(img.name || `image-${idx + 1}.jpg`),
          mimeType: String(img.mimeType || 'image/jpeg'),
          dataUrl: String(img.dataUrl || ''),
          byteLength: Number(img.byteLength) || 0,
          stepHint: String(img.stepHint || '')
        }))
      : [];

  return {
    filename: String(playbook.filename || 'playbook.md'),
    title: String(playbook.title || '手順書'),
    goal: String(playbook.goal || ''),
    startUrl: String(playbook.startUrl || ''),
    steps: Array.isArray(playbook.steps) ? playbook.steps.map((s) => String(s)) : [],
    images,
    strictMode: playbook.strictMode !== false,
    rawText: String(playbook.rawText || ''),
    charCount: Number(playbook.charCount) || String(playbook.rawText || '').length
  };
}

export function compactEventsForStorage(events, { maxEvents = 80, keepPreviewCount = 8 } = {}) {
  if (!Array.isArray(events) || events.length === 0) return [];
  const sliced = events.slice(-maxEvents).map((ev) => ({ ...ev }));
  let keptPreviews = 0;

  for (let i = sliced.length - 1; i >= 0; i -= 1) {
    if (sliced[i].previewDataUrl) {
      if (keptPreviews < keepPreviewCount) {
        keptPreviews += 1;
      } else {
        delete sliced[i].previewDataUrl;
      }
    }
  }
  return sliced;
}

export async function savePanelSessionState(storageArea, state = {}) {
  if (!storageArea?.set) return false;

  const buildPayload = (includeImages) => ({
    goal: String(state.goal || ''),
    selectedPresetId: String(state.selectedPresetId || ''),
    activeMainTab: state.activeMainTab === 'flow' ? 'flow' : 'agent',
    playbookSectionOpen: Boolean(state.playbookSectionOpen),
    loadedPlaybook: compactPlaybookForStorage(state.loadedPlaybook, { includeImages }),
    updatedAt: Date.now()
  });

  try {
    await storageArea.set({ [PANEL_STATE_STORAGE_KEY]: buildPayload(true) });
    return true;
  } catch {
    try {
      await storageArea.set({ [PANEL_STATE_STORAGE_KEY]: buildPayload(false) });
      return true;
    } catch {
      return false;
    }
  }
}

export async function loadPanelSessionState(storageArea) {
  if (!storageArea?.get) return null;
  try {
    const res = await storageArea.get(PANEL_STATE_STORAGE_KEY);
    const saved = res?.[PANEL_STATE_STORAGE_KEY];
    return saved && typeof saved === 'object' ? saved : null;
  } catch {
    return null;
  }
}

export async function saveRunProgressState(storageArea, runState = {}) {
  if (!storageArea?.set) return false;

  const buildPayload = (keepPreviewCount, includeImages) => ({
    running: Boolean(runState.running),
    mode: runState.mode === 'foreground' ? 'foreground' : 'background',
    goal: String(runState.goal || ''),
    settings: runState.settings ? { ...runState.settings } : null,
    events: compactEventsForStorage(runState.events, { maxEvents: 80, keepPreviewCount }),
    pendingConfirmation: runState.pendingConfirmation ? { ...runState.pendingConfirmation } : null,
    lastOutcome: runState.lastOutcome ? { ...runState.lastOutcome } : null,
    loadedPlaybook: compactPlaybookForStorage(runState.loadedPlaybook, { includeImages }),
    workspace: runState.workspace ? { ...runState.workspace } : null,
    updatedAt: Date.now()
  });

  try {
    await storageArea.set({ [RUN_STATE_STORAGE_KEY]: buildPayload(8, true) });
    return true;
  } catch {
    try {
      await storageArea.set({ [RUN_STATE_STORAGE_KEY]: buildPayload(0, false) });
      return true;
    } catch {
      return false;
    }
  }
}

export function isLegacyMaxStepsRunState(runState) {
  if (!runState || typeof runState !== 'object' || runState.running) {
    return false;
  }
  if (
    runState.lastOutcome?.status === 'max_steps' ||
    String(runState.lastOutcome?.message || '').includes('最大ステップ数に達した')
  ) {
    return true;
  }
  if (
    Array.isArray(runState.events) &&
    runState.events.some(
      (ev) =>
        ev?.type === 'run_finished' &&
        (ev.status === 'max_steps' || String(ev.message || '').includes('最大ステップ数に達した'))
    )
  ) {
    return true;
  }
  return false;
}

export async function loadRunProgressState(storageArea) {
  if (!storageArea?.get) return null;
  try {
    const res = await storageArea.get(RUN_STATE_STORAGE_KEY);
    const saved = res?.[RUN_STATE_STORAGE_KEY];
    if (!saved || typeof saved !== 'object') {
      return null;
    }
    if (isLegacyMaxStepsRunState(saved)) {
      await clearRunProgressState(storageArea);
      return null;
    }
    return saved;
  } catch {
    return null;
  }
}

export async function clearRunProgressState(storageArea) {
  if (!storageArea) return false;
  try {
    if (typeof storageArea.remove === 'function') {
      await storageArea.remove(RUN_STATE_STORAGE_KEY);
      return true;
    }
    if (typeof storageArea.set === 'function') {
      await storageArea.set({ [RUN_STATE_STORAGE_KEY]: null });
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

export function buildReplayPlan(runState) {
  if (!runState || typeof runState !== 'object' || isLegacyMaxStepsRunState(runState)) {
    return {
      shouldRestore: false,
      running: false,
      mode: 'background',
      goal: '',
      loadedPlaybook: null,
      workspace: null,
      eventsToReplay: [],
      pendingConfirmation: null,
      lastOutcome: null
    };
  }

  const rawEvents = Array.isArray(runState.events) ? runState.events : [];
  // Do not replay historical confirmation_requested events so resolved cards never pop back up
  const eventsToReplay = rawEvents.filter((ev) => ev && ev.type !== 'confirmation_requested');
  const running = Boolean(runState.running);
  const pendingConfirmation = running && runState.pendingConfirmation ? runState.pendingConfirmation : null;
  const shouldRestore = running || eventsToReplay.length > 0 || Boolean(runState.lastOutcome);

  return {
    shouldRestore,
    running,
    mode: runState.mode === 'foreground' ? 'foreground' : 'background',
    goal: String(runState.goal || ''),
    loadedPlaybook: runState.loadedPlaybook || null,
    workspace: runState.workspace || null,
    eventsToReplay,
    pendingConfirmation,
    lastOutcome: runState.lastOutcome || null
  };
}
