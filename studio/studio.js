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
  connectNodesSmart,
  copySubgraph,
  createNode,
  disconnectEdge,
  moveGraphNodePosition,
  pasteSubgraphAt,
  removeGraphNode,
  removeMultipleGraphNodes,
  selectNodesInRect,
  updateGraphNode,
  validateWorkflowPreset
} from '../shared/workflow-flow.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const NODE_WIDTH = 240;
const MAX_UNDO_HISTORY = 50;
const store = new WorkflowPresetStore(chrome.storage?.local);

const els = {
  studioPresetName: document.getElementById('studioPresetName'),
  studioSaveStatus: document.getElementById('studioSaveStatus'),
  undoBtn: document.getElementById('undoBtn'),
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
  marqueeBox: document.getElementById('marqueeBox'),
  inspectorTitle: document.getElementById('inspectorTitle'),
  inspectorBody: document.getElementById('inspectorBody'),
  playbookModal: document.getElementById('playbookModal'),
  playbookModalBackdrop: document.getElementById('playbookModalBackdrop'),
  closePlaybookModalBtn: document.getElementById('closePlaybookModalBtn'),
  compiledPlaybookPre: document.getElementById('compiledPlaybookPre')
};

let presets = [];
let activePreset = null;
let selectedNodeIds = new Set(['node_start']);
let primarySelectedNodeId = 'node_start';
let connectingFrom = null; // { nodeId, port }
let cursorPos = { x: 480, y: 200 };
let dragState = null;
let marqueeState = null;
let undoStack = [];
let nodeClipboard = null;
let suppressNextCardClick = false;
let suppressNextStageClick = false;
const nodeDomMap = new Map();

function markDirty(dirty = true) {
  els.studioSaveStatus.textContent = dirty ? '未保存の変更' : '保存済み';
  els.studioSaveStatus.classList.toggle('dirty', dirty);
}

function setSingleSelection(nodeId) {
  selectedNodeIds = nodeId ? new Set([nodeId]) : new Set();
  primarySelectedNodeId = nodeId || null;
}

function setMultiSelection(ids, primaryId = null) {
  const list = Array.from(ids || []).filter(Boolean);
  selectedNodeIds = new Set(list);
  if (primaryId && selectedNodeIds.has(primaryId)) {
    primarySelectedNodeId = primaryId;
  } else {
    primarySelectedNodeId = list[list.length - 1] || null;
  }
}

function blurActiveTextInput() {
  const active = document.activeElement;
  if (active && ['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName)) {
    active.blur();
  }
}

function updateUndoButtonState() {
  if (els.undoBtn) {
    els.undoBtn.disabled = undoStack.length === 0;
  }
}

function resetUndoHistory() {
  undoStack = [];
  updateUndoButtonState();
}

function pushUndoSnapshot() {
  if (!activePreset) return;
  undoStack.push({
    preset: clonePreset(activePreset),
    selectedIds: Array.from(selectedNodeIds),
    primaryId: primarySelectedNodeId
  });
  if (undoStack.length > MAX_UNDO_HISTORY) {
    undoStack.shift();
  }
  updateUndoButtonState();
}

function performUndo() {
  if (!undoStack.length) return false;
  const snapshot = undoStack.pop();
  activePreset = clonePreset(snapshot.preset);
  const existingIds = new Set(activePreset.nodes.map((n) => n.id));
  const restoredSelected = (snapshot.selectedIds || []).filter((id) => existingIds.has(id));
  if (restoredSelected.length > 0) {
    setMultiSelection(
      restoredSelected,
      existingIds.has(snapshot.primaryId) ? snapshot.primaryId : restoredSelected[0]
    );
  } else {
    setSingleSelection(activePreset.nodes.find((n) => n.type === 'start')?.id || activePreset.nodes[0]?.id || null);
  }
  connectingFrom = null;
  markDirty(true);
  updateUndoButtonState();
  renderAll();
  return true;
}

function updateCanvasStatusBar(customMessage = null) {
  if (customMessage) {
    els.canvasStatusBar.textContent = customMessage;
    els.canvasStatusBar.classList.remove('connecting');
    return;
  }
  if (connectingFrom) {
    const srcNode = activePreset?.nodes.find((n) => n.id === connectingFrom.nodeId);
    const portText =
      connectingFrom.port === 'yes'
        ? 'YES'
        : connectingFrom.port === 'no'
          ? 'NO'
          : connectingFrom.port === 'auto'
            ? '自動ポート'
            : '次へ';
    els.canvasStatusBar.textContent = `接続モード: 「${srcNode?.label || connectingFrom.nodeId}」(${portText}) の接続先ノードをクリックしてください（Esc または背景クリックでキャンセル）`;
    els.canvasStatusBar.classList.add('connecting');
  } else if (selectedNodeIds.size > 1) {
    els.canvasStatusBar.textContent = `${selectedNodeIds.size} 個のノードを選択中 — ドラッグでまとめて移動 / Ctrl+C:コピー / Ctrl+X:切り取り / Del:削除`;
    els.canvasStatusBar.classList.remove('connecting');
  } else {
    els.canvasStatusBar.textContent =
      'ヒント: 左ノードをドラッグ設置 / 空き領域ドラッグで複数選択 / Ctrl+クリック2回で接続 / Ctrl+C,X,V,A,Z,S,L 対応';
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
      setSingleSelection(activePreset.nodes.find((n) => n.type === 'start')?.id || activePreset.nodes[0]?.id || null);
      connectingFrom = null;
      resetUndoHistory();
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
      pushUndoSnapshot();
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
      pushUndoSnapshot();
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

function syncSelectionClassesInDom() {
  for (const [id, el] of nodeDomMap.entries()) {
    el.classList.toggle('selected', selectedNodeIds.has(id));
  }
}

function getCurrentNodeSizeMap() {
  const sizeMap = new Map();
  for (const [id, el] of nodeDomMap.entries()) {
    sizeMap.set(id, {
      width: el.offsetWidth || NODE_WIDTH,
      height: el.offsetHeight || 120
    });
  }
  return sizeMap;
}

function createGraphNodeElement(node) {
  const card = document.createElement('div');
  const isSourceActive = Boolean(connectingFrom) && connectingFrom.nodeId === node.id;
  const isTargetReady =
    Boolean(connectingFrom) &&
    connectingFrom.nodeId !== node.id &&
    node.type !== 'start';

  card.className = `graph-node graph-node-${node.type}${selectedNodeIds.has(node.id) ? ' selected' : ''}${
    isSourceActive ? ' connect-source-active' : ''
  }${isTargetReady ? ' connect-target-ready' : ''}`;
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
      blurActiveTextInput();
      if (connectingFrom && connectingFrom.nodeId !== node.id) {
        pushUndoSnapshot();
        if (connectingFrom.port === 'auto') {
          connectNodesSmart(activePreset, connectingFrom.nodeId, node.id);
        } else {
          connectNodes(activePreset, connectingFrom.nodeId, connectingFrom.port, node.id);
        }
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
      blurActiveTextInput();
      if (connectingFrom?.nodeId === node.id) {
        connectingFrom = null;
      }
      pushUndoSnapshot();
      removeGraphNode(activePreset, node.id);
      selectedNodeIds.delete(node.id);
      if (selectedNodeIds.size === 0) {
        setSingleSelection('node_start');
      } else if (primarySelectedNodeId === node.id) {
        primarySelectedNodeId = Array.from(selectedNodeIds)[0];
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

  // Click to select, finish connection, or Ctrl+Click 1 & 2 connect
  card.addEventListener('click', (e) => {
    e.stopPropagation();
    blurActiveTextInput();
    if (suppressNextCardClick) {
      suppressNextCardClick = false;
      return;
    }

    const isCtrlOrMeta = e.ctrlKey || e.metaKey;
    if (isCtrlOrMeta) {
      if (!connectingFrom) {
        if (node.type === 'done') {
          updateCanvasStatusBar('完了ノードからは接続元を開始できません。他のノードを Ctrl+クリックしてください。');
          return;
        }
        connectingFrom = { nodeId: node.id, port: 'auto' };
        const anchor = getPortAnchor(node.id, 'auto');
        cursorPos = { x: anchor.x, y: anchor.y + 40 };
        renderCanvas();
        return;
      }
      if (connectingFrom.nodeId === node.id) {
        connectingFrom = null;
        renderCanvas();
        return;
      }
      if (node.type === 'start') {
        updateCanvasStatusBar('開始ノードは接続先にできません。別のノードを Ctrl+クリックしてください。');
        return;
      }
      pushUndoSnapshot();
      const result =
        connectingFrom.port === 'auto'
          ? connectNodesSmart(activePreset, connectingFrom.nodeId, node.id)
          : { ok: Boolean(connectNodes(activePreset, connectingFrom.nodeId, connectingFrom.port, node.id)) };
      connectingFrom = null;
      if (result.ok) {
        markDirty(true);
        renderCanvas();
        renderPresetList();
      }
      return;
    }

    if (connectingFrom) {
      if (connectingFrom.nodeId !== node.id && node.type !== 'start') {
        pushUndoSnapshot();
        if (connectingFrom.port === 'auto') {
          connectNodesSmart(activePreset, connectingFrom.nodeId, node.id);
        } else {
          connectNodes(activePreset, connectingFrom.nodeId, connectingFrom.port, node.id);
        }
        connectingFrom = null;
        markDirty(true);
        renderCanvas();
        renderPresetList();
        return;
      }
    }

    if (e.shiftKey) {
      const nextSet = new Set(selectedNodeIds);
      if (nextSet.has(node.id) && nextSet.size > 1) {
        nextSet.delete(node.id);
        setMultiSelection(nextSet);
      } else {
        nextSet.add(node.id);
        setMultiSelection(nextSet, node.id);
      }
    } else {
      setSingleSelection(node.id);
    }
    renderCanvas();
    renderInspector();
  });

  // Pointer drag to move single or multi-selected nodes freely on stage
  card.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('button')) return;
    if (connectingFrom) return;
    if (e.ctrlKey || e.metaKey) return;

    e.stopPropagation();
    blurActiveTextInput();

    if (!selectedNodeIds.has(node.id) && !e.shiftKey) {
      setSingleSelection(node.id);
      syncSelectionClassesInDom();
      renderInspector();
      updateCanvasStatusBar();
    }

    const dragIds = selectedNodeIds.has(node.id) ? Array.from(selectedNodeIds) : [node.id];
    const items = dragIds
      .map((id) => {
        const targetNode = activePreset.nodes.find((n) => n.id === id);
        const targetEl = nodeDomMap.get(id);
        if (!targetNode || !targetEl) return null;
        targetEl.classList.add('dragging');
        return { id, origX: targetNode.x, origY: targetNode.y, el: targetEl };
      })
      .filter(Boolean);

    dragState = {
      leadNodeId: node.id,
      cardEl: card,
      startPointerX: e.clientX,
      startPointerY: e.clientY,
      moved: false,
      undoPushed: false,
      items
    };
    card.setPointerCapture?.(e.pointerId);
  });

  card.addEventListener('pointermove', (e) => {
    if (!dragState || dragState.leadNodeId !== node.id) return;
    const dx = e.clientX - dragState.startPointerX;
    const dy = e.clientY - dragState.startPointerY;
    if (!dragState.moved && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) {
      dragState.moved = true;
    }
    if (!dragState.moved) return;

    if (!dragState.undoPushed) {
      pushUndoSnapshot();
      dragState.undoPushed = true;
    }

    for (const item of dragState.items) {
      const nextX = Math.max(20, Math.min(1220, Math.round((item.origX + dx) / 10) * 10));
      const nextY = Math.max(20, Math.min(1040, Math.round((item.origY + dy) / 10) * 10));
      moveGraphNodePosition(activePreset, item.id, nextX, nextY);
      item.el.style.left = `${nextX}px`;
      item.el.style.top = `${nextY}px`;
    }
    renderEdgesSvg();
  });

  card.addEventListener('pointerup', (e) => {
    if (!dragState || dragState.leadNodeId !== node.id) return;
    for (const item of dragState.items) {
      item.el.classList.remove('dragging');
    }
    card.releasePointerCapture?.(e.pointerId);
    if (dragState.moved) {
      suppressNextCardClick = true;
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

function attachInputUndo(inputEl) {
  let pushedForFocus = false;
  inputEl.addEventListener('focus', () => {
    pushedForFocus = false;
  });
  return () => {
    if (!pushedForFocus) {
      pushUndoSnapshot();
      pushedForFocus = true;
    }
  };
}

function copySelectedNodes() {
  if (!activePreset) return 0;
  const copied = copySubgraph(activePreset, Array.from(selectedNodeIds));
  if (!copied.nodes.length) {
    updateCanvasStatusBar('開始ノード以外のノードを選択してからコピーしてください。');
    return 0;
  }
  nodeClipboard = copied;
  updateCanvasStatusBar(`${copied.nodes.length} 個のノードをコピーしました（Ctrl+V でカーソル位置に貼り付け）`);
  return copied.nodes.length;
}

function cutSelectedNodes() {
  if (!activePreset) return 0;
  const copied = copySubgraph(activePreset, Array.from(selectedNodeIds));
  if (!copied.nodes.length) {
    updateCanvasStatusBar('開始ノードは切り取りできません。別のノードを選択してください。');
    return 0;
  }
  nodeClipboard = copied;
  pushUndoSnapshot();
  const removed = removeMultipleGraphNodes(activePreset, copied.nodes.map((n) => n.id));
  if (removed > 0) {
    setSingleSelection('node_start');
    markDirty(true);
    renderAll();
    updateCanvasStatusBar(`${removed} 個のノードを切り取りました（Ctrl+V で貼り付け / Ctrl+Z で元に戻す）`);
  }
  return removed;
}

function pasteCopiedNodesAtCursor() {
  if (!activePreset || !nodeClipboard?.nodes?.length) {
    updateCanvasStatusBar('貼り付けるノードがありません（先に Ctrl+C または Ctrl+X でコピーしてください）。');
    return 0;
  }
  pushUndoSnapshot();
  const rawX = Number.isFinite(cursorPos.x) ? cursorPos.x - NODE_WIDTH / 2 : 480;
  const rawY = Number.isFinite(cursorPos.y) ? cursorPos.y - 40 : 200;
  const targetX = Math.max(20, Math.min(1220, Math.round(rawX / 10) * 10));
  const targetY = Math.max(20, Math.min(1040, Math.round(rawY / 10) * 10));
  const pastedIds = pasteSubgraphAt(activePreset, nodeClipboard, targetX, targetY);
  if (pastedIds.length > 0) {
    setMultiSelection(pastedIds);
    markDirty(true);
    renderAll();
    updateCanvasStatusBar(`${pastedIds.length} 個のノードをカーソル位置に貼り付けました`);
  }
  return pastedIds.length;
}

function deleteSelectedNodes() {
  if (!activePreset) return 0;
  const deletable = Array.from(selectedNodeIds).filter((id) => {
    const n = activePreset.nodes.find((node) => node.id === id);
    return n && n.type !== 'start' && n.id !== 'node_start';
  });
  if (!deletable.length) return 0;
  pushUndoSnapshot();
  const removed = removeMultipleGraphNodes(activePreset, deletable);
  if (removed > 0) {
    setSingleSelection('node_start');
    markDirty(true);
    renderAll();
    updateCanvasStatusBar(`${removed} 個のノードを削除しました（Ctrl+Z で元に戻す）`);
  }
  return removed;
}

function renderInspector() {
  els.inspectorBody.innerHTML = '';
  if (!activePreset) return;

  if (selectedNodeIds.size > 1) {
    els.inspectorTitle.textContent = `複数選択 (${selectedNodeIds.size}ノード)`;

    const info = document.createElement('p');
    info.className = 'inspector-help';
    info.textContent =
      '選択中のノードをドラッグでまとめて移動、または一括コピー・切り取り・削除できます（開始ノードは削除・コピー対象外です）。';
    els.inspectorBody.appendChild(info);

    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'inspector-actions';

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'btn btn-secondary btn-xs';
    copyBtn.textContent = 'コピー (Ctrl+C)';
    copyBtn.addEventListener('click', copySelectedNodes);

    const cutBtn = document.createElement('button');
    cutBtn.type = 'button';
    cutBtn.className = 'btn btn-secondary btn-xs';
    cutBtn.textContent = '切り取り (Ctrl+X)';
    cutBtn.addEventListener('click', cutSelectedNodes);

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'btn btn-danger btn-xs';
    delBtn.textContent = '選択を削除 (Del)';
    delBtn.addEventListener('click', deleteSelectedNodes);

    actionsDiv.appendChild(copyBtn);
    actionsDiv.appendChild(cutBtn);
    actionsDiv.appendChild(delBtn);
    els.inspectorBody.appendChild(actionsDiv);
    return;
  }

  const targetId = primarySelectedNodeId || Array.from(selectedNodeIds)[0];
  const node = activePreset.nodes.find((n) => n.id === targetId);
  if (!node || node.type === 'start') {
    els.inspectorTitle.textContent = 'フロー全体設定 (開始ノード)';

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.value = activePreset.name;
    const ensureNameUndo = attachInputUndo(nameInput);
    nameInput.addEventListener('input', () => {
      ensureNameUndo();
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
    const ensureUrlUndo = attachInputUndo(urlInput);
    urlInput.addEventListener('input', () => {
      ensureUrlUndo();
      activePreset.startUrl = urlInput.value.trim();
      markDirty(true);
      renderCanvas();
    });
    addField(els.inspectorBody, '開始URL（任意）', urlInput);

    const descInput = document.createElement('textarea');
    descInput.value = activePreset.description || '';
    descInput.placeholder = 'このフローの目的や前提条件を記述してください';
    const ensureDescUndo = attachInputUndo(descInput);
    descInput.addEventListener('input', () => {
      ensureDescUndo();
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
  const ensureLabelUndo = attachInputUndo(labelInput);
  labelInput.addEventListener('input', () => {
    ensureLabelUndo();
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
      pushUndoSnapshot();
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
      const ensureActionUrlUndo = attachInputUndo(urlInput);
      urlInput.addEventListener('input', () => {
        ensureActionUrlUndo();
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
      const ensureTargetUndo = attachInputUndo(targetInput);
      targetInput.addEventListener('input', () => {
        ensureTargetUndo();
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
      const ensureValUndo = attachInputUndo(valInput);
      valInput.addEventListener('input', () => {
        ensureValUndo();
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
      const ensureMsUndo = attachInputUndo(msInput);
      msInput.addEventListener('input', () => {
        ensureMsUndo();
        updateGraphNode(activePreset, node.id, { ms: Number(msInput.value) || 1000 });
        markDirty(true);
        renderCanvas();
      });
      addField(els.inspectorBody, '待機時間 (ms)', msInput);
    }

    const notesInput = document.createElement('textarea');
    notesInput.value = node.notes || '';
    notesInput.placeholder = 'AI への補足条件や注意点';
    const ensureNotesUndo = attachInputUndo(notesInput);
    notesInput.addEventListener('input', () => {
      ensureNotesUndo();
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
      pushUndoSnapshot();
      updateGraphNode(activePreset, node.id, { conditionType: condSel.value });
      markDirty(true);
      renderCanvas();
    });
    addField(els.inspectorBody, '条件判定方法', condSel);

    const condValInput = document.createElement('input');
    condValInput.type = 'text';
    condValInput.placeholder = '例: ログイン / /error / 購入ボタン';
    condValInput.value = node.conditionValue || '';
    const ensureCondValUndo = attachInputUndo(condValInput);
    condValInput.addEventListener('input', () => {
      ensureCondValUndo();
      updateGraphNode(activePreset, node.id, { conditionValue: condValInput.value });
      markDirty(true);
      renderCanvas();
    });
    addField(els.inspectorBody, '判定対象テキスト / 条件内容', condValInput);
  } else {
    const msgInput = document.createElement('textarea');
    msgInput.value = node.message || '';
    const ensureMsgUndo = attachInputUndo(msgInput);
    msgInput.addEventListener('input', () => {
      ensureMsgUndo();
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
    pushUndoSnapshot();
    removeGraphNode(activePreset, node.id);
    setSingleSelection('node_start');
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
  pushUndoSnapshot();
  const baseId = primarySelectedNodeId || Array.from(selectedNodeIds)[0];
  const baseNode = activePreset.nodes.find((n) => n.id === baseId) || activePreset.nodes[0];
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

  setSingleSelection(created.id);
  markDirty(true);
  renderCanvas();
  renderInspector();
  renderPresetList();
}

function getStageCoordinates(clientX, clientY) {
  const rect = els.flowStage.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(els.flowStage.offsetWidth || 1600, clientX - rect.left)),
    y: Math.max(0, Math.min(els.flowStage.offsetHeight || 1200, clientY - rect.top))
  };
}

// Always track stage mouse cursor for Ctrl+V paste & live preview wire
els.flowStage.addEventListener('mousemove', (e) => {
  cursorPos = getStageCoordinates(e.clientX, e.clientY);
  if (connectingFrom) {
    renderEdgesSvg();
  }
});

// Drag marquee multi-selection on empty stage background
els.flowStage.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  if (e.target.closest('.graph-node') || e.target.closest('.edge-badge-group') || e.target.closest('.edge-hit-area')) {
    return;
  }
  blurActiveTextInput();
  if (connectingFrom) return;

  const pos = getStageCoordinates(e.clientX, e.clientY);
  cursorPos = pos;
  marqueeState = {
    startX: pos.x,
    startY: pos.y,
    curX: pos.x,
    curY: pos.y,
    moved: false,
    additive: e.shiftKey,
    baseSelected: new Set(selectedNodeIds)
  };
  els.flowStage.setPointerCapture?.(e.pointerId);
});

els.flowStage.addEventListener('pointermove', (e) => {
  cursorPos = getStageCoordinates(e.clientX, e.clientY);
  if (!marqueeState || !activePreset) return;

  marqueeState.curX = cursorPos.x;
  marqueeState.curY = cursorPos.y;
  const dx = marqueeState.curX - marqueeState.startX;
  const dy = marqueeState.curY - marqueeState.startY;
  if (!marqueeState.moved && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) {
    marqueeState.moved = true;
    els.marqueeBox.classList.remove('hidden');
  }
  if (!marqueeState.moved) return;

  const left = Math.min(marqueeState.startX, marqueeState.curX);
  const top = Math.min(marqueeState.startY, marqueeState.curY);
  const width = Math.abs(dx);
  const height = Math.abs(dy);

  // Direct CSSOM positioning (strict CSP compliant)
  els.marqueeBox.style.left = `${left}px`;
  els.marqueeBox.style.top = `${top}px`;
  els.marqueeBox.style.width = `${width}px`;
  els.marqueeBox.style.height = `${height}px`;

  const hitIds = selectNodesInRect(
    activePreset,
    { x1: left, y1: top, x2: left + width, y2: top + height },
    getCurrentNodeSizeMap()
  );
  const nextSelection = marqueeState.additive ? new Set([...marqueeState.baseSelected, ...hitIds]) : new Set(hitIds);
  setMultiSelection(nextSelection);
  syncSelectionClassesInDom();
  updateCanvasStatusBar();
});

function finishMarquee(e) {
  if (!marqueeState) return;
  const hadDrag = marqueeState.moved;
  els.marqueeBox.classList.add('hidden');
  els.flowStage.releasePointerCapture?.(e.pointerId);
  marqueeState = null;
  if (hadDrag) {
    suppressNextStageClick = true;
    renderInspector();
    updateCanvasStatusBar();
  }
}

els.flowStage.addEventListener('pointerup', finishMarquee);
els.flowStage.addEventListener('pointercancel', finishMarquee);

els.flowStage.addEventListener('click', () => {
  blurActiveTextInput();
  if (suppressNextStageClick) {
    suppressNextStageClick = false;
    return;
  }
  if (connectingFrom) {
    connectingFrom = null;
    renderCanvas();
    return;
  }
  if (activePreset && selectedNodeIds.size > 0) {
    setSingleSelection(activePreset.nodes.find((n) => n.type === 'start')?.id || 'node_start');
    renderCanvas();
    renderInspector();
  }
});

function runAutoLayout() {
  if (!activePreset) return;
  pushUndoSnapshot();
  autoLayoutGraph(activePreset);
  markDirty(true);
  renderCanvas();
  updateCanvasStatusBar('ノードを自動整列しました（Ctrl+Z で元に戻す）');
}

document.addEventListener('keydown', (e) => {
  const isCtrlOrMeta = e.ctrlKey || e.metaKey;
  const key = (e.key || '').toLowerCase();
  const activeEl = document.activeElement;
  const isTypingField =
    Boolean(activeEl) &&
    (['INPUT', 'TEXTAREA', 'SELECT'].includes(activeEl.tagName) || activeEl.isContentEditable);

  if (key === 'escape') {
    if (!els.playbookModal.classList.contains('hidden')) {
      els.playbookModal.classList.add('hidden');
      return;
    }
    if (connectingFrom) {
      connectingFrom = null;
      renderCanvas();
      return;
    }
  }

  // Global save & auto-layout shortcuts work even when focus is in inspector inputs
  if (isCtrlOrMeta && key === 's') {
    e.preventDefault();
    saveCurrentPreset();
    return;
  }
  if (isCtrlOrMeta && key === 'l') {
    e.preventDefault();
    runAutoLayout();
    return;
  }

  // Keep native text editing shortcuts intact when typing inside inputs/textareas
  if (isTypingField) return;

  if (isCtrlOrMeta && key === 'c') {
    e.preventDefault();
    copySelectedNodes();
    return;
  }
  if (isCtrlOrMeta && key === 'x') {
    e.preventDefault();
    cutSelectedNodes();
    return;
  }
  if (isCtrlOrMeta && key === 'v') {
    e.preventDefault();
    pasteCopiedNodesAtCursor();
    return;
  }
  if (isCtrlOrMeta && key === 'a') {
    e.preventDefault();
    if (!activePreset) return;
    setMultiSelection(activePreset.nodes.map((n) => n.id));
    renderCanvas();
    renderInspector();
    return;
  }
  if (isCtrlOrMeta && key === 'z' && !e.shiftKey) {
    e.preventDefault();
    if (!performUndo()) {
      updateCanvasStatusBar('これ以上戻せる操作履歴はありません。');
    }
    return;
  }
  if (key === 'delete' || key === 'backspace') {
    if (selectedNodeIds.size > 0) {
      e.preventDefault();
      deleteSelectedNodes();
    }
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
const ensureTopNameUndo = attachInputUndo(els.studioPresetName);
els.studioPresetName.addEventListener('input', () => {
  if (!activePreset) return;
  ensureTopNameUndo();
  activePreset.name = els.studioPresetName.value;
  markDirty(true);
  renderCanvas();
  if (selectedNodeIds.size === 1 && selectedNodeIds.has('node_start')) {
    renderInspector();
  }
});

els.undoBtn.addEventListener('click', () => {
  performUndo();
});

els.autoLayoutBtn.addEventListener('click', runAutoLayout);

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
    setSingleSelection(activePreset.nodes.find((n) => n.type === 'start')?.id || 'node_start');
    connectingFrom = null;
    resetUndoHistory();
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
  setSingleSelection(startNode.id);
  connectingFrom = null;
  resetUndoHistory();
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
  setSingleSelection(activePreset.nodes.find((n) => n.type === 'start')?.id || 'node_start');
  connectingFrom = null;
  resetUndoHistory();
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
  setSingleSelection(activePreset.nodes.find((n) => n.type === 'start')?.id || 'node_start');
  connectingFrom = null;
  resetUndoHistory();
  markDirty(false);
  renderAll();
});

// Boot
presets = await store.list();
const params = new URLSearchParams(location.search);
const requestedId = params.get('presetId');
const initial = (requestedId && presets.find((p) => p.id === requestedId)) || presets[0];
activePreset = clonePreset(initial);
setSingleSelection(activePreset.nodes.find((n) => n.type === 'start')?.id || 'node_start');
resetUndoHistory();
markDirty(false);
renderAll();
