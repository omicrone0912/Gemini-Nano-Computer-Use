import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WorkflowPresetStore,
  addGraphNode,
  autoLayoutGraph,
  buildPreviewStepsFromGraph,
  compileWorkflowToPlaybook,
  connectNodes,
  createDefaultPresets,
  createNode,
  disconnectEdge,
  findNodeById,
  insertNodeAt,
  moveGraphNodePosition,
  moveNodeById,
  removeGraphNode,
  removeNodeById,
  updateNodeById,
  validateWorkflowPreset
} from '../shared/workflow-flow.js';

function createMemoryStorage() {
  const map = new Map();
  return {
    async get(key) {
      return { [key]: map.get(key) };
    },
    async set(obj) {
      for (const [k, v] of Object.entries(obj)) {
        map.set(k, structuredClone(v));
      }
    }
  };
}

test('createDefaultPresets provides valid branching presets', () => {
  const defaults = createDefaultPresets();
  assert.ok(defaults.length >= 2);
  assert.equal(defaults[0].nodes.some((n) => n.type === 'condition'), true);
});

test('tree helpers insert, update, move, and remove nodes in root and condition branches', () => {
  const nodes = [
    createNode('action', { id: 'a1', label: 'Step 1' }),
    createNode('condition', {
      id: 'c1',
      label: 'Check',
      conditionType: 'text_contains',
      conditionValue: 'OK',
      yesBranch: [],
      noBranch: []
    })
  ];

  const yesChild = createNode('action', { id: 'y1', label: 'Yes Action' });
  const noChild = createNode('ask_user', { id: 'n1', label: 'Ask', message: '確認してください' });

  assert.equal(insertNodeAt(nodes, yesChild, { parentId: 'c1', branch: 'yes' }), true);
  assert.equal(insertNodeAt(nodes, noChild, { parentId: 'c1', branch: 'no' }), true);
  assert.equal(findNodeById(nodes, 'y1')?.node.label, 'Yes Action');

  assert.equal(updateNodeById(nodes, 'y1', { label: 'Updated Yes' }), true);
  assert.equal(findNodeById(nodes, 'y1')?.node.label, 'Updated Yes');

  assert.equal(moveNodeById(nodes, 'c1', 'up'), true);
  assert.equal(nodes[0].id, 'c1');

  assert.equal(removeNodeById(nodes, 'n1'), true);
  assert.equal(findNodeById(nodes, 'n1'), null);
});

test('compileWorkflowToPlaybook generates strict AI-readable branching playbook', () => {
  const preset = createDefaultPresets()[0];
  const playbook = compileWorkflowToPlaybook(preset);

  assert.equal(playbook.strictMode, true);
  assert.equal(playbook.presetId, preset.id);
  assert.match(playbook.rawText, /\*\*IF（条件分岐）\*\*/);
  assert.match(playbook.rawText, /\*\*YES（条件に一致する場合）\*\*/);
  assert.match(playbook.rawText, /\*\*NO（不一致|一致しない場合）\*\*/);
  assert.match(playbook.rawText, /\[ask_user\]/);
  assert.match(playbook.rawText, /\[download_page_pdf\]/);
});

test('WorkflowPresetStore seeds defaults and persists CRUD operations locally', async () => {
  const store = new WorkflowPresetStore(createMemoryStorage());
  const seeded = await store.list();
  assert.ok(seeded.length >= 2);

  const saved = await store.save({
    id: 'custom_1',
    name: 'カスタムフロー',
    startUrl: 'https://example.com',
    nodes: [createNode('done', { message: '完了' })]
  });
  assert.equal(saved.name, 'カスタムフロー');

  const fetched = await store.get('custom_1');
  assert.equal(fetched?.name, 'カスタムフロー');

  await store.remove('custom_1');
  const afterRemove = await store.get('custom_1');
  assert.equal(afterRemove, null);
});

test('graph editing helpers support drag positions, click connections, disconnect, and removal', () => {
  const preset = validateWorkflowPreset({
    id: 'g_1',
    name: 'グラフテスト',
    nodes: [createNode('start', { id: 'node_start', x: 100, y: 40 })],
    edges: []
  });

  const cond = addGraphNode(preset, 'condition', { id: 'c1', label: '判定', conditionValue: '完了', x: 100, y: 200 });
  const yesAct = addGraphNode(preset, 'action', { id: 'a_yes', label: 'YES処理', x: 20, y: 360 });
  const noDone = addGraphNode(preset, 'done', { id: 'd_no', label: 'NO終了', x: 260, y: 360 });

  assert.equal(connectNodes(preset, 'node_start', 'next', cond.id)?.to, 'c1');
  assert.equal(connectNodes(preset, cond.id, 'yes', yesAct.id)?.port, 'yes');
  assert.equal(connectNodes(preset, cond.id, 'no', noDone.id)?.port, 'no');
  // Self connection is rejected
  assert.equal(connectNodes(preset, cond.id, 'yes', cond.id), null);

  // Overwrite same port replaces previous edge
  const replacement = connectNodes(preset, cond.id, 'yes', noDone.id);
  assert.equal(replacement?.to, 'd_no');
  assert.equal(preset.edges.filter((e) => e.from === cond.id && e.port === 'yes').length, 1);

  assert.equal(moveGraphNodePosition(preset, yesAct.id, 300, 420), true);
  assert.equal(yesAct.x, 300);
  assert.equal(yesAct.y, 420);

  assert.equal(disconnectEdge(preset, replacement.id), true);
  assert.equal(removeGraphNode(preset, yesAct.id), true);
  assert.equal(preset.nodes.some((n) => n.id === 'a_yes'), false);
  // Start node cannot be removed
  assert.equal(removeGraphNode(preset, 'node_start'), false);

  autoLayoutGraph(preset);
  assert.ok(preset.nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y)));
});

test('validateWorkflowPreset migrates legacy tree presets and compileWorkflowToPlaybook handles merges/cycles safely', () => {
  const legacyPreset = {
    id: 'legacy_1',
    name: '旧形式フロー',
    nodes: [
      {
        id: 'c_old',
        type: 'condition',
        label: '分岐',
        conditionType: 'text_contains',
        conditionValue: '次へ',
        yesBranch: [{ id: 'a_y', type: 'action', label: 'YES操作', actionType: 'click' }],
        noBranch: []
      },
      { id: 'd_end', type: 'done', label: '完了', message: 'おわり' }
    ]
  };

  const migrated = validateWorkflowPreset(legacyPreset);
  assert.ok(Array.isArray(migrated.edges));
  assert.ok(migrated.nodes.some((n) => n.type === 'start'));
  assert.ok(migrated.edges.some((e) => e.from === 'c_old' && e.port === 'yes' && e.to === 'a_y'));
  assert.ok(migrated.edges.some((e) => e.from === 'a_y' && e.to === 'd_end'));
  assert.ok(migrated.edges.some((e) => e.from === 'c_old' && e.port === 'no' && e.to === 'd_end'));

  const compiled = compileWorkflowToPlaybook(migrated);
  assert.match(compiled.rawText, /\*\*IF（条件分岐）\*\*/);
  assert.match(compiled.rawText, /合流/);

  const preview = buildPreviewStepsFromGraph(migrated);
  assert.equal(preview[0].type, 'condition');
  assert.equal(preview[0].yesBranch.length, 2);
});
