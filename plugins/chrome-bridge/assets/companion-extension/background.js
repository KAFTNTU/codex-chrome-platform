const DEFAULT_SERVER = 'http://127.0.0.1:17373';
const HIGHLIGHT_ID = '__codex_chrome_bridge_highlight__';
const MAX_COMMAND_LOG = 60;
const MAX_NETWORK_LOG = 120;
const MAX_CONSOLE_LOG = 120;
const MAX_SESSION_MEMORY = 80;
const MAX_RESPONSE_BODY = 200000;
const HEARTBEAT_ALARM = 'bridge-heartbeat';
const POLL_ALARM = 'bridge-poll';
const NATIVE_HOST_NAME = 'com.codex.bridge';

let state = {
  connected: false,
  clientId: null,
  lastError: null,
  serverUrl: DEFAULT_SERVER,
  bridgeToken: '',
  accessProfile: 'controlled',
  mode: 'safe',
  mouseCueEnabled: true,
  workspaceGroupId: null,
  workspaceGroupTitle: 'Codex Agent Workspace',
  workspaceGroupColor: 'blue',
};
let nativeBridgePort = null;
let nativeBridgeReconnectTimer = null;
let nativeBridgeBackoffMs = 1000;
let stateLoaded = false;
let warmupInFlight = null;
let lastHeartbeatAt = 0;
let lastPollAt = 0;
let commandLog = [];
let networkState = {
  attachedTabId: null,
  logsByTab: {},
  requestsByTab: {},
  responseBodiesByTab: {},
};
let consoleState = {
  attachedTabId: null,
  logsByTab: {},
};
let sessionMemory = {
  byTab: {},
};
let macroState = {
  recording: false,
  name: null,
  actions: [],
  startedAt: null,
};
let namedRecipes = {};

async function loadState() {
  const stored = await chrome.storage.local.get(['clientId', 'serverUrl', 'bridgeToken', 'namedRecipes', 'mouseCueEnabled', 'workspaceGroupId', 'workspaceGroupTitle', 'workspaceGroupColor', 'accessProfile']);
  state.clientId = stored.clientId || crypto.randomUUID();
  state.serverUrl = stored.serverUrl || DEFAULT_SERVER;
  state.bridgeToken = stored.bridgeToken || '';
  state.accessProfile = stored.accessProfile || 'controlled';
  state.mouseCueEnabled = stored.mouseCueEnabled !== false;
  state.workspaceGroupId = Number.isFinite(Number(stored.workspaceGroupId)) ? Number(stored.workspaceGroupId) : null;
  state.workspaceGroupTitle = stored.workspaceGroupTitle || 'Codex Agent Workspace';
  state.workspaceGroupColor = stored.workspaceGroupColor || 'blue';
  namedRecipes = stored.namedRecipes || {};
  await chrome.storage.local.set({
    clientId: state.clientId,
    serverUrl: state.serverUrl,
    bridgeToken: state.bridgeToken,
    accessProfile: state.accessProfile,
    mouseCueEnabled: state.mouseCueEnabled,
    workspaceGroupId: state.workspaceGroupId,
    workspaceGroupTitle: state.workspaceGroupTitle,
    workspaceGroupColor: state.workspaceGroupColor,
  });
  stateLoaded = true;
}

async function ensureStateLoaded() {
  if (!stateLoaded) {
    await loadState();
  }
}

async function persistRecipes() {
  await chrome.storage.local.set({ namedRecipes });
}

async function persistBridgeState() {
  try {
    await chrome.storage.local.set({ bridgeState: state });
  } catch {
    // Ignore transient storage failures during service worker restarts.
  }
}

async function persistWorkspaceState() {
  try {
    await chrome.storage.local.set({
      workspaceGroupId: state.workspaceGroupId,
      workspaceGroupTitle: state.workspaceGroupTitle,
      workspaceGroupColor: state.workspaceGroupColor,
      accessProfile: state.accessProfile,
    });
  } catch {
    // Ignore transient storage failures.
  }
}

function scheduleNativeBridgeReconnect() {
  if (nativeBridgeReconnectTimer) return;
  nativeBridgeReconnectTimer = setTimeout(() => {
    nativeBridgeReconnectTimer = null;
    void connectNativeBridge().catch(() => {});
  }, nativeBridgeBackoffMs);
  nativeBridgeBackoffMs = Math.min(Math.max(1000, nativeBridgeBackoffMs * 2), 30000);
}

async function connectNativeBridge() {
  await ensureStateLoaded();
  if (nativeBridgePort) return nativeBridgePort;
  try {
    const port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
    nativeBridgePort = port;
    nativeBridgeBackoffMs = 1000;
    port.onMessage.addListener((message) => {
      if (message?.ok) {
        state.connected = true;
        state.lastError = null;
        void persistBridgeState();
      }
      if (message?.type === 'bootstrap-ack' && message?.bridgeStarted) {
        state.connected = true;
        state.lastError = null;
        void persistBridgeState();
      }
    });
    port.onDisconnect.addListener(() => {
      const error = chrome.runtime.lastError?.message || 'Native messaging host disconnected';
      nativeBridgePort = null;
      state.connected = false;
      state.lastError = error;
      void persistBridgeState();
      scheduleNativeBridgeReconnect();
    });
    port.postMessage({
      type: 'bootstrap',
      clientId: state.clientId,
      serverUrl: state.serverUrl,
      mode: state.mode,
      workspaceGroupId: state.workspaceGroupId,
    });
    return port;
  } catch (error) {
    nativeBridgePort = null;
    state.connected = false;
    state.lastError = error?.message || String(error);
    void persistBridgeState();
    scheduleNativeBridgeReconnect();
    return null;
  }
}

function normalizeTabGroupColor(color) {
  const allowed = new Set(['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange']);
  const value = String(color || '').trim().toLowerCase();
  return allowed.has(value) ? value : 'blue';
}

async function getValidatedWorkspaceGroup() {
  if (state.workspaceGroupId == null) return null;
  try {
    const group = await chrome.tabGroups.get(Number(state.workspaceGroupId));
    if (!group) return null;
    return group;
  } catch {
    state.workspaceGroupId = null;
    await persistWorkspaceState();
    return null;
  }
}

async function updateWorkspaceGroup(groupId, options = {}) {
  const title = String(options.title || state.workspaceGroupTitle || 'Codex Agent Workspace').trim() || 'Codex Agent Workspace';
  const color = normalizeTabGroupColor(options.color || state.workspaceGroupColor || 'blue');
  const collapsed = options.collapsed != null ? !!options.collapsed : false;
  const updated = await chrome.tabGroups.update(Number(groupId), { title, color, collapsed });
  state.workspaceGroupId = Number(groupId);
  state.workspaceGroupTitle = title;
  state.workspaceGroupColor = color;
  await persistWorkspaceState();
  return updated;
}

async function createWorkspaceGroupForTab(tabId, options = {}) {
  const groupId = await chrome.tabs.group({ tabIds: Number(tabId) });
  await updateWorkspaceGroup(groupId, options);
  return groupId;
}

async function ensureWorkspaceGroup(tabId, options = {}) {
  const existing = await getValidatedWorkspaceGroup();
  if (existing) return existing;
  if (tabId == null) return null;
  const groupId = await createWorkspaceGroupForTab(tabId, options);
  return await chrome.tabGroups.get(groupId);
}

function scheduleBridgeAlarms() {
  if (!chrome.alarms) return;
  chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: 1 });
  chrome.alarms.create(POLL_ALARM, { periodInMinutes: 1 });
}

async function warmBridge(force = false) {
  await ensureStateLoaded();
  const now = Date.now();
  if (force || now - lastHeartbeatAt > 25000) {
    await heartbeat();
  }
  if (force || now - lastPollAt > 1200) {
    await pollOnce();
  }
}

async function bootstrapBridge() {
  if (warmupInFlight) return warmupInFlight;
  warmupInFlight = (async () => {
    await ensureStateLoaded();
    await connectNativeBridge();
    await ensureOffscreenDocument();
    scheduleBridgeAlarms();
    await warmBridge(true);
    await syncAccessProfileToBridge();
  })().catch((error) => {
    state.connected = false;
    state.lastError = error.message || String(error);
    void persistBridgeState();
  }).finally(() => {
    warmupInFlight = null;
  });
  return warmupInFlight;
}

function pushCommandLog(entry) {
  commandLog = [{
    at: new Date().toISOString(),
    ...entry,
  }, ...commandLog].slice(0, MAX_COMMAND_LOG);
}

function recordSessionEvent(tabId, action, details = {}) {
  if (tabId == null) return;
  const key = String(tabId);
  sessionMemory.byTab[key] ||= [];
  sessionMemory.byTab[key] = [{
    at: new Date().toISOString(),
    action,
    ...details,
  }, ...sessionMemory.byTab[key]].slice(0, MAX_SESSION_MEMORY);
}

function getSessionMemory(tabId = null) {
  if (tabId != null) {
    return {
      tabId: Number(tabId),
      events: sessionMemory.byTab[String(tabId)] || [],
    };
  }
  return {
    tabs: Object.entries(sessionMemory.byTab).map(([key, events]) => ({
      tabId: Number(key),
      events,
    })),
  };
}

function clearSessionMemory(tabId = null) {
  if (tabId != null) {
    delete sessionMemory.byTab[String(tabId)];
    return { cleared: true, tabId: Number(tabId) };
  }
  sessionMemory.byTab = {};
  return { cleared: true, allTabs: true };
}

function debuggerTarget(tabId) {
  return { tabId: Number(tabId) };
}

function ensureTabBuckets(tabId) {
  const key = String(tabId);
  networkState.logsByTab[key] ||= [];
  networkState.requestsByTab[key] ||= {};
  networkState.responseBodiesByTab[key] ||= {};
  consoleState.logsByTab[key] ||= [];
  return key;
}

function appendConsoleEntry(tabId, entry) {
  const key = ensureTabBuckets(tabId);
  consoleState.logsByTab[key] = [{
    at: new Date().toISOString(),
    ...entry,
  }, ...consoleState.logsByTab[key]].slice(0, MAX_CONSOLE_LOG);
}

function getConsoleSnapshot(tabId = null) {
  const resolvedTabId = tabId != null ? Number(tabId) : consoleState.attachedTabId;
  const key = resolvedTabId != null ? String(resolvedTabId) : null;
  return {
    attachedTabId: consoleState.attachedTabId,
    tabId: resolvedTabId,
    logs: key ? (consoleState.logsByTab[key] || []) : [],
  };
}

function clearConsoleLog(tabId = null) {
  const resolvedTabId = tabId != null ? Number(tabId) : consoleState.attachedTabId;
  if (resolvedTabId == null) return { cleared: true, tabId: null };
  consoleState.logsByTab[String(resolvedTabId)] = [];
  return { cleared: true, tabId: resolvedTabId };
}

function normalizeResponseBody(body, base64Encoded, mimeType = '') {
  if (!body) {
    return { body: '', base64Encoded: !!base64Encoded, preview: '' };
  }
  const isTextLike = /json|javascript|xml|html|text|svg|x-www-form-urlencoded/i.test(mimeType || '');
  if (base64Encoded && !isTextLike) {
    return {
      body: String(body).slice(0, MAX_RESPONSE_BODY),
      base64Encoded: true,
      preview: '[binary]',
    };
  }
  try {
    const rawBody = base64Encoded ? atob(body) : body;
    return {
      body: String(rawBody).slice(0, MAX_RESPONSE_BODY),
      base64Encoded: false,
      preview: previewText(rawBody),
    };
  } catch {
    return {
      body: String(body).slice(0, MAX_RESPONSE_BODY),
      base64Encoded: !!base64Encoded,
      preview: previewText(body),
    };
  }
}

function getRecordedResponseBody(tabId, requestId) {
  const key = String(tabId);
  return networkState.responseBodiesByTab[key]?.[requestId] || null;
}

function shouldRecordMacroAction(action) {
  return !new Set([
    'startMacroRecording',
    'stopMacroRecording',
    'getMacroState',
    'saveRecipe',
    'listRecipes',
    'deleteRecipe',
    'runRecipe',
  ]).has(action);
}

function recordMacroAction(action, params) {
  if (!macroState.recording || !shouldRecordMacroAction(action)) return;
  macroState.actions.push({
    action,
    params: JSON.parse(JSON.stringify(params || {})),
  });
}

function getMacroState() {
  return {
    ...macroState,
    actionCount: macroState.actions.length,
  };
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
  await chrome.debugger.sendCommand(debuggerTarget(resolvedTabId), 'Runtime.enable');
  await chrome.debugger.sendCommand(debuggerTarget(resolvedTabId), 'Log.enable');
  ensureTabBuckets(resolvedTabId);
  networkState.attachedTabId = resolvedTabId;
  consoleState.attachedTabId = resolvedTabId;
  appendNetworkEntry(resolvedTabId, { kind: 'system', message: 'Network monitor attached' });
  appendConsoleEntry(resolvedTabId, { kind: 'system', level: 'info', text: 'Console monitor attached' });
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
  if (consoleState.attachedTabId === resolvedTabId) {
    appendConsoleEntry(resolvedTabId, { kind: 'system', level: 'info', text: 'Console monitor detached' });
    consoleState.attachedTabId = null;
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
  networkState.responseBodiesByTab[key] = {};
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
    headers: {
      'Content-Type': 'application/json',
      ...(state.bridgeToken ? { 'X-Bridge-Token': state.bridgeToken } : {}),
    },
    body: JSON.stringify({
      ...(payload || {}),
      ...(state.bridgeToken ? { token: state.bridgeToken } : {}),
    }),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function get(path) {
  const separator = path.includes('?') ? '&' : '?';
  const tokenParam = state.bridgeToken ? `${separator}token=${encodeURIComponent(state.bridgeToken)}` : '';
  const response = await fetch(state.serverUrl + path + tokenParam, {
    headers: state.bridgeToken ? { 'X-Bridge-Token': state.bridgeToken } : {},
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function getModeForAccessProfile(accessProfile) {
  return accessProfile === 'expanded' ? 'expanded' : 'safe';
}

async function syncAccessProfileToBridge() {
  try {
    const response = await post('/api/mode', { mode: getModeForAccessProfile(state.accessProfile) });
    state.mode = response.mode || state.mode;
    state.connected = true;
    state.lastError = null;
    await persistBridgeState();
    return { ok: true, mode: state.mode };
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
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

async function runAndRemember(action, func, args = [], tabId = null, detailBuilder = null) {
  const resolvedTabId = await resolveTargetTabId(tabId);
  const result = await executeInTab(func, args, resolvedTabId);
  try {
    const details = typeof detailBuilder === 'function' ? (detailBuilder(result) || {}) : {};
    recordSessionEvent(resolvedTabId, action, details);
  } catch {
    // Ignore memory builder failures.
  }
  return result;
}

async function waitForPageReady(tabId = null, timeoutMs = 15000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < Math.max(1000, Number(timeoutMs || 15000))) {
    const state = await executeInTab(() => {
      return {
        readyState: document.readyState,
        title: document.title || '',
        url: location.href,
      };
    }, [], tabId);
    if (state?.readyState === 'complete' || state?.readyState === 'interactive') {
      return {
        ok: true,
        elapsedMs: Date.now() - startedAt,
        readyState: state.readyState,
        title: state.title,
        url: state.url,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 160));
  }
  throw new Error('Timed out waiting for page ready state');
}

async function navigateAndWait(url, options = {}, tabId = null) {
  const resolvedTabId = await resolveTargetTabId(tabId);
  await chrome.tabs.update(resolvedTabId, { url });
  const ready = await waitForPageReady(resolvedTabId, options.timeoutMs || 15000);
  const titleNeedle = String(options.titleContains || '').trim().toLowerCase();
  const urlNeedle = String(options.urlContains || '').trim().toLowerCase();
  if (titleNeedle || urlNeedle) {
    const startedAt = Date.now();
    const timeoutMs = Math.max(1000, Number(options.timeoutMs || 15000));
    while (Date.now() - startedAt < timeoutMs) {
      const snap = await activeTab();
      const titleOk = !titleNeedle || (snap?.title || '').toLowerCase().includes(titleNeedle);
      const urlOk = !urlNeedle || (snap?.url || '').toLowerCase().includes(urlNeedle);
      if (titleOk && urlOk) {
        return { ok: true, tabId: resolvedTabId, url: snap.url, title: snap.title, ready };
      }
      await new Promise((resolve) => setTimeout(resolve, 180));
    }
    throw new Error(`Navigation finished but condition not met: title~"${options.titleContains || ''}" url~"${options.urlContains || ''}"`);
  }
  const tab = await chrome.tabs.get(resolvedTabId);
  return { ok: true, tabId: resolvedTabId, url: tab.url || url, title: tab.title || '', ready };
}

function resolveAtoModulePath(moduleKey) {
  const key = String(moduleKey || '').trim().toLowerCase();
  const map = {
    home: '/ATutor/bounce.php?course=1',
    file_storage: '/ATutor/mods/_standard/file_storage/index.php',
    files: '/ATutor/mods/_standard/file_storage/index.php',
    assignment_dropbox: '/ATutor/mods/_standard/assignment_dropbox/index.php',
    dropbox: '/ATutor/mods/_standard/assignment_dropbox/index.php',
    tests: '/ATutor/mods/_standard/tests/my_tests.php',
    glossary: '/ATutor/mods/_core/glossary/index.php',
    chat: '/ATutor/mods/_standard/chat/index.php',
    directory: '/ATutor/mods/_standard/directory/directory.php',
  };
  return map[key] || null;
}

async function openAtoModule(moduleKey, options = {}, tabId = null) {
  const current = await activeTab();
  const baseUrl = String(options.baseUrl || current?.url || '').trim();
  if (!baseUrl) throw new Error('Unable to resolve ATutor base URL');
  const modulePath = resolveAtoModulePath(moduleKey);
  if (!modulePath) throw new Error(`Unknown ATutor module key: ${moduleKey}`);
  const base = new URL(baseUrl);
  const finalUrl = `${base.protocol}//${base.host}${modulePath}`;
  const titleHint = options.titleContains || null;
  return await navigateAndWait(finalUrl, {
    timeoutMs: options.timeoutMs || 18000,
    titleContains: titleHint || null,
    urlContains: options.urlContains || modulePath,
  }, tabId);
}

async function openAtoTopicByTitle(title, options = {}, tabId = null) {
  const query = String(title || '').trim();
  if (!query) throw new Error('title is required');
  const resolvedTabId = await resolveTargetTabId(tabId);
  const scan = await executeInTab((needle) => {
    const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const target = norm(needle);
    const visible = (el) => {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const links = Array.from(document.querySelectorAll('a[href]')).filter(visible).map((el) => {
      const text = norm(el.textContent || el.innerText || '');
      if (!text) return null;
      let score = -1;
      if (text === target) score = 1000;
      else if (text.includes(target)) score = 700 - Math.max(0, text.length - target.length);
      else {
        const overlap = target.split(' ').filter((part) => part && text.includes(part)).length;
        if (overlap > 0) score = 200 + overlap;
      }
      if (score < 0) return null;
      return {
        href: el.href,
        text: text.slice(0, 220),
        score,
      };
    }).filter(Boolean).sort((a, b) => b.score - a.score);
    return {
      best: links[0] || null,
      alternatives: links.slice(1, 6),
      currentUrl: location.href,
      title: document.title,
    };
  }, [query], resolvedTabId);
  if (!scan?.best?.href) {
    throw new Error(`Topic not found by title: ${query}`);
  }
  const nav = await navigateAndWait(scan.best.href, {
    timeoutMs: options.timeoutMs || 18000,
    titleContains: options.titleContains || null,
  }, resolvedTabId);
  return { ok: true, query, chosen: scan.best, alternatives: scan.alternatives || [], navigation: nav };
}

async function ensureAtoContext(options = {}, tabId = null) {
  return await executeInTab((expectedCourse, expectedModule) => {
    const href = location.href;
    const title = document.title || '';
    const checks = [];
    if (expectedCourse) {
      const ok = href.toLowerCase().includes(String(expectedCourse).toLowerCase()) ||
        title.toLowerCase().includes(String(expectedCourse).toLowerCase());
      checks.push({ key: 'course', expected: expectedCourse, ok });
    }
    if (expectedModule) {
      const ok = href.toLowerCase().includes(String(expectedModule).toLowerCase()) ||
        title.toLowerCase().includes(String(expectedModule).toLowerCase());
      checks.push({ key: 'module', expected: expectedModule, ok });
    }
    return {
      ok: checks.every((x) => x.ok),
      url: href,
      title,
      checks,
    };
  }, [options.expectedCourse || null, options.expectedModule || null], tabId);
}

async function atoPrepareDropboxUpload(params = {}, tabId = null) {
  const files = Array.isArray(params.files) ? params.files : [];
  if (!files.length) throw new Error('files is required');
  const selector = params.fileSelector || 'input[type="file"]';
  const uploadResult = await setFileInputFiles(selector, files, tabId);
  const postCheck = await executeInTab(() => {
    const fileInput = document.querySelector('input[type="file"]');
    const selectedCount = fileInput?.files?.length || 0;
    const submitButtons = Array.from(document.querySelectorAll('button, input[type="submit"], [role="button"]'))
      .filter((el) => {
        const text = String(el.innerText || el.textContent || el.value || '').toLowerCase();
        return /відправ|submit|upload|завантаж/i.test(text);
      })
      .slice(0, 4)
      .map((el) => ({
        text: String(el.innerText || el.textContent || el.value || '').replace(/\s+/g, ' ').trim().slice(0, 120),
        tag: el.tagName.toLowerCase(),
      }));
    return { selectedCount, submitButtons };
  }, [], tabId);
  return {
    ok: true,
    upload: uploadResult,
    selectedCount: postCheck?.selectedCount || 0,
    submitButtons: postCheck?.submitButtons || [],
    readyForManualSubmit: (postCheck?.selectedCount || 0) > 0,
  };
}

async function readingScrollSession(params = {}, tabId = null) {
  const totalMinutes = Math.max(1, Number(params.minutes || 3));
  const stepY = Math.max(40, Number(params.stepY || 120));
  const delayMs = Math.max(200, Number(params.delayMs || 900));
  const upRatio = Math.min(0.6, Math.max(0, Number(params.upRatio || 0.22)));
  const totalMs = totalMinutes * 60 * 1000;
  const startedAt = Date.now();
  let downMoves = 0;
  let upMoves = 0;
  while (Date.now() - startedAt < totalMs) {
    const down = await executeInTab((step) => {
      const before = window.scrollY;
      window.scrollBy(0, step);
      const after = window.scrollY;
      const bottom = (window.innerHeight + Math.ceil(after)) >= Math.max(document.body?.scrollHeight || 0, document.documentElement?.scrollHeight || 0);
      return { before, after, moved: after - before, bottom };
    }, [stepY], tabId);
    downMoves += 1;
    if (down?.bottom) {
      await executeInTab((step) => window.scrollBy(0, -Math.max(80, Math.round(step * 3.2))), [stepY], tabId);
      upMoves += 1;
    } else if (Math.random() < upRatio) {
      await executeInTab((step) => window.scrollBy(0, -Math.max(50, Math.round(step * 1.5))), [stepY], tabId);
      upMoves += 1;
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return {
    ok: true,
    minutes: totalMinutes,
    elapsedMs: Date.now() - startedAt,
    downMoves,
    upMoves,
  };
}

async function showMouseCue(selector, tabId = null, label = 'Agent') {
  if (!state.mouseCueEnabled || !selector) return { shown: false, disabled: true };
  return await executeInTab((targetSelector, targetLabel) => {
    const el = document.querySelector(targetSelector);
    if (!el) return { shown: false, reason: `Selector not found: ${targetSelector}` };
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const id = '__codex_bridge_mouse_cue__';
    let cue = document.getElementById(id);
    if (!cue) {
      cue = document.createElement('div');
      cue.id = id;
      cue.style.position = 'fixed';
      cue.style.left = '0';
      cue.style.top = '0';
      cue.style.width = '20px';
      cue.style.height = '20px';
      cue.style.border = '2px solid rgba(255, 120, 120, 0.95)';
      cue.style.borderRadius = '999px';
      cue.style.background = 'rgba(255, 120, 120, 0.2)';
      cue.style.boxShadow = '0 0 0 6px rgba(255, 120, 120, 0.14)';
      cue.style.zIndex = '2147483647';
      cue.style.pointerEvents = 'none';
      cue.style.transition = 'transform 0.18s ease, opacity 0.22s ease';
      document.documentElement.appendChild(cue);
    }
    cue.style.opacity = '1';
    cue.style.transform = `translate(${Math.round(x - 10)}px, ${Math.round(y - 10)}px)`;
    cue.setAttribute('title', targetLabel || 'Agent');
    setTimeout(() => {
      const stillThere = document.getElementById(id);
      if (stillThere) stillThere.style.opacity = '0.35';
    }, 900);
    return { shown: true, selector: targetSelector, x: Math.round(x), y: Math.round(y) };
  }, [selector, label], tabId);
}

async function safeClickWithRetries(selector, options = {}, tabId = null) {
  return await executeInTab(async (targetSelector, opts) => {
    const queryAllDeep = (selectorQuery) => {
      const results = [];
      const roots = [document];
      while (roots.length) {
        const root = roots.shift();
        if (root.querySelectorAll) {
          results.push(...root.querySelectorAll(selectorQuery));
        }
        const nodes = root.querySelectorAll ? Array.from(root.querySelectorAll('*')) : [];
        for (const node of nodes) {
          if (node.shadowRoot) roots.push(node.shadowRoot);
        }
      }
      return results;
    };
    const visible = (el) => {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const maxAttempts = Math.max(1, Number(opts.maxAttempts || 3));
    const settleMs = Math.max(40, Number(opts.settleMs || 90));
    const allowForce = opts.allowForce === true;
    const preferHumanEvents = opts.preferHumanEvents !== false;

    const candidate = queryAllDeep(targetSelector)[0] || null;
    if (!candidate) throw new Error(`Selector not found: ${targetSelector}`);
    if (!visible(candidate)) throw new Error(`Element not visible: ${targetSelector}`);
    const clickOnce = (node, x, y) => {
      const eventInit = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: 1, view: window };
      if (preferHumanEvents) {
        node.dispatchEvent(new PointerEvent('pointerdown', eventInit));
        node.dispatchEvent(new MouseEvent('mousedown', eventInit));
        node.dispatchEvent(new PointerEvent('pointerup', eventInit));
        node.dispatchEvent(new MouseEvent('mouseup', eventInit));
      }
      node.dispatchEvent(new MouseEvent('click', eventInit));
    };

    const attempts = [];
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      candidate.scrollIntoView({ behavior: 'auto', block: 'center', inline: 'center' });
      await sleep(settleMs);
      const before = candidate.getBoundingClientRect();
      await sleep(40);
      const after = candidate.getBoundingClientRect();
      const stable = Math.abs(before.left - after.left) < 1 && Math.abs(before.top - after.top) < 1;
      const rect = after;
      const points = [
        [rect.left + rect.width / 2, rect.top + rect.height / 2],
        [rect.left + rect.width * 0.3, rect.top + rect.height * 0.5],
        [rect.left + rect.width * 0.7, rect.top + rect.height * 0.5],
        [rect.left + rect.width * 0.5, rect.top + rect.height * 0.3],
        [rect.left + rect.width * 0.5, rect.top + rect.height * 0.7],
      ];
      let chosen = null;
      for (const [x, y] of points) {
        const top = document.elementFromPoint(x, y);
        if (top && (candidate === top || candidate.contains(top))) {
          chosen = { x, y, top };
          break;
        }
      }
      if (!chosen && allowForce) {
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        chosen = { x, y, top: candidate };
      }
      if (!chosen) {
        attempts.push({ attempt, ok: false, stable, reason: 'covered_by_other_element' });
        continue;
      }
      candidate.focus?.();
      clickOnce(chosen.top || candidate, chosen.x, chosen.y);
      attempts.push({ attempt, ok: true, stable, x: Math.round(chosen.x), y: Math.round(chosen.y) });
      return {
        clicked: true,
        selector: targetSelector,
        attempts,
        usedAttempt: attempt,
      };
    }
    throw new Error(`safeClick failed after ${maxAttempts} attempts`);
  }, [selector, options], tabId);
}

async function executeStructuredDomActions(actions, tabId = null) {
  const resolvedTabId = await resolveTargetTabId(tabId);
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: resolvedTabId },
    world: 'MAIN',
    func: (items) => {
    const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const isVisible = (el) => {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    const queryAllDeep = (selector) => {
      const matches = [];
      const roots = [document];
      while (roots.length) {
        const root = roots.shift();
        if (root.querySelectorAll) {
          matches.push(...root.querySelectorAll(selector));
        }
        const nodes = root.querySelectorAll ? Array.from(root.querySelectorAll('*')) : [];
        for (const node of nodes) {
          if (node.shadowRoot) roots.push(node.shadowRoot);
        }
      }
      return matches;
    };
    const queryDeep = (selector) => queryAllDeep(selector)[0] || null;
    const findByText = (text, selector) => {
      const needle = norm(text).toLowerCase();
      if (!needle) return null;
      const nodes = queryAllDeep(selector || 'a, button, input, select, textarea, label, summary, [role="button"], [onclick], [contenteditable="true"], div, span');
      return nodes.find((node) => isVisible(node) && norm(node.innerText || node.textContent || node.value || '').toLowerCase().includes(needle)) || null;
    };
    const results = [];
    for (const item of items || []) {
      const action = item?.action || '';
      try {
        if (action === 'clearBlocklyWorkspace') {
          const ws = window.workspace || (window.Blockly && Blockly.getMainWorkspace && Blockly.getMainWorkspace());
          if (!ws) throw new Error('Blockly workspace not found');
          ws.clear();
          ws.render && ws.render();
          results.push({ action, ok: true });
          continue;
        }
        if (action === 'blocklyLoadXml') {
          const ws = window.workspace || (window.Blockly && Blockly.getMainWorkspace && Blockly.getMainWorkspace());
          if (!ws || !window.Blockly || !Blockly.Xml) throw new Error('Blockly XML API not available');
          ws.clear();
          const dom = Blockly.Xml.textToDom(String(item.xml || ''));
          Blockly.Xml.domToWorkspace(dom, ws);
          ws.cleanUp && ws.cleanUp();
          ws.render && ws.render();
          results.push({ action, ok: true, blockCount: ws.getAllBlocks(false).length });
          continue;
        }
        if (action === 'blocklyCreateChain') {
          const ws = window.workspace || (window.Blockly && Blockly.getMainWorkspace && Blockly.getMainWorkspace());
          if (!ws) throw new Error('Blockly workspace not found');
          let previous = null;
          let first = null;
          let y = Number(item.y || 60);
          for (const spec of item.blocks || []) {
            const block = ws.newBlock(spec.type);
            block.initSvg && block.initSvg();
            block.render && block.render();
            if (Array.isArray(spec.fields)) {
              for (const field of spec.fields) {
                if (field?.name && block.getField(field.name)) {
                  block.setFieldValue(String(field.value), field.name);
                }
              }
            }
            if (typeof block.moveBy === 'function') {
              block.moveBy(Number(item.x || 80), y);
              y += 96;
            }
            if (!first) first = block;
            if (previous?.nextConnection && block.previousConnection) {
              previous.nextConnection.connect(block.previousConnection);
            }
            previous = block;
          }
          ws.cleanUp && ws.cleanUp();
          ws.render && ws.render();
          results.push({ action, ok: true, blockCount: ws.getAllBlocks(false).length, firstType: first?.type || null });
          continue;
        }
        if (action === 'blocklyListCapabilities') {
          const ws = window.workspace || (window.Blockly && Blockly.getMainWorkspace && Blockly.getMainWorkspace());
          const blockTypes = Object.keys((window.Blockly && Blockly.Blocks) || {}).sort();
          results.push({
            action,
            ok: true,
            workspacePresent: !!ws,
            blockTypes,
          });
          continue;
        }
        if (action === 'blocklyExportXml') {
          const ws = window.workspace || (window.Blockly && Blockly.getMainWorkspace && Blockly.getMainWorkspace());
          if (!ws || !window.Blockly || !Blockly.Xml) throw new Error('Blockly XML API not available');
          const xmlDom = Blockly.Xml.workspaceToDom(ws);
          const xmlText = Blockly.Xml.domToText(xmlDom);
          results.push({ action, ok: true, xml: xmlText, blockCount: ws.getAllBlocks(false).length });
          continue;
        }
        if (action === 'blocklyInspectBlocks') {
          const ws = window.workspace || (window.Blockly && Blockly.getMainWorkspace && Blockly.getMainWorkspace());
          if (!ws) throw new Error('Blockly workspace not found');
          const blocks = ws.getAllBlocks(false).map((block) => ({
            id: block.id,
            type: block.type,
            fields: block.inputList.flatMap((input) => input.fieldRow.map((field) => ({
              name: field.name || null,
              value: field.getValue ? field.getValue() : null,
              text: field.getText ? field.getText() : null,
            }))).filter((field) => field.name),
            inputs: block.inputList.map((input) => ({
              name: input.name || null,
              type: input.type,
            })),
          }));
          results.push({ action, ok: true, blocks });
          continue;
        }
        if (action === 'blocklyMutateBlock') {
          const ws = window.workspace || (window.Blockly && Blockly.getMainWorkspace && Blockly.getMainWorkspace());
          if (!ws || !window.Blockly) throw new Error('Blockly workspace not found');
          const target = item.blockId
            ? ws.getBlockById(String(item.blockId))
            : ws.getAllBlocks(false).find((block) => block.type === item.blockType) || null;
          if (!target) throw new Error('Target block not found');
          if (typeof target.domToMutation !== 'function') throw new Error('Target block does not support mutations');
          const mutation = document.createElement('mutation');
          for (const [key, value] of Object.entries(item.mutation || {})) {
            mutation.setAttribute(key, String(value));
          }
          target.domToMutation(mutation);
          target.initSvg && target.initSvg();
          target.render && target.render();
          results.push({ action, ok: true, blockId: target.id, blockType: target.type });
          continue;
        }
        if (action === 'blocklySetField') {
          const ws = window.workspace || (window.Blockly && Blockly.getMainWorkspace && Blockly.getMainWorkspace());
          if (!ws) throw new Error('Blockly workspace not found');
          const target = item.blockId
            ? ws.getBlockById(String(item.blockId))
            : ws.getAllBlocks(false).find((block) => block.type === item.blockType) || null;
          if (!target) throw new Error('Target block not found');
          if (!target.getField(item.field)) throw new Error(`Field not found: ${item.field}`);
          target.setFieldValue(String(item.value ?? ''), item.field);
          target.render && target.render();
          results.push({ action, ok: true, blockId: target.id, field: item.field, value: item.value });
          continue;
        }
        if (action === 'blocklyAutoLayout') {
          const ws = window.workspace || (window.Blockly && Blockly.getMainWorkspace && Blockly.getMainWorkspace());
          if (!ws) throw new Error('Blockly workspace not found');
          ws.cleanUp && ws.cleanUp();
          ws.render && ws.render();
          results.push({ action, ok: true, blockCount: ws.getAllBlocks(false).length });
          continue;
        }
        if (action === 'blocklyUndo') {
          const ws = window.workspace || (window.Blockly && Blockly.getMainWorkspace && Blockly.getMainWorkspace());
          if (!ws || typeof ws.undo !== 'function') throw new Error('Blockly undo not available');
          ws.undo(false);
          ws.render && ws.render();
          results.push({ action, ok: true });
          continue;
        }
        if (action === 'blocklyRedo') {
          const ws = window.workspace || (window.Blockly && Blockly.getMainWorkspace && Blockly.getMainWorkspace());
          if (!ws || typeof ws.undo !== 'function') throw new Error('Blockly redo not available');
          ws.undo(true);
          ws.render && ws.render();
          results.push({ action, ok: true });
          continue;
        }
        if (action === 'clickSelector') {
          const el = queryDeep(item.selector);
          if (!el) throw new Error(`Selector not found: ${item.selector}`);
          el.click();
          results.push({ action, ok: true, selector: item.selector });
          continue;
        }
        if (action === 'clickText') {
          const el = findByText(item.text, item.selector);
          if (!el) throw new Error(`Text match not found: ${item.text}`);
          el.click();
          results.push({ action, ok: true, text: item.text });
          continue;
        }
        if (action === 'typeSelector') {
          const el = queryDeep(item.selector);
          if (!el) throw new Error(`Selector not found: ${item.selector}`);
          el.focus();
          if ('value' in el) {
            el.value = String(item.text || '');
          } else if (el.isContentEditable) {
            el.textContent = String(item.text || '');
          } else {
            throw new Error('Element is not typable');
          }
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          results.push({ action, ok: true, selector: item.selector, textLength: String(item.text || '').length });
          continue;
        }
        if (action === 'setTextContent') {
          const el = queryDeep(item.selector);
          if (!el) throw new Error(`Selector not found: ${item.selector}`);
          el.textContent = String(item.text || '');
          results.push({ action, ok: true, selector: item.selector });
          continue;
        }
        if (action === 'setAttribute') {
          const el = queryDeep(item.selector);
          if (!el) throw new Error(`Selector not found: ${item.selector}`);
          el.setAttribute(String(item.name || ''), String(item.value || ''));
          results.push({ action, ok: true, selector: item.selector, name: item.name });
          continue;
        }
        if (action === 'focusSelector') {
          const el = queryDeep(item.selector);
          if (!el) throw new Error(`Selector not found: ${item.selector}`);
          el.focus();
          results.push({ action, ok: true, selector: item.selector });
          continue;
        }
        if (action === 'note') {
          const noteId = item.id || '__codex_note';
          let note = document.getElementById(noteId);
          if (!note) {
            note = document.createElement('div');
            note.id = noteId;
            note.style.position = 'fixed';
            note.style.right = '14px';
            note.style.bottom = '14px';
            note.style.zIndex = '999999';
            note.style.background = 'rgba(37,99,235,.95)';
            note.style.color = 'white';
            note.style.padding = '10px 14px';
            note.style.borderRadius = '12px';
            note.style.font = '700 13px Segoe UI, sans-serif';
            note.style.boxShadow = '0 10px 28px rgba(0,0,0,.35)';
            document.body.appendChild(note);
          }
          note.textContent = String(item.text || '');
          results.push({ action, ok: true, id: noteId });
          continue;
        }
        throw new Error(`Unsupported dom action: ${action}`);
      } catch (error) {
        results.push({ action, ok: false, error: error.message || String(error) });
      }
    }
    return { ok: results.every((entry) => entry.ok), results };
    },
    args: [actions || []],
  });
  recordSessionEvent(resolvedTabId, 'domActions', {
    actionCount: result?.results?.length || 0,
  });
  return result;
}

async function listTabs(currentWindowOnly = false) {
  const tabs = await queryTabs(currentWindowOnly ? { currentWindow: true } : {});
  return tabs.map(serializeTab);
}

async function recentTabs(maxItems = 20) {
  const tabs = await queryTabs({});
  return tabs
    .sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))
    .slice(0, maxItems)
    .map((tab) => ({
      ...serializeTab(tab),
      lastAccessed: tab.lastAccessed || null,
    }));
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

async function createCodexTabGroup(url = 'about:blank', options = {}) {
  const tab = await chrome.tabs.create({ url, active: options.active !== false });
  const groupId = await createWorkspaceGroupForTab(tab.id, options);
  return {
    tab: serializeTab(tab),
    groupId,
    workspace: {
      groupId,
      title: state.workspaceGroupTitle,
      color: state.workspaceGroupColor,
    },
  };
}

async function openInCodexWorkspace(url = 'about:blank', options = {}) {
  const tab = await chrome.tabs.create({ url, active: options.active !== false });
  const groupOptions = {
    title: options.title || state.workspaceGroupTitle || 'Codex Agent Workspace',
    color: options.color || state.workspaceGroupColor || 'blue',
    collapsed: options.collapsed,
  };
  const existingGroup = await getValidatedWorkspaceGroup();
  if (existingGroup && state.workspaceGroupId != null) {
    await chrome.tabs.group({ groupId: Number(state.workspaceGroupId), tabIds: tab.id });
    await updateWorkspaceGroup(Number(state.workspaceGroupId), groupOptions);
  } else {
    await createWorkspaceGroupForTab(tab.id, groupOptions);
  }
  return {
    tab: serializeTab(tab),
    workspace: {
      groupId: state.workspaceGroupId,
      title: state.workspaceGroupTitle,
      color: state.workspaceGroupColor,
      collapsed: !!existingGroup?.collapsed,
    },
  };
}

async function getTabWorkspaceState() {
  const group = await getValidatedWorkspaceGroup();
  if (!group) {
    return {
      ok: true,
      workspace: null,
    };
  }
  const tabs = await chrome.tabs.query({ groupId: Number(state.workspaceGroupId) });
  return {
    ok: true,
    workspace: {
      groupId: Number(state.workspaceGroupId),
      title: group.title || state.workspaceGroupTitle,
      color: group.color || state.workspaceGroupColor,
      collapsed: !!group.collapsed,
      tabCount: tabs.length,
      tabs: tabs.map(serializeTab),
    },
  };
}

async function addActiveTabToWorkspace(tabId = null, options = {}) {
  const resolvedTabId = await resolveTargetTabId(tabId);
  const groupOptions = {
    title: options.title || state.workspaceGroupTitle || 'Codex Agent Workspace',
    color: options.color || state.workspaceGroupColor || 'blue',
    collapsed: options.collapsed,
  };
  const group = await ensureWorkspaceGroup(resolvedTabId, groupOptions);
  if (group && state.workspaceGroupId != null) {
    await chrome.tabs.group({ groupId: Number(state.workspaceGroupId), tabIds: resolvedTabId });
    await updateWorkspaceGroup(Number(state.workspaceGroupId), groupOptions);
  }
  return {
    ok: true,
    tabId: resolvedTabId,
    workspace: {
      groupId: state.workspaceGroupId,
      title: state.workspaceGroupTitle,
      color: state.workspaceGroupColor,
    },
  };
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

function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

async function captureElementScreenshot(selector, tabId = null, padding = 10) {
  const resolvedTabId = await resolveTargetTabId(tabId);
  const elementInfo = await chrome.scripting.executeScript({
    target: { tabId: resolvedTabId },
    world: 'MAIN',
    func: (inputSelector, extraPadding) => {
      const queryDeep = (selector) => {
        const roots = [document];
        while (roots.length) {
          const root = roots.shift();
          const found = root.querySelector?.(selector);
          if (found) return found;
          const nodes = root.querySelectorAll ? Array.from(root.querySelectorAll('*')) : [];
          for (const node of nodes) {
            if (node.shadowRoot) roots.push(node.shadowRoot);
          }
        }
        return null;
      };
      const el = queryDeep(inputSelector);
      if (!el) throw new Error(`Selector not found: ${inputSelector}`);
      el.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });
      const rect = el.getBoundingClientRect();
      return {
        title: document.title,
        url: location.href,
        devicePixelRatio: window.devicePixelRatio || 1,
        rect: {
          left: Math.max(0, rect.left - extraPadding),
          top: Math.max(0, rect.top - extraPadding),
          width: rect.width + extraPadding * 2,
          height: rect.height + extraPadding * 2,
        },
      };
    },
    args: [selector, Math.max(0, Number(padding || 0))],
  });
  const meta = elementInfo?.[0]?.result;
  if (!meta?.rect) throw new Error('Could not measure element for screenshot');
  const shot = await captureScreenshot(resolvedTabId);
  const response = await fetch(shot.dataUrl);
  const blob = await response.blob();
  const bitmap = await createImageBitmap(blob);
  const scale = meta.devicePixelRatio || 1;
  const srcX = Math.max(0, Math.round(meta.rect.left * scale));
  const srcY = Math.max(0, Math.round(meta.rect.top * scale));
  const srcW = Math.max(1, Math.min(bitmap.width - srcX, Math.round(meta.rect.width * scale)));
  const srcH = Math.max(1, Math.min(bitmap.height - srcY, Math.round(meta.rect.height * scale)));
  const canvas = new OffscreenCanvas(srcW, srcH);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, srcX, srcY, srcW, srcH, 0, 0, srcW, srcH);
  const outBlob = await canvas.convertToBlob({ type: 'image/png' });
  const outBuffer = await outBlob.arrayBuffer();
  return {
    tab: shot.tab,
    title: meta.title,
    url: meta.url,
    selector,
    format: 'png',
    width: srcW,
    height: srcH,
    dataUrl: `data:image/png;base64,${arrayBufferToBase64(outBuffer)}`,
  };
}

async function setFileInputFiles(selector, files, tabId = null) {
  const resolvedTabId = await resolveTargetTabId(tabId);
  const marker = `codex-file-target-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const marked = await chrome.scripting.executeScript({
    target: { tabId: resolvedTabId },
    world: 'MAIN',
    func: (inputSelector, markerName) => {
      const queryDeep = (selector) => {
        const roots = [document];
        while (roots.length) {
          const root = roots.shift();
          const found = root.querySelector?.(selector);
          if (found) return found;
          const nodes = root.querySelectorAll ? Array.from(root.querySelectorAll('*')) : [];
          for (const node of nodes) {
            if (node.shadowRoot) roots.push(node.shadowRoot);
          }
        }
        return null;
      };
      const el = queryDeep(inputSelector);
      if (!el) throw new Error(`Selector not found: ${inputSelector}`);
      if (!(el instanceof HTMLInputElement) || el.type !== 'file') {
        throw new Error('Target is not an input[type="file"]');
      }
      el.setAttribute('data-codex-file-target', markerName);
      return { marked: true };
    },
    args: [selector, marker],
  });
  if (!marked?.[0]?.result?.marked) throw new Error('Failed to mark file input');
  return await withDebugger(resolvedTabId, async (debugTabId) => {
    await chrome.debugger.sendCommand(debuggerTarget(debugTabId), 'DOM.enable');
    const root = await chrome.debugger.sendCommand(debuggerTarget(debugTabId), 'DOM.getDocument', { depth: -1, pierce: true });
    const node = await chrome.debugger.sendCommand(debuggerTarget(debugTabId), 'DOM.querySelector', {
      nodeId: root.root.nodeId,
      selector: `[data-codex-file-target="${marker}"]`,
    });
    if (!node?.nodeId) throw new Error('Could not resolve file input in DOM');
    await chrome.debugger.sendCommand(debuggerTarget(debugTabId), 'DOM.setFileInputFiles', {
      nodeId: node.nodeId,
      files: (files || []).map((file) => String(file)),
    });
    await chrome.scripting.executeScript({
      target: { tabId: debugTabId },
      world: 'MAIN',
      func: (markerName) => {
        const el = document.querySelector(`[data-codex-file-target="${markerName}"]`);
        if (!el) return;
        el.removeAttribute('data-codex-file-target');
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      },
      args: [marker],
    });
    return { ok: true, selector, fileCount: (files || []).length };
  });
}

async function inspectCanvas(maxItems = 5, includeDataUrl = false, tabId = null) {
  return await chrome.scripting.executeScript({
    target: { tabId: await resolveTargetTabId(tabId) },
    world: 'MAIN',
    func: (limit, withData) => {
      const canvases = [];
      const roots = [document];
      while (roots.length) {
        const root = roots.shift();
        const nodes = root.querySelectorAll ? Array.from(root.querySelectorAll('*')) : [];
        for (const node of nodes) {
          if (node instanceof HTMLCanvasElement) canvases.push(node);
          if (node.shadowRoot) roots.push(node.shadowRoot);
        }
      }
      return {
        title: document.title,
        url: location.href,
        canvases: canvases.slice(0, limit).map((canvas, index) => {
          const rect = canvas.getBoundingClientRect();
          return {
            index,
            width: canvas.width,
            height: canvas.height,
            clientWidth: Math.round(rect.width),
            clientHeight: Math.round(rect.height),
            left: Math.round(rect.left),
            top: Math.round(rect.top),
            dataUrl: withData ? canvas.toDataURL('image/png') : undefined,
          };
        }),
      };
    },
    args: [Math.max(1, Number(maxItems || 5)), !!includeDataUrl],
  }).then((items) => items?.[0]?.result);
}

async function handleCommand(command) {
  const params = command.params || {};
  pushCommandLog({
    action: command.action,
    paramsPreview: previewText(JSON.stringify(params)),
  });
  recordMacroAction(command.action, params);
  switch (command.action) {
    case 'getActiveTab':
      return await activeTab();
    case 'listTabs':
      return { tabs: await listTabs(!!params.currentWindowOnly) };
    case 'switchTab':
      return await switchTab(params.tabId);
    case 'openNewTab':
      return await openNewTab(params.url || 'about:blank', params.active !== false);
    case 'createCodexTabGroup':
      return await createCodexTabGroup(params.url || 'about:blank', params);
    case 'openInCodexWorkspace':
      return await openInCodexWorkspace(params.url || 'about:blank', params);
    case 'getTabWorkspaceState':
      return await getTabWorkspaceState();
    case 'addActiveTabToWorkspace':
      return await addActiveTabToWorkspace(params.tabId ?? null, params);
    case 'closeTab':
      return await closeTab(params.tabId ?? null);
    case 'navigate': {
      const resolvedTabId = await resolveTargetTabId(params.tabId ?? null);
      await chrome.tabs.update(resolvedTabId, { url: params.url });
      return { ok: true, tabId: resolvedTabId, url: params.url };
    }
    case 'navigateAndWait':
      return await navigateAndWait(params.url, {
        timeoutMs: params.timeoutMs || 15000,
        titleContains: params.titleContains || null,
        urlContains: params.urlContains || null,
      }, params.tabId ?? null);
    case 'waitForPageReady':
      return await waitForPageReady(params.tabId ?? null, params.timeoutMs || 15000);
    case 'openAtoModule':
      return await openAtoModule(params.moduleKey || params.module || '', {
        timeoutMs: params.timeoutMs || 18000,
        titleContains: params.titleContains || null,
        urlContains: params.urlContains || null,
        baseUrl: params.baseUrl || null,
      }, params.tabId ?? null);
    case 'openAtoTopicByTitle':
      return await openAtoTopicByTitle(params.title || params.text || '', {
        timeoutMs: params.timeoutMs || 18000,
        titleContains: params.titleContains || null,
      }, params.tabId ?? null);
    case 'ensureAtoContext':
      return await ensureAtoContext({
        expectedCourse: params.expectedCourse || null,
        expectedModule: params.expectedModule || null,
      }, params.tabId ?? null);
    case 'readingScrollSession':
      return await readingScrollSession({
        minutes: params.minutes || 3,
        stepY: params.stepY || 120,
        delayMs: params.delayMs || 900,
        upRatio: params.upRatio ?? 0.22,
      }, params.tabId ?? null);
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
    case 'smoothScroll':
      return await runAndRemember('smoothScroll', async (totalY, stepY, delayMs) => {
        const target = Number(totalY || 0);
        const step = Math.max(20, Math.abs(stepY || 140));
        const direction = target >= 0 ? 1 : -1;
        let moved = 0;
        while (Math.abs(moved) < Math.abs(target)) {
          const remaining = Math.abs(target) - Math.abs(moved);
          const chunk = Math.min(step, remaining) * direction;
          window.scrollBy(0, chunk);
          moved += chunk;
          await new Promise((resolve) => setTimeout(resolve, Math.max(10, delayMs || 35)));
        }
        return { ok: true, movedY: moved, scrollX: window.scrollX, scrollY: window.scrollY };
      }, [params.totalY || 0, params.stepY || 140, params.delayMs || 35], params.tabId ?? null, (result) => ({
        movedY: result?.movedY || 0,
      }));
    case 'infiniteScroll':
      return await runAndRemember('infiniteScroll', async (maxPasses, stepY, delayMs, stablePasses) => {
        const passes = Math.max(1, maxPasses || 8);
        let stable = 0;
        let lastHeight = document.body?.scrollHeight || 0;
        const snapshots = [];
        for (let i = 0; i < passes; i += 1) {
          window.scrollBy(0, stepY || window.innerHeight);
          await new Promise((resolve) => setTimeout(resolve, Math.max(80, delayMs || 350)));
          const height = document.body?.scrollHeight || 0;
          const itemCount = document.querySelectorAll('a, article, li, .card, .item, [data-testid]').length;
          snapshots.push({ pass: i + 1, scrollHeight: height, itemCount });
          if (height === lastHeight) {
            stable += 1;
          } else {
            stable = 0;
            lastHeight = height;
          }
          if (stable >= Math.max(1, stablePasses || 2)) break;
        }
        return {
          ok: true,
          passesRun: snapshots.length,
          snapshots,
          finalScrollHeight: lastHeight,
          finalY: window.scrollY,
        };
      }, [params.maxPasses || 8, params.stepY || 0, params.delayMs || 350, params.stablePasses || 2], params.tabId ?? null, (result) => ({
        passesRun: result?.passesRun || 0,
      }));
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
    case 'clickByText':
      return await runAndRemember('clickByText', (needle, exact, selector, showCue) => {
        const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim();
        const target = norm(needle);
        if (!target) throw new Error('text is required');
        const isVisible = (el) => {
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.visibility !== 'hidden' &&
            style.display !== 'none' &&
            rect.width > 0 &&
            rect.height > 0;
        };
        const elements = Array.from(document.querySelectorAll(selector || 'a, button, input, select, textarea, label, summary, [role="button"], [onclick], [contenteditable="true"]'));
        const candidate = elements.find((el) => {
          if (!isVisible(el)) return false;
          const text = norm(el.innerText || el.textContent || el.value || '');
          if (!text) return false;
          return exact ? text === target : text.toLowerCase().includes(target.toLowerCase());
        });
        if (!candidate) throw new Error(`No visible element found for text: ${target}`);
        candidate.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
        if (showCue) {
          const rect = candidate.getBoundingClientRect();
          const id = '__codex_bridge_mouse_cue__';
          let cue = document.getElementById(id);
          if (!cue) {
            cue = document.createElement('div');
            cue.id = id;
            cue.style.position = 'fixed';
            cue.style.left = '0';
            cue.style.top = '0';
            cue.style.width = '20px';
            cue.style.height = '20px';
            cue.style.border = '2px solid rgba(255, 120, 120, 0.95)';
            cue.style.borderRadius = '999px';
            cue.style.background = 'rgba(255, 120, 120, 0.2)';
            cue.style.boxShadow = '0 0 0 6px rgba(255, 120, 120, 0.14)';
            cue.style.zIndex = '2147483647';
            cue.style.pointerEvents = 'none';
            cue.style.transition = 'transform 0.18s ease, opacity 0.22s ease';
            document.documentElement.appendChild(cue);
          }
          cue.style.opacity = '1';
          cue.style.transform = `translate(${Math.round(rect.left + rect.width / 2 - 10)}px, ${Math.round(rect.top + rect.height / 2 - 10)}px)`;
          setTimeout(() => {
            const stillThere = document.getElementById(id);
            if (stillThere) stillThere.style.opacity = '0.35';
          }, 900);
        }
        candidate.click();
        return {
          clicked: true,
          text: target,
          exact: !!exact,
          tag: candidate.tagName.toLowerCase(),
          matchedText: norm(candidate.innerText || candidate.textContent || candidate.value || '').slice(0, 200),
        };
      }, [params.text || '', !!params.exact, params.selector || null, state.mouseCueEnabled], params.tabId ?? null, (result) => ({
        text: result?.matchedText || params.text || '',
      }));
    case 'clickNearestMatch':
      return await runAndRemember('clickNearestMatch', (needle, selector, maxItems) => {
        const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim();
        const target = norm(needle).toLowerCase();
        if (!target) throw new Error('text is required');
        const isVisible = (el) => {
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.visibility !== 'hidden' &&
            style.display !== 'none' &&
            rect.width > 0 &&
            rect.height > 0;
        };
        const scoreText = (text) => {
          const candidate = norm(text).toLowerCase();
          if (!candidate) return -1;
          if (candidate === target) return 1000;
          if (candidate.startsWith(target)) return 800 - Math.max(0, candidate.length - target.length);
          if (candidate.includes(target)) return 600 - Math.abs(candidate.length - target.length);
          const overlap = target.split(' ').filter((part) => part && candidate.includes(part)).length;
          return overlap > 0 ? 200 + overlap : -1;
        };
        const elements = Array.from(document.querySelectorAll(selector || 'a, button, input, select, textarea, label, summary, [role="button"], [onclick], [contenteditable="true"]'))
          .filter(isVisible)
          .map((el) => {
            const text = norm(el.innerText || el.textContent || el.value || '');
            return { el, text, score: scoreText(text) };
          })
          .filter((item) => item.score >= 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, Math.max(1, maxItems || 5));
        const best = elements[0];
        if (!best) throw new Error(`No visible element found for text: ${needle}`);
        best.el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
        const rect = best.el.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        const top = document.elementFromPoint(x, y);
        const targetNode = top && (best.el === top || best.el.contains(top)) ? top : best.el;
        const eventInit = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: 1, view: window };
        targetNode.dispatchEvent(new PointerEvent('pointerdown', eventInit));
        targetNode.dispatchEvent(new MouseEvent('mousedown', eventInit));
        targetNode.dispatchEvent(new PointerEvent('pointerup', eventInit));
        targetNode.dispatchEvent(new MouseEvent('mouseup', eventInit));
        targetNode.dispatchEvent(new MouseEvent('click', eventInit));
        return {
          clicked: true,
          matchedText: best.text,
          score: best.score,
          alternatives: elements.slice(1).map((item) => ({ text: item.text.slice(0, 120), score: item.score })),
        };
      }, [params.text || '', params.selector || null, params.maxItems || 5], params.tabId ?? null, (result) => ({
        text: result?.matchedText || params.text || '',
        score: result?.score || null,
      }));
    case 'listFrames':
      return await executeInTab(() => {
        const frames = Array.from(document.querySelectorAll('iframe, frame')).map((frame, index) => ({
          index,
          tag: frame.tagName.toLowerCase(),
          id: frame.id || null,
          name: frame.getAttribute('name'),
          src: frame.getAttribute('src'),
          title: frame.getAttribute('title'),
        }));
        return { title: document.title, url: location.href, frames };
      }, [], params.tabId ?? null);
    case 'getForms':
      return await executeInTab((maxForms) => {
        const forms = Array.from(document.forms)
          .slice(0, maxForms)
          .map((form, index) => ({
            index,
            id: form.id || null,
            name: form.getAttribute('name'),
            action: form.getAttribute('action'),
            method: form.getAttribute('method') || 'get',
            fields: Array.from(form.elements).slice(0, 40).map((field) => ({
              tag: field.tagName.toLowerCase(),
              type: field.getAttribute('type'),
              name: field.getAttribute('name'),
              id: field.id || null,
              placeholder: field.getAttribute('placeholder'),
              valuePreview: String(field.value || '').slice(0, 120),
            })),
          }));
        return { title: document.title, url: location.href, forms };
      }, [params.maxForms || 20], params.tabId ?? null);
    case 'inspectUploadField':
      return await executeInTab((selector) => {
        const targetSelector = selector || 'input[type="file"]';
        const list = Array.from(document.querySelectorAll(targetSelector));
        const visible = (el) => {
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
        };
        const first = list[0] || null;
        const chosen = list.find(visible) || first;
        if (!chosen) {
          return { found: false, selector: targetSelector, totalMatches: 0, visibleMatches: 0 };
        }
        const rect = chosen.getBoundingClientRect();
        return {
          found: true,
          selector: targetSelector,
          totalMatches: list.length,
          visibleMatches: list.filter(visible).length,
          tag: chosen.tagName.toLowerCase(),
          id: chosen.id || null,
          name: chosen.getAttribute('name') || null,
          accept: chosen.getAttribute('accept') || null,
          multiple: !!chosen.multiple,
          disabled: !!chosen.disabled,
          x: Math.round(rect.left),
          y: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        };
      }, [params.selector || null], params.tabId ?? null);
    case 'fillFields':
      return await executeInTab((entries) => {
        const results = [];
        for (const entry of entries) {
          const selector = entry.selector || null;
          const text = entry.value ?? '';
          const checked = entry.checked;
          const el = selector ? document.querySelector(selector) : null;
          if (!el) {
            results.push({ selector, ok: false, error: 'Selector not found' });
            continue;
          }
          try {
            if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio') && typeof checked === 'boolean') {
              el.checked = checked;
            } else if (el instanceof HTMLSelectElement && entry.selectValue != null) {
              el.value = entry.selectValue;
            } else if ('value' in el) {
              el.value = text;
            } else if (el.isContentEditable) {
              el.textContent = text;
            } else {
              throw new Error('Element is not fillable');
            }
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            results.push({ selector, ok: true });
          } catch (error) {
            results.push({ selector, ok: false, error: error.message || String(error) });
          }
        }
        return { filled: results };
      }, [params.entries || []], params.tabId ?? null);
    case 'fillLoginForm':
      return await runAndRemember('fillLoginForm', (username, password, autoSubmit) => {
        const norm = (value) => String(value || '').toLowerCase();
        const bySelector = (selector) => document.querySelector(selector);
        const visible = (el) => {
          if (!el) return false;
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
        };
        const candidates = Array.from(document.querySelectorAll('input, textarea')).filter(visible);
        const findUser = () => {
          const direct = bySelector('input[type="email"], input[name*="user" i], input[name*="login" i], input[id*="user" i], input[id*="login" i]');
          if (direct && visible(direct)) return direct;
          return candidates.find((el) => {
            const t = norm(el.type);
            if (!['text', 'email', 'tel', 'search'].includes(t) && t !== '') return false;
            const hint = `${el.name || ''} ${el.id || ''} ${el.placeholder || ''} ${el.getAttribute('aria-label') || ''}`;
            return /user|login|email|ім.?я|логін|пошта/i.test(hint);
          }) || candidates.find((el) => ['text', 'email', 'tel', 'search', ''].includes(norm(el.type))) || null;
        };
        const findPass = () => {
          const direct = bySelector('input[type="password"]');
          if (direct && visible(direct)) return direct;
          return candidates.find((el) => /pass|парол/i.test(`${el.name || ''} ${el.id || ''} ${el.placeholder || ''}`)) || null;
        };
        const userEl = findUser();
        const passEl = findPass();
        if (!userEl) throw new Error('Username field not found');
        if (!passEl) throw new Error('Password field not found');
        userEl.focus();
        userEl.value = String(username ?? '');
        userEl.dispatchEvent(new Event('input', { bubbles: true }));
        userEl.dispatchEvent(new Event('change', { bubbles: true }));
        passEl.focus();
        passEl.value = String(password ?? '');
        passEl.dispatchEvent(new Event('input', { bubbles: true }));
        passEl.dispatchEvent(new Event('change', { bubbles: true }));
        let submitted = false;
        if (autoSubmit) {
          const form = passEl.form || userEl.form || null;
          const submitBtn = form
            ? form.querySelector('button[type="submit"], input[type="submit"], button:not([type]), [role="button"]')
            : document.querySelector('button[type="submit"], input[type="submit"]');
          if (submitBtn && visible(submitBtn)) {
            submitBtn.click();
            submitted = true;
          } else if (form) {
            form.requestSubmit ? form.requestSubmit() : form.submit();
            submitted = true;
          }
        }
        return {
          ok: true,
          filled: true,
          submitted,
          userSelector: `${userEl.tagName.toLowerCase()}#${userEl.id || ''}.${userEl.className || ''}`.replace(/\.$/, ''),
          passSelector: `${passEl.tagName.toLowerCase()}#${passEl.id || ''}.${passEl.className || ''}`.replace(/\.$/, ''),
        };
      }, [params.username ?? '', params.password ?? '', !!params.autoSubmit], params.tabId ?? null, () => ({
        autoSubmit: !!params.autoSubmit,
      }));
    case 'submitForm':
      return await runAndRemember('submitForm', (selector) => {
        const visible = (el) => {
          if (!el) return false;
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
        };
        let target = null;
        if (selector) {
          target = document.querySelector(selector);
        } else {
          target = document.querySelector('button[type="submit"], input[type="submit"], form button:not([type])');
        }
        if (target && visible(target)) {
          target.click();
          return { submitted: true, method: 'click', selector: selector || null };
        }
        const active = document.activeElement;
        const form = active?.form || document.querySelector('form');
        if (form) {
          form.requestSubmit ? form.requestSubmit() : form.submit();
          return { submitted: true, method: 'formSubmit' };
        }
        throw new Error('No submit target found');
      }, [params.selector || null], params.tabId ?? null);
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
      await showMouseCue(params.selector, params.tabId ?? null, 'Click');
      {
        const resolvedTabId = await resolveTargetTabId(params.tabId ?? null);
        const result = await safeClickWithRetries(params.selector, {
          maxAttempts: params.maxAttempts || 3,
          settleMs: params.settleMs || 90,
          allowForce: params.allowForce === true,
          preferHumanEvents: params.preferHumanEvents !== false,
        }, resolvedTabId);
        recordSessionEvent(resolvedTabId, 'click', { selector: params.selector });
        return result;
      }
    case 'safeClick':
      await showMouseCue(params.selector, params.tabId ?? null, 'Safe click');
      return await runAndRemember('safeClick', async () => {
        return await safeClickWithRetries(params.selector, {
          maxAttempts: params.maxAttempts || 3,
          settleMs: params.settleMs || 90,
          allowForce: params.allowForce === true,
          preferHumanEvents: params.preferHumanEvents !== false,
        }, params.tabId ?? null);
      }, [], params.tabId ?? null, () => ({
        selector: params.selector,
        maxAttempts: params.maxAttempts || 3,
      }));
    case 'moveCursor':
      return await runAndRemember('moveCursor', (selector, steps, durationMs) => {
        const el = document.querySelector(selector);
        if (!el) throw new Error(`Selector not found: ${selector}`);
        const rect = el.getBoundingClientRect();
        const cursorId = '__codex_bridge_cursor__';
        let cursor = document.getElementById(cursorId);
        if (!cursor) {
          cursor = document.createElement('div');
          cursor.id = cursorId;
          cursor.style.position = 'fixed';
          cursor.style.width = '12px';
          cursor.style.height = '12px';
          cursor.style.borderRadius = '999px';
          cursor.style.background = '#ff5a36';
          cursor.style.boxShadow = '0 0 0 2px rgba(255,255,255,0.85), 0 0 18px rgba(255,90,54,0.45)';
          cursor.style.zIndex = '2147483647';
          cursor.style.pointerEvents = 'none';
          document.body.appendChild(cursor);
        }
        const startX = 18;
        const startY = 18;
        const endX = rect.left + rect.width / 2;
        const endY = rect.top + rect.height / 2;
        const frames = Math.max(3, steps || 12);
        for (let i = 0; i <= frames; i += 1) {
          const t = i / frames;
          const eased = 1 - Math.pow(1 - t, 3);
          const x = startX + (endX - startX) * eased;
          const y = startY + (endY - startY) * eased + Math.sin(t * Math.PI) * 12;
          cursor.style.transform = `translate(${x}px, ${y}px)`;
        }
        el.dispatchEvent(new MouseEvent('mousemove', {
          bubbles: true,
          clientX: endX,
          clientY: endY,
          view: window,
        }));
        return { moved: true, selector, durationMs: durationMs || 400, steps: frames };
      }, [params.selector, params.steps || 12, params.durationMs || 400], params.tabId ?? null, () => ({
        selector: params.selector,
      }));
    case 'humanClick':
      await showMouseCue(params.selector, params.tabId ?? null, 'Click');
      return await runAndRemember('humanClick', (selector, steps, button) => {
        const el = document.querySelector(selector);
        if (!el) throw new Error(`Selector not found: ${selector}`);
        const rect = el.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        const cursorId = '__codex_bridge_cursor__';
        let cursor = document.getElementById(cursorId);
        if (!cursor) {
          cursor = document.createElement('div');
          cursor.id = cursorId;
          cursor.style.position = 'fixed';
          cursor.style.width = '12px';
          cursor.style.height = '12px';
          cursor.style.borderRadius = '999px';
          cursor.style.background = '#ff5a36';
          cursor.style.boxShadow = '0 0 0 2px rgba(255,255,255,0.85), 0 0 18px rgba(255,90,54,0.45)';
          cursor.style.zIndex = '2147483647';
          cursor.style.pointerEvents = 'none';
          document.body.appendChild(cursor);
        }
        cursor.style.transform = `translate(${x}px, ${y}px)`;
        const eventInit = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: button || 0, buttons: 1, view: window };
        el.dispatchEvent(new MouseEvent('pointerdown', eventInit));
        el.dispatchEvent(new MouseEvent('mousedown', eventInit));
        el.dispatchEvent(new MouseEvent('pointerup', eventInit));
        el.dispatchEvent(new MouseEvent('mouseup', eventInit));
        el.dispatchEvent(new MouseEvent('click', eventInit));
        return { clicked: true, selector, steps: Math.max(3, steps || 12) };
      }, [params.selector, params.steps || 12, params.button || 0], params.tabId ?? null, () => ({
        selector: params.selector,
      }));
    case 'doubleClick':
      await showMouseCue(params.selector, params.tabId ?? null, 'Double click');
      return await runAndRemember('doubleClick', (selector) => {
        const el = document.querySelector(selector);
        if (!el) throw new Error(`Selector not found: ${selector}`);
        const rect = el.getBoundingClientRect();
        const eventInit = {
          bubbles: true,
          cancelable: true,
          clientX: rect.left + rect.width / 2,
          clientY: rect.top + rect.height / 2,
          detail: 2,
          view: window,
        };
        el.dispatchEvent(new MouseEvent('dblclick', eventInit));
        if (typeof el.click === 'function') {
          el.click();
          el.click();
        }
        return { doubleClicked: true, selector };
      }, [params.selector], params.tabId ?? null, () => ({ selector: params.selector }));
    case 'rightClick':
      await showMouseCue(params.selector, params.tabId ?? null, 'Right click');
      return await runAndRemember('rightClick', (selector) => {
        const el = document.querySelector(selector);
        if (!el) throw new Error(`Selector not found: ${selector}`);
        const rect = el.getBoundingClientRect();
        const eventInit = {
          bubbles: true,
          cancelable: true,
          clientX: rect.left + rect.width / 2,
          clientY: rect.top + rect.height / 2,
          button: 2,
          buttons: 2,
          view: window,
        };
        el.dispatchEvent(new MouseEvent('contextmenu', eventInit));
        return { rightClicked: true, selector };
      }, [params.selector], params.tabId ?? null, () => ({ selector: params.selector }));
    case 'hover':
      await showMouseCue(params.selector, params.tabId ?? null, 'Hover');
      return await runAndRemember('hover', (selector) => {
        const el = document.querySelector(selector);
        if (!el) throw new Error(`Selector not found: ${selector}`);
        const rect = el.getBoundingClientRect();
        const eventInit = {
          bubbles: true,
          cancelable: true,
          clientX: rect.left + Math.min(rect.width / 2, Math.max(rect.width - 1, 1)),
          clientY: rect.top + Math.min(rect.height / 2, Math.max(rect.height - 1, 1)),
          view: window,
        };
        el.dispatchEvent(new MouseEvent('pointerover', eventInit));
        el.dispatchEvent(new MouseEvent('mouseover', eventInit));
        el.dispatchEvent(new MouseEvent('mouseenter', eventInit));
        return { hovered: true, selector, tag: el.tagName.toLowerCase() };
      }, [params.selector], params.tabId ?? null, () => ({ selector: params.selector }));
    case 'hoverInspect':
      return await runAndRemember('hoverInspect', async (selector, waitMs) => {
        const el = document.querySelector(selector);
        if (!el) throw new Error(`Selector not found: ${selector}`);
        const rect = el.getBoundingClientRect();
        const eventInit = {
          bubbles: true,
          cancelable: true,
          clientX: rect.left + rect.width / 2,
          clientY: rect.top + rect.height / 2,
          view: window,
        };
        el.dispatchEvent(new MouseEvent('pointerover', eventInit));
        el.dispatchEvent(new MouseEvent('mouseover', eventInit));
        el.dispatchEvent(new MouseEvent('mouseenter', eventInit));
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim();
        const isVisible = (node) => {
          const style = window.getComputedStyle(node);
          const bounds = node.getBoundingClientRect();
          return style.visibility !== 'hidden' && style.display !== 'none' && bounds.width > 0 && bounds.height > 0;
        };
        const surfaced = Array.from(document.querySelectorAll('[role="dialog"], [role="menu"], [role="listbox"], [role="tooltip"], dialog, .dropdown-menu, .menu, .popover, .tooltip'))
          .filter(isVisible)
          .slice(0, 12)
          .map((node) => ({
            tag: node.tagName.toLowerCase(),
            role: node.getAttribute('role'),
            text: norm(node.innerText || node.textContent || '').slice(0, 220),
          }));
        return { hovered: true, selector, surfaced };
      }, [params.selector, params.waitMs || 300], params.tabId ?? null, () => ({ selector: params.selector }));
    case 'dragAndDrop':
      return await runAndRemember('dragAndDrop', (sourceSelector, targetSelector) => {
        const source = document.querySelector(sourceSelector);
        const target = document.querySelector(targetSelector);
        if (!source) throw new Error(`Source not found: ${sourceSelector}`);
        if (!target) throw new Error(`Target not found: ${targetSelector}`);
        const dataTransfer = new DataTransfer();
        const fire = (node, type) => node.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer }));
        fire(source, 'dragstart');
        fire(target, 'dragenter');
        fire(target, 'dragover');
        fire(target, 'drop');
        fire(source, 'dragend');
        return { moved: true, sourceSelector, targetSelector };
      }, [params.sourceSelector, params.targetSelector], params.tabId ?? null, () => ({
        sourceSelector: params.sourceSelector,
        targetSelector: params.targetSelector,
      }));
    case 'type':
      await showMouseCue(params.selector, params.tabId ?? null, 'Type');
      return await runAndRemember('type', (selector, text) => {
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
      }, [params.selector, params.text], params.tabId ?? null, () => ({
        selector: params.selector,
        textLength: String(params.text || '').length,
      }));
    case 'pasteText':
      await showMouseCue(params.selector, params.tabId ?? null, 'Paste');
      return await runAndRemember('pasteText', (selector, text) => {
        const el = document.querySelector(selector);
        if (!el) throw new Error(`Selector not found: ${selector}`);
        el.focus();
        const normalized = String(text ?? '');
        const clipboardData = new DataTransfer();
        clipboardData.setData('text/plain', normalized);
        const pasteEvent = new ClipboardEvent('paste', {
          bubbles: true,
          cancelable: true,
          clipboardData,
        });
        el.dispatchEvent(pasteEvent);
        if ('value' in el) {
          const start = el.selectionStart ?? el.value.length;
          const end = el.selectionEnd ?? start;
          const before = el.value.slice(0, start);
          const after = el.value.slice(end);
          el.value = `${before}${normalized}${after}`;
        } else if (el.isContentEditable) {
          document.execCommand('insertText', false, normalized);
          if (!el.textContent?.includes(normalized)) {
            el.textContent = `${el.textContent || ''}${normalized}`;
          }
        }
        el.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, data: normalized, inputType: 'insertFromPaste' }));
        el.dispatchEvent(new InputEvent('input', { bubbles: true, data: normalized, inputType: 'insertFromPaste' }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { pasted: true, selector, textLength: normalized.length };
      }, [params.selector, params.text || ''], params.tabId ?? null, () => ({
        selector: params.selector,
        textLength: String(params.text || '').length,
      }));
    case 'typeIntoEditor':
      return await runAndRemember('typeIntoEditor', (selector, text, append) => {
        const el = selector ? document.querySelector(selector) : (document.activeElement || null);
        if (!el) throw new Error('Editor target not found');
        const normalized = String(text ?? '');
        const applyToMonaco = () => {
          const maybeEditor = el.closest('.monaco-editor');
          if (!maybeEditor) return false;
          const textarea = maybeEditor.querySelector('textarea');
          if (!textarea) return false;
          textarea.focus();
          textarea.value = append ? `${textarea.value || ''}${normalized}` : normalized;
          textarea.dispatchEvent(new Event('input', { bubbles: true }));
          return true;
        };
        const applyToCodeMirror = () => {
          const maybeEditor = el.closest('.CodeMirror, .cm-editor');
          if (!maybeEditor) return false;
          const content = maybeEditor.querySelector('[contenteditable=\"true\"], textarea');
          if (!content) return false;
          content.focus();
          if ('value' in content) {
            content.value = append ? `${content.value || ''}${normalized}` : normalized;
          } else {
            content.textContent = append ? `${content.textContent || ''}${normalized}` : normalized;
          }
          content.dispatchEvent(new Event('input', { bubbles: true }));
          return true;
        };
        if (!applyToMonaco() && !applyToCodeMirror()) {
          el.focus();
          if ('value' in el) {
            el.value = append ? `${el.value || ''}${normalized}` : normalized;
          } else if (el.isContentEditable) {
            el.textContent = append ? `${el.textContent || ''}${normalized}` : normalized;
          } else {
            throw new Error('Element is not editor-compatible');
          }
        }
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { typed: true, selector: selector || null, textLength: normalized.length, append: !!append };
      }, [params.selector || null, params.text || '', !!params.append], params.tabId ?? null, () => ({
        selector: params.selector || null,
        textLength: String(params.text || '').length,
      }));
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
    case 'waitForText':
      return await executeInTab(async (needle, timeoutMs, exact, selector) => {
        const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim();
        const target = norm(needle);
        const startedAt = Date.now();
        while (Date.now() - startedAt < timeoutMs) {
          const roots = selector ? Array.from(document.querySelectorAll(selector)) : [document.body];
          for (const root of roots) {
            const text = norm(root?.innerText || root?.textContent || '');
            if (!text) continue;
            const ok = exact ? text === target : text.toLowerCase().includes(target.toLowerCase());
            if (ok) {
              return { found: true, text: target, elapsedMs: Date.now() - startedAt };
            }
          }
          await new Promise((resolve) => setTimeout(resolve, 150));
        }
        throw new Error(`Timed out waiting for text: ${target}`);
      }, [params.text || '', params.timeoutMs || 10000, !!params.exact, params.selector || null], params.tabId ?? null);
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
    case 'elementScreenshot':
      return await captureElementScreenshot(params.selector, params.tabId ?? null, params.padding ?? 10);
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
    case 'selectTextByDrag':
      return await runAndRemember('selectTextByDrag', (selector) => {
        const el = document.querySelector(selector);
        if (!el) throw new Error(`Selector not found: ${selector}`);
        const selection = window.getSelection();
        selection.removeAllRanges();
        const range = document.createRange();
        range.selectNodeContents(el);
        selection.addRange(range);
        const rect = el.getBoundingClientRect();
        const start = { x: rect.left + 4, y: rect.top + 4 };
        const end = { x: rect.right - 4, y: rect.bottom - 4 };
        el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: start.x, clientY: start.y, view: window }));
        el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: end.x, clientY: end.y, view: window }));
        el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: end.x, clientY: end.y, view: window }));
        return { selected: true, selector, text: selection.toString().slice(0, 500), textLength: selection.toString().length };
      }, [params.selector], params.tabId ?? null, () => ({ selector: params.selector }));
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
    case 'extractTables':
      return await executeInTab((maxTables, maxRows) => {
        const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim();
        const tables = Array.from(document.querySelectorAll('table'))
          .slice(0, maxTables)
          .map((table, index) => {
            const rows = Array.from(table.querySelectorAll('tr'));
            const headers = Array.from(table.querySelectorAll('th'))
              .slice(0, 40)
              .map((cell) => norm(cell.innerText || cell.textContent || ''))
              .filter(Boolean);
            const bodyRows = rows
              .slice(0, maxRows)
              .map((row) => Array.from(row.cells).map((cell) => norm(cell.innerText || cell.textContent || '')).slice(0, 20))
              .filter((cells) => cells.some(Boolean));
            return {
              index,
              caption: norm(table.caption?.innerText || table.caption?.textContent || ''),
              headers,
              rowCount: rows.length,
              rows: bodyRows,
            };
          });
        return { title: document.title, url: location.href, tables };
      }, [params.maxTables || 10, params.maxRows || 20], params.tabId ?? null);
    case 'canvasInspect':
      return await inspectCanvas(params.maxItems || 5, !!params.includeDataUrl, params.tabId ?? null);
    case 'pageOverview':
      return await executeInTab(() => {
        const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim();
        const headings = Array.from(document.querySelectorAll('h1, h2, h3'))
          .slice(0, 20)
          .map((el) => ({
            level: el.tagName.toLowerCase(),
            text: norm(el.innerText || el.textContent || '').slice(0, 200),
          }))
          .filter((item) => item.text);
        const landmarks = ['header', 'nav', 'main', 'aside', 'footer', '[role="dialog"]', '[role="main"]', '[role="navigation"]']
          .flatMap((selector) => Array.from(document.querySelectorAll(selector)).map((el) => ({
            selector,
            tag: el.tagName.toLowerCase(),
            text: norm(el.innerText || el.textContent || '').slice(0, 120),
          })))
          .slice(0, 20);
        return {
          title: document.title,
          url: location.href,
          lang: document.documentElement?.lang || null,
          headingCount: document.querySelectorAll('h1, h2, h3, h4, h5, h6').length,
          linkCount: document.links.length,
          formCount: document.forms.length,
          frameCount: document.querySelectorAll('iframe, frame').length,
          buttonCount: document.querySelectorAll('button, input[type="button"], input[type="submit"], [role="button"]').length,
          headings,
          landmarks,
        };
      }, [], params.tabId ?? null);
    case 'smartFocus':
      return await runAndRemember('smartFocus', (mode, textNeedle) => {
        const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim();
        const isVisible = (el) => {
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
        };
        const controls = Array.from(document.querySelectorAll('input, textarea, select, button, [contenteditable="true"], [role="button"]'))
          .filter(isVisible);
        let target = null;
        if (textNeedle) {
          const needle = norm(textNeedle).toLowerCase();
          target = controls.find((el) => {
            const text = norm(el.innerText || el.textContent || el.getAttribute('placeholder') || el.getAttribute('aria-label') || '').toLowerCase();
            return text.includes(needle);
          }) || null;
        }
        if (!target) {
          if (mode === 'button') {
            target = controls.find((el) => el.tagName === 'BUTTON' || el.getAttribute('role') === 'button') || null;
          } else {
            target = controls.find((el) => ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || el.isContentEditable) || null;
          }
        }
        if (!target) throw new Error('No focusable target found');
        target.focus();
        target.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
        return {
          focused: true,
          tag: target.tagName.toLowerCase(),
          type: target.getAttribute('type'),
          placeholder: target.getAttribute('placeholder'),
          ariaLabel: target.getAttribute('aria-label'),
        };
      }, [params.mode || 'input', params.text || null], params.tabId ?? null, (result) => ({
        tag: result?.tag || null,
      }));
    case 'openFilePicker':
      return await runAndRemember('openFilePicker', (selector) => {
        const el = document.querySelector(selector);
        if (!el) throw new Error(`Selector not found: ${selector}`);
        if (!(el instanceof HTMLInputElement) || el.type !== 'file') {
          throw new Error('Target is not an input[type="file"]');
        }
        el.click();
        return { opened: true, selector, awaitsUserSelection: true };
      }, [params.selector], params.tabId ?? null, () => ({ selector: params.selector }));
    case 'setFileInputFiles':
      return await setFileInputFiles(params.selector, params.files || [], params.tabId ?? null);
    case 'atoPrepareDropboxUpload':
      return await atoPrepareDropboxUpload({
        files: params.files || [],
        fileSelector: params.fileSelector || null,
      }, params.tabId ?? null);
    case 'getSessionMemory':
      return getSessionMemory(params.tabId ?? null);
    case 'clearSessionMemory':
      return clearSessionMemory(params.tabId ?? null);
    case 'getConsoleLog':
      return getConsoleSnapshot(params.tabId ?? null);
    case 'clearConsoleLog':
      return clearConsoleLog(params.tabId ?? null);
    case 'readResponseBody': {
      const resolvedTabId = await resolveTargetTabId(params.tabId ?? null);
      const requestId = String(params.requestId || '');
      if (!requestId) throw new Error('requestId is required');
      const responseBody = getRecordedResponseBody(resolvedTabId, requestId);
      if (!responseBody) throw new Error(`No recorded response body for requestId: ${requestId}`);
      return {
        tabId: resolvedTabId,
        requestId,
        ...responseBody,
      };
    }
    case 'getCookies': {
      const url = params.url || await getPageUrl(params.tabId ?? null);
      const cookies = await chrome.cookies.getAll({ url });
      return { url, cookies };
    }
    case 'downloadUrl': {
      const url = params.url;
      if (!url) throw new Error('url is required');
      const downloadId = await chrome.downloads.download({
        url,
        filename: params.filename || undefined,
        saveAs: params.saveAs !== false,
      });
      return { ok: true, url, downloadId };
    }
    case 'domActions':
      return await executeStructuredDomActions(params.actions || [], params.tabId ?? null);
    case 'startMacroRecording':
      macroState = {
        recording: true,
        name: params.name || null,
        actions: [],
        startedAt: new Date().toISOString(),
      };
      return getMacroState();
    case 'stopMacroRecording': {
      const finished = getMacroState();
      macroState.recording = false;
      if (params.saveAs || macroState.name) {
        namedRecipes[params.saveAs || macroState.name] = finished.actions;
        await persistRecipes();
      }
      return finished;
    }
    case 'getMacroState':
      return getMacroState();
    case 'saveRecipe':
      if (!params.name) throw new Error('name is required');
      namedRecipes[String(params.name)] = params.actions || [];
      await persistRecipes();
      return { ok: true, name: String(params.name), actionCount: namedRecipes[String(params.name)].length };
    case 'listRecipes':
      return {
        recipes: Object.entries(namedRecipes).map(([name, actions]) => ({
          name,
          actionCount: Array.isArray(actions) ? actions.length : 0,
        })),
      };
    case 'deleteRecipe':
      if (!params.name) throw new Error('name is required');
      delete namedRecipes[String(params.name)];
      await persistRecipes();
      return { ok: true, deleted: String(params.name) };
    case 'runRecipe': {
      const name = String(params.name || '');
      if (!name) throw new Error('name is required');
      const recipe = namedRecipes[name];
      if (!Array.isArray(recipe)) throw new Error(`Unknown recipe: ${name}`);
      const results = [];
      for (const step of recipe) {
        const stepParams = { ...(step.params || {}) };
        if (params.tabId != null && stepParams.tabId == null) {
          stepParams.tabId = params.tabId;
        }
        results.push(await handleCommand({ action: step.action, params: stepParams }));
      }
      return { ok: true, name, stepCount: recipe.length, results };
    }
    case 'runActionQueue': {
      const queue = Array.isArray(params.queue) ? params.queue : [];
      if (!queue.length) throw new Error('queue is required');
      const results = [];
      for (const step of queue) {
        const action = String(step.action || '').trim();
        if (!action) throw new Error('queue step action is required');
        const stepParams = { ...(step.params || {}) };
        if (params.tabId != null && stepParams.tabId == null) {
          stepParams.tabId = params.tabId;
        }
        results.push({
          action,
          result: await handleCommand({ action, params: stepParams }),
        });
      }
      return { ok: true, steps: queue.length, results };
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
        try {
          const result = (0, eval)(script);
          return {
            ok: true,
            result: serialize(result),
          };
        } catch (error) {
          return {
            ok: false,
            error: error?.message || String(error),
            hint: 'The page blocked eval-style script execution. Use domActions for CSP-safe interactions.',
          };
        }
      }, [params.script || 'null'], params.tabId ?? null);
    case 'networkAttach':
      return await attachNetworkMonitor(params.tabId ?? null);
    case 'networkDetach':
      return await detachNetworkMonitor(params.tabId ?? null);
    case 'networkGetLog':
      return getNetworkSnapshot(params.tabId ?? null);
    case 'networkClearLog':
      return clearNetworkLog(params.tabId ?? null);
    case 'recentTabs':
      return { tabs: await recentTabs(params.maxItems || 20) };
    default:
      throw new Error(`Unsupported action: ${command.action}`);
  }
}

chrome.debugger.onEvent.addListener(async (source, method, params) => {
  const tabId = source.tabId;
  if (tabId == null) return;
  const consoleAttached = consoleState.attachedTabId === tabId;
  const networkAttached = networkState.attachedTabId === tabId;
  if (!consoleAttached && !networkAttached) return;
  const key = ensureTabBuckets(tabId);
  const requestMap = networkState.requestsByTab[key];

  if (consoleAttached && method === 'Runtime.consoleAPICalled') {
    appendConsoleEntry(tabId, {
      kind: 'console',
      level: params.type || 'log',
      text: (params.args || []).map((arg) => arg?.value ?? arg?.description ?? '').join(' ').trim(),
      stack: params.stackTrace?.callFrames?.slice(0, 6).map((frame) => ({
        url: frame.url,
        functionName: frame.functionName,
        lineNumber: frame.lineNumber,
        columnNumber: frame.columnNumber,
      })) || [],
    });
    return;
  }

  if (consoleAttached && method === 'Runtime.exceptionThrown') {
    appendConsoleEntry(tabId, {
      kind: 'exception',
      level: 'error',
      text: params.exceptionDetails?.text || params.exceptionDetails?.exception?.description || 'Runtime exception',
      url: params.exceptionDetails?.url || '',
      lineNumber: params.exceptionDetails?.lineNumber,
      columnNumber: params.exceptionDetails?.columnNumber,
    });
    return;
  }

  if (consoleAttached && method === 'Log.entryAdded') {
    appendConsoleEntry(tabId, {
      kind: 'log',
      level: params.entry?.level || 'info',
      text: params.entry?.text || '',
      url: params.entry?.url || '',
      lineNumber: params.entry?.lineNumber,
    });
    return;
  }

  if (!networkAttached) return;

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
    let responseMeta = { body: '', base64Encoded: false, preview: '' };
    try {
      const response = await chrome.debugger.sendCommand(debuggerTarget(tabId), 'Network.getResponseBody', {
        requestId: params.requestId,
      });
      responseMeta = normalizeResponseBody(response?.body || '', !!response?.base64Encoded, entry.mimeType || '');
    } catch {
      responseMeta = { body: '', base64Encoded: false, preview: '' };
    }
    networkState.responseBodiesByTab[key][params.requestId] = {
      url: entry.responseUrl || entry.url,
      mimeType: entry.mimeType || '',
      status: entry.status || null,
      method: entry.method || '',
      body: responseMeta.body,
      base64Encoded: responseMeta.base64Encoded,
      preview: responseMeta.preview,
    };
    appendNetworkEntry(tabId, {
      kind: 'finished',
      requestId: params.requestId,
      method: entry.method,
      status: entry.status,
      url: entry.responseUrl || entry.url,
      mimeType: entry.mimeType,
      durationMs,
      requestBodyPreview: entry.requestBodyPreview || '',
      responseBodyPreview: responseMeta.preview,
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
  if (consoleState.attachedTabId === tabId) {
    appendConsoleEntry(tabId, { kind: 'system', level: 'warn', text: `Console monitor detached: ${reason}` });
    consoleState.attachedTabId = null;
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    await ensureStateLoaded();
    if (message?.type === 'offscreen-heartbeat') {
      void warmBridge().catch(() => {});
      sendResponse({ ok: true });
      return;
    }
    if (message?.type === 'popup-connect-native-bridge') {
      const port = await connectNativeBridge();
      sendResponse({ ok: !!port, connected: !!nativeBridgePort, host: NATIVE_HOST_NAME });
      return;
    }
    if (message?.type === 'popup-get-state') {
      sendResponse({
        clientId: state.clientId,
        serverUrl: state.serverUrl,
        bridgeToken: state.bridgeToken,
        accessProfile: state.accessProfile,
        mouseCueEnabled: state.mouseCueEnabled,
        bridgeState: state,
        activeTab: await activeTab(),
        commandLog,
        network: getNetworkSnapshot(message.tabId ?? null),
        console: getConsoleSnapshot(message.tabId ?? null),
        macro: getMacroState(),
        recipes: Object.keys(namedRecipes),
        nativeBridge: {
          connected: !!nativeBridgePort,
          host: NATIVE_HOST_NAME,
          workspaceGroupId: state.workspaceGroupId,
        },
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
    if (message?.type === 'popup-save-token') {
      state.bridgeToken = String(message.bridgeToken || '').trim();
      await chrome.storage.local.set({ bridgeToken: state.bridgeToken });
      sendResponse({ ok: true, bridgeToken: state.bridgeToken });
      return;
    }
    if (message?.type === 'popup-save-access-profile') {
      const value = String(message.accessProfile || 'controlled').trim().toLowerCase();
      state.accessProfile = value === 'expanded' ? 'expanded' : 'controlled';
      await chrome.storage.local.set({ accessProfile: state.accessProfile });
      await persistWorkspaceState();
      void syncAccessProfileToBridge();
      sendResponse({ ok: true, accessProfile: state.accessProfile });
      return;
    }
    if (message?.type === 'popup-save-mouse-cue') {
      state.mouseCueEnabled = message.mouseCueEnabled !== false;
      await chrome.storage.local.set({ mouseCueEnabled: state.mouseCueEnabled });
      sendResponse({ ok: true, mouseCueEnabled: state.mouseCueEnabled });
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

chrome.runtime.onStartup.addListener(() => {
  void bootstrapBridge();
});

chrome.runtime.onInstalled.addListener(() => {
  void bootstrapBridge();
});

chrome.alarms?.onAlarm.addListener((alarm) => {
  if (alarm?.name === HEARTBEAT_ALARM || alarm?.name === POLL_ALARM) {
    void warmBridge().catch(() => {});
  }
});

async function heartbeat() {
  await ensureStateLoaded();
  try {
    const tab = await activeTab();
    const response = await post('/api/register', { clientId: state.clientId, lastTab: tab });
    state.connected = true;
    state.lastError = null;
    state.mode = response.mode || state.mode;
    lastHeartbeatAt = Date.now();
  } catch (error) {
    state.connected = false;
    state.lastError = error.message;
  }
  await persistBridgeState();
}

async function pollOnce() {
  await ensureStateLoaded();
  try {
    const payload = await get(`/api/pull?clientId=${encodeURIComponent(state.clientId)}`);
    state.connected = true;
    state.lastError = null;
    lastPollAt = Date.now();
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
  await bootstrapBridge();
  setInterval(heartbeat, 5000);
  setInterval(pollOnce, 700);
}

loop().catch((error) => {
  state.connected = false;
  state.lastError = error.message || String(error);
  void persistBridgeState();
});
