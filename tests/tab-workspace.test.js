import test from 'node:test';
import assert from 'node:assert/strict';
import { TabWorkspaceManager } from '../shared/tab-workspace.js';

function createMockChrome() {
  let nextTabId = 100;
  let nextGroupId = 500;
  const tabs = new Map();
  const groups = new Map();

  const api = {
    _tabs: tabs,
    _groups: groups,
    seedTab(tab) {
      tabs.set(tab.id, { ...tab });
    },
    tabs: {
      async get(tabId) {
        const t = tabs.get(tabId);
        if (!t) throw new Error('Tab not found');
        return { ...t };
      },
      async create(opts) {
        const id = nextTabId;
        nextTabId += 1;
        const tab = {
          id,
          windowId: opts.windowId ?? 1,
          url: opts.url || 'about:blank',
          title: `Tab ${id}`,
          active: opts.active !== false,
          pinned: false,
          groupId: -1
        };
        if (tab.active) {
          for (const existing of tabs.values()) {
            if (existing.windowId === tab.windowId) existing.active = false;
          }
        }
        tabs.set(id, tab);
        return { ...tab };
      },
      async update(tabId, props) {
        const t = tabs.get(tabId);
        if (!t) throw new Error('Tab not found');
        if (props.active) {
          for (const existing of tabs.values()) {
            if (existing.windowId === t.windowId) existing.active = false;
          }
        }
        Object.assign(t, props);
        return { ...t };
      },
      async remove(tabId) {
        tabs.delete(tabId);
      },
      async group({ tabIds, groupId }) {
        const gid = groupId ?? nextGroupId++;
        if (!groups.has(gid)) {
          groups.set(gid, { id: gid, title: '', color: 'grey', collapsed: false });
        }
        for (const id of tabIds) {
          const t = tabs.get(id);
          if (t) t.groupId = gid;
        }
        return gid;
      }
    },
    tabGroups: {
      async update(groupId, props) {
        const g = groups.get(groupId);
        if (!g) throw new Error('Group not found');
        Object.assign(g, props);
        return { ...g };
      }
    },
    windows: {
      async update() {}
    }
  };
  return api;
}

test('TabWorkspaceManager creates tab group on initialize and opens background tabs in the same group', async () => {
  const mockChrome = createMockChrome();
  mockChrome.seedTab({ id: 10, windowId: 1, url: 'https://example.com', title: 'Home', active: true, pinned: false });

  const mgr = new TabWorkspaceManager(mockChrome);
  const ws1 = await mgr.initialize({
    initialTab: { id: 10, windowId: 1, url: 'https://example.com', pinned: false },
    multiTabEnabled: true,
    backgroundMode: true,
    groupTitle: 'Nano AI',
    groupColor: 'blue'
  });

  assert.equal(ws1.groupId, 500);
  assert.equal(mockChrome._groups.get(500).title, 'Nano AI');
  assert.equal(mockChrome._groups.get(500).color, 'blue');
  assert.equal(ws1.tabs.length, 1);

  const opened = await mgr.openTab('https://ja.wikipedia.org');
  assert.equal(opened.tab.active, false);
  assert.equal(mockChrome._tabs.get(opened.tab.id).groupId, 500);
  assert.equal(opened.workspace.tabs.length, 2);
  assert.equal(opened.workspace.currentTabId, opened.tab.id);
});

test('TabWorkspaceManager enforces managed tab boundaries on switch and close', async () => {
  const mockChrome = createMockChrome();
  mockChrome.seedTab({ id: 10, windowId: 1, url: 'https://a.example', title: 'A', active: true, pinned: false });
  mockChrome.seedTab({ id: 99, windowId: 1, url: 'https://other.example', title: 'Other', active: false, pinned: false });

  const mgr = new TabWorkspaceManager(mockChrome);
  await mgr.initialize({
    initialTab: { id: 10, windowId: 1, url: 'https://a.example', pinned: false },
    multiTabEnabled: true,
    backgroundMode: false
  });

  // Cannot close the last tab in group
  await assert.rejects(() => mgr.closeTab({ tabIndex: 1 }), /最後のタブ/);

  // Cannot switch to unmanaged tab
  await assert.rejects(() => mgr.switchTab({ tabId: 99 }), /作業グループ内に見つかりません/);

  const opened = await mgr.openTab('https://b.example');
  const switched = await mgr.switchTab({ tabIndex: 1 });
  assert.equal(switched.tab.id, 10);

  const closed = await mgr.closeTab({ tabIndex: 2 });
  assert.equal(closed.closedTabId, opened.tab.id);
  assert.equal(closed.workspace.tabs.length, 1);
});

test('TabWorkspaceManager creates fresh workspace tab when initial tab is pinned and adopts child tabs', async () => {
  const mockChrome = createMockChrome();
  mockChrome.seedTab({ id: 1, windowId: 1, url: 'https://pinned.example', title: 'Pinned', active: true, pinned: true });

  const mgr = new TabWorkspaceManager(mockChrome);
  const ws = await mgr.initialize({
    initialTab: { id: 1, windowId: 1, url: 'https://pinned.example', pinned: true },
    multiTabEnabled: true,
    backgroundMode: true
  });

  assert.notEqual(ws.currentTabId, 1);
  assert.equal(ws.groupId, 500);

  // Simulate child tab opened via target="_blank" from workspace tab
  const childTab = { id: 200, windowId: 1, openerTabId: ws.currentTabId, url: 'https://child.example', active: false };
  mockChrome.seedTab(childTab);
  const adopted = await mgr.adoptChildTab(childTab);
  assert.equal(adopted, true);
  assert.equal(mockChrome._tabs.get(200).groupId, 500);

  // Removing child tab cleans up state
  await mockChrome.tabs.remove(200);
  const removed = await mgr.handleTabRemoved(200);
  assert.equal(removed, true);
  const after = await mgr.getWorkspaceContext();
  assert.equal(after.tabs.length, 1);
});
