const DEFAULT_SERVER = 'http://127.0.0.1:17373';
const HIGHLIGHT_ID = '__codex_chrome_bridge_highlight__';
const MAX_COMMAND_LOG = 60;
const MAX_NETWORK_LOG = 120;

let state = { connected: false, clientId: null, lastError: null, serverUrl: DEFAULT_SERVER };
let commandLog = [];
let networkState = {
  attachedTabId: null,
  logsByTab: {},
  requestsByTab: {},
};

async function loadState() {
  const stored = await chrome.storage.local.get(['clientId', 'serverUrl']);
  state.clientId = stored.clientId || crypto.randomUUID();
  state.serverUrl = stored.serverUrl || DEFAULT_SERVER;
  await chrome.storage.local.set({ clientId: state.clientId, serverUrl: state.serverUrl });
}

async function persistBridgeState() {
  try {
    await chrome.storage.local.set({ bridgeState: state });
  } catch {
    // Ignore transient storage failures during service worker restarts.
  }
}

function pushCommandLog(entry) {
  commandLog = [{
    at: new Date().toISOString(),
    ...entry,
  }, ...commandLog].slice(0, MAX_COMMAND_LOG);
}

function debuggerTarget(tabId) {
  return { tabId: Number(tabId) };
}

function ensureTabBuckets(tabId) {
  const key = String(tabId);
  networkState.logsByTab[key] ||= [];
  networkState.requestsByTab[key] ||= {};
  return key;
}

function previewText(value, maxLength = 400) {
  if (!value) return '';
  return String(value).replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function appendNetworkEntry(tabId, entry) {
  const key = ensureTabBuckets(tabId);
  networkState.logsByTab[key] = [{
    at: new Date().toISOString(),
    ...entry,
  }, ...networkState.logsByTab[key]].slice(0, MAX_NETWORK_LOG);
}

async function attachNetworkMonitor(tabId) {
  const resolvedTabId = await resolveTargetTabId(tabId);
  if (networkState.attachedTabId === resolvedTabId) {
    return { attached: true, tabId: resolvedTabId, alreadyAttached: true };
  }
  if (networkState.attachedTabId != null) {
    await detachNetworkMonitor(networkState.attachedTabId);
  }
  await chrome.debugger.attach(debuggerTarget(resolvedTabId), '1.3');
  await chrome.debugger.sendCommand(debuggerTarget(resolvedTabId), 'Network.enable');
  ensureTabBuckets(resolvedTabId);
  networkState.attachedTabId = resolvedTabId;
  appendNetworkEntry(resolvedTabId, { kind: 'system', message: 'Network monitor attached' });
  return { attached: true, tabId: resolvedTabId };
}

async function detachNetworkMonitor(tabId = null) {
  const resolvedTabId = tabId != null ? Number(tabId) : networkState.attachedTabId;
  if (resolvedTabId == null) return { detached: true, tabId: null, alreadyDetached: true };
  try {
    await chrome.debugger.detach(debuggerTarget(resolvedTabId));
  } catch {
    // Ignore detach errors if the tab was closed or already detached.
  }
  if (networkState.attachedTabId === resolvedTabId) {
    appendNetworkEntry(resolvedTabId, { kind: 'system', message: 'Network monitor detached' });
    networkState.attachedTabId = null;
  }
  return { detached: true, tabId: resolvedTabId };
}

function getNetworkSnapshot(tabId = null) {
  const resolvedTabId = tabId != null ? Number(tabId) : networkState.attachedTabId;
  const key = resolvedTabId != null ? String(resolvedTabId) : null;
  return {
    attachedTabId: networkState.attachedTabId,
    tabId: resolvedTabId,
    logs: key ? (networkState.logsByTab[key] || []) : [],
  };
}

function clearNetworkLog(tabId = null) {
  const resolvedTabId = tabId != null ? Number(tabId) : networkState.attachedTabId;
  if (resolvedTabId == null) return { cleared: true, tabId: null };
  const key = ensureTabBuckets(resolvedTabId);
  networkState.logsByTab[key] = [];
  networkState.requestsByTab[key] = {};
  return { cleared: true, tabId: resolvedTabId };
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

async function safeActiveTab() {
  try {
    return await activeTab();
  } catch {
    return null;
  }
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

async function withDebugger(tabId, fn) {
  const resolvedTabId = await resolveTargetTabId(tabId);
  const wasNetworkAttached = networkState.attachedTabId === resolvedTabId;
  if (!wasNetworkAttached) {
    await chrome.debugger.attach(debuggerTarget(resolvedTabId), '1.3');
  }
  try {
    return await fn(resolvedTabId);
  } finally {
    if (!wasNetworkAttached) {
      try {
        await chrome.debugger.detach(debuggerTarget(resolvedTabId));
      } catch {
        // Ignore transient detach failures.
      }
    }
  }
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

async function getPageUrl(tabId = null) {
  const resolvedTabId = await resolveTargetTabId(tabId);
  const tab = await chrome.tabs.get(resolvedTabId);
  return tab.url || '';
}

function normalizeCopyMode(mode) {
  return mode === 'html' ? 'html' : 'text';
}

async function handleCommand(command) {
  const params = command.params || {};
  pushCommandLog({
    action: command.action,
    paramsPreview: previewText(JSON.stringify(params)),
  });
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
    case 'findByText':
      return await executeInTab((needle, exact, maxItems) => {
        const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim();
        const target = norm(needle);
        if (!target) return { matches: [] };
        const isVisible = (el) => {
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.visibility !== 'hidden' &&
            style.display !== 'none' &&
            rect.width > 0 &&
            rect.height > 0;
        };
        const selectorFor = (el) => {
          if (el.id) return `#${el.id}`;
          const cls = Array.from(el.classList || []).slice(0, 2).map((x) => `.${x}`).join('');
          return `${el.tagName.toLowerCase()}${cls}`;
        };
        const elements = Array.from(document.querySelectorAll('a, button, input, select, textarea, label, summary, [role], [contenteditable="true"], p, h1, h2, h3, h4, h5, h6, span, div'));
        const matches = [];
        for (const el of elements) {
          if (!isVisible(el)) continue;
          const text = norm(el.innerText || el.textContent || el.value || '');
          if (!text) continue;
          const ok = exact ? text === target : text.toLowerCase().includes(target.toLowerCase());
          if (!ok) continue;
          matches.push({
            tag: el.tagName.toLowerCase(),
            text: text.slice(0, 200),
            selector: selectorFor(el),
            href: el.href || null,
            role: el.getAttribute('role'),
          });
          if (matches.length >= maxItems) break;
        }
        return { title: document.title, url: location.href, needle: target, exact, matches };
      }, [params.text || '', !!params.exact, params.maxItems || 25], params.tabId ?? null);
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
    case 'fullPageScreenshot': {
      const data = await withDebugger(params.tabId ?? null, async (resolvedTabId) => {
        await chrome.debugger.sendCommand(debuggerTarget(resolvedTabId), 'Page.enable');
        const shot = await chrome.debugger.sendCommand(debuggerTarget(resolvedTabId), 'Page.captureScreenshot', {
          format: 'png',
          fromSurface: true,
          captureBeyondViewport: true,
        });
        return {
          tab: serializeTab(await chrome.tabs.get(resolvedTabId)),
          format: 'png',
          dataUrl: `data:image/png;base64,${shot.data}`,
        };
      });
      return data;
    }
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
    case 'selectText':
      return await executeInTab((selector, textNeedle) => {
        const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim();
        let el = null;
        if (selector) {
          el = document.querySelector(selector);
        } else if (textNeedle) {
          const needle = norm(textNeedle).toLowerCase();
          el = Array.from(document.querySelectorAll('body *')).find((node) => {
            const text = norm(node.innerText || node.textContent || '');
            if (!text) return false;
            const style = window.getComputedStyle(node);
            const rect = node.getBoundingClientRect();
            return style.visibility !== 'hidden' &&
              style.display !== 'none' &&
              rect.width > 0 &&
              rect.height > 0 &&
              text.toLowerCase().includes(needle);
          }) || null;
        }
        if (!el) throw new Error('No matching element to select text from');
        const selection = window.getSelection();
        selection.removeAllRanges();
        const range = document.createRange();
        range.selectNodeContents(el);
        selection.addRange(range);
        const text = selection.toString();
        return { selected: true, textLength: text.length, text: text.slice(0, 500) };
      }, [params.selector || null, params.text || null], params.tabId ?? null);
    case 'copySelectedText': {
      const selected = await executeInTab(() => {
        const text = window.getSelection ? window.getSelection().toString() : '';
        return { text };
      }, [], params.tabId ?? null);
      await writeClipboardText(selected.text || '');
      return { copied: true, textLength: (selected.text || '').length, text: (selected.text || '').slice(0, 500) };
    }
    case 'getStorage':
      return await executeInTab((which) => {
        const fromStorage = (storage) => {
          const data = {};
          for (let i = 0; i < storage.length; i += 1) {
            const key = storage.key(i);
            data[key] = storage.getItem(key);
          }
          return data;
        };
        const mode = which === 'session' ? 'session' : which === 'all' ? 'all' : 'local';
        return {
          title: document.title,
          url: location.href,
          mode,
          localStorage: mode === 'session' ? undefined : fromStorage(window.localStorage),
          sessionStorage: mode === 'local' ? undefined : fromStorage(window.sessionStorage),
        };
      }, [params.storage || 'all'], params.tabId ?? null);
    case 'getCookies': {
      const url = params.url || await getPageUrl(params.tabId ?? null);
      const cookies = await chrome.cookies.getAll({ url });
      return { url, cookies };
    }
    case 'runScript':
      return await executeInTab((script) => {
        const serialize = (value) => {
          try {
            return JSON.parse(JSON.stringify(value));
          } catch {
            return String(value);
          }
        };
        const result = (0, eval)(script);
        return {
          ok: true,
          result: serialize(result),
        };
      }, [params.script || 'null'], params.tabId ?? null);
    case 'networkAttach':
      return await attachNetworkMonitor(params.tabId ?? null);
    case 'networkDetach':
      return await detachNetworkMonitor(params.tabId ?? null);
    case 'networkGetLog':
      return getNetworkSnapshot(params.tabId ?? null);
    case 'networkClearLog':
      return clearNetworkLog(params.tabId ?? null);
    default:
      throw new Error(`Unsupported action: ${command.action}`);
  }
}

chrome.debugger.onEvent.addListener(async (source, method, params) => {
  const tabId = source.tabId;
  if (tabId == null || networkState.attachedTabId !== tabId) return;
  const key = ensureTabBuckets(tabId);
  const requestMap = networkState.requestsByTab[key];

  if (method === 'Network.requestWillBeSent') {
    requestMap[params.requestId] = {
      requestId: params.requestId,
      url: params.request?.url,
      method: params.request?.method,
      type: params.type,
      startedAt: Date.now(),
      requestHeaders: params.request?.headers || {},
      requestBodyPreview: previewText(params.request?.postData),
    };
    appendNetworkEntry(tabId, {
      kind: 'request',
      requestId: params.requestId,
      method: params.request?.method,
      url: params.request?.url,
      type: params.type,
      requestBodyPreview: previewText(params.request?.postData),
    });
    return;
  }

  if (method === 'Network.responseReceived') {
    const entry = requestMap[params.requestId] || {};
    entry.status = params.response?.status;
    entry.statusText = params.response?.statusText;
    entry.mimeType = params.response?.mimeType;
    entry.responseHeaders = params.response?.headers || {};
    entry.responseUrl = params.response?.url;
    requestMap[params.requestId] = entry;
    appendNetworkEntry(tabId, {
      kind: 'response',
      requestId: params.requestId,
      status: params.response?.status,
      statusText: params.response?.statusText,
      mimeType: params.response?.mimeType,
      url: params.response?.url,
    });
    return;
  }

  if (method === 'Network.loadingFinished') {
    const entry = requestMap[params.requestId] || {};
    const durationMs = entry.startedAt ? Date.now() - entry.startedAt : null;
    let responseBodyPreview = '';
    try {
      const response = await chrome.debugger.sendCommand(debuggerTarget(tabId), 'Network.getResponseBody', {
        requestId: params.requestId,
      });
      if (response?.body) {
        const rawBody = response.base64Encoded ? atob(response.body) : response.body;
        responseBodyPreview = previewText(rawBody);
      }
    } catch {
      responseBodyPreview = '';
    }
    appendNetworkEntry(tabId, {
      kind: 'finished',
      requestId: params.requestId,
      method: entry.method,
      status: entry.status,
      url: entry.responseUrl || entry.url,
      mimeType: entry.mimeType,
      durationMs,
      requestBodyPreview: entry.requestBodyPreview || '',
      responseBodyPreview,
    });
    delete requestMap[params.requestId];
    return;
  }

  if (method === 'Network.loadingFailed') {
    const entry = requestMap[params.requestId] || {};
    appendNetworkEntry(tabId, {
      kind: 'failed',
      requestId: params.requestId,
      method: entry.method,
      url: entry.url,
      errorText: params.errorText,
      canceled: !!params.canceled,
    });
    delete requestMap[params.requestId];
  }
});

chrome.debugger.onDetach.addListener((source, reason) => {
  const tabId = source.tabId;
  if (tabId == null) return;
  if (networkState.attachedTabId === tabId) {
    appendNetworkEntry(tabId, { kind: 'system', message: `Network monitor detached: ${reason}` });
    networkState.attachedTabId = null;
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    if (message?.type === 'popup-get-state') {
      sendResponse({
        clientId: state.clientId,
        serverUrl: state.serverUrl,
        bridgeState: state,
        activeTab: await activeTab(),
        commandLog,
        network: getNetworkSnapshot(message.tabId ?? null),
      });
      return;
    }
    if (message?.type === 'popup-save-server-url') {
      const value = String(message.serverUrl || '').trim();
      state.serverUrl = value || DEFAULT_SERVER;
      await chrome.storage.local.set({ serverUrl: state.serverUrl });
      sendResponse({ ok: true, serverUrl: state.serverUrl });
      return;
    }
    if (message?.type === 'popup-network-attach') {
      sendResponse(await attachNetworkMonitor(message.tabId ?? null));
      return;
    }
    if (message?.type === 'popup-network-detach') {
      sendResponse(await detachNetworkMonitor(message.tabId ?? null));
      return;
    }
    if (message?.type === 'popup-network-clear') {
      sendResponse(clearNetworkLog(message.tabId ?? null));
      return;
    }
    if (message?.type === 'popup-run-command') {
      const result = await handleCommand({
        action: message.action,
        params: message.params || {},
      });
      sendResponse({ ok: true, result });
      return;
    }
    sendResponse({ ok: false, error: 'Unknown popup message' });
  })().catch((error) => {
    sendResponse({ ok: false, error: error.message || String(error) });
  });
  return true;
});

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
  await persistBridgeState();
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
          lastTab: await safeActiveTab(),
        });
      } catch (error) {
        try {
          await post('/api/result', {
            clientId: state.clientId,
            commandId: payload.command.commandId,
            ok: false,
            error: error.message || String(error),
            lastTab: await safeActiveTab(),
          });
        } catch (reportError) {
          state.lastError = reportError.message || String(reportError);
        }
      }
    }
  } catch (error) {
    state.connected = false;
    state.lastError = error.message;
  }
  await persistBridgeState();
}

async function loop() {
  await loadState();
  await heartbeat();
  setInterval(heartbeat, 5000);
  setInterval(pollOnce, 700);
}

loop().catch((error) => {
  state.connected = false;
  state.lastError = error.message || String(error);
  void persistBridgeState();
});
