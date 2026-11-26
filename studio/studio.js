import { MSG_TYPES } from '../shared/constants.js';
import {
  FLOW_ACTION_TYPES,
  FLOW_CONDITION_TYPES,
  WorkflowPresetStore,
  addGraphNode,
  autoLayoutGraph,
  clonePreset,
  compileWorkflowToPlaybook,
  connectNodes,
  createNode,
  disconnectEdge,
  moveGraphNodePosition,
  removeGraphNode,
  updateGraphNode,
  validateWorkflowPreset
} from '../shared/workflow-flow.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const NODE_WIDTH = 240;
const store = new WorkflowPresetStore(chrome.storage?.local);

const els = {
  studioPresetName: document.getElementById('studioPresetName'),
  studioSaveStatus: document.getElementById('studioSaveStatus'),
  autoLayoutBtn: document.getElementById('autoLayoutBtn'),
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
  canvasScrollArea: document.getElementById('canvasScrollArea'),
  canvasStatusBar: document.getElementById('canvasStatusBar'),
  flowStage: document.getElementById('flowStage'),
  flowEdgesSvg: document.getElementById('flowEdgesSvg'),
  flowNodesLayer: document.getElementById('flowNodesLayer'),
  inspectorTitle: document.getElementById('inspectorTitle'),
  inspectorBody: document.getElementById('inspectorBody'),
  playbookModal: document.getElementById('playbookModal'),
  playbookModalBackdrop: document.getElementById('playbookModalBackdrop'),
  closePlaybookModalBtn: document.getElementById('closePlaybookModalBtn'),
  compiledPlaybookPre: document.getElementById('compiledPlaybookPre')
};

let presets = [];
let activePreset = null;
let selectedNodeId = 'node_start';
let connectingFrom = null; // { nodeId, port }
let cursorPos = { x: 0, y: 0 };
let dragState = null;
const nodeDomMap = new Map();

function markDirty(dirty = true) {
  els.studioSaveStatus.textContent = dirty ? '未保存の変更' : '保存済み';
  els.studioSaveStatus.classList.toggle('dirty', dirty);
}

function updateCanvasStatusBar() {
  if (connectingFrom) {
    const srcNode = activePreset?.nodes.find((n) => n.id === connectingFrom.nodeId);
    const portText = connectingFrom.port === 'yes' ? 'YES' : connectingFrom.port === 'no' ? 'NO' : '次へ';
    els.canvasStatusBar.textContent = `接続モード: 「${srcNode?.label || connectingFrom.nodeId}」(${portText}) の接続先ノードをクリックしてください（Esc または背景クリックでキャンセル）`;
    els.canvasStatusBar.classList.add('connecting');
  } else {
    els.canvasStatusBar.textContent =
      'ヒント: 左のノードをドラッグして設置 / ノード自体はドラッグで移動 / 下部の出力ポートをクリックしてから接続先ノードをクリックして接続（線上のラベルクリックで切断）';
    els.canvasStatusBar.classList.remove('connecting');
  }
}

function summarizeNode(node) {
  if (node.type === 'start') {
    return activePreset?.startUrl ? `開始URL: ${activePreset.startUrl}` : '現在のタブから開始';
  }
  if (node.type === 'condition') {
    const condDef = FLOW_CONDITION_TYPES.find((c) => c.value === node.conditionType);
    const val = node.conditionValue ? `「${node.conditionValue}」` : '(条件値未設定)';
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
  if (type === 'start') return '開始';
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
    metaEl.textContent = `${Math.max(0, preset.nodes.length - 1)}ノード ・ ${preset.edges.length}接続`;

    btn.appendChild(nameEl);
    btn.appendChild(metaEl);
    btn.addEventListener('click', () => {
      activePreset = clonePreset(preset);
      selectedNodeId = activePreset.nodes.find((n) => n.type === 'start')?.id || activePreset.nodes[0]?.id || null;
      connectingFrom = null;
      markDirty(false);
      renderAll();
    });
    els.presetList.appendChild(btn);
  }
}

function getPortAnchor(nodeId, port) {
  const node = activePreset?.nodes.find((n) => n.id === nodeId);
  if (!node) return { x: 0, y: 0 };
  const el = nodeDomMap.get(nodeId);
  const width = el?.offsetWidth || NODE_WIDTH;
  const height = el?.offsetHeight || 110;

  if (port === 'in') {
    return { x: node.x + width / 2, y: node.y };
  }
  if (node.type === 'condition') {
    if (port === 'yes') {
      return { x: node.x + width * 0.3, y: node.y + height };
    }
    if (port === 'no') {
      return { x: node.x + width * 0.7, y: node.y + height };
    }
  }
  return { x: node.x + width / 2, y: node.y + height };
}

function makeBezierPath(x1, y1, x2, y2) {
  const dy = Math.max(45, Math.abs(y2 - y1) * 0.52);
  return `M ${x1} ${y1} C ${x1} ${y1 + dy}, ${x2} ${y2 - dy}, ${x2} ${y2}`;
}

function renderEdgesSvg() {
  els.flowEdgesSvg.innerHTML = '';
  if (!activePreset) return;

  // Arrowhead markers
  const defs = document.createElementNS(SVG_NS, 'defs');
  const markerColors = [
    { id: 'arrow-next', color: '#1a73e8' },
    { id: 'arrow-yes', color: '#137333' },
    { id: 'arrow-no', color: '#c5221f' }
  ];
  for (const m of markerColors) {
    const marker = document.createElementNS(SVG_NS, 'marker');
    marker.setAttribute('id', m.id);
    marker.setAttribute('viewBox', '0 0 10 10');
    marker.setAttribute('refX', '8');
    marker.setAttribute('refY', '5');
    marker.setAttribute('markerWidth', '7');
    marker.setAttribute('markerHeight', '7');
    marker.setAttribute('orient', 'auto-start-reverse');
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', 'M 0 1 L 10 5 L 0 9 z');
    path.setAttribute('fill', m.color);
    marker.appendChild(path);
    defs.appendChild(marker);
  }
  els.flowEdgesSvg.appendChild(defs);

  for (const edge of activePreset.edges) {
    const p1 = getPortAnchor(edge.from, edge.port);
    const p2 = getPortAnchor(edge.to, 'in');
    const d = makeBezierPath(p1.x, p1.y, p2.x, p2.y);

    const hit = document.createElementNS(SVG_NS, 'path');
    hit.setAttribute('d', d);
    hit.setAttribute('class', 'edge-hit-area');
    hit.addEventListener('click', (e) => {
      e.stopPropagation();
      disconnectEdge(activePreset, edge.id);
      markDirty(true);
      renderEdgesSvg();
      renderPresetList();
    });

    const visible = document.createElementNS(SVG_NS, 'path');
    visible.setAttribute('d', d);
    visible.setAttribute('class', `edge-path edge-path-${edge.port}`);
    visible.setAttribute('marker-end', `url(#arrow-${edge.port})`);

    els.flowEdgesSvg.appendChild(hit);
    els.flowEdgesSvg.appendChild(visible);

    // Midpoint label & disconnect badge
    const mx = (p1.x + p2.x) / 2;
    const my = (p1.y + p2.y) / 2;
    const badgeGroup = document.createElementNS(SVG_NS, 'g');
    badgeGroup.setAttribute('class', 'edge-badge-group');
    badgeGroup.addEventListener('click', (e) => {
      e.stopPropagation();
      disconnectEdge(activePreset, edge.id);
      markDirty(true);
      renderEdgesSvg();
      renderPresetList();
    });

    const labelText = edge.port === 'yes' ? 'YES ✕' : edge.port === 'no' ? 'NO ✕' : '✕';
    const rectW = edge.port === 'next' ? 22 : 52;
    const rect = document.createElementNS(SVG_NS, 'rect');
    rect.setAttribute('x', String(mx - rectW / 2));
    rect.setAttribute('y', String(my - 10));
    rect.setAttribute('width', String(rectW));
    rect.setAttribute('height', '20');
    rect.setAttribute('rx', '10');
    rect.setAttribute('class', 'edge-badge-bg');

    const text = document.createElementNS(SVG_NS, 'text');
    text.setAttribute('x', String(mx));
    text.setAttribute('y', String(my));
    text.setAttribute('class', 'edge-badge-text');
    text.textContent = labelText;

    badgeGroup.appendChild(rect);
    badgeGroup.appendChild(text);
    els.flowEdgesSvg.appendChild(badgeGroup);
  }

  // Live preview edge while connecting
  if (connectingFrom) {
    const p1 = getPortAnchor(connectingFrom.nodeId, connectingFrom.port);
    const preview = document.createElementNS(SVG_NS, 'path');
    preview.setAttribute('d', makeBezierPath(p1.x, p1.y, cursorPos.x, cursorPos.y));
    preview.setAttribute('class', 'edge-path-preview');
    els.flowEdgesSvg.appendChild(preview);
  }
}

function createGraphNodeElement(node) {
  const card = document.createElement('div');
  const isTargetReady =
    Boolean(connectingFrom) &&
    connectingFrom.nodeId !== node.id &&
    node.type !== 'start';

  card.className = `graph-node graph-node-${node.type}${selectedNodeId === node.id ? ' selected' : ''}${
    isTargetReady ? ' connect-target-ready' : ''
  }`;
  // Direct CSSOM property assignment (no cssText / style attribute string) for strict CSP compliance
  card.style.left = `${node.x}px`;
  card.style.top = `${node.y}px`;

  if (node.type !== 'start') {
    const portInWrap = document.createElement('div');
    portInWrap.className = 'node-port-in-wrap';
    const portInDot = document.createElement('button');
    portInDot.type = 'button';
    portInDot.className = 'port-in-dot';
    portInDot.title = '入力ポート（ここへ接続）';
    portInDot.addEventListener('click', (e) => {
      e.stopPropagation();
      if (connectingFrom && connectingFrom.nodeId !== node.id) {
        connectNodes(activePreset, connectingFrom.nodeId, connectingFrom.port, node.id);
        connectingFrom = null;
        markDirty(true);
        renderCanvas();
        renderPresetList();
      }
    });
    portInWrap.appendChild(portInDot);
    card.appendChild(portInWrap);
  }

  const body = document.createElement('div');
  body.className = 'graph-node-body';

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
  top.appendChild(titleWrap);

  if (node.type !== 'start') {
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'node-del-btn';
    delBtn.textContent = '✕';
    delBtn.title = '削除';
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (connectingFrom?.nodeId === node.id) {
        connectingFrom = null;
      }
      removeGraphNode(activePreset, node.id);
      if (selectedNodeId === node.id) {
        selectedNodeId = 'node_start';
      }
      markDirty(true);
      renderCanvas();
      renderInspector();
      renderPresetList();
    });
    top.appendChild(delBtn);
  }

  const summary = document.createElement('div');
  summary.className = 'flow-card-summary';
  summary.textContent = summarizeNode(node);

  body.appendChild(top);
  body.appendChild(summary);
  card.appendChild(body);

  // Output ports
  if (node.type !== 'done') {
    const portsOut = document.createElement('div');
    portsOut.className = 'node-ports-out';

    const outDefs =
      node.type === 'condition'
        ? [
            { port: 'yes', text: '● YES', cls: 'port-out-yes' },
            { port: 'no', text: '● NO', cls: 'port-out-no' }
          ]
        : [{ port: 'next', text: '● 次へ接続', cls: 'port-out-next' }];

    for (const def of outDefs) {
      const portBtn = document.createElement('button');
      portBtn.type = 'button';
      const isActive = connectingFrom?.nodeId === node.id && connectingFrom?.port === def.port;
      portBtn.className = `port-out-btn ${def.cls}${isActive ? ' active-connecting' : ''}`;
      portBtn.textContent = def.text;
      portBtn.title = 'クリックして接続先ノードを選択';
      portBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (connectingFrom?.nodeId === node.id && connectingFrom?.port === def.port) {
          connectingFrom = null;
        } else {
          connectingFrom = { nodeId: node.id, port: def.port };
          const anchor = getPortAnchor(node.id, def.port);
          cursorPos = { x: anchor.x, y: anchor.y + 40 };
        }
        renderCanvas();
      });
      portsOut.appendChild(portBtn);
    }

    card.appendChild(portsOut);
  }

  // Click to select OR finish connection
  card.addEventListener('click', (e) => {
    e.stopPropagation();
    if (connectingFrom) {
      if (connectingFrom.nodeId !== node.id && node.type !== 'start') {
        connectNodes(activePreset, connectingFrom.nodeId, connectingFrom.port, node.id);
        connectingFrom = null;
        markDirty(true);
        renderCanvas();
        renderPresetList();
        return;
      }
    }
    selectedNodeId = node.id;
    renderCanvas();
    renderInspector();
  });

  // Pointer drag to move node freely on stage
  card.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('button')) return;
    if (connectingFrom) return;

    e.stopPropagation();
    dragState = {
      nodeId: node.id,
      cardEl: card,
      startPointerX: e.clientX,
      startPointerY: e.clientY,
      origX: node.x,
      origY: node.y,
      moved: false
    };
    card.classList.add('dragging');
    card.setPointerCapture?.(e.pointerId);
  });

  card.addEventListener('pointermove', (e) => {
    if (!dragState || dragState.nodeId !== node.id) return;
    const dx = e.clientX - dragState.startPointerX;
    const dy = e.clientY - dragState.startPointerY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
      dragState.moved = true;
    }
    const nextX = Math.max(20, Math.min(1220, Math.round((dragState.origX + dx) / 10) * 10));
    const nextY = Math.max(20, Math.min(1040, Math.round((dragState.origY + dy) / 10) * 10));
    moveGraphNodePosition(activePreset, node.id, nextX, nextY);
    card.style.left = `${nextX}px`;
    card.style.top = `${nextY}px`;
    renderEdgesSvg();
  });

  card.addEventListener('pointerup', (e) => {
    if (!dragState || dragState.nodeId !== node.id) return;
    card.classList.remove('dragging');
    card.releasePointerCapture?.(e.pointerId);
    if (dragState.moved) {
      markDirty(true);
    }
    dragState = null;
  });

  return card;
}

function renderCanvas() {
  updateCanvasStatusBar();
  els.flowNodesLayer.innerHTML = '';
  nodeDomMap.clear();
  if (!activePreset) return;

  els.studioPresetName.value = activePreset.name;

  for (const node of activePreset.nodes) {
    const el = createGraphNodeElement(node);
    nodeDomMap.set(node.id, el);
    els.flowNodesLayer.appendChild(el);
  }

  renderEdgesSvg();
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

  const node = activePreset.nodes.find((n) => n.id === selectedNodeId);
  if (!node || node.type === 'start') {
    els.inspectorTitle.textContent = 'フロー全体設定 (開始ノード)';

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

  els.inspectorTitle.textContent = `ノード設定 (${getNodeBadgeText(node.type)})`;

  const labelInput = document.createElement('input');
  labelInput.type = 'text';
  labelInput.value = node.label || '';
  labelInput.addEventListener('input', () => {
    updateGraphNode(activePreset, node.id, { label: labelInput.value });
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
      updateGraphNode(activePreset, node.id, { actionType: actionSel.value });
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
        updateGraphNode(activePreset, node.id, { url: urlInput.value });
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
        updateGraphNode(activePreset, node.id, { target: targetInput.value });
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
        updateGraphNode(activePreset, node.id, { value: valInput.value });
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
        updateGraphNode(activePreset, node.id, { ms: Number(msInput.value) || 1000 });
        markDirty(true);
        renderCanvas();
      });
      addField(els.inspectorBody, '待機時間 (ms)', msInput);
    }

    const notesInput = document.createElement('textarea');
    notesInput.value = node.notes || '';
    notesInput.placeholder = 'AI への補足条件や注意点';
    notesInput.addEventListener('input', () => {
      updateGraphNode(activePreset, node.id, { notes: notesInput.value });
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
      updateGraphNode(activePreset, node.id, { conditionType: condSel.value });
      markDirty(true);
      renderCanvas();
    });
    addField(els.inspectorBody, '条件判定方法', condSel);

    const condValInput = document.createElement('input');
    condValInput.type = 'text';
    condValInput.placeholder = '例: ログイン / /error / 購入ボタン';
    condValInput.value = node.conditionValue || '';
    condValInput.addEventListener('input', () => {
      updateGraphNode(activePreset, node.id, { conditionValue: condValInput.value });
      markDirty(true);
      renderCanvas();
    });
    addField(els.inspectorBody, '判定対象テキスト / 条件内容', condValInput);
  } else {
    const msgInput = document.createElement('textarea');
    msgInput.value = node.message || '';
    msgInput.addEventListener('input', () => {
      updateGraphNode(activePreset, node.id, { message: msgInput.value });
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
    removeGraphNode(activePreset, node.id);
    selectedNodeId = 'node_start';
    markDirty(true);
    renderCanvas();
    renderInspector();
    renderPresetList();
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

function addNodeAndMaybeAutoConnect(type, dropX = null, dropY = null) {
  if (!activePreset) return;
  const baseNode = activePreset.nodes.find((n) => n.id === selectedNodeId) || activePreset.nodes[0];
  const x = dropX !== null ? dropX : (baseNode?.x ?? 460);
  const y = dropY !== null ? dropY : (baseNode?.y ?? 40) + 170;

  const created = addGraphNode(activePreset, type, { x, y });
  if (!created) return;

  // If added via click (not drop), auto-connect from selected node if it has a free port
  if (dropX === null && baseNode && baseNode.type !== 'done') {
    const existingFromBase = activePreset.edges.filter((e) => e.from === baseNode.id);
    if (baseNode.type === 'condition') {
      if (!existingFromBase.some((e) => e.port === 'yes')) {
        connectNodes(activePreset, baseNode.id, 'yes', created.id);
      } else if (!existingFromBase.some((e) => e.port === 'no')) {
        connectNodes(activePreset, baseNode.id, 'no', created.id);
      }
    } else if (!existingFromBase.some((e) => e.port === 'next')) {
      connectNodes(activePreset, baseNode.id, 'next', created.id);
    }
  }

  selectedNodeId = created.id;
  markDirty(true);
  renderCanvas();
  renderInspector();
  renderPresetList();
}

// Stage mouse tracking for live preview connection wire & drag-drop placement
els.flowStage.addEventListener('mousemove', (e) => {
  if (!connectingFrom) return;
  const rect = els.flowStage.getBoundingClientRect();
  cursorPos = {
    x: e.clientX - rect.left,
    y: e.clientY - rect.top
  };
  renderEdgesSvg();
});

els.flowStage.addEventListener('click', () => {
  if (connectingFrom) {
    connectingFrom = null;
    renderCanvas();
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && connectingFrom) {
    connectingFrom = null;
    renderCanvas();
  }
});

// Palette Drag & Drop onto Stage
for (const btn of document.querySelectorAll('[data-add-type]')) {
  btn.addEventListener('dragstart', (e) => {
    const type = btn.getAttribute('data-add-type');
    e.dataTransfer?.setData('application/x-nano-node-type', type);
    e.dataTransfer?.setData('text/plain', type);
  });

  btn.addEventListener('click', () => {
    const type = btn.getAttribute('data-add-type');
    addNodeAndMaybeAutoConnect(type);
  });
}

els.flowStage.addEventListener('dragover', (e) => {
  e.preventDefault();
  els.flowStage.classList.add('drop-active');
});

els.flowStage.addEventListener('dragleave', () => {
  els.flowStage.classList.remove('drop-active');
});

els.flowStage.addEventListener('drop', (e) => {
  e.preventDefault();
  els.flowStage.classList.remove('drop-active');
  const type =
    e.dataTransfer?.getData('application/x-nano-node-type') ||
    e.dataTransfer?.getData('text/plain');
  if (!['action', 'condition', 'ask_user', 'done'].includes(type)) return;

  const rect = els.flowStage.getBoundingClientRect();
  const rawX = e.clientX - rect.left - NODE_WIDTH / 2;
  const rawY = e.clientY - rect.top - 40;
  const snappedX = Math.max(20, Math.min(1220, Math.round(rawX / 20) * 20));
  const snappedY = Math.max(20, Math.min(1040, Math.round(rawY / 20) * 20));
  addNodeAndMaybeAutoConnect(type, snappedX, snappedY);
});

// Topbar & Sidebar Events
els.studioPresetName.addEventListener('input', () => {
  if (!activePreset) return;
  activePreset.name = els.studioPresetName.value;
  markDirty(true);
  renderCanvas();
  if (selectedNodeId === 'node_start') {
    renderInspector();
  }
});

els.autoLayoutBtn.addEventListener('click', () => {
  if (!activePreset) return;
  autoLayoutGraph(activePreset);
  markDirty(true);
  renderCanvas();
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
    selectedNodeId = activePreset.nodes.find((n) => n.type === 'start')?.id || 'node_start';
    connectingFrom = null;
    markDirty(false);
    renderAll();
  } catch (error) {
    els.studioSaveStatus.textContent = `読込エラー: ${error?.message || error}`;
  }
});

els.newPresetBtn.addEventListener('click', async () => {
  const startNode = createNode('start', { id: 'node_start', label: '開始', x: 480, y: 40 });
  const actNode = createNode('action', { id: `n_${Date.now().toString(36)}_1`, x: 480, y: 200 });
  const doneNode = createNode('done', { id: `n_${Date.now().toString(36)}_2`, x: 480, y: 360 });
  const fresh = validateWorkflowPreset({
    id: `preset_${Date.now().toString(36)}`,
    name: '新しいフロー',
    description: '',
    startUrl: '',
    nodes: [startNode, actNode, doneNode],
    edges: [
      { id: 'e_init_1', from: startNode.id, port: 'next', to: actNode.id },
      { id: 'e_init_2', from: actNode.id, port: 'next', to: doneNode.id }
    ]
  });
  activePreset = await store.save(fresh);
  presets = await store.list();
  selectedNodeId = startNode.id;
  connectingFrom = null;
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
  selectedNodeId = activePreset.nodes.find((n) => n.type === 'start')?.id || 'node_start';
  connectingFrom = null;
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
  selectedNodeId = activePreset.nodes.find((n) => n.type === 'start')?.id || 'node_start';
  connectingFrom = null;
  markDirty(false);
  renderAll();
});

// Boot
presets = await store.list();
const params = new URLSearchParams(location.search);
const requestedId = params.get('presetId');
const initial = (requestedId && presets.find((p) => p.id === requestedId)) || presets[0];
activePreset = clonePreset(initial);
selectedNodeId = activePreset.nodes.find((n) => n.type === 'start')?.id || 'node_start';
markDirty(false);
renderAll();
