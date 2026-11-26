import { FLOW_PRESETS_STORAGE_KEY } from './constants.js';
import { parsePlaybookContent } from './playbook.js';

export const FLOW_NODE_TYPES = Object.freeze(['action', 'condition', 'ask_user', 'done']);

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
  const id = overrides.id || generateId('node');
  switch (type) {
    case 'condition':
      return {
        id,
        type: 'condition',
        label: overrides.label ?? '条件分岐',
        conditionType: overrides.conditionType ?? 'text_contains',
        conditionValue: overrides.conditionValue ?? '',
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
        message: overrides.message ?? '画面状態を確認し、次の指示を入力してください。'
      };
    case 'done':
      return {
        id,
        type: 'done',
        label: overrides.label ?? 'フロー完了',
        message: overrides.message ?? '手順フローが完了しました。結果を日本語で報告します。'
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
        notes: overrides.notes ?? ''
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

export function validateWorkflowPreset(rawPreset) {
  if (!rawPreset || typeof rawPreset !== 'object') {
    throw new Error('プリセットデータが不正です。');
  }
  const name = String(rawPreset.name ?? '').trim() || '無題のフロー';
  const nodes = Array.isArray(rawPreset.nodes) ? rawPreset.nodes.map((n) => normalizeNode(n)) : [];
  return {
    id: String(rawPreset.id || generateId('preset')),
    name,
    description: String(rawPreset.description ?? '').trim(),
    startUrl: String(rawPreset.startUrl ?? '').trim(),
    updatedAt: Number(rawPreset.updatedAt) || Date.now(),
    nodes
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
        createNode('action', {
          id: 'n_nav_1',
          label: '開始ページを開く',
          actionType: 'navigate',
          url: 'https://ja.wikipedia.org',
          notes: 'ページ読み込み完了を確認する'
        }),
        createNode('condition', {
          id: 'n_cond_1',
          label: 'ログイン画面が表示されているか',
          conditionType: 'text_contains',
          conditionValue: 'ログイン',
          yesBranch: [
            createNode('ask_user', {
              id: 'n_ask_login',
              label: 'ログイン操作を依頼',
              message: 'ログインが求められています。手動でログイン後、続行を押してください。'
            })
          ],
          noBranch: [
            createNode('action', {
              id: 'n_pdf_save',
              label: '画面をPDF保存＆読込',
              actionType: 'download_page_pdf',
              value: 'wikipedia-top.pdf'
            })
          ]
        }),
        createNode('done', {
          id: 'n_done_1',
          label: '結果を報告して完了',
          message: 'ページ内容（および保存したPDFの要点）を日本語でまとめて完了してください。'
        })
      ]
    }),
    validateWorkflowPreset({
      id: 'preset_multitab_compare',
      name: '複数タブで2サイト比較調査',
      description: '作業用タブグループ内で2つのサイトを開き、条件分岐を確認して比較結果をまとめます。',
      startUrl: 'https://example.com',
      updatedAt: 1700000000001,
      nodes: [
        createNode('action', {
          id: 'n_tab_1',
          label: '1つ目のサイトを確認',
          actionType: 'navigate',
          url: 'https://example.com'
        }),
        createNode('action', {
          id: 'n_tab_2',
          label: '別タブで2つ目のサイトを開く',
          actionType: 'open_tab',
          url: 'https://ja.wikipedia.org'
        }),
        createNode('condition', {
          id: 'n_cond_2',
          label: '検索ボックスが表示されているか',
          conditionType: 'element_visible',
          conditionValue: '検索',
          yesBranch: [
            createNode('action', {
              id: 'n_type_search',
              label: '「生成AI」を検索',
              actionType: 'type',
              target: '検索入力欄',
              value: '生成AI'
            })
          ],
          noBranch: [
            createNode('action', {
              id: 'n_scroll_check',
              label: 'ページ下部を確認',
              actionType: 'scroll',
              value: 'down'
            })
          ]
        }),
        createNode('done', {
          id: 'n_done_2',
          label: '比較結果をまとめて完了',
          message: 'タブグループ内の各タブで確認した内容を比較し、日本語で報告してください。'
        })
      ]
    })
  ];
}

function walkNodeList(list, visitor) {
  for (let i = 0; i < list.length; i += 1) {
    const node = list[i];
    const stop = visitor(node, list, i);
    if (stop) return true;
    if (node.type === 'condition') {
      if (walkNodeList(node.yesBranch, visitor)) return true;
      if (walkNodeList(node.noBranch, visitor)) return true;
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

function renderNodesMarkdown(nodes, prefixNum = '', indent = '') {
  const lines = [];
  nodes.forEach((node, idx) => {
    const stepNum = prefixNum ? `${prefixNum}.${idx + 1}` : `${idx + 1}`;
    if (node.type === 'condition') {
      lines.push(`${indent}${stepNum}. **IF（条件分岐）**: ${formatConditionLabel(node)}`);
      lines.push(`${indent}   - **YES（条件に一致する場合）**:`);
      if (node.yesBranch.length === 0) {
        lines.push(`${indent}     - （特になし → 次のステップへ進む）`);
      } else {
        lines.push(...renderNodesMarkdown(node.yesBranch, `${stepNum}Y`, `${indent}     `));
      }
      lines.push(`${indent}   - **NO（条件に一致しない場合）**:`);
      if (node.noBranch.length === 0) {
        lines.push(`${indent}     - （特になし → 次のステップへ進む）`);
      } else {
        lines.push(...renderNodesMarkdown(node.noBranch, `${stepNum}N`, `${indent}     `));
      }
    } else if (node.type === 'ask_user') {
      lines.push(`${indent}${stepNum}. [ask_user] ${node.label || '人間へ確認'}: 「${node.message}」`);
    } else if (node.type === 'done') {
      lines.push(`${indent}${stepNum}. [done] ${node.label || '完了'}: 「${node.message}」`);
    } else {
      lines.push(`${indent}${stepNum}. ${formatActionLine(node)}`);
    }
  });
  return lines;
}

/**
 * Compile a visual flowchart preset into a strict AI-readable Playbook object.
 */
export function compileWorkflowToPlaybook(rawPreset) {
  const preset = validateWorkflowPreset(rawPreset);
  const lines = [];
  lines.push(`# 手順書タイトル: ${preset.name}`);
  lines.push('');
  lines.push('## 目的');
  lines.push(preset.description || `フローチャートプリセット「${preset.name}」の条件分岐と手順に従って正確に実行する。`);

  if (preset.startUrl) {
    lines.push('', '## 開始URL', preset.startUrl);
  }

  lines.push('', '## 前提条件・実行ルール（必守）');
  lines.push('- 必ず下記のフローチャート（実行ステップおよび IF / YES / NO 分岐）の順序通りに実行すること。');
  lines.push('- フローに記載のない状況・対象要素が見つからない場合・分岐条件の判定に迷う場合は、推測で進めず必ず [ask_user] で人間に指示を仰ぐこと。');

  lines.push('', '## 実行ステップ（フローチャート）');
  if (preset.nodes.length === 0) {
    lines.push('1. [ask_user] フローにステップが定義されていません。実行内容を確認してください。');
  } else {
    lines.push(...renderNodesMarkdown(preset.nodes));
  }

  lines.push('', '## 確認ポイント（完了条件）');
  lines.push('- すべてのフローおよび該当する条件分岐（YES / NO）を完了していること。');

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
