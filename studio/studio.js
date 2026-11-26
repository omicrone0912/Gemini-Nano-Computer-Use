import { MSG_TYPES } from '../shared/constants.js';
import {
  FLOW_ACTION_TYPES,
  FLOW_CONDITION_TYPES,
  WorkflowPresetStore,
  clonePreset,
  compileWorkflowToPlaybook,
  createNode,
  findNodeById,
  insertNodeAt,
  moveNodeById,
  removeNodeById,
  updateNodeById,
  validateWorkflowPreset
} from '../shared/workflow-flow.js';

const store = new WorkflowPresetStore(chrome.storage?.local);

const els = {
  studioPresetName: document.getElementById('studioPresetName'),
  studioSaveStatus: document.getElementById('studioSaveStatus'),
  previewPlaybookBtn: document.getElementById('previewPlaybookBtn'),
  exportJsonBtn: document.getElementById('exportJsonBtn'),
  importJsonBtn: document.getElementById('importJsonBtn'),
  importJsonInput: document.getElementById('importJsonInput'),
  savePresetBtn: document.getElementById('savePresetBtn'),
  runPresetBtn: document.getElementById('runPresetBtn'),
  newPresetBtn: document.getElementById('newPresetBtn'),
  duplicatePresetBtn: document.getElementById('duplicatePresetBtn'),
  deletePresetBtn: document.getElementById('deletePresetBtn'),
  presetList: document.getElementById('presetList'),
  flowCanvas: document.getElementById('flowCanvas'),
  inspectorTitle: document.getElementById('inspectorTitle'),
  inspectorBody: document.getElementById('inspectorBody'),
  playbookModal: document.getElementById('playbookModal'),
  playbookModalBackdrop: document.getElementById('playbookModalBackdrop'),
  closePlaybookModalBtn: document.getElementById('closePlaybookModalBtn'),
  compiledPlaybookPre: document.getElementById('compiledPlaybookPre')
};

let presets = [];
let activePreset = null;
let selectedTarget = 'flow'; // 'flow' or nodeId
let isDirty = false;

function markDirty(dirty = true) {
  isDirty = dirty;
  els.studioSaveStatus.textContent = dirty ? '未保存の変更' : '保存済み';
  els.studioSaveStatus.classList.toggle('dirty', dirty);
}

function summarizeNode(node) {
  if (node.type === 'condition') {
    const condDef = FLOW_CONDITION_TYPES.find((c) => c.value === node.conditionType);
    const val = node.conditionValue ? `「${node.conditionValue}」` : '(未設定)';
    return `${condDef?.label || node.conditionType}: ${val}`;
  }
  if (node.type === 'ask_user') {
    return node.message || '確認メッセージ';
  }
  if (node.type === 'done') {
    return node.message || '完了メッセージ';
  }
  const parts = [node.actionType];
  if (node.url) parts.push(node.url);
  if (node.target) parts.push(`対象: ${node.target}`);
  if (node.value) parts.push(`値: ${node.value}`);
  if (node.actionType === 'wait') parts.push(`${node.ms || 1000}ms`);
  return parts.join(' ・ ');
}

function getNodeBadgeText(type) {
  if (type === 'condition') return 'IF';
  if (type === 'ask_user') return '確認';
  if (type === 'done') return '完了';
  return '操作';
}

function renderPresetList() {
  els.presetList.innerHTML = '';
  for (const preset of presets) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `preset-item${activePreset && preset.id === activePreset.id ? ' active' : ''}`;

    const nameEl = document.createElement('span');
    nameEl.className = 'preset-item-name';
    nameEl.textContent = preset.name;

    const metaEl = document.createElement('span');
    metaEl.className = 'preset-item-meta';
    metaEl.textContent = `${preset.nodes.length}ステップ${preset.startUrl ? ` ・ ${preset.startUrl}` : ''}`;

    btn.appendChild(nameEl);
    btn.appendChild(metaEl);
    btn.addEventListener('click', () => {
      activePreset = clonePreset(preset);
      selectedTarget = 'flow';
      markDirty(false);
      renderAll();
    });
    els.presetList.appendChild(btn);
  }
}

function createNodeElement(node) {
  const card = document.createElement('div');
  card.className = `flow-card flow-card-${node.type}${selectedTarget === node.id ? ' selected' : ''}`;
  card.addEventListener('click', (e) => {
    e.stopPropagation();
    selectedTarget = node.id;
    renderCanvas();
    renderInspector();
  });

  const top = document.createElement('div');
  top.className = 'flow-card-top';

  const titleWrap = document.createElement('div');
  titleWrap.className = 'flow-card-title-wrap';

  const pill = document.createElement('span');
  pill.className = `node-type-pill pill-${node.type}`;
  pill.textContent = getNodeBadgeText(node.type);

  const title = document.createElement('span');
  title.className = 'flow-card-title';
  title.textContent = node.label || node.type;

  titleWrap.appendChild(pill);
  titleWrap.appendChild(title);

  const controls = document.createElement('div');
  controls.className = 'flow-node-controls';

  const upBtn = document.createElement('button');
  upBtn.type = 'button';
  upBtn.className = 'node-ctrl-btn';
  upBtn.textContent = '↑';
  upBtn.title = '上へ移動';
  upBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (moveNodeById(activePreset.nodes, node.id, 'up')) {
      markDirty(true);
      renderCanvas();
    }
  });

  const downBtn = document.createElement('button');
  downBtn.type = 'button';
  downBtn.className = 'node-ctrl-btn';
  downBtn.textContent = '↓';
  downBtn.title = '下へ移動';
  downBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (moveNodeById(activePreset.nodes, node.id, 'down')) {
      markDirty(true);
      renderCanvas();
    }
  });

  const delBtn = document.createElement('button');
  delBtn.type = 'button';
  delBtn.className = 'node-ctrl-btn';
  delBtn.textContent = '✕';
  delBtn.title = '削除';
  delBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (removeNodeById(activePreset.nodes, node.id)) {
      if (selectedTarget === node.id) {
        selectedTarget = 'flow';
      }
      markDirty(true);
      renderCanvas();
      renderInspector();
    }
  });

  controls.appendChild(upBtn);
  controls.appendChild(downBtn);
  controls.appendChild(delBtn);

  top.appendChild(titleWrap);
  top.appendChild(controls);

  const summary = document.createElement('div');
  summary.className = 'flow-card-summary';
  summary.textContent = summarizeNode(node);

  card.appendChild(top);
  card.appendChild(summary);

  if (node.type === 'condition') {
    const grid = document.createElement('div');
    grid.className = 'branch-grid';

    grid.appendChild(renderBranchColumn(node.id, 'yes', 'YES（一致時）', node.yesBranch));
    grid.appendChild(renderBranchColumn(node.id, 'no', 'NO（不一致時）', node.noBranch));
    card.appendChild(grid);
  }

  return card;
}

function renderBranchColumn(parentId, branchKey, headingText, branchNodes) {
  const col = document.createElement('div');
  col.className = `branch-col branch-${branchKey}`;

  const header = document.createElement('div');
  header.className = 'branch-col-header';
  header.textContent = `${headingText} (${branchNodes.length})`;
  col.appendChild(header);

  if (branchNodes.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'branch-empty';
    empty.textContent = '（ステップ未設定）';
    col.appendChild(empty);
  } else {
    branchNodes.forEach((child, idx) => {
      if (idx > 0) {
        const conn = document.createElement('div');
        conn.className = 'flow-connector';
        col.appendChild(conn);
      }
      col.appendChild(createNodeElement(child));
    });
  }

  const addBar = document.createElement('div');
  addBar.className = 'branch-add-bar';

  const quickDefs = [
    { type: 'action', label: '+ 操作' },
    { type: 'condition', label: '+ 分岐' },
    { type: 'ask_user', label: '+ 確認' },
    { type: 'done', label: '+ 完了' }
  ];

  for (const q of quickDefs) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'node-ctrl-btn';
    btn.textContent = q.label;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const created = createNode(q.type);
      insertNodeAt(activePreset.nodes, created, { parentId, branch: branchKey });
      selectedTarget = created.id;
      markDirty(true);
      renderCanvas();
      renderInspector();
    });
    addBar.appendChild(btn);
  }

  col.appendChild(addBar);
  return col;
}

function renderCanvas() {
  els.flowCanvas.innerHTML = '';
  if (!activePreset) return;

  els.studioPresetName.value = activePreset.name;

  // Start Card
  const startCard = document.createElement('div');
  startCard.className = `flow-card flow-card-start${selectedTarget === 'flow' ? ' selected' : ''}`;
  startCard.addEventListener('click', () => {
    selectedTarget = 'flow';
    renderCanvas();
    renderInspector();
  });
  startCard.innerHTML = `
    <div class="flow-card-top">
      <div class="flow-card-title-wrap">
        <span class="node-type-pill pill-start">開始</span>
        <span class="flow-card-title"></span>
      </div>
    </div>
    <div class="flow-card-summary"></div>
  `;
  startCard.querySelector('.flow-card-title').textContent = activePreset.name;
  startCard.querySelector('.flow-card-summary').textContent =
    activePreset.startUrl ? `開始URL: ${activePreset.startUrl}` : '開始URL未設定（現在開いているタブから開始）';
  els.flowCanvas.appendChild(startCard);

  for (const node of activePreset.nodes) {
    const conn = document.createElement('div');
    conn.className = 'flow-connector';
    els.flowCanvas.appendChild(conn);
    els.flowCanvas.appendChild(createNodeElement(node));
  }

  const endConn = document.createElement('div');
  endConn.className = 'flow-connector';
  els.flowCanvas.appendChild(endConn);

  const endPill = document.createElement('div');
  endPill.className = 'flow-end-pill';
  endPill.textContent = 'フロー終了';
  els.flowCanvas.appendChild(endPill);
}

function addField(container, labelText, inputEl) {
  const wrap = document.createElement('div');
  wrap.className = 'form-field';
  const label = document.createElement('label');
  label.textContent = labelText;
  wrap.appendChild(label);
  wrap.appendChild(inputEl);
  container.appendChild(wrap);
  return wrap;
}

function renderInspector() {
  els.inspectorBody.innerHTML = '';
  if (!activePreset) return;

  if (selectedTarget === 'flow') {
    els.inspectorTitle.textContent = 'フロー全体設定';

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.value = activePreset.name;
    nameInput.addEventListener('input', () => {
      activePreset.name = nameInput.value;
      els.studioPresetName.value = nameInput.value;
      markDirty(true);
      renderCanvas();
    });
    addField(els.inspectorBody, 'プリセット名', nameInput);

    const urlInput = document.createElement('input');
    urlInput.type = 'text';
    urlInput.placeholder = 'https://example.com';
    urlInput.value = activePreset.startUrl || '';
    urlInput.addEventListener('input', () => {
      activePreset.startUrl = urlInput.value.trim();
      markDirty(true);
      renderCanvas();
    });
    addField(els.inspectorBody, '開始URL（任意）', urlInput);

    const descInput = document.createElement('textarea');
    descInput.value = activePreset.description || '';
    descInput.placeholder = 'このフローの目的や前提条件を記述してください';
    descInput.addEventListener('input', () => {
      activePreset.description = descInput.value;
      markDirty(true);
    });
    addField(els.inspectorBody, 'フローの説明・目的', descInput);
    return;
  }

  const found = findNodeById(activePreset.nodes, selectedTarget);
  if (!found) {
    selectedTarget = 'flow';
    renderInspector();
    return;
  }

  const { node } = found;
  els.inspectorTitle.textContent = `ノード設定 (${getNodeBadgeText(node.type)})`;

  const labelInput = document.createElement('input');
  labelInput.type = 'text';
  labelInput.value = node.label || '';
  labelInput.addEventListener('input', () => {
    updateNodeById(activePreset.nodes, node.id, { label: labelInput.value });
    markDirty(true);
    renderCanvas();
  });
  addField(els.inspectorBody, 'ノード表示名', labelInput);

  if (node.type === 'action') {
    const actionSel = document.createElement('select');
    for (const opt of FLOW_ACTION_TYPES) {
      const o = document.createElement('option');
      o.value = opt.value;
      o.textContent = opt.label;
      o.selected = opt.value === node.actionType;
      actionSel.appendChild(o);
    }
    actionSel.addEventListener('change', () => {
      updateNodeById(activePreset.nodes, node.id, { actionType: actionSel.value });
      markDirty(true);
      renderCanvas();
      renderInspector();
    });
    addField(els.inspectorBody, 'アクション種別', actionSel);

    if (node.actionType === 'navigate' || node.actionType === 'open_tab') {
      const urlInput = document.createElement('input');
      urlInput.type = 'text';
      urlInput.placeholder = 'https://example.com';
      urlInput.value = node.url || '';
      urlInput.addEventListener('input', () => {
        updateNodeById(activePreset.nodes, node.id, { url: urlInput.value });
        markDirty(true);
        renderCanvas();
      });
      addField(els.inspectorBody, '移動先 URL', urlInput);
    }

    if (['click', 'type', 'select', 'ai_step'].includes(node.actionType)) {
      const targetInput = document.createElement('input');
      targetInput.type = 'text';
      targetInput.placeholder = '例: ログインボタン / 検索入力欄';
      targetInput.value = node.target || '';
      targetInput.addEventListener('input', () => {
        updateNodeById(activePreset.nodes, node.id, { target: targetInput.value });
        markDirty(true);
        renderCanvas();
      });
      addField(els.inspectorBody, '対象要素の説明', targetInput);
    }

    if (['type', 'select', 'scroll', 'download_page_pdf', 'read_pdf', 'switch_tab', 'ai_step'].includes(node.actionType)) {
      const valInput = document.createElement('input');
      valInput.type = 'text';
      valInput.placeholder = '入力文字 / ファイル名 / 方向 / ページ番号等';
      valInput.value = node.value || '';
      valInput.addEventListener('input', () => {
        updateNodeById(activePreset.nodes, node.id, { value: valInput.value });
        markDirty(true);
        renderCanvas();
      });
      addField(els.inspectorBody, '値 / パラメータ', valInput);
    }

    if (node.actionType === 'wait') {
      const msInput = document.createElement('input');
      msInput.type = 'number';
      msInput.min = '200';
      msInput.max = '5000';
      msInput.value = String(node.ms || 1000);
      msInput.addEventListener('input', () => {
        updateNodeById(activePreset.nodes, node.id, { ms: Number(msInput.value) || 1000 });
        markDirty(true);
        renderCanvas();
      });
      addField(els.inspectorBody, '待機時間 (ms)', msInput);
    }

    const notesInput = document.createElement('textarea');
    notesInput.value = node.notes || '';
    notesInput.placeholder = 'AI への補足条件や注意点';
    notesInput.addEventListener('input', () => {
      updateNodeById(activePreset.nodes, node.id, { notes: notesInput.value });
      markDirty(true);
    });
    addField(els.inspectorBody, '補足指示（任意）', notesInput);
  } else if (node.type === 'condition') {
    const condSel = document.createElement('select');
    for (const opt of FLOW_CONDITION_TYPES) {
      const o = document.createElement('option');
      o.value = opt.value;
      o.textContent = opt.label;
      o.selected = opt.value === node.conditionType;
      condSel.appendChild(o);
    }
    condSel.addEventListener('change', () => {
      updateNodeById(activePreset.nodes, node.id, { conditionType: condSel.value });
      markDirty(true);
      renderCanvas();
    });
    addField(els.inspectorBody, '条件判定方法', condSel);

    const condValInput = document.createElement('input');
    condValInput.type = 'text';
    condValInput.placeholder = '例: ログイン / /error / 購入ボタン';
    condValInput.value = node.conditionValue || '';
    condValInput.addEventListener('input', () => {
      updateNodeById(activePreset.nodes, node.id, { conditionValue: condValInput.value });
      markDirty(true);
      renderCanvas();
    });
    addField(els.inspectorBody, '判定対象テキスト / 条件内容', condValInput);
  } else {
    const msgInput = document.createElement('textarea');
    msgInput.value = node.message || '';
    msgInput.addEventListener('input', () => {
      updateNodeById(activePreset.nodes, node.id, { message: msgInput.value });
      markDirty(true);
      renderCanvas();
    });
    addField(els.inspectorBody, 'メッセージ内容', msgInput);
  }

  const actionsDiv = document.createElement('div');
  actionsDiv.className = 'inspector-actions';

  const delBtn = document.createElement('button');
  delBtn.type = 'button';
  delBtn.className = 'btn btn-danger btn-xs';
  delBtn.textContent = 'このノードを削除';
  delBtn.addEventListener('click', () => {
    removeNodeById(activePreset.nodes, node.id);
    selectedTarget = 'flow';
    markDirty(true);
    renderCanvas();
    renderInspector();
  });
  actionsDiv.appendChild(delBtn);
  els.inspectorBody.appendChild(actionsDiv);
}

function renderAll() {
  renderPresetList();
  renderCanvas();
  renderInspector();
}

async function saveCurrentPreset() {
  if (!activePreset) return null;
  const saved = await store.save(activePreset);
  activePreset = clonePreset(saved);
  presets = await store.list();
  markDirty(false);
  renderAll();
  return saved;
}

// Topbar & Sidebar Events
els.studioPresetName.addEventListener('input', () => {
  if (!activePreset) return;
  activePreset.name = els.studioPresetName.value;
  markDirty(true);
  renderCanvas();
  if (selectedTarget === 'flow') {
    renderInspector();
  }
});

els.savePresetBtn.addEventListener('click', saveCurrentPreset);

els.runPresetBtn.addEventListener('click', async () => {
  const saved = await saveCurrentPreset();
  if (!saved) return;
  await chrome.runtime.sendMessage({
    type: MSG_TYPES.RUN_WORKFLOW_PRESET,
    preset: saved
  });
  els.studioSaveStatus.textContent = '実行開始しました';
});

els.previewPlaybookBtn.addEventListener('click', () => {
  if (!activePreset) return;
  const compiled = compileWorkflowToPlaybook(activePreset);
  els.compiledPlaybookPre.textContent = compiled.rawText;
  els.playbookModal.classList.remove('hidden');
});

els.closePlaybookModalBtn.addEventListener('click', () => els.playbookModal.classList.add('hidden'));
els.playbookModalBackdrop.addEventListener('click', () => els.playbookModal.classList.add('hidden'));

els.exportJsonBtn.addEventListener('click', async () => {
  if (!activePreset) return;
  const blob = new Blob([JSON.stringify(activePreset, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  try {
    await chrome.downloads.download({
      url,
      filename: `${activePreset.id || 'flow-preset'}.json`,
      saveAs: false
    });
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
});

els.importJsonBtn.addEventListener('click', () => {
  els.importJsonInput.value = '';
  els.importJsonInput.click();
});

els.importJsonInput.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    const validated = validateWorkflowPreset({
      ...parsed,
      id: `preset_${Date.now().toString(36)}`
    });
    activePreset = await store.save(validated);
    presets = await store.list();
    selectedTarget = 'flow';
    markDirty(false);
    renderAll();
  } catch (error) {
    els.studioSaveStatus.textContent = `読込エラー: ${error?.message || error}`;
  }
});

els.newPresetBtn.addEventListener('click', async () => {
  const fresh = validateWorkflowPreset({
    id: `preset_${Date.now().toString(36)}`,
    name: '新しいフロー',
    description: '',
    startUrl: '',
    nodes: [createNode('action'), createNode('done')]
  });
  activePreset = await store.save(fresh);
  presets = await store.list();
  selectedTarget = 'flow';
  markDirty(false);
  renderAll();
});

els.duplicatePresetBtn.addEventListener('click', async () => {
  if (!activePreset) return;
  const copy = clonePreset({
    ...activePreset,
    id: `preset_${Date.now().toString(36)}`,
    name: `${activePreset.name} (コピー)`
  });
  activePreset = await store.save(copy);
  presets = await store.list();
  selectedTarget = 'flow';
  markDirty(false);
  renderAll();
});

els.deletePresetBtn.addEventListener('click', async () => {
  if (!activePreset) return;
  presets = await store.remove(activePreset.id);
  if (presets.length === 0) {
    presets = await store.seedIfEmpty();
  }
  activePreset = clonePreset(presets[0]);
  selectedTarget = 'flow';
  markDirty(false);
  renderAll();
});

for (const btn of document.querySelectorAll('[data-add-type]')) {
  btn.addEventListener('click', () => {
    if (!activePreset) return;
    const type = btn.getAttribute('data-add-type');
    const node = createNode(type);
    insertNodeAt(activePreset.nodes, node);
    selectedTarget = node.id;
    markDirty(true);
    renderCanvas();
    renderInspector();
  });
}

// Boot
presets = await store.list();
const params = new URLSearchParams(location.search);
const requestedId = params.get('presetId');
const initial = (requestedId && presets.find((p) => p.id === requestedId)) || presets[0];
activePreset = clonePreset(initial);
markDirty(false);
renderAll();
