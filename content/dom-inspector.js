(function initNanoComputerUseInspector() {
  if (window.__NANO_CU_LOADED__) {
    return;
  }
  window.__NANO_CU_LOADED__ = true;

  const MSG = {
    PING: 'NANO_CU_PING',
    CAPTURE_SNAPSHOT: 'NANO_CU_CAPTURE_SNAPSHOT',
    EXECUTE_DOM_ACTION: 'NANO_CU_EXECUTE_DOM_ACTION'
  };

  const INTERACTIVE_SELECTOR = [
    'a[href]',
    'button',
    'input:not([type="hidden"])',
    'textarea',
    'select',
    'summary',
    '[role="button"]',
    '[role="link"]',
    '[role="tab"]',
    '[role="menuitem"]',
    '[role="option"]',
    '[role="checkbox"]',
    '[role="radio"]',
    '[role="switch"]',
    '[role="textbox"]',
    '[role="combobox"]',
    '[role="searchbox"]',
    '[contenteditable="true"]',
    '[contenteditable=""]',
    '[onclick]'
  ].join(',');

  const OVERLAY_ID = '__nano_cu_action_overlay__';
  let elementMap = new Map();
  let overlayTimer = null;

  function cleanText(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
  }

  function clearActionOverlay() {
    if (overlayTimer) {
      clearTimeout(overlayTimer);
      overlayTimer = null;
    }
    const existing = document.getElementById(OVERLAY_ID);
    if (existing) {
      existing.remove();
    }
  }

  function showActionOverlay(el, labelText) {
    clearActionOverlay();
    if (!el || typeof el.getBoundingClientRect !== 'function') return;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    const root = document.createElement('div');
    root.id = OVERLAY_ID;
    root.style.cssText = [
      'position: fixed',
      `left: ${Math.max(0, rect.left - 3)}px`,
      `top: ${Math.max(0, rect.top - 3)}px`,
      `width: ${Math.max(12, rect.width + 6)}px`,
      `height: ${Math.max(12, rect.height + 6)}px`,
      'border: 3px solid #2563eb',
      'background: rgba(37, 99, 235, 0.14)',
      'border-radius: 6px',
      'box-shadow: 0 0 0 2px rgba(255,255,255,0.85)',
      'pointer-events: none',
      'z-index: 2147483647',
      'transition: opacity 0.2s ease'
    ].join(';');

    if (labelText) {
      const badge = document.createElement('div');
      badge.textContent = labelText;
      const badgeTop = rect.top > 26 ? -24 : rect.height + 6;
      badge.style.cssText = [
        'position: absolute',
        'left: 0',
        `top: ${badgeTop}px`,
        'background: #1d4ed8',
        'color: #ffffff',
        'font: 600 11px/1.3 system-ui, -apple-system, sans-serif',
        'padding: 3px 7px',
        'border-radius: 4px',
        'white-space: nowrap',
        'box-shadow: 0 2px 6px rgba(0,0,0,0.25)'
      ].join(';');
      root.appendChild(badge);
    }

    (document.body || document.documentElement).appendChild(root);
    overlayTimer = setTimeout(clearActionOverlay, 950);
  }

  function isElementVisible(el) {
    if (!el || el.id === OVERLAY_ID || el.closest?.(`#${OVERLAY_ID}`)) {
      return false;
    }
    const style = window.getComputedStyle(el);
    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      parseFloat(style.opacity || '1') === 0
    ) {
      return false;
    }

    const rect = el.getBoundingClientRect();
    if (rect.width < 4 || rect.height < 4) {
      return false;
    }

    const vw = window.innerWidth || document.documentElement.clientWidth;
    const vh = window.innerHeight || document.documentElement.clientHeight;
    if (rect.bottom <= 0 || rect.right <= 0 || rect.top >= vh || rect.left >= vw) {
      return false;
    }

    return true;
  }

  function collectCandidates(root, out, visitedRoots) {
    if (!root || visitedRoots.has(root)) return;
    visitedRoots.add(root);

    let matched = [];
    try {
      matched = root.querySelectorAll(INTERACTIVE_SELECTOR);
    } catch {
      matched = [];
    }

    for (const el of matched) {
      out.add(el);
    }

    // Traverse open Shadow DOMs
    let allNodes = [];
    try {
      allNodes = root.querySelectorAll('*');
    } catch {
      allNodes = [];
    }
    for (const node of allNodes) {
      if (node.shadowRoot) {
        collectCandidates(node.shadowRoot, out, visitedRoots);
      }
    }
  }

  function findLabelText(el) {
    const aria = cleanText(el.getAttribute('aria-label'));
    if (aria) return aria;

    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const parts = labelledBy
        .split(/\s+/)
        .map((id) => cleanText(document.getElementById(id)?.innerText))
        .filter(Boolean);
      if (parts.length > 0) return parts.join(' ');
    }

    if (el.id && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT')) {
      try {
        const assocLabel = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (assocLabel) {
          const text = cleanText(assocLabel.innerText);
          if (text) return text;
        }
      } catch {
        // Ignore CSS.escape failure
      }
    }

    const parentLabel = el.closest?.('label');
    if (parentLabel) {
      const text = cleanText(parentLabel.innerText);
      if (text) return text;
    }

    const titleAttr = cleanText(el.getAttribute('title'));
    const altAttr = cleanText(el.getAttribute('alt'));
    const inner = cleanText(el.innerText || el.textContent);

    if (el.tagName === 'INPUT') {
      const inputType = (el.type || '').toLowerCase();
      if (inputType === 'submit' || inputType === 'button' || inputType === 'reset') {
        return cleanText(el.value) || titleAttr || inputType;
      }
      return cleanText(el.placeholder) || titleAttr || cleanText(el.name);
    }

    if (el.tagName === 'TEXTAREA') {
      return cleanText(el.placeholder) || titleAttr || cleanText(el.name);
    }

    if (inner) return inner.slice(0, 80);
    if (altAttr) return altAttr;
    if (titleAttr) return titleAttr;

    const imgAlt = cleanText(el.querySelector?.('img[alt]')?.getAttribute('alt'));
    if (imgAlt) return imgAlt;

    return '';
  }

  function extractPageTextExcerpt(maxChars = 1200) {
    const raw = cleanText(document.body?.innerText || '');
    return raw.slice(0, maxChars);
  }

  function captureSnapshot(options = {}) {
    clearActionOverlay();
    const maxElements = Number(options.maxElements) > 0 ? Number(options.maxElements) : 60;

    const candidates = new Set();
    collectCandidates(document, candidates, new Set());

    const vw = window.innerWidth || document.documentElement.clientWidth || 1280;
    const vh = window.innerHeight || document.documentElement.clientHeight || 800;

    const items = [];
    const nextMap = new Map();

    // Sort roughly top-to-bottom, left-to-right for natural reading order
    const visibleList = Array.from(candidates)
      .filter((el) => isElementVisible(el))
      .map((el) => ({ el, rect: el.getBoundingClientRect() }))
      .sort((a, b) => {
        const dy = Math.round(a.rect.top / 16) - Math.round(b.rect.top / 16);
        if (dy !== 0) return dy;
        return a.rect.left - b.rect.left;
      });

    let idCounter = 1;
    for (const { el, rect } of visibleList) {
      if (items.length >= maxElements) break;

      const tag = el.tagName.toLowerCase();
      const role = cleanText(el.getAttribute('role')) || undefined;
      const inputType =
        tag === 'input' || tag === 'button' ? cleanText(el.getAttribute('type') || el.type).toLowerCase() : undefined;
      const label = findLabelText(el);
      const placeholder = cleanText(el.getAttribute('placeholder')) || undefined;
      const ariaLabel = cleanText(el.getAttribute('aria-label')) || undefined;
      const href = tag === 'a' ? cleanText(el.getAttribute('href')) || undefined : undefined;
      const disabled = Boolean(el.disabled || el.getAttribute('aria-disabled') === 'true');

      let value;
      if (tag === 'input' || tag === 'textarea' || tag === 'select') {
        value = inputType === 'password' ? (el.value ? '***' : '') : String(el.value ?? '');
      } else if (el.isContentEditable) {
        value = cleanText(el.innerText).slice(0, 80);
      }

      let checked;
      if (tag === 'input' && (inputType === 'checkbox' || inputType === 'radio')) {
        checked = Boolean(el.checked);
      } else if (el.hasAttribute('aria-checked')) {
        checked = el.getAttribute('aria-checked') === 'true';
      }

      let optionsList;
      if (tag === 'select') {
        optionsList = Array.from(el.options || [])
          .slice(0, 15)
          .map((opt) => ({
            value: String(opt.value),
            text: cleanText(opt.text)
          }));
      }

      const id = idCounter;
      idCounter += 1;
      nextMap.set(id, el);

      items.push({
        id,
        tag,
        role,
        inputType,
        label,
        placeholder,
        ariaLabel,
        value,
        checked,
        disabled,
        href,
        options: optionsList,
        rect: {
          x: Math.round(rect.left),
          y: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        }
      });
    }

    elementMap = nextMap;

    const docEl = document.documentElement;
    const maxY = Math.max(0, (docEl?.scrollHeight || document.body?.scrollHeight || 0) - vh);

    return {
      restricted: false,
      url: location.href,
      title: document.title || '',
      viewport: {
        width: vw,
        height: vh,
        devicePixelRatio: window.devicePixelRatio || 1
      },
      scroll: {
        x: window.scrollX || 0,
        y: window.scrollY || 0,
        maxY
      },
      elements: items,
      textExcerpt: extractPageTextExcerpt(1200)
    };
  }

  function setNativeInputValue(el, newValue) {
    const proto =
      el.tagName === 'TEXTAREA'
        ? window.HTMLTextAreaElement?.prototype
        : window.HTMLInputElement?.prototype;
    const descriptor = proto ? Object.getOwnPropertyDescriptor(proto, 'value') : null;
    if (descriptor && typeof descriptor.set === 'function') {
      descriptor.set.call(el, newValue);
    } else {
      el.value = newValue;
    }
  }

  function dispatchMouseSequence(el) {
    const rect = el.getBoundingClientRect();
    const clientX = rect.left + rect.width / 2;
    const clientY = rect.top + rect.height / 2;
    const common = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX,
      clientY
    };

    try {
      el.dispatchEvent(new PointerEvent('pointerdown', common));
      el.dispatchEvent(new MouseEvent('mousedown', common));
      el.dispatchEvent(new PointerEvent('pointerup', common));
      el.dispatchEvent(new MouseEvent('mouseup', common));
    } catch {
      // Fallback if PointerEvent constructor fails in older contexts
    }

    if (typeof el.click === 'function') {
      el.click();
    } else {
      el.dispatchEvent(new MouseEvent('click', common));
    }
  }

  function dispatchKeyPress(target, key) {
    const keyName = key || 'Enter';
    const keyCodeMap = {
      Enter: 13,
      Tab: 9,
      Escape: 27,
      ArrowDown: 40,
      ArrowUp: 38,
      ArrowLeft: 37,
      ArrowRight: 39,
      Backspace: 8,
      ' ': 32
    };
    const code = keyCodeMap[keyName] || 0;
    const init = {
      key: keyName,
      code: keyName === ' ' ? 'Space' : keyName,
      keyCode: code,
      which: code,
      bubbles: true,
      cancelable: true
    };
    target.dispatchEvent(new KeyboardEvent('keydown', init));
    target.dispatchEvent(new KeyboardEvent('keypress', init));
    target.dispatchEvent(new KeyboardEvent('keyup', init));
  }

  async function executeDomAction(action) {
    switch (action.action) {
      case 'click': {
        const el = elementMap.get(action.elementId);
        if (!el || !el.isConnected) {
          return { ok: false, error: `要素 #${action.elementId} が見つからないか DOM から削除されています。` };
        }
        el.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });
        showActionOverlay(el, `Nano: Click #${action.elementId}`);
        el.focus?.({ preventScroll: true });
        dispatchMouseSequence(el);
        return { ok: true, detail: `要素 #${action.elementId} をクリックしました。` };
      }

      case 'type': {
        const el = elementMap.get(action.elementId);
        if (!el || !el.isConnected) {
          return { ok: false, error: `入力要素 #${action.elementId} が見つかりません。` };
        }
        el.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });
        showActionOverlay(el, `Nano: Type #${action.elementId}`);
        el.focus?.({ preventScroll: true });

        const shouldClear = action.clear !== false;
        const textToType = String(action.text ?? '');

        if (el.isContentEditable) {
          el.textContent = shouldClear ? textToType : `${el.textContent || ''}${textToType}`;
          el.dispatchEvent(new InputEvent('input', { bubbles: true, data: textToType, inputType: 'insertText' }));
        } else {
          const nextValue = shouldClear ? textToType : `${el.value ?? ''}${textToType}`;
          setNativeInputValue(el, nextValue);
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }

        if (action.submit) {
          dispatchKeyPress(el, 'Enter');
          const form = el.closest?.('form');
          if (form) {
            if (typeof form.requestSubmit === 'function') {
              try {
                form.requestSubmit();
              } catch {
                form.submit?.();
              }
            } else {
              form.submit?.();
            }
          }
        }

        return { ok: true, detail: `要素 #${action.elementId} にテキストを入力しました。` };
      }

      case 'select': {
        const el = elementMap.get(action.elementId);
        if (!el || !el.isConnected || el.tagName !== 'SELECT') {
          return { ok: false, error: `セレクト要素 #${action.elementId} が見つかりません。` };
        }
        el.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });
        showActionOverlay(el, `Nano: Select #${action.elementId}`);

        const targetText = cleanText(action.text).toLowerCase();
        const options = Array.from(el.options || []);
        const matched =
          options.find((opt) => cleanText(opt.value).toLowerCase() === targetText) ||
          options.find((opt) => cleanText(opt.text).toLowerCase() === targetText) ||
          options.find((opt) => cleanText(opt.text).toLowerCase().includes(targetText));

        if (!matched) {
          return { ok: false, error: `選択肢 "${action.text}" が見つかりません。` };
        }

        el.value = matched.value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, detail: `選択肢 "${cleanText(matched.text)}" を選択しました。` };
      }

      case 'press_key': {
        const target = document.activeElement && document.activeElement !== document.body
          ? document.activeElement
          : document.body || document.documentElement;
        dispatchKeyPress(target, action.key || 'Enter');
        if ((action.key || 'Enter') === 'Enter' && target?.closest?.('form')) {
          const form = target.closest('form');
          try {
            form.requestSubmit?.();
          } catch {
            // Ignore submit restrictions
          }
        }
        return { ok: true, detail: `キー "${action.key || 'Enter'}" を押下しました。` };
      }

      case 'scroll': {
        const vh = window.innerHeight || document.documentElement.clientHeight || 700;
        const delta = Math.round(vh * 0.78);
        switch (action.direction) {
          case 'up':
            window.scrollBy({ top: -delta, behavior: 'smooth' });
            break;
          case 'top':
            window.scrollTo({ top: 0, behavior: 'smooth' });
            break;
          case 'bottom':
            window.scrollTo({ top: document.documentElement.scrollHeight || document.body.scrollHeight, behavior: 'smooth' });
            break;
          case 'down':
          default:
            window.scrollBy({ top: delta, behavior: 'smooth' });
            break;
        }
        return { ok: true, detail: `${action.direction || 'down'} 方向にスクロールしました。` };
      }

      default:
        return { ok: false, error: `DOM スクリプト未対応のアクション: ${action.action}` };
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message.type !== 'string') {
      return false;
    }

    if (message.type === MSG.PING) {
      sendResponse({ ok: true });
      return false;
    }

    if (message.type === MSG.CAPTURE_SNAPSHOT) {
      try {
        const snapshot = captureSnapshot(message.options);
        sendResponse({ ok: true, snapshot });
      } catch (error) {
        sendResponse({ ok: false, error: error?.message || String(error) });
      }
      return false;
    }

    if (message.type === MSG.EXECUTE_DOM_ACTION) {
      executeDomAction(message.action)
        .then((result) => sendResponse(result))
        .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
      return true;
    }

    return false;
  });
})();
