import { FLOW_PRESETS_STORAGE_KEY } from './constants.js';
import { parsePlaybookContent } from './playbook.js';

export const FLOW_NODE_TYPES = Object.freeze(['start', 'action', 'condition', 'ask_user', 'done']);

export const FLOW_ACTION_TYPES = Object.freeze([
  { value: 'navigate', label: 'URLへ移動 (navigate)' },
  { value: 'click', label: '要素をクリック (click)' },
  { value: 'type', label: 'テキストを入力 (type)' },
  { value: 'select', label: 'プルダウン選択 (select)' },
  { value: 'scroll', label: '画面スクロール (scroll)' },
  { value: 'wait', label: '待機 (wait)' },
  { value: 'open_tab', label: '新規タブを開く (open_tab)' },
  { value: 'switch_tab', label: 'タブ切り替え (switch_tab)' },
  { value: 'close_tab', label: 'タブを閉じる (close_tab)' },
  { value: 'download_page_pdf', label: '画面をPDF保存＆読込 (download_page_pdf)' },
  { value: 'read_pdf', label: 'PDFページ読込 (read_pdf)' },
  { value: 'ai_step', label: 'AI自律ステップ (自由指示)' }
]);

export const FLOW_CONDITION_TYPES = Object.freeze([
  { value: 'text_contains', label: 'ページ本文に特定の文字を含む' },
  { value: 'url_contains', label: '現在のURLに特定の文字を含む' },
  { value: 'element_visible', label: '特定のボタン・要素が表示されている' },
  { value: 'ai_judge', label: 'AIが画面を見て条件を判断する' }
]);

function generateId(prefix = 'node') {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
  }
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

export function createNode(type = 'action', overrides = {}) {
  const id = overrides.id || generateId(type === 'start' ? 'start' : 'node');
  const x = Number.isFinite(Number(overrides.x)) ? Math.round(Number(overrides.x)) : 460;
  const y = Number.isFinite(Number(overrides.y)) ? Math.round(Number(overrides.y)) : 160;

  switch (type) {
    case 'start':
      return {
        id: overrides.id || 'node_start',
        type: 'start',
        label: overrides.label ?? '開始',
        x,
        y
      };
    case 'condition':
      return {
        id,
        type: 'condition',
        label: overrides.label ?? '条件分岐',
        conditionType: overrides.conditionType ?? 'text_contains',
        conditionValue: overrides.conditionValue ?? '',
        x,
        y,
        yesBranch: Array.isArray(overrides.yesBranch)
          ? overrides.yesBranch.map((n) => normalizeNode(n))
          : [],
        noBranch: Array.isArray(overrides.noBranch)
          ? overrides.noBranch.map((n) => normalizeNode(n))
          : []
      };
    case 'ask_user':
      return {
        id,
        type: 'ask_user',
        label: overrides.label ?? '人間に指示を仰ぐ',
        message: overrides.message ?? '画面状態を確認し、次の指示を入力してください。',
        x,
        y
      };
    case 'done':
      return {
        id,
        type: 'done',
        label: overrides.label ?? 'フロー完了',
        message: overrides.message ?? '手順フローが完了しました。結果を日本語で報告します。',
        x,
        y
      };
    case 'action':
    default:
      return {
        id,
        type: 'action',
        label: overrides.label ?? '操作ステップ',
        actionType: overrides.actionType ?? 'click',
        target: overrides.target ?? '',
        value: overrides.value ?? '',
        url: overrides.url ?? '',
        ms: Number.isFinite(Number(overrides.ms)) ? Number(overrides.ms) : 1000,
        notes: overrides.notes ?? '',
        x,
        y
      };
  }
}

export function normalizeNode(raw) {
  if (!raw || typeof raw !== 'object') {
    return createNode('action');
  }
  const type = FLOW_NODE_TYPES.includes(raw.type) ? raw.type : 'action';
  return createNode(type, raw);
}

function normalizeEdge(raw) {
  if (!raw || typeof raw !== 'object' || !raw.from || !raw.to) return null;
  const port = raw.port === 'yes' || raw.port === 'no' ? raw.port : 'next';
  return {
    id: String(raw.id || generateId('edge')),
    from: String(raw.from),
    port,
    to: String(raw.to)
  };
}

function migrateLegacyTreeToGraph(rawNodes) {
  const startNode = createNode('start', { id: 'node_start', label: '開始', x: 460, y: 40 });
  const graphNodes = [startNode];
  const graphEdges = [];

  const flattenSequence = (seq, incomingRefs) => {
    let tails = incomingRefs; // Array<{ from, port }>
    for (const item of seq) {
      const node = normalizeNode(item);
      const cleanNode = { ...node };
      const yesBranch = Array.isArray(item.yesBranch) ? item.yesBranch : [];
      const noBranch = Array.isArray(item.noBranch) ? item.noBranch : [];
      if (cleanNode.type === 'condition') {
        cleanNode.yesBranch = [];
        cleanNode.noBranch = [];
      }
      graphNodes.push(cleanNode);

      for (const inc of tails) {
        graphEdges.push(
          normalizeEdge({
            from: inc.from,
            port: inc.port,
            to: cleanNode.id
          })
        );
      }

      if (cleanNode.type === 'condition') {
        const yesTails =
          yesBranch.length > 0
            ? flattenSequence(yesBranch, [{ from: cleanNode.id, port: 'yes' }])
            : [{ from: cleanNode.id, port: 'yes' }];
        const noTails =
          noBranch.length > 0
            ? flattenSequence(noBranch, [{ from: cleanNode.id, port: 'no' }])
            : [{ from: cleanNode.id, port: 'no' }];
        tails = [...yesTails, ...noTails];
      } else if (cleanNode.type === 'done') {
        tails = [];
      } else {
        tails = [{ from: cleanNode.id, port: 'next' }];
      }
    }
    return tails;
  };

  flattenSequence(rawNodes, [{ from: startNode.id, port: 'next' }]);
  return { nodes: graphNodes, edges: graphEdges.filter(Boolean) };
}

export function autoLayoutGraph(preset) {
  const nodes = Array.isArray(preset?.nodes) ? preset.nodes : [];
  const edges = Array.isArray(preset?.edges) ? preset.edges : [];
  if (nodes.length === 0) return preset;

  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const startNode = nodes.find((n) => n.type === 'start') || nodes[0];
  const outEdges = new Map();
  for (const e of edges) {
    if (!outEdges.has(e.from)) outEdges.set(e.from, []);
    outEdges.get(e.from).push(e);
  }

  // BFS topological-like level & horizontal offset assignment
  const depthMap = new Map();
  const xHintMap = new Map();
  const queue = [{ id: startNode.id, depth: 0, xHint: 480 }];
  depthMap.set(startNode.id, 0);
  xHintMap.set(startNode.id, 480);

  while (queue.length > 0) {
    const { id, depth, xHint } = queue.shift();
    const outs = outEdges.get(id) || [];
    for (const edge of outs) {
      if (!nodeMap.has(edge.to)) continue;
      let nextX = xHint;
      if (edge.port === 'yes') nextX = xHint - 220;
      else if (edge.port === 'no') nextX = xHint + 220;

      const prevDepth = depthMap.get(edge.to);
      if (prevDepth === undefined || prevDepth < depth + 1) {
        depthMap.set(edge.to, depth + 1);
        xHintMap.set(edge.to, nextX);
        queue.push({ id: edge.to, depth: depth + 1, xHint: nextX });
      }
    }
  }

  // Place disconnected nodes neatly at the bottom
  let maxDepth = 0;
  for (const d of depthMap.values()) maxDepth = Math.max(maxDepth, d);
  let orphanIdx = 0;
  for (const n of nodes) {
    if (!depthMap.has(n.id)) {
      maxDepth += 1;
      depthMap.set(n.id, maxDepth);
      xHintMap.set(n.id, 480 + (orphanIdx % 2 === 0 ? 0 : 240));
      orphanIdx += 1;
    }
  }

  // Resolve horizontal collisions within the same depth row
  const rows = new Map();
  for (const n of nodes) {
    const d = depthMap.get(n.id) ?? 0;
    if (!rows.has(d)) rows.set(d, []);
    rows.get(d).push(n);
  }

  for (const [depth, rowNodes] of rows.entries()) {
    rowNodes.sort((a, b) => (xHintMap.get(a.id) ?? 480) - (xHintMap.get(b.id) ?? 480));
    let prevX = -Infinity;
    for (const n of rowNodes) {
      let desiredX = Math.max(40, Math.round((xHintMap.get(n.id) ?? 480) / 20) * 20);
      if (desiredX - prevX < 280) {
        desiredX = prevX + 280;
      }
      n.x = desiredX;
      n.y = 40 + depth * 170;
      prevX = desiredX;
    }
  }

  return preset;
}

export function validateWorkflowPreset(rawPreset) {
  if (!rawPreset || typeof rawPreset !== 'object') {
    throw new Error('プリセットデータが不正です。');
  }
  const name = String(rawPreset.name ?? '').trim() || '無題のフロー';
  const rawNodes = Array.isArray(rawPreset.nodes) ? rawPreset.nodes : [];
  const hasEdgesArray = Array.isArray(rawPreset.edges);
  const hasLegacyBranches = rawNodes.some(
    (n) => (Array.isArray(n?.yesBranch) && n.yesBranch.length > 0) || (Array.isArray(n?.noBranch) && n.noBranch.length > 0)
  );

  let nodes;
  let edges;

  if (!hasEdgesArray || hasLegacyBranches) {
    const migrated = migrateLegacyTreeToGraph(rawNodes);
    nodes = migrated.nodes;
    edges = migrated.edges;
    const presetObj = {
      id: String(rawPreset.id || generateId('preset')),
      name,
      description: String(rawPreset.description ?? '').trim(),
      startUrl: String(rawPreset.startUrl ?? '').trim(),
      updatedAt: Number(rawPreset.updatedAt) || Date.now(),
      nodes,
      edges
    };
    autoLayoutGraph(presetObj);
    return presetObj;
  }

  nodes = rawNodes.map((n) => normalizeNode(n));
  if (!nodes.some((n) => n.type === 'start')) {
    nodes.unshift(createNode('start', { id: 'node_start', label: '開始', x: 460, y: 40 }));
  }
  const nodeIds = new Set(nodes.map((n) => n.id));
  edges = rawPreset.edges
    .map((e) => normalizeEdge(e))
    .filter((e) => e && e.from !== e.to && nodeIds.has(e.from) && nodeIds.has(e.to));

  return {
    id: String(rawPreset.id || generateId('preset')),
    name,
    description: String(rawPreset.description ?? '').trim(),
    startUrl: String(rawPreset.startUrl ?? '').trim(),
    updatedAt: Number(rawPreset.updatedAt) || Date.now(),
    nodes,
    edges
  };
}

export function clonePreset(preset) {
  return JSON.parse(JSON.stringify(validateWorkflowPreset(preset)));
}

export function createDefaultPresets() {
  return [
    validateWorkflowPreset({
      id: 'preset_portal_branch_pdf',
      name: '条件分岐付きページ確認＆PDF保存',
      description: '対象ページを確認し、ログイン要求が出ていれば人間へ確認、そうでなければPDF保存して要約します。',
      startUrl: 'https://ja.wikipedia.org',
      updatedAt: 1700000000000,
      nodes: [
        createNode('start', { id: 'node_start', label: '開始', x: 480, y: 40 }),
        createNode('action', {
          id: 'n_nav_1',
          label: '開始ページを開く',
          actionType: 'navigate',
          url: 'https://ja.wikipedia.org',
          notes: 'ページ読み込み完了を確認する',
          x: 480,
          y: 200
        }),
        createNode('condition', {
          id: 'n_cond_1',
          label: 'ログイン画面が表示されているか',
          conditionType: 'text_contains',
          conditionValue: 'ログイン',
          x: 480,
          y: 360
        }),
        createNode('ask_user', {
          id: 'n_ask_login',
          label: 'ログイン操作を依頼',
          message: 'ログインが求められています。手動でログイン後、続行を押してください。',
          x: 240,
          y: 540
        }),
        createNode('action', {
          id: 'n_pdf_save',
          label: '画面をPDF保存＆読込',
          actionType: 'download_page_pdf',
          value: 'wikipedia-top.pdf',
          x: 720,
          y: 540
        }),
        createNode('done', {
          id: 'n_done_1',
          label: '結果を報告して完了',
          message: 'ページ内容（および保存したPDFの要点）を日本語でまとめて完了してください。',
          x: 480,
          y: 720
        })
      ],
      edges: [
        { id: 'e_1', from: 'node_start', port: 'next', to: 'n_nav_1' },
        { id: 'e_2', from: 'n_nav_1', port: 'next', to: 'n_cond_1' },
        { id: 'e_3', from: 'n_cond_1', port: 'yes', to: 'n_ask_login' },
        { id: 'e_4', from: 'n_cond_1', port: 'no', to: 'n_pdf_save' },
        { id: 'e_5', from: 'n_ask_login', port: 'next', to: 'n_done_1' },
        { id: 'e_6', from: 'n_pdf_save', port: 'next', to: 'n_done_1' }
      ]
    }),
    validateWorkflowPreset({
      id: 'preset_multitab_compare',
      name: '複数タブで2サイト比較調査',
      description: '作業用タブグループ内で2つのサイトを開き、条件分岐を確認して比較結果をまとめます。',
      startUrl: 'https://example.com',
      updatedAt: 1700000000001,
      nodes: [
        createNode('start', { id: 'node_start', label: '開始', x: 480, y: 40 }),
        createNode('action', {
          id: 'n_tab_1',
          label: '1つ目のサイトを確認',
          actionType: 'navigate',
          url: 'https://example.com',
          x: 480,
          y: 200
        }),
        createNode('action', {
          id: 'n_tab_2',
          label: '別タブで2つ目のサイトを開く',
          actionType: 'open_tab',
          url: 'https://ja.wikipedia.org',
          x: 480,
          y: 360
        }),
        createNode('condition', {
          id: 'n_cond_2',
          label: '検索ボックスが表示されているか',
          conditionType: 'element_visible',
          conditionValue: '検索',
          x: 480,
          y: 520
        }),
        createNode('action', {
          id: 'n_type_search',
          label: '「生成AI」を検索',
          actionType: 'type',
          target: '検索入力欄',
          value: '生成AI',
          x: 240,
          y: 700
        }),
        createNode('action', {
          id: 'n_scroll_check',
          label: 'ページ下部を確認',
          actionType: 'scroll',
          value: 'down',
          x: 720,
          y: 700
        }),
        createNode('done', {
          id: 'n_done_2',
          label: '比較結果をまとめて完了',
          message: 'タブグループ内の各タブで確認した内容を比較し、日本語で報告してください。',
          x: 480,
          y: 880
        })
      ],
      edges: [
        { id: 'e_m1', from: 'node_start', port: 'next', to: 'n_tab_1' },
        { id: 'e_m2', from: 'n_tab_1', port: 'next', to: 'n_tab_2' },
        { id: 'e_m3', from: 'n_tab_2', port: 'next', to: 'n_cond_2' },
        { id: 'e_m4', from: 'n_cond_2', port: 'yes', to: 'n_type_search' },
        { id: 'e_m5', from: 'n_cond_2', port: 'no', to: 'n_scroll_check' },
        { id: 'e_m6', from: 'n_type_search', port: 'next', to: 'n_done_2' },
        { id: 'e_m7', from: 'n_scroll_check', port: 'next', to: 'n_done_2' }
      ]
    })
  ];
}

// --- Graph Manipulation Helpers ---

export function addGraphNode(preset, type, overrides = {}) {
  if (!preset || type === 'start') return null;
  const node = createNode(type, overrides);
  preset.nodes.push(node);
  return node;
}

export function updateGraphNode(preset, nodeId, patch) {
  const idx = preset?.nodes?.findIndex((n) => n.id === nodeId) ?? -1;
  if (idx === -1) return false;
  const existing = preset.nodes[idx];
  preset.nodes[idx] = normalizeNode({
    ...existing,
    ...patch,
    id: existing.id,
    type: existing.type
  });
  return true;
}

export function moveGraphNodePosition(preset, nodeId, x, y) {
  const node = preset?.nodes?.find((n) => n.id === nodeId);
  if (!node) return false;
  node.x = Math.max(20, Math.round(x));
  node.y = Math.max(20, Math.round(y));
  return true;
}

export function removeGraphNode(preset, nodeId) {
  if (!preset) return false;
  const target = preset.nodes.find((n) => n.id === nodeId);
  if (!target || target.type === 'start') return false;
  preset.nodes = preset.nodes.filter((n) => n.id !== nodeId);
  preset.edges = preset.edges.filter((e) => e.from !== nodeId && e.to !== nodeId);
  return true;
}

export function connectNodes(preset, fromId, port = 'next', toId) {
  if (!preset || !fromId || !toId || fromId === toId) {
    return null;
  }
  const fromNode = preset.nodes.find((n) => n.id === fromId);
  const toNode = preset.nodes.find((n) => n.id === toId);
  if (!fromNode || !toNode || toNode.type === 'start' || fromNode.type === 'done') {
    return null;
  }

  const normalizedPort =
    fromNode.type === 'condition'
      ? port === 'no'
        ? 'no'
        : 'yes'
      : 'next';

  // Replace any existing edge from the exact same (fromId, port)
  preset.edges = preset.edges.filter(
    (e) => !(e.from === fromId && e.port === normalizedPort)
  );

  const edge = {
    id: generateId('edge'),
    from: fromId,
    port: normalizedPort,
    to: toId
  };
  preset.edges.push(edge);
  return edge;
}

export function disconnectEdge(preset, edgeId) {
  if (!preset) return false;
  const prevLen = preset.edges.length;
  preset.edges = preset.edges.filter((e) => e.id !== edgeId);
  return preset.edges.length !== prevLen;
}

export function copySubgraph(preset, selectedIds) {
  if (!preset || !Array.isArray(preset.nodes)) {
    return { nodes: [], edges: [], minX: 0, minY: 0 };
  }
  const requested = new Set(Array.isArray(selectedIds) ? selectedIds : selectedIds || []);
  const copiedNodes = preset.nodes
    .filter((node) => requested.has(node.id) && node.type !== 'start' && node.id !== 'node_start')
    .map((node) => normalizeNode(JSON.parse(JSON.stringify(node))));

  if (!copiedNodes.length) {
    return { nodes: [], edges: [], minX: 0, minY: 0 };
  }

  const copiedIdSet = new Set(copiedNodes.map((n) => n.id));
  const copiedEdges = (preset.edges || [])
    .filter((e) => copiedIdSet.has(e.from) && copiedIdSet.has(e.to))
    .map((e) => ({ ...e }));

  const minX = Math.min(...copiedNodes.map((n) => Number(n.x) || 0));
  const minY = Math.min(...copiedNodes.map((n) => Number(n.y) || 0));

  return { nodes: copiedNodes, edges: copiedEdges, minX, minY };
}

export function pasteSubgraphAt(preset, clipboardData, targetX, targetY) {
  if (!preset || !Array.isArray(preset.nodes) || !clipboardData || !Array.isArray(clipboardData.nodes) || !clipboardData.nodes.length) {
    return [];
  }
  if (!Array.isArray(preset.edges)) preset.edges = [];

  const baseMinX = Number.isFinite(clipboardData.minX)
    ? clipboardData.minX
    : Math.min(...clipboardData.nodes.map((n) => Number(n.x) || 0));
  const baseMinY = Number.isFinite(clipboardData.minY)
    ? clipboardData.minY
    : Math.min(...clipboardData.nodes.map((n) => Number(n.y) || 0));
  const destX = Number.isFinite(targetX) ? targetX : baseMinX + 40;
  const destY = Number.isFinite(targetY) ? targetY : baseMinY + 40;

  const idMap = new Map();
  const pastedIds = [];

  for (const srcNode of clipboardData.nodes) {
    const newId = generateId('node');
    idMap.set(srcNode.id, newId);
    const cloned = JSON.parse(JSON.stringify(srcNode));
    cloned.id = newId;
    if (cloned.type === 'start') {
      cloned.type = 'action';
    }
    cloned.x = Math.max(24, Math.round((Number(srcNode.x) || 0) - baseMinX + destX));
    cloned.y = Math.max(24, Math.round((Number(srcNode.y) || 0) - baseMinY + destY));
    const normalized = normalizeNode(cloned);
    preset.nodes.push(normalized);
    pastedIds.push(normalized.id);
  }

  for (const srcEdge of clipboardData.edges || []) {
    const fromId = idMap.get(srcEdge.from);
    const toId = idMap.get(srcEdge.to);
    if (fromId && toId) {
      connectNodes(preset, fromId, srcEdge.port || 'next', toId);
    }
  }

  return pastedIds;
}

export function removeMultipleGraphNodes(preset, nodeIds) {
  if (!preset || !Array.isArray(preset.nodes)) return 0;
  const toDelete = new Set();
  const list = Array.isArray(nodeIds) ? nodeIds : nodeIds || [];
  for (const id of list) {
    if (!id || id === 'node_start') continue;
    const node = preset.nodes.find((n) => n.id === id);
    if (node && node.type !== 'start') {
      toDelete.add(id);
    }
  }
  if (!toDelete.size) return 0;

  const prevLen = preset.nodes.length;
  preset.nodes = preset.nodes.filter((n) => !toDelete.has(n.id));
  preset.edges = (preset.edges || []).filter((e) => !toDelete.has(e.from) && !toDelete.has(e.to));
  return prevLen - preset.nodes.length;
}

export function connectNodesSmart(preset, fromId, toId) {
  if (!preset || !Array.isArray(preset.nodes) || !fromId || !toId || fromId === toId) {
    return { ok: false, reason: 'invalid' };
  }
  const fromNode = preset.nodes.find((n) => n.id === fromId);
  const toNode = preset.nodes.find((n) => n.id === toId);
  if (!fromNode || !toNode || toNode.type === 'start') {
    return { ok: false, reason: 'invalid_target' };
  }

  let port = 'next';
  if (fromNode.type === 'condition') {
    const outgoing = (preset.edges || []).filter((e) => e.from === fromId);
    const hasYes = outgoing.some((e) => e.port === 'yes');
    const hasNo = outgoing.some((e) => e.port === 'no');
    if (!hasYes) {
      port = 'yes';
    } else if (!hasNo) {
      port = 'no';
    } else {
      port = 'yes';
    }
  }

  const edge = connectNodes(preset, fromId, port, toId);
  return { ok: Boolean(edge), port, edge };
}

export function selectNodesInRect(preset, rect, nodeSizeMap = null) {
  if (!preset || !Array.isArray(preset.nodes) || !rect) return [];
  let minX;
  let maxX;
  let minY;
  let maxY;
  if (Number.isFinite(rect.x1) && Number.isFinite(rect.x2)) {
    minX = Math.min(rect.x1, rect.x2);
    maxX = Math.max(rect.x1, rect.x2);
    minY = Math.min(rect.y1 ?? 0, rect.y2 ?? 0);
    maxY = Math.max(rect.y1 ?? 0, rect.y2 ?? 0);
  } else {
    const rx = Number(rect.x ?? rect.left ?? 0);
    const ry = Number(rect.y ?? rect.top ?? 0);
    const rw = Number(rect.width ?? 0);
    const rh = Number(rect.height ?? 0);
    minX = Math.min(rx, rx + rw);
    maxX = Math.max(rx, rx + rw);
    minY = Math.min(ry, ry + rh);
    maxY = Math.max(ry, ry + rh);
  }

  const selected = [];
  for (const node of preset.nodes) {
    const size = nodeSizeMap
      ? (nodeSizeMap instanceof Map ? nodeSizeMap.get(node.id) : nodeSizeMap[node.id])
      : null;
    const nw = Number(size?.width) || 240;
    const nh = Number(size?.height) || 120;
    const nx1 = Number(node.x) || 0;
    const ny1 = Number(node.y) || 0;
    const nx2 = nx1 + nw;
    const ny2 = ny1 + nh;
    if (nx1 <= maxX && nx2 >= minX && ny1 <= maxY && ny2 >= minY) {
      selected.push(node.id);
    }
  }
  return selected;
}

// --- Legacy Tree Manipulation Helpers (kept for compatibility) ---

function walkNodeList(list, visitor) {
  for (let i = 0; i < list.length; i += 1) {
    const node = list[i];
    const stop = visitor(node, list, i);
    if (stop) return true;
    if (node.type === 'condition') {
      if (walkNodeList(node.yesBranch || [], visitor)) return true;
      if (walkNodeList(node.noBranch || [], visitor)) return true;
    }
  }
  return false;
}

export function findNodeById(nodes, nodeId) {
  let found = null;
  walkNodeList(nodes, (node, parentList, index) => {
    if (node.id === nodeId) {
      found = { node, parentList, index };
      return true;
    }
    return false;
  });
  return found;
}

export function resolveBranchList(nodes, parentInfo = null) {
  if (!parentInfo || !parentInfo.parentId) {
    return nodes;
  }
  const found = findNodeById(nodes, parentInfo.parentId);
  if (!found || found.node.type !== 'condition') {
    return null;
  }
  return parentInfo.branch === 'no' ? found.node.noBranch : found.node.yesBranch;
}

export function insertNodeAt(nodes, newNode, parentInfo = null, index = undefined) {
  const targetList = resolveBranchList(nodes, parentInfo);
  if (!targetList) return false;
  const normalized = normalizeNode(newNode);
  if (typeof index === 'number' && index >= 0 && index <= targetList.length) {
    targetList.splice(index, 0, normalized);
  } else {
    targetList.push(normalized);
  }
  return true;
}

export function updateNodeById(nodes, nodeId, patch) {
  const found = findNodeById(nodes, nodeId);
  if (!found) return false;
  const updated = normalizeNode({ ...found.node, ...patch, id: found.node.id, type: found.node.type });
  found.parentList[found.index] = updated;
  return true;
}

export function removeNodeById(nodes, nodeId) {
  const found = findNodeById(nodes, nodeId);
  if (!found) return false;
  found.parentList.splice(found.index, 1);
  return true;
}

export function moveNodeById(nodes, nodeId, direction) {
  const found = findNodeById(nodes, nodeId);
  if (!found) return false;
  const { parentList, index } = found;
  const targetIndex = direction === 'up' ? index - 1 : index + 1;
  if (targetIndex < 0 || targetIndex >= parentList.length) {
    return false;
  }
  const [item] = parentList.splice(index, 1);
  parentList.splice(targetIndex, 0, item);
  return true;
}

// --- Compilation & Graph Traversal ---

function formatActionLine(node) {
  const tag = node.actionType === 'ai_step' ? 'ai_step' : node.actionType;
  const parts = [`[${tag}]`, node.label || node.actionType];
  if (node.url) parts.push(`(URL: ${node.url})`);
  if (node.target) parts.push(`(対象: "${node.target}")`);
  if (node.value !== undefined && node.value !== '') parts.push(`(値: "${node.value}")`);
  if (node.actionType === 'wait' && node.ms) parts.push(`(${node.ms}ms)`);
  if (node.notes) parts.push(`— ${node.notes}`);
  return parts.join(' ');
}

function formatConditionLabel(node) {
  const condDef = FLOW_CONDITION_TYPES.find((c) => c.value === node.conditionType);
  const typeLabel = condDef ? condDef.label : node.conditionType;
  const valPart = node.conditionValue ? `「${node.conditionValue}」` : '';
  return `${node.label || '条件判定'}【条件: ${typeLabel}${valPart}】`;
}

function renderGraphMarkdownFromNode(nodeId, nodeMap, edgesByFrom, prefixNum = '', indent = '', pathSet = new Set(), stepCounter = { count: 0 }, renderedLabels = new Map()) {
  const lines = [];
  let currentId = nodeId;
  let localIdx = 0;

  while (currentId) {
    const node = nodeMap.get(currentId);
    if (!node) break;

    if (pathSet.has(currentId)) {
      lines.push(`${indent}- ↪ 「${node.label || currentId}」へ戻る（ループ）`);
      break;
    }

    if (node.type === 'start') {
      const nextEdge = (edgesByFrom.get(currentId) || []).find((e) => e.port === 'next');
      currentId = nextEdge?.to || null;
      continue;
    }

    if (renderedLabels.has(currentId)) {
      lines.push(`${indent}- ➔ 共通ステップ「${node.label}」(${renderedLabels.get(currentId)}) へ合流する`);
      break;
    }

    localIdx += 1;
    stepCounter.count += 1;
    const stepNum = prefixNum ? `${prefixNum}.${localIdx}` : `${localIdx}`;
    renderedLabels.set(currentId, `ステップ ${stepNum}`);

    const nextPath = new Set(pathSet);
    nextPath.add(currentId);

    const outs = edgesByFrom.get(currentId) || [];

    if (node.type === 'condition') {
      lines.push(`${indent}${stepNum}. **IF（条件分岐）**: ${formatConditionLabel(node)}`);
      const yesEdge = outs.find((e) => e.port === 'yes');
      const noEdge = outs.find((e) => e.port === 'no');

      lines.push(`${indent}   - **YES（条件に一致する場合）**:`);
      if (!yesEdge) {
        lines.push(`${indent}     - [ask_user] YES 側の後続処理が未接続です。人間に確認してください。`);
      } else {
        lines.push(
          ...renderGraphMarkdownFromNode(
            yesEdge.to,
            nodeMap,
            edgesByFrom,
            `${stepNum}Y`,
            `${indent}     `,
            nextPath,
            stepCounter,
            renderedLabels
          )
        );
      }

      lines.push(`${indent}   - **NO（条件に一致しない場合）**:`);
      if (!noEdge) {
        lines.push(`${indent}     - [ask_user] NO 側の後続処理が未接続です。人間に確認してください。`);
      } else {
        lines.push(
          ...renderGraphMarkdownFromNode(
            noEdge.to,
            nodeMap,
            edgesByFrom,
            `${stepNum}N`,
            `${indent}     `,
            nextPath,
            stepCounter,
            renderedLabels
          )
        );
      }
      break;
    }

    if (node.type === 'ask_user') {
      lines.push(`${indent}${stepNum}. [ask_user] ${node.label || '人間へ確認'}: 「${node.message}」`);
    } else if (node.type === 'done') {
      lines.push(`${indent}${stepNum}. [done] ${node.label || '完了'}: 「${node.message}」`);
      break;
    } else {
      lines.push(`${indent}${stepNum}. ${formatActionLine(node)}`);
    }

    const nextEdge = outs.find((e) => e.port === 'next');
    currentId = nextEdge?.to || null;
  }

  return lines;
}

/**
 * Compile a graph-based flowchart preset into a strict AI-readable Playbook object.
 */
export function compileWorkflowToPlaybook(rawPreset) {
  const preset = validateWorkflowPreset(rawPreset);
  const nodeMap = new Map(preset.nodes.map((n) => [n.id, n]));
  const edgesByFrom = new Map();
  for (const e of preset.edges) {
    if (!edgesByFrom.has(e.from)) edgesByFrom.set(e.from, []);
    edgesByFrom.get(e.from).push(e);
  }

  const startNode = preset.nodes.find((n) => n.type === 'start') || preset.nodes[0];
  const stepLines = startNode
    ? renderGraphMarkdownFromNode(startNode.id, nodeMap, edgesByFrom)
    : [];

  const lines = [];
  lines.push(`# 手順書タイトル: ${preset.name}`);
  lines.push('');
  lines.push('## 目的');
  lines.push(preset.description || `フローチャートプリセット「${preset.name}」の条件分岐と接続順序に従って正確に実行する。`);

  if (preset.startUrl) {
    lines.push('', '## 開始URL', preset.startUrl);
  }

  lines.push('', '## 前提条件・実行ルール（必守）');
  lines.push('- 必ず下記のフローチャート（接続されたノード順序および IF / YES / NO 分岐）通りに実行すること。');
  lines.push('- フローに記載のない状況・対象要素が見つからない場合・分岐条件の判定に迷う場合は、推測で進めず必ず [ask_user] で人間に指示を仰ぐこと。');

  lines.push('', '## 実行ステップ（フローチャート）');
  if (stepLines.length === 0) {
    lines.push('1. [ask_user] 開始ノードから接続されたステップがありません。フローを確認してください。');
  } else {
    lines.push(...stepLines);
  }

  lines.push('', '## 確認ポイント（完了条件）');
  lines.push('- 接続されたすべてのフローおよび該当する条件分岐（YES / NO）を完了していること。');

  const markdown = lines.join('\n');
  const playbook = parsePlaybookContent(markdown, `${preset.id}.flow.md`);
  return {
    ...playbook,
    presetId: preset.id,
    presetName: preset.name,
    startUrl: preset.startUrl || playbook.startUrl
  };
}

/**
 * Build a simplified nested structure from graph preset for Side Panel mini-preview.
 */
export function buildPreviewStepsFromGraph(rawPreset) {
  const preset = validateWorkflowPreset(rawPreset);
  const nodeMap = new Map(preset.nodes.map((n) => [n.id, n]));
  const edgesByFrom = new Map();
  for (const e of preset.edges) {
    if (!edgesByFrom.has(e.from)) edgesByFrom.set(e.from, []);
    edgesByFrom.get(e.from).push(e);
  }

  const walk = (startId, visited = new Set()) => {
    const out = [];
    let currentId = startId;
    while (currentId && !visited.has(currentId)) {
      const node = nodeMap.get(currentId);
      if (!node) break;
      visited.add(currentId);

      if (node.type === 'start') {
        const nextEdge = (edgesByFrom.get(currentId) || []).find((e) => e.port === 'next');
        currentId = nextEdge?.to || null;
        continue;
      }

      const outs = edgesByFrom.get(currentId) || [];
      if (node.type === 'condition') {
        const yesEdge = outs.find((e) => e.port === 'yes');
        const noEdge = outs.find((e) => e.port === 'no');
        out.push({
          ...node,
          yesBranch: yesEdge ? walk(yesEdge.to, new Set(visited)) : [],
          noBranch: noEdge ? walk(noEdge.to, new Set(visited)) : []
        });
        break;
      }

      out.push(node);
      if (node.type === 'done') break;
      const nextEdge = outs.find((e) => e.port === 'next');
      currentId = nextEdge?.to || null;
    }
    return out;
  };

  const startNode = preset.nodes.find((n) => n.type === 'start');
  return startNode ? walk(startNode.id) : [];
}

/**
 * Local storage persistence for workflow presets (`chrome.storage.local` or mock).
 */
export class WorkflowPresetStore {
  constructor(storageArea = globalThis.chrome?.storage?.local, storageKey = FLOW_PRESETS_STORAGE_KEY) {
    this.storage = storageArea;
    this.storageKey = storageKey;
  }

  async _readAll() {
    if (!this.storage?.get) {
      return [];
    }
    const res = await this.storage.get(this.storageKey);
    const list = res?.[this.storageKey];
    if (!Array.isArray(list)) return [];
    return list.map((p) => validateWorkflowPreset(p));
  }

  async _writeAll(presets) {
    if (!this.storage?.set) {
      return;
    }
    await this.storage.set({ [this.storageKey]: presets.map((p) => validateWorkflowPreset(p)) });
  }

  async seedIfEmpty() {
    const existing = await this._readAll();
    if (existing.length > 0) {
      return existing;
    }
    const defaults = createDefaultPresets();
    await this._writeAll(defaults);
    return defaults;
  }

  async list() {
    const list = await this.seedIfEmpty();
    return list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  async get(id) {
    const list = await this.list();
    return list.find((p) => p.id === id) ?? null;
  }

  async save(rawPreset) {
    const list = await this.seedIfEmpty();
    const preset = validateWorkflowPreset({ ...rawPreset, updatedAt: Date.now() });
    const idx = list.findIndex((p) => p.id === preset.id);
    if (idx !== -1) {
      list[idx] = preset;
    } else {
      list.unshift(preset);
    }
    await this._writeAll(list);
    return preset;
  }

  async remove(id) {
    const list = await this._readAll();
    const filtered = list.filter((p) => p.id !== id);
    await this._writeAll(filtered);
    return filtered;
  }
}
