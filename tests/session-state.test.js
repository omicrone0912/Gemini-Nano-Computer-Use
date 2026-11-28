import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PANEL_STATE_STORAGE_KEY,
  RUN_STATE_STORAGE_KEY,
  buildReplayPlan,
  clearRunProgressState,
  compactEventsForStorage,
  isLegacyMaxStepsRunState,
  loadPanelSessionState,
  loadRunProgressState,
  savePanelSessionState,
  saveRunProgressState
} from '../shared/session-state.js';

function createMemoryStorage({ failWhenLargerThan = Infinity } = {}) {
  const map = new Map();
  return {
    async get(key) {
      return { [key]: map.get(key) };
    },
    async set(obj) {
      const size = JSON.stringify(obj).length;
      if (size > failWhenLargerThan) {
        throw new Error('QuotaExceededError');
      }
      for (const [k, v] of Object.entries(obj)) {
        map.set(k, structuredClone(v));
      }
    },
    async remove(key) {
      map.delete(key);
    },
    _map: map
  };
}

test('savePanelSessionState and loadPanelSessionState persist playbook, goal, preset, and active tab', async () => {
  const storage = createMemoryStorage();
  const samplePlaybook = {
    filename: 'sop.docx',
    title: '月次処理',
    goal: 'ポータルから請求書を確認',
    startUrl: 'https://portal.example.com',
    steps: ['1. 開く', '2. 完了'],
    images: [{ index: 1, name: 'screen.jpg', mimeType: 'image/jpeg', dataUrl: 'data:image/jpeg;base64,AAA=' }],
    strictMode: true,
    rawText: '# 手順書タイトル: 月次処理'
  };

  const ok = await savePanelSessionState(storage, {
    goal: 'ポータルから請求書を確認',
    selectedPresetId: 'preset_1',
    activeMainTab: 'flow',
    playbookSectionOpen: true,
    loadedPlaybook: samplePlaybook
  });
  assert.equal(ok, true);

  const loaded = await loadPanelSessionState(storage);
  assert.equal(loaded.goal, 'ポータルから請求書を確認');
  assert.equal(loaded.selectedPresetId, 'preset_1');
  assert.equal(loaded.activeMainTab, 'flow');
  assert.equal(loaded.playbookSectionOpen, true);
  assert.equal(loaded.loadedPlaybook.title, '月次処理');
  assert.equal(loaded.loadedPlaybook.images.length, 1);
});

test('savePanelSessionState falls back cleanly without playbook images when storage quota is tight', async () => {
  const storage = createMemoryStorage({ failWhenLargerThan: 500 });
  const bigImage = 'data:image/jpeg;base64,' + 'A'.repeat(1200);
  const ok = await savePanelSessionState(storage, {
    goal: '短い目標',
    loadedPlaybook: {
      title: '手順',
      rawText: '1. クリック',
      images: [{ index: 1, name: 'big.jpg', dataUrl: bigImage }]
    }
  });
  assert.equal(ok, true);

  const loaded = await loadPanelSessionState(storage);
  assert.equal(loaded.goal, '短い目標');
  assert.equal(loaded.loadedPlaybook.title, '手順');
  assert.equal(loaded.loadedPlaybook.images.length, 0);
});

test('compactEventsForStorage caps event count and preserves only most recent previewDataUrls', () => {
  const events = Array.from({ length: 100 }, (_, i) => ({
    type: 'observation_captured',
    step: i + 1,
    previewDataUrl: `data:image/jpeg;base64,frame_${i + 1}`
  }));

  const compacted = compactEventsForStorage(events, { maxEvents: 80, keepPreviewCount: 4 });
  assert.equal(compacted.length, 80);
  assert.equal(compacted[0].step, 21);

  const withPreviews = compacted.filter((ev) => Boolean(ev.previewDataUrl));
  assert.equal(withPreviews.length, 4);
  assert.deepEqual(
    withPreviews.map((e) => e.step),
    [97, 98, 99, 100]
  );
});

test('buildReplayPlan omits historical confirmation_requested events and respects pendingConfirmation', () => {
  const planActive = buildReplayPlan({
    running: true,
    mode: 'background',
    goal: 'テスト作業',
    events: [
      { type: 'step_started', step: 1, maxSteps: 10 },
      { type: 'confirmation_requested', details: { title: '昔の質問' } },
      { type: 'step_completed', step: 1, result: { ok: true } },
      { type: 'step_started', step: 2, maxSteps: 10 },
      { type: 'confirmation_requested', details: { title: '今の質問' } }
    ],
    pendingConfirmation: { title: '今の質問', allowCustomReply: true }
  });

  assert.equal(planActive.shouldRestore, true);
  assert.equal(planActive.running, true);
  assert.equal(planActive.eventsToReplay.length, 3);
  assert.equal(
    planActive.eventsToReplay.some((e) => e.type === 'confirmation_requested'),
    false
  );
  assert.equal(planActive.pendingConfirmation.title, '今の質問');

  const planFinished = buildReplayPlan({
    running: false,
    events: [{ type: 'confirmation_requested', details: { title: '昔の質問' } }],
    pendingConfirmation: { title: '残骸' },
    lastOutcome: { status: 'completed', message: '完了' }
  });
  assert.equal(planFinished.pendingConfirmation, null);
  assert.equal(planFinished.lastOutcome.status, 'completed');
});

test('saveRunProgressState and clearRunProgressState isolate run history from panel state', async () => {
  const storage = createMemoryStorage();
  await savePanelSessionState(storage, { goal: '保持すべき目標' });
  await saveRunProgressState(storage, {
    running: true,
    goal: '保持すべき目標',
    events: [{ type: 'step_started', step: 1, maxSteps: 5 }]
  });

  assert.ok(storage._map.has(PANEL_STATE_STORAGE_KEY));
  assert.ok(storage._map.has(RUN_STATE_STORAGE_KEY));

  await clearRunProgressState(storage);
  assert.equal(await loadRunProgressState(storage), null);
  assert.equal((await loadPanelSessionState(storage)).goal, '保持すべき目標');
});

test('loadRunProgressState and buildReplayPlan discard legacy max_steps outcomes', async () => {
  const legacyOutcomeState = {
    running: false,
    mode: 'background',
    goal: '古い作業',
    events: [{ type: 'run_finished', status: 'max_steps', message: '最大ステップ数に達したため終了しました。' }],
    lastOutcome: { status: 'max_steps', message: '最大ステップ数に達したため終了しました。' }
  };

  assert.equal(isLegacyMaxStepsRunState(legacyOutcomeState), true);
  assert.equal(
    isLegacyMaxStepsRunState({
      running: false,
      lastOutcome: { status: 'completed', message: '完了しました' }
    }),
    false
  );
  assert.equal(
    isLegacyMaxStepsRunState({
      running: true,
      lastOutcome: { status: 'max_steps', message: '最大ステップ数に達したため終了しました。' }
    }),
    false
  );

  const storage = createMemoryStorage();
  await saveRunProgressState(storage, legacyOutcomeState);
  assert.ok(storage._map.has(RUN_STATE_STORAGE_KEY));

  const loaded = await loadRunProgressState(storage);
  assert.equal(loaded, null);
  assert.equal(storage._map.has(RUN_STATE_STORAGE_KEY), false);

  const plan = buildReplayPlan(legacyOutcomeState);
  assert.equal(plan.shouldRestore, false);
});
