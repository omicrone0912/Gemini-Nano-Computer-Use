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
      tabs.set(tab.id, { groupId: -1, ...tab });
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

test('TabWorkspaceManager creates a new tab in a new tab group without grouping the active tab', async () => {
  const mockChrome = createMockChrome();
  mockChrome.seedTab({ id: 10, windowId: 1, url: 'https://example.com', title: 'Home', active: true, pinned: false });

  const mgr = new TabWorkspaceManager(mockChrome);
  const ws1 = await mgr.initialize({
    initialTab: { id: 10, windowId: 1, title: 'Home', url: 'https://example.com', pinned: false },
    multiTabEnabled: true,
    backgroundMode: true,
    groupTitle: 'Nano AI',
    groupColor: 'blue'
  });

  // Active tab remains ungrouped and untouched
  assert.equal(mockChrome._tabs.get(10).groupId, -1);
  assert.equal(mockChrome._tabs.get(10).active, true);

  assert.equal(ws1.groupId, 500);
  assert.equal(mockChrome._groups.get(500).title, 'Nano AI');
  assert.equal(mockChrome._groups.get(500).color, 'blue');
  assert.equal(ws1.tabs.length, 1);
  assert.notEqual(ws1.currentTabId, 10);
  assert.equal(mockChrome._tabs.get(ws1.currentTabId).url, 'about:blank');
  assert.equal(mockChrome._tabs.get(ws1.currentTabId).active, false);
  assert.deepEqual(ws1.referenceTab, { title: 'Home', url: 'https://example.com' });

  const opened = await mgr.openTab('https://ja.wikipedia.org');
  assert.equal(opened.tab.active, false);
  assert.equal(mockChrome._tabs.get(opened.tab.id).groupId, 500);
  assert.equal(opened.workspace.tabs.length, 2);
  assert.equal(opened.workspace.currentTabId, opened.tab.id);
});

test('TabWorkspaceManager opens startUrl in new group tab and enforces managed tab boundaries', async () => {
  const mockChrome = createMockChrome();
  mockChrome.seedTab({ id: 10, windowId: 1, url: 'https://user-active.example', title: 'Active', active: true, pinned: false });
  mockChrome.seedTab({ id: 99, windowId: 1, url: 'https://other.example', title: 'Other', active: false, pinned: false });

  const mgr = new TabWorkspaceManager(mockChrome);
  const ws = await mgr.initialize({
    initialTab: { id: 10, windowId: 1, title: 'Active', url: 'https://user-active.example', pinned: false },
    startUrl: 'https://a.example',
    multiTabEnabled: true,
    backgroundMode: false
  });

  const firstWorkspaceTabId = ws.currentTabId;
  assert.notEqual(firstWorkspaceTabId, 10);
  assert.equal(mockChrome._tabs.get(10).groupId, -1);
  assert.equal(mockChrome._tabs.get(firstWorkspaceTabId).url, 'https://a.example');

  // Cannot close the last tab in group
  await assert.rejects(() => mgr.closeTab({ tabIndex: 1 }), /最後のタブ/);

  // Cannot switch to user's active tab or unmanaged tab
  await assert.rejects(() => mgr.switchTab({ tabId: 10 }), /作業グループ内に見つかりません/);
  await assert.rejects(() => mgr.switchTab({ tabId: 99 }), /作業グループ内に見つかりません/);

  const opened = await mgr.openTab('https://b.example');
  const switched = await mgr.switchTab({ tabIndex: 1 });
  assert.equal(switched.tab.id, firstWorkspaceTabId);

  const closed = await mgr.closeTab({ tabIndex: 2 });
  assert.equal(closed.closedTabId, opened.tab.id);
  assert.equal(closed.workspace.tabs.length, 1);
});

test('TabWorkspaceManager works with pinned initial tab, adopts child tabs into new group, and supports single-tab mode', async () => {
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
  assert.equal(mockChrome._tabs.get(1).groupId, -1);

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

  // When multiTabEnabled is false, operate on initialTab without creating a group
  const singleMgr = new TabWorkspaceManager(mockChrome);
  const singleWs = await singleMgr.initialize({
    initialTab: { id: 1, windowId: 1, url: 'https://pinned.example', pinned: true },
    multiTabEnabled: false,
    backgroundMode: false
  });
  assert.equal(singleWs.groupId, null);
  assert.equal(singleWs.currentTabId, 1);
  assert.equal(singleWs.tabs.length, 1);
});
