import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WorkflowPresetStore,
  compileWorkflowToPlaybook,
  createDefaultPresets,
  createNode,
  findNodeById,
  insertNodeAt,
  moveNodeById,
  removeNodeById,
  updateNodeById
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
