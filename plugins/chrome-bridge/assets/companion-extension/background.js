const DEFAULT_SERVER = 'http://127.0.0.1:17373';
const HIGHLIGHT_ID = '__codex_chrome_bridge_highlight__';

let state = { connected: false, clientId: null, lastError: null, serverUrl: DEFAULT_SERVER };

async function loadState() {
  const stored = await chrome.storage.local.get(['clientId', 'serverUrl']);
  state.clientId = stored.clientId || crypto.randomUUID();
  state.serverUrl = stored.serverUrl || DEFAULT_SERVER;
  await chrome.storage.local.set({ clientId: state.clientId, serverUrl: state.serverUrl });
}

async function queryTabs(query = {}) {
  return await chrome.tabs.query(query);
}

async function activeTab() {
  const tabs = await queryTabs({ active: true, lastFocusedWindow: true });
  const tab = tabs[0];
  if (!tab) return null;
  return serializeTab(tab);
}

function serializeTab(tab) {
  return {
    id: tab.id,
    windowId: tab.windowId,
    index: tab.index,
    active: !!tab.active,
    title: tab.title || '',
    url: tab.url || '',
  };
}

async function post(path, payload) {
  const response = await fetch(state.serverUrl + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function get(path) {
  const response = await fetch(state.serverUrl + path);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function resolveTargetTabId(requestedTabId = null) {
  if (requestedTabId != null) {
    const tab = await chrome.tabs.get(Number(requestedTabId));
    if (!tab?.id) throw new Error(`Unknown tab: ${requestedTabId}`);
    return tab.id;
  }
  const tab = await activeTab();
  if (!tab?.id) throw new Error('No active tab');
  return tab.id;
}

async function executeInTab(func, args = [], tabId = null) {
  const resolvedTabId = await resolveTargetTabId(tabId);
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: resolvedTabId },
    func,
    args,
  });
  return result;
}

async function listTabs(currentWindowOnly = false) {
  const tabs = await queryTabs(currentWindowOnly ? { currentWindow: true } : {});
  return tabs.map(serializeTab);
}

async function switchTab(tabId) {
  const tab = await chrome.tabs.get(Number(tabId));
  if (!tab?.id) throw new Error(`Unknown tab: ${tabId}`);
  await chrome.tabs.update(tab.id, { active: true });
  if (tab.windowId != null) {
    await chrome.windows.update(tab.windowId, { focused: true });
  }
  return serializeTab(await chrome.tabs.get(tab.id));
}

async function openNewTab(url = 'about:blank', active = true) {
  const tab = await chrome.tabs.create({ url, active });
  return serializeTab(tab);
}

async function closeTab(tabId = null) {
  const resolvedTabId = await resolveTargetTabId(tabId);
  const tab = await chrome.tabs.get(resolvedTabId);
  await chrome.tabs.remove(resolvedTabId);
  return { closed: true, tab: serializeTab(tab) };
}

async function captureScreenshot(tabId = null) {
  const resolvedTabId = await resolveTargetTabId(tabId);
  const tab = await chrome.tabs.get(resolvedTabId);
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  return {
    tab: serializeTab(tab),
    format: 'png',
    dataUrl,
  };
}

async function ensureOffscreenDocument() {
  const url = chrome.runtime.getURL('offscreen.html');
  if (chrome.offscreen?.hasDocument) {
    const existing = await chrome.offscreen.hasDocument();
    if (existing) return;
  }
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['CLIPBOARD'],
    justification: 'Copy extracted page content to the system clipboard.',
  });
}

async function writeClipboardText(text) {
  await ensureOffscreenDocument();
  await chrome.runtime.sendMessage({ type: 'clipboard-write-text', text });
}

function normalizeCopyMode(mode) {
  return mode === 'html' ? 'html' : 'text';
}

async function handleCommand(command) {
  const params = command.params || {};
  switch (command.action) {
    case 'getActiveTab':
      return await activeTab();
    case 'listTabs':
      return { tabs: await listTabs(!!params.currentWindowOnly) };
    case 'switchTab':
      return await switchTab(params.tabId);
    case 'openNewTab':
      return await openNewTab(params.url || 'about:blank', params.active !== false);
    case 'closeTab':
      return await closeTab(params.tabId ?? null);
    case 'navigate': {
      const resolvedTabId = await resolveTargetTabId(params.tabId ?? null);
      await chrome.tabs.update(resolvedTabId, { url: params.url });
      return { ok: true, tabId: resolvedTabId, url: params.url };
    }
    case 'back': {
      const resolvedTabId = await resolveTargetTabId(params.tabId ?? null);
      await chrome.tabs.goBack(resolvedTabId);
      return { ok: true, tabId: resolvedTabId };
    }
    case 'forward': {
      const resolvedTabId = await resolveTargetTabId(params.tabId ?? null);
      await chrome.tabs.goForward(resolvedTabId);
      return { ok: true, tabId: resolvedTabId };
    }
    case 'reload': {
      const resolvedTabId = await resolveTargetTabId(params.tabId ?? null);
      await chrome.tabs.reload(resolvedTabId);
      return { ok: true, tabId: resolvedTabId };
    }
    case 'scroll':
      return await executeInTab((deltaX, deltaY) => {
        window.scrollBy(deltaX, deltaY);
        return { scrollX: window.scrollX, scrollY: window.scrollY };
      }, [params.deltaX || 0, params.deltaY || 0], params.tabId ?? null);
    case 'scrollToSelector':
      return await executeInTab((selector) => {
        const el = document.querySelector(selector);
        if (!el) throw new Error(`Selector not found: ${selector}`);
        el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
        return { scrolled: true, selector };
      }, [params.selector], params.tabId ?? null);
    case 'extractText':
      return await executeInTab((maxLength) => ({
        title: document.title,
        url: location.href,
        text: document.body ? document.body.innerText.slice(0, maxLength) : '',
      }), [params.maxLength || 12000], params.tabId ?? null);
    case 'extractHtml':
      return await executeInTab((maxLength) => ({
        title: document.title,
        url: location.href,
        html: document.documentElement ? document.documentElement.outerHTML.slice(0, maxLength) : '',
      }), [params.maxLength || 120000], params.tabId ?? null);
    case 'extractVisibleDom':
      return await executeInTab((maxItems) => {
        const isVisible = (el) => {
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.visibility !== 'hidden' &&
            style.display !== 'none' &&
            rect.width > 0 &&
            rect.height > 0;
        };
        const describe = (el, index) => {
          const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 160);
          const id = el.id ? `#${el.id}` : '';
          const classes = Array.from(el.classList || []).slice(0, 3).map((x) => `.${x}`).join('');
          return {
            nodeIndex: index,
            tag: el.tagName.toLowerCase(),
            selector: `${el.tagName.toLowerCase()}${id}${classes}`,
            text,
            href: el.href || null,
            name: el.getAttribute('name'),
            type: el.getAttribute('type'),
            role: el.getAttribute('role'),
          };
        };
        const nodes = Array.from(document.querySelectorAll('a, button, input, select, textarea, [role="button"], [onclick], [contenteditable="true"]'))
          .filter(isVisible)
          .slice(0, maxItems)
          .map(describe);
        return { title: document.title, url: location.href, nodes };
      }, [params.maxItems || 200], params.tabId ?? null);
    case 'getElements':
      return await executeInTab((kind, maxItems) => {
        const selectorByKind = {
          all: 'a, button, input, select, textarea',
          links: 'a[href]',
          buttons: 'button, input[type="button"], input[type="submit"], [role="button"]',
          inputs: 'input, select, textarea, [contenteditable="true"]',
        };
        const selector = selectorByKind[kind] || selectorByKind.all;
        const isVisible = (el) => {
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.visibility !== 'hidden' &&
            style.display !== 'none' &&
            rect.width > 0 &&
            rect.height > 0;
        };
        const items = Array.from(document.querySelectorAll(selector))
          .filter(isVisible)
          .slice(0, maxItems)
          .map((el) => ({
            tag: el.tagName.toLowerCase(),
            text: (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 160),
            id: el.id || null,
            name: el.getAttribute('name'),
            type: el.getAttribute('type'),
            href: el.href || null,
            selector: el.id ? `#${el.id}` : el.tagName.toLowerCase(),
          }));
        return { title: document.title, url: location.href, kind, items };
      }, [params.kind || 'all', params.maxItems || 200], params.tabId ?? null);
    case 'click':
      return await executeInTab((selector) => {
        const el = document.querySelector(selector);
        if (!el) throw new Error(`Selector not found: ${selector}`);
        el.click();
        return { clicked: true, selector };
      }, [params.selector], params.tabId ?? null);
    case 'type':
      return await executeInTab((selector, text) => {
        const el = document.querySelector(selector);
        if (!el) throw new Error(`Selector not found: ${selector}`);
        el.focus();
        if ('value' in el) {
          el.value = text;
        } else if (el.isContentEditable) {
          el.textContent = text;
        } else {
          throw new Error(`Element is not typable: ${selector}`);
        }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { typed: true, selector, textLength: text.length };
      }, [params.selector, params.text], params.tabId ?? null);
    case 'pressKey':
      return await executeInTab((key, ctrlKey, altKey, shiftKey, metaKey) => {
        const target = document.activeElement || document.body || document.documentElement;
        const eventInit = { key, ctrlKey, altKey, shiftKey, metaKey, bubbles: true };
        target.dispatchEvent(new KeyboardEvent('keydown', eventInit));
        target.dispatchEvent(new KeyboardEvent('keypress', eventInit));
        target.dispatchEvent(new KeyboardEvent('keyup', eventInit));
        if (key === 'Enter' && typeof target.click === 'function' && target.tagName === 'BUTTON') {
          target.click();
        }
        return { pressed: true, key, ctrlKey, altKey, shiftKey, metaKey };
      }, [
        params.key,
        !!params.ctrlKey,
        !!params.altKey,
        !!params.shiftKey,
        !!params.metaKey,
      ], params.tabId ?? null);
    case 'waitForSelector':
      return await executeInTab(async (selector, timeoutMs) => {
        const startedAt = Date.now();
        while (Date.now() - startedAt < timeoutMs) {
          const el = document.querySelector(selector);
          if (el) {
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            if (style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0) {
              return { found: true, selector, elapsedMs: Date.now() - startedAt };
            }
          }
          await new Promise((resolve) => setTimeout(resolve, 150));
        }
        throw new Error(`Timed out waiting for selector: ${selector}`);
      }, [params.selector, params.timeoutMs || 10000], params.tabId ?? null);
    case 'selectOption':
      return await executeInTab((selector, value, label, index) => {
        const el = document.querySelector(selector);
        if (!el) throw new Error(`Selector not found: ${selector}`);
        if (!(el instanceof HTMLSelectElement)) throw new Error(`Element is not a <select>: ${selector}`);
        let matched = false;
        if (value != null) {
          el.value = value;
          matched = el.value === value;
        } else if (label != null) {
          const option = Array.from(el.options).find((opt) => opt.label === label || opt.text === label);
          if (option) {
            el.value = option.value;
            matched = true;
          }
        } else if (index != null && el.options[index]) {
          el.selectedIndex = index;
          matched = true;
        }
        if (!matched) throw new Error(`No matching option for selector: ${selector}`);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { selected: true, selector, value: el.value };
      }, [params.selector, params.value ?? null, params.label ?? null, params.index ?? null], params.tabId ?? null);
    case 'highlightElement':
      return await executeInTab((selector, color, durationMs, highlightId) => {
        const el = document.querySelector(selector);
        if (!el) throw new Error(`Selector not found: ${selector}`);
        const existing = document.getElementById(highlightId);
        if (existing) existing.remove();
        const rect = el.getBoundingClientRect();
        const overlay = document.createElement('div');
        overlay.id = highlightId;
        overlay.style.position = 'fixed';
        overlay.style.left = `${rect.left}px`;
        overlay.style.top = `${rect.top}px`;
        overlay.style.width = `${rect.width}px`;
        overlay.style.height = `${rect.height}px`;
        overlay.style.border = `3px solid ${color}`;
        overlay.style.background = 'rgba(255,255,0,0.08)';
        overlay.style.zIndex = '2147483647';
        overlay.style.pointerEvents = 'none';
        document.body.appendChild(overlay);
        el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
        window.setTimeout(() => overlay.remove(), durationMs);
        return { highlighted: true, selector, color, durationMs };
      }, [params.selector, params.color || '#ffcc00', params.durationMs || 2000, HIGHLIGHT_ID], params.tabId ?? null);
    case 'screenshot':
      return await captureScreenshot(params.tabId ?? null);
    case 'copyPageContent': {
      const mode = normalizeCopyMode(params.mode);
      const extracted = await executeInTab((copyMode, maxLength) => {
        const text = document.body ? document.body.innerText.slice(0, maxLength) : '';
        const html = document.documentElement ? document.documentElement.outerHTML.slice(0, maxLength) : '';
        return {
          title: document.title,
          url: location.href,
          text,
          html,
          selected: copyMode === 'html' ? html : text,
        };
      }, [mode, params.maxLength || 250000], params.tabId ?? null);
      await writeClipboardText(extracted.selected);
      return {
        copied: true,
        mode,
        title: extracted.title,
        url: extracted.url,
        textLength: extracted.text.length,
        htmlLength: extracted.html.length,
      };
    }
    default:
      throw new Error(`Unsupported action: ${command.action}`);
  }
}

async function heartbeat() {
  try {
    const tab = await activeTab();
    await post('/api/register', { clientId: state.clientId, lastTab: tab });
    state.connected = true;
    state.lastError = null;
  } catch (error) {
    state.connected = false;
    state.lastError = error.message;
  }
  await chrome.storage.local.set({ bridgeState: state });
}

async function pollOnce() {
  try {
    const payload = await get(`/api/pull?clientId=${encodeURIComponent(state.clientId)}`);
    state.connected = true;
    state.lastError = null;
    if (payload.command) {
      try {
        const data = await handleCommand(payload.command);
        await post('/api/result', {
          clientId: state.clientId,
          commandId: payload.command.commandId,
          ok: true,
          data,
          lastTab: await activeTab(),
        });
      } catch (error) {
        await post('/api/result', {
          clientId: state.clientId,
          commandId: payload.command.commandId,
          ok: false,
          error: error.message || String(error),
          lastTab: await activeTab(),
        });
      }
    }
  } catch (error) {
    state.connected = false;
    state.lastError = error.message;
  }
  await chrome.storage.local.set({ bridgeState: state });
}

async function loop() {
  await loadState();
  await heartbeat();
  setInterval(heartbeat, 5000);
  setInterval(pollOnce, 700);
}

loop();
