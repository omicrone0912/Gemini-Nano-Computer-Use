/**
 * Manages the active workspace tab(s) and Chrome Tab Group for multi-tab and
 * background execution. Dependency-injected for clean unit testing.
 */
export class TabWorkspaceManager {
  constructor(chromeApi = globalThis.chrome) {
    this.chrome = chromeApi;
    this.groupId = null;
    this.windowId = null;
    this.managedTabIds = [];
    this.currentTabId = null;
    this.referenceTab = null;
    this.groupTitle = 'Nano AI';
    this.groupColor = 'blue';
    this.backgroundMode = false;
    this.multiTabEnabled = false;
  }

  reset() {
    this.groupId = null;
    this.windowId = null;
    this.managedTabIds = [];
    this.currentTabId = null;
    this.referenceTab = null;
  }

  async _ensureTabExists(tabId) {
    try {
      const tab = await this.chrome.tabs.get(tabId);
      return tab || null;
    } catch {
      return null;
    }
  }

  async _ensureGroupForTab(tabId) {
    if (!this.multiTabEnabled || !this.chrome?.tabs?.group) {
      return null;
    }

    const tab = await this._ensureTabExists(tabId);
    if (!tab) return null;

    // Pinned tabs cannot be grouped in Chrome
    if (tab.pinned) {
      return null;
    }

    if (this.groupId !== null) {
      try {
        await this.chrome.tabs.group({ tabIds: [tabId], groupId: this.groupId });
        return this.groupId;
      } catch {
        // Existing group might have been deleted by user; fall through to create a new one
        this.groupId = null;
      }
    }

    const createGroupOpts = { tabIds: [tabId] };
    if (this.windowId !== null) {
      createGroupOpts.createProperties = { windowId: this.windowId };
    }

    const newGroupId = await this.chrome.tabs.group(createGroupOpts);
    this.groupId = newGroupId;

    if (this.chrome?.tabGroups?.update) {
      try {
        await this.chrome.tabGroups.update(newGroupId, {
          title: this.groupTitle,
          color: this.groupColor,
          collapsed: false
        });
      } catch {
        // Ignore styling failure if tabGroups API is restricted
      }
    }
    return newGroupId;
  }

  async initialize({
    initialTab = null,
    startUrl = '',
    windowId = null,
    multiTabEnabled = true,
    backgroundMode = true,
    groupTitle = 'Nano AI',
    groupColor = 'blue'
  } = {}) {
    this.reset();
    this.multiTabEnabled = Boolean(multiTabEnabled);
    this.backgroundMode = Boolean(backgroundMode);
    this.groupTitle = groupTitle || 'Nano AI';
    this.groupColor = groupColor || 'blue';
    this.windowId = initialTab?.windowId ?? windowId ?? null;
    this.referenceTab =
      initialTab?.url && /^https?:/i.test(initialTab.url)
        ? { title: initialTab.title || '', url: initialTab.url }
        : null;

    if (this.multiTabEnabled) {
      const targetUrl = startUrl && /^https?:/i.test(startUrl) ? startUrl : 'about:blank';
      const workingTab = await this.chrome.tabs.create({
        windowId: this.windowId ?? undefined,
        url: targetUrl,
        active: !this.backgroundMode
      });
      this.managedTabIds = [workingTab.id];
      this.currentTabId = workingTab.id;
      await this._ensureGroupForTab(workingTab.id);
      return this.getWorkspaceContext();
    }

    if (!initialTab?.id) {
      throw new Error('初期化対象のタブが見つかりません。');
    }

    this.managedTabIds = [initialTab.id];
    this.currentTabId = initialTab.id;

    return this.getWorkspaceContext();
  }

  async openTab(url = 'https://www.google.com') {
    if (!this.multiTabEnabled) {
      throw new Error('複数タブでの作業が許可されていません。設定で許可してください。');
    }

    const created = await this.chrome.tabs.create({
      windowId: this.windowId ?? undefined,
      url,
      active: !this.backgroundMode
    });

    if (!this.managedTabIds.includes(created.id)) {
      this.managedTabIds.push(created.id);
    }
    this.currentTabId = created.id;

    await this._ensureGroupForTab(created.id);
    return {
      ok: true,
      tab: created,
      workspace: await this.getWorkspaceContext()
    };
  }

  _resolveManagedTabId({ tabIndex, tabId } = {}) {
    if (typeof tabId === 'number' && this.managedTabIds.includes(tabId)) {
      return tabId;
    }
    if (typeof tabIndex === 'number' && tabIndex >= 1 && tabIndex <= this.managedTabIds.length) {
      return this.managedTabIds[tabIndex - 1];
    }
    return null;
  }

  async switchTab({ tabIndex, tabId } = {}) {
    if (!this.multiTabEnabled) {
      throw new Error('複数タブでの作業が許可されていません。');
    }

    const targetId = this._resolveManagedTabId({ tabIndex, tabId });
    if (!targetId) {
      throw new Error(`指定されたタブ（index=${tabIndex ?? '-'}）は作業グループ内に見つかりません。`);
    }

    const tab = await this._ensureTabExists(targetId);
    if (!tab) {
      await this.handleTabRemoved(targetId);
      throw new Error('指定されたタブはすでに閉じられています。');
    }

    this.currentTabId = targetId;
    if (!this.backgroundMode) {
      await this.chrome.tabs.update(targetId, { active: true });
    }

    return {
      ok: true,
      tab,
      workspace: await this.getWorkspaceContext()
    };
  }

  async focusTab(tabId) {
    const targetId = this._resolveManagedTabId({ tabId }) ?? this.currentTabId;
    if (!targetId) return null;
    const tab = await this._ensureTabExists(targetId);
    if (!tab) return null;
    this.currentTabId = targetId;
    await this.chrome.tabs.update(targetId, { active: true });
    if (tab.windowId !== undefined && this.chrome?.windows?.update) {
      try {
        await this.chrome.windows.update(tab.windowId, { focused: true });
      } catch {
        // Ignore window focus failure
      }
    }
    return this.getWorkspaceContext();
  }

  async closeTab({ tabIndex, tabId } = {}) {
    if (!this.multiTabEnabled) {
      throw new Error('複数タブでの作業が許可されていません。');
    }
    if (this.managedTabIds.length <= 1) {
      throw new Error('作業グループ内の最後のタブは閉じることができません。');
    }

    const targetId =
      tabIndex !== undefined || tabId !== undefined
        ? this._resolveManagedTabId({ tabIndex, tabId })
        : this.currentTabId;

    if (!targetId) {
      throw new Error('閉じる対象のタブが作業グループ内に見つかりません。');
    }

    await this.chrome.tabs.remove(targetId);
    await this.handleTabRemoved(targetId);

    if (!this.backgroundMode && this.currentTabId) {
      try {
        await this.chrome.tabs.update(this.currentTabId, { active: true });
      } catch {
        // Ignore
      }
    }

    return {
      ok: true,
      closedTabId: targetId,
      workspace: await this.getWorkspaceContext()
    };
  }

  async adoptChildTab(tab) {
    if (!this.multiTabEnabled || !tab?.id || !tab.openerTabId) {
      return false;
    }
    if (!this.managedTabIds.includes(tab.openerTabId)) {
      return false;
    }
    if (!this.managedTabIds.includes(tab.id)) {
      this.managedTabIds.push(tab.id);
    }
    this.currentTabId = tab.id;
    await this._ensureGroupForTab(tab.id);
    if (this.backgroundMode && tab.active && this.managedTabIds[0]) {
      // Keep focus out of newly spawned child tab only if explicitly backgrounded? Do not fight user manually clicking; leave as created.
    }
    return true;
  }

  async handleTabRemoved(tabId) {
    const idx = this.managedTabIds.indexOf(tabId);
    if (idx === -1) return false;

    this.managedTabIds.splice(idx, 1);
    if (this.currentTabId === tabId) {
      this.currentTabId = this.managedTabIds[Math.max(0, idx - 1)] ?? this.managedTabIds[0] ?? null;
    }
    if (this.managedTabIds.length === 0) {
      this.groupId = null;
    }
    return true;
  }

  async getCurrentTab() {
    if (this.currentTabId) {
      const tab = await this._ensureTabExists(this.currentTabId);
      if (tab) return tab;
      await this.handleTabRemoved(this.currentTabId);
    }
    if (this.managedTabIds.length > 0) {
      for (const id of [...this.managedTabIds]) {
        const tab = await this._ensureTabExists(id);
        if (tab) {
          this.currentTabId = id;
          return tab;
        }
        await this.handleTabRemoved(id);
      }
    }
    return null;
  }

  async getWorkspaceContext() {
    const tabs = [];
    const aliveIds = [];

    for (const id of this.managedTabIds) {
      const tab = await this._ensureTabExists(id);
      if (tab) {
        aliveIds.push(id);
        tabs.push({
          index: tabs.length + 1,
          tabId: tab.id,
          title: tab.title || '(無題)',
          url: tab.url || '',
          active: Boolean(tab.active),
          isCurrent: tab.id === this.currentTabId
        });
      }
    }

    this.managedTabIds = aliveIds;
    if (this.currentTabId && !aliveIds.includes(this.currentTabId)) {
      this.currentTabId = aliveIds[0] ?? null;
      if (tabs[0]) tabs[0].isCurrent = true;
    }

    return {
      groupId: this.groupId,
      groupTitle: this.groupTitle,
      groupColor: this.groupColor,
      multiTabEnabled: this.multiTabEnabled,
      backgroundMode: this.backgroundMode,
      currentTabId: this.currentTabId,
      referenceTab: this.referenceTab,
      tabs
    };
  }
}
