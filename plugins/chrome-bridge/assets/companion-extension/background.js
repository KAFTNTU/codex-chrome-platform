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
  assistantApiEndpoint: '',
  assistantModel: '',
  assistantApiKey: '',
  assistantTask: '',
  assistantRememberApiKey: false,
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
  pageSnapshotsByTab: {},
};
let downloadMemory = {
  recent: [],
};
let macroState = {
  recording: false,
  name: null,
  actions: [],
  startedAt: null,
};
let namedRecipes = {};
let formProfiles = {};
let assistantChatLog = [];

async function loadState() {
  const stored = await chrome.storage.local.get([
    'clientId',
    'serverUrl',
    'bridgeToken',
    'assistantApiEndpoint',
    'assistantModel',
    'assistantApiKey',
    'assistantTask',
    'assistantRememberApiKey',
    'assistantChatLog',
    'namedRecipes',
    'formProfiles',
    'mouseCueEnabled',
    'workspaceGroupId',
    'workspaceGroupTitle',
    'workspaceGroupColor',
    'accessProfile',
  ]);
  state.clientId = stored.clientId || crypto.randomUUID();
  state.serverUrl = stored.serverUrl || DEFAULT_SERVER;
  state.bridgeToken = stored.bridgeToken || '';
  state.assistantApiEndpoint = stored.assistantApiEndpoint || '';
  state.assistantModel = stored.assistantModel || '';
  state.assistantApiKey = stored.assistantApiKey || '';
  state.assistantTask = stored.assistantTask || '';
  state.assistantRememberApiKey = stored.assistantRememberApiKey === true;
  state.accessProfile = stored.accessProfile || 'controlled';
  state.mouseCueEnabled = stored.mouseCueEnabled !== false;
  state.workspaceGroupId = Number.isFinite(Number(stored.workspaceGroupId)) ? Number(stored.workspaceGroupId) : null;
  state.workspaceGroupTitle = stored.workspaceGroupTitle || 'Codex Agent Workspace';
  state.workspaceGroupColor = stored.workspaceGroupColor || 'blue';
  namedRecipes = stored.namedRecipes || {};
  formProfiles = stored.formProfiles || {};
  assistantChatLog = Array.isArray(stored.assistantChatLog) ? stored.assistantChatLog.slice(0, 120) : [];
  await chrome.storage.local.set({
    clientId: state.clientId,
    serverUrl: state.serverUrl,
    bridgeToken: state.bridgeToken,
    assistantApiEndpoint: state.assistantApiEndpoint,
    assistantModel: state.assistantModel,
    assistantTask: state.assistantTask,
    assistantRememberApiKey: state.assistantRememberApiKey,
    assistantChatLog,
    accessProfile: state.accessProfile,
    mouseCueEnabled: state.mouseCueEnabled,
    workspaceGroupId: state.workspaceGroupId,
    workspaceGroupTitle: state.workspaceGroupTitle,
    workspaceGroupColor: state.workspaceGroupColor,
    formProfiles,
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

async function persistFormProfiles() {
  await chrome.storage.local.set({ formProfiles });
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

function buildAssistantSystemPrompt(context) {
  const activeTabText = context?.activeTab
    ? `Current active tab: ${context.activeTab.title || '(no title)'} | ${context.activeTab.url || '(no url)'}`
    : 'Current active tab: unavailable';
  const profileText = context?.accessProfile || 'controlled';
  const connectedText = context?.bridgeConnected ? 'connected' : 'not connected';
  const pageSummaryText = context?.pageSummary?.summaryText
    || context?.pageSummary?.summary?.join?.(' | ')
    || 'Page summary: unavailable';
  const pageOutlineText = context?.pageOutline?.summaryText
    || context?.pageOutline?.summary?.join?.(' | ')
    || 'DOM outline: unavailable';
  const pageInteractText = context?.pageInteract?.summaryText
    || context?.pageInteract?.interactMap?.slice?.(0, 10)?.map?.((item) => {
      const role = item?.kind || item?.role || item?.tag || 'control';
      const text = item?.text || item?.ariaLabel || item?.placeholder || item?.name || '';
      const intent = item?.intent ? ` intent=${item.intent}` : '';
      return `${item?.index ?? '?'}:${role}:${text}${intent}`;
    })?.join?.(' | ')
    || 'Interact map: unavailable';
  const pageDigestText = context?.pageDigest?.text
    || context?.pageDigest?.summaryText
    || 'Page digest: unavailable';
  return [
    'You are Codex, a browser agent running inside a real Chrome/Edge session through Chrome Bridge.',
    'You can help the user with browser tasks in their personal browser session, including opening pages, reading page content, finding controls, filling forms, scrolling, clicking visible controls, focusing fields, hovering, and explaining what to do next.',
    'The bridge can interact with real page elements. Treat visible inputs, text fields, buttons, links, selects, checkboxes, radios, tabs, dialogs, and other controls as actionable browser targets.',
    'When a page has forms or buttons, prefer the interact map, semantic click, and form assist tools to identify what can be clicked or typed into. If fields are visible, you can work with them directly through the bridge.',
    'When browser actions are needed, return ONLY valid JSON with this shape: {"assistant_text":"...","actions":[{"action":"...","params":{}}]}. Do not add markdown, code fences, or extra prose around the JSON.',
    'The actions array should contain bridge commands such as searchWeb, openNewTab, navigate, pageInteractClick, semanticClick, universalFormAssist, type, pasteText, hover, waitForPageReady, and scroll or smoothScroll.',
    'For scrolling, use smoothScroll: negative totalY scrolls up, positive totalY scrolls down. Example: {"assistant_text":"Scrolling up a bit.","actions":[{"action":"smoothScroll","params":{"totalY":-800,"stepY":120,"delayMs":25}}]}',
    'Assume the bridge can act on the real browser when appropriate. If a step is sensitive, destructive, login-related, or submit-related, ask for confirmation before proceeding.',
    'Be concise and practical. If you need browser interaction, describe the next browser action clearly.',
    'Available bridge skills include: pageSummary, pageDomOutline, pageDomSnapshot, pageSectionReader, pageInteractMap, pageInteractClick, semanticClick, findDomControl, universalFormAssist, OCR from screenshot, page compare, site memory, workspace tabs, file upload assistant, and searchWeb.',
    `Bridge connected: ${connectedText}. Access profile: ${profileText}.`,
    activeTabText,
    `Page summary: ${pageSummaryText}`,
    `DOM outline: ${pageOutlineText}`,
    `Interact map: ${pageInteractText}`,
    `Page digest: ${pageDigestText}`,
  ].join('\n');
}

function inferAssistantModel(endpoint) {
  const value = String(endpoint || '').toLowerCase();
  if (value.includes('openrouter.ai')) return 'openrouter/auto';
  return 'gpt-4o-mini';
}

async function callAssistantApi({ endpoint, apiKey, model, task, context }) {
  const selectedModel = String(model || '').trim() || inferAssistantModel(endpoint);
  const endpointText = String(endpoint || '').toLowerCase();
  const body = {
    model: selectedModel,
    messages: [
      {
        role: 'system',
        content: buildAssistantSystemPrompt(context),
      },
      {
        role: 'user',
        content: task,
      },
    ],
  };
  if (endpointText.includes('openrouter.ai') || endpointText.includes('openai.com')) {
    body.response_format = { type: 'json_object' };
  }
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  };
  if (endpointText.includes('openrouter.ai')) {
    headers['HTTP-Referer'] = 'https://github.com/KAFTNTU/codex-chrome-platform';
    headers['X-Title'] = 'Bridge Companion';
  }
  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const rawText = await response.text();
  let data = null;
  try {
    data = rawText ? JSON.parse(rawText) : null;
  } catch {
    data = null;
  }
  if (!response.ok) {
    const message = data?.error?.message || data?.message || rawText || `HTTP ${response.status}`;
    throw new Error(message);
  }
  const reply = data?.choices?.[0]?.message?.content
    ?? data?.choices?.[0]?.text
    ?? data?.output_text
    ?? data?.output?.text
    ?? rawText
    ?? '';
  return { reply: String(reply).trim(), model: selectedModel, raw: data };
}

function stripAssistantJsonFence(text) {
  const value = String(text || '').trim();
  const fenced = value.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced?.[1]) return fenced[1].trim();
  return value;
}

function parseAssistantPlan(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const candidates = [raw];
  const fenced = stripAssistantJsonFence(raw);
  if (fenced && fenced !== raw) candidates.push(fenced);
  const firstBrace = raw.indexOf('{');
  const lastBrace = raw.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(raw.slice(firstBrace, lastBrace + 1));
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object') {
        return parsed;
      }
    } catch {
      // ignore malformed candidates
    }
  }
  return null;
}

function normalizeAssistantPlan(plan) {
  if (!plan || typeof plan !== 'object') return null;
  const assistantText = String(plan.assistant_text || plan.reply || plan.text || '').trim();
  const actionsSource = Array.isArray(plan.actions)
    ? plan.actions
    : Array.isArray(plan.queue)
      ? plan.queue
      : [];
  const actions = actionsSource.map((step) => {
    if (!step || typeof step !== 'object') return null;
    const action = String(step.action || step.name || step.command || '').trim();
    if (!action) return null;
    const params = step.params && typeof step.params === 'object' ? step.params : {};
    return { action, params };
  }).filter(Boolean);
  return {
    assistantText,
    actions,
  };
}

function normalizeCommandAction(action) {
  const raw = String(action || '').trim();
  if (!raw) return '';
  const lower = raw.toLowerCase();
  const aliasMap = {
    get_active_tab: 'getActiveTab',
    list_tabs: 'listTabs',
    switch_tab: 'switchTab',
    open_new_tab: 'openNewTab',
    search_web: 'searchWeb',
    reddit_compose_draft: 'redditComposeDraft',
    universal_form_assist: 'universalFormAssist',
    create_codex_tab_group: 'createCodexTabGroup',
    open_in_codex_workspace: 'openInCodexWorkspace',
    get_tab_workspace_state: 'getTabWorkspaceState',
    add_active_tab_to_workspace: 'addActiveTabToWorkspace',
    close_tab: 'closeTab',
    navigate_and_wait: 'navigateAndWait',
    wait_for_page_ready: 'waitForPageReady',
    open_ato_module: 'openAtoModule',
    open_ato_topic_by_title: 'openAtoTopicByTitle',
    ensure_ato_context: 'ensureAtoContext',
    reading_scroll_session: 'readingScrollSession',
    smooth_scroll: 'smoothScroll',
    scroll_to_selector: 'scrollToSelector',
    page_summary: 'pageSummary',
    page_dom_outline: 'pageDomOutline',
    page_dom_snapshot: 'pageDomSnapshot',
    page_section_reader: 'pageSectionReader',
    page_intent_map: 'pageIntentMap',
    page_interact_map: 'pageInteractMap',
    page_interact_click: 'pageInteractClick',
    semantic_click: 'semanticClick',
    find_dom_control: 'findDomControl',
    page_diff_memory: 'pageDiffMemory',
    page_interact_type: 'pageInteractType',
    page_interact_hover: 'pageInteractHover',
    page_interact_focus: 'pageInteractFocus',
    page_wizard_next: 'pageWizardNext',
    page_wizard_prev: 'pageWizardPrev',
  };
  return aliasMap[lower] || raw;
}

function summarizeAssistantActions(results = []) {
  if (!Array.isArray(results) || !results.length) return 'No browser actions executed.';
  return results.map((entry, index) => {
    const action = entry?.action || 'action';
    const ok = entry?.result?.ok !== false;
    const stateText = ok ? 'ok' : 'error';
    const detail = entry?.result?.error || entry?.result?.message || entry?.result?.status || '';
    return `${index + 1}. ${action}: ${stateText}${detail ? ` (${detail})` : ''}`;
  }).join('\n');
}

async function runAssistantActionPlan(actions = [], tabId = null) {
  const results = [];
  for (const step of actions.slice(0, 12)) {
    try {
      const result = await handleCommand({
        action: step.action,
        params: {
          ...(step.params || {}),
          ...(tabId != null && step.params?.tabId == null ? { tabId } : {}),
        },
      });
      results.push({ action: step.action, result });
    } catch (error) {
      results.push({
        action: step.action,
        result: {
          ok: false,
          error: error?.message || String(error),
        },
      });
    }
  }
  return results;
}

async function collectAssistantPageContext() {
  const active = await safeActiveTab();
  let pageSummary = null;
  let pageOutline = null;
  let pageSnapshot = null;
  let pageInteract = null;
  let pageDigest = null;
  try {
    const response = await post('/api/action', {
      action: 'pageSummary',
      params: { tabId: active?.id ?? null, maxItems: 10 },
    });
    pageSummary = response?.result || response || null;
  } catch {
    // Ignore pageSummary failures.
  }
  try {
    const response = await post('/api/action', {
      action: 'pageDomOutline',
      params: { tabId: active?.id ?? null, maxItems: 10 },
    });
    pageOutline = response?.result || response || null;
  } catch {
    // Ignore pageDomOutline failures.
  }
  try {
    const response = await post('/api/action', {
      action: 'pageDomSnapshot',
      params: { tabId: active?.id ?? null, maxItems: 8 },
    });
    pageSnapshot = response?.result || response || null;
  } catch {
    // Ignore pageDomSnapshot failures.
  }
  try {
    const response = await post('/api/action', {
      action: 'pageInteractMap',
      params: { tabId: active?.id ?? null, kind: 'all', maxItems: 30 },
    });
    pageInteract = response?.result || response || null;
  } catch {
    // Ignore pageInteractMap failures.
  }
  if (active?.id != null) {
    try {
      pageDigest = await executeInTab(() => {
        const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim();
        const visible = (el) => {
          if (!el) return false;
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
        };
        const headings = Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6'))
          .filter(visible)
          .slice(0, 10)
          .map((el) => norm(el.innerText || el.textContent || '').slice(0, 160))
          .filter(Boolean);
        const controls = Array.from(document.querySelectorAll('a[href], button, input, select, textarea, [contenteditable="true"], [role="button"], [role="link"]'))
          .filter(visible)
          .slice(0, 16)
          .map((el) => {
            const text = norm(el.innerText || el.textContent || el.value || '').slice(0, 120);
            return [
              el.tagName.toLowerCase(),
              el.getAttribute('type') || '',
              el.getAttribute('role') || '',
              text,
              el.getAttribute('placeholder') || '',
              el.getAttribute('aria-label') || '',
            ].filter(Boolean).join(' | ');
          });
        const text = norm(document.body?.innerText || document.body?.textContent || '').slice(0, 2000);
        return {
          title: document.title || '',
          url: location.href,
          headings,
          controls,
          text,
          summaryText: [
            `Title: ${document.title || '(untitled)'}`,
            `URL: ${location.href}`,
            `Headings: ${headings.slice(0, 5).join(' || ') || '(none)'}`,
            `Controls: ${controls.slice(0, 8).join(' || ') || '(none)'}`,
            `Text preview: ${text.slice(0, 800) || '(none)'}`,
          ].join(' | '),
        };
      }, [], active.id);
    } catch {
      // Ignore direct digest failures.
    }
  }
  return {
    activeTab: active,
    pageSummary,
    pageOutline,
    pageSnapshot,
    pageInteract,
    pageDigest,
  };
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

function pushAssistantChat(entry) {
  assistantChatLog = [{
    at: new Date().toISOString(),
    ...entry,
  }, ...assistantChatLog].slice(0, 120);
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
    delete sessionMemory.pageSnapshotsByTab[String(tabId)];
    return { cleared: true, tabId: Number(tabId) };
  }
  sessionMemory.byTab = {};
  sessionMemory.pageSnapshotsByTab = {};
  return { cleared: true, allTabs: true };
}

function getPageSnapshotMemory(tabId = null) {
  if (tabId != null) {
    return sessionMemory.pageSnapshotsByTab[String(tabId)] || null;
  }
  return sessionMemory.pageSnapshotsByTab;
}

function setPageSnapshotMemory(tabId, snapshot) {
  if (tabId == null) return;
  sessionMemory.pageSnapshotsByTab[String(tabId)] = snapshot;
}

function getFormProfiles() {
  return formProfiles || {};
}

function setFormProfile(name, profile) {
  const key = String(name || '').trim();
  if (!key) throw new Error('name is required');
  formProfiles[key] = profile;
  return key;
}

function compactDownloadItem(item) {
  return {
    id: item.id,
    url: item.url || '',
    finalUrl: item.finalUrl || null,
    filename: item.filename || '',
    danger: item.danger || null,
    mime: item.mime || item.mimeType || null,
    state: item.state || null,
    error: item.error || null,
    bytesReceived: item.bytesReceived || 0,
    totalBytes: item.totalBytes || 0,
    startTime: item.startTime || null,
    endTime: item.endTime || null,
    byExtensionId: item.byExtensionId || null,
    exists: item.exists !== false,
  };
}

async function queryDownloadsSnapshot(filter = {}) {
  const items = await chrome.downloads.search({
    ...filter,
  });
  return items.map(compactDownloadItem);
}

async function waitForDownloadMatch(needle = '', options = {}) {
  const target = String(needle || '').trim().toLowerCase();
  const timeoutMs = Math.max(1000, Number(options.timeoutMs || 20000));
  const startedAt = Date.now();
  let lastMatch = null;
  while (Date.now() - startedAt < timeoutMs) {
    const items = await queryDownloadsSnapshot(options.filter || {});
    const matches = items.filter((item) => {
      const hay = `${item.filename || ''} ${item.url || ''} ${item.finalUrl || ''}`.toLowerCase();
      if (!target) return true;
      return hay.includes(target);
    });
    if (matches.length) {
      lastMatch = matches[0];
      if (!options.waitForComplete) {
        return {
          ok: true,
          elapsedMs: Date.now() - startedAt,
          download: lastMatch,
          matches,
        };
      }
      const complete = matches.find((item) => item.state === 'complete') || null;
      if (complete) {
        return {
          ok: true,
          elapsedMs: Date.now() - startedAt,
          download: complete,
          matches,
        };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, Math.max(150, Number(options.pollMs || 500))));
  }
  throw new Error(`Timed out waiting for download: ${needle || 'any download'}`);
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

function looksLikeUrl(text) {
  const value = String(text || '').trim();
  if (!value) return false;
  if (/^https?:\/\//i.test(value)) return true;
  if (/\s/.test(value)) return false;
  return /[.]/.test(value) && /[a-z0-9-]+\.[a-z]{2,}/i.test(value);
}

function buildSearchUrl(query, engine = 'bing') {
  const q = encodeURIComponent(String(query || '').trim());
  const normalizedEngine = String(engine || 'bing').trim().toLowerCase();
  const map = {
    bing: `https://www.bing.com/search?q=${q}`,
    google: `https://www.google.com/search?q=${q}`,
    duckduckgo: `https://duckduckgo.com/?q=${q}`,
    ddg: `https://duckduckgo.com/?q=${q}`,
    yahoo: `https://search.yahoo.com/search?p=${q}`,
    brave: `https://search.brave.com/search?q=${q}`,
  };
  return map[normalizedEngine] || map.bing;
}

async function searchWeb(query, options = {}, tabId = null) {
  const term = String(query || '').trim();
  if (!term) throw new Error('query is required');
  const url = looksLikeUrl(term) ? (term.startsWith('http://') || term.startsWith('https://') ? term : `https://${term}`) : buildSearchUrl(term, options.engine || 'bing');
  if (options.newTab !== false) {
    return await openNewTab(url, options.active !== false);
  }
  return await navigateAndWait(url, {
    timeoutMs: options.timeoutMs || 15000,
    titleContains: options.titleContains || null,
    urlContains: options.urlContains || null,
  }, tabId);
}

async function redditComposeDraft(params = {}, tabId = null) {
  const subreddit = String(params.subreddit || '').trim().replace(/^r\//i, '').replace(/^\/+/g, '');
  const draftUrl = subreddit ? `https://www.reddit.com/r/${encodeURIComponent(subreddit)}/submit` : 'https://www.reddit.com/submit';
  const nav = await navigateAndWait(draftUrl, {
    timeoutMs: params.timeoutMs || 20000,
    titleContains: params.titleContains || 'Reddit',
    urlContains: '/submit',
  }, tabId);
  let fillResult = null;
  if (params.title || params.body) {
    fillResult = await executeInTab((draft) => {
      const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const isVisible = (el) => {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };
      const setNativeValue = (el, value) => {
        if (!el) return false;
        const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (setter) setter.call(el, value);
        else el.value = value;
        el.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
        el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
        return true;
      };
      const titleNeedle = norm('title');
      const bodyNeedle = norm('body');
      const titleCandidates = Array.from(document.querySelectorAll('input, textarea, [contenteditable="true"]'))
        .filter(isVisible)
        .filter((el) => {
          const hint = norm(`${el.getAttribute('aria-label') || ''} ${el.getAttribute('placeholder') || ''} ${el.name || ''} ${el.id || ''} ${el.closest('label')?.innerText || ''}`);
          return hint.includes(titleNeedle) || el.name === 'title' || el.id === 'title';
        });
      const bodyCandidates = Array.from(document.querySelectorAll('textarea, [contenteditable="true"], input'))
        .filter(isVisible)
        .filter((el) => {
          const hint = norm(`${el.getAttribute('aria-label') || ''} ${el.getAttribute('placeholder') || ''} ${el.name || ''} ${el.id || ''} ${el.closest('label')?.innerText || ''}`);
          return hint.includes(bodyNeedle) || hint.includes('text') || hint.includes('post');
        });
      const titleEl = titleCandidates[0] || Array.from(document.querySelectorAll('input, textarea')).find((el) => isVisible(el) && el.type === 'text');
      const bodyEl = bodyCandidates.find((el) => el !== titleEl) || Array.from(document.querySelectorAll('[contenteditable="true"], textarea')).find((el) => isVisible(el) && el !== titleEl);
      const result = {
        titleFound: !!titleEl,
        bodyFound: !!bodyEl,
      };
      if (draft.title && titleEl) {
        titleEl.focus();
        result.titleFilled = setNativeValue(titleEl, draft.title);
      }
      if (draft.body && bodyEl) {
        bodyEl.focus();
        if (bodyEl.isContentEditable) {
          bodyEl.innerText = draft.body;
          bodyEl.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: draft.body }));
          result.bodyFilled = true;
        } else {
          result.bodyFilled = setNativeValue(bodyEl, draft.body);
        }
      }
      return result;
    }, [{ title: params.title || '', body: params.body || '' }], tabId);
  }
  return {
    ok: true,
    subreddit: subreddit || null,
    url: draftUrl,
    navigation: nav,
    filled: fillResult,
  };
}

async function universalFormAssist(params = {}, tabId = null) {
  const resolvedTabId = await resolveTargetTabId(tabId);
  return await runAndRemember('universalFormAssist', (payload) => {
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const lower = (value) => normalize(value).toLowerCase();
    const isVisible = (el) => {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const deepQueryOne = (selector) => {
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
    const deepQueryAll = (selector) => {
      const items = [];
      const seen = new Set();
      const roots = [document];
      while (roots.length) {
        const root = roots.shift();
        const nodes = root.querySelectorAll ? Array.from(root.querySelectorAll(selector)) : [];
        for (const node of nodes) {
          if (seen.has(node)) continue;
          seen.add(node);
          items.push(node);
        }
        const all = root.querySelectorAll ? Array.from(root.querySelectorAll('*')) : [];
        for (const node of all) {
          if (node.shadowRoot) roots.push(node.shadowRoot);
        }
      }
      return items;
    };
    const setNativeValue = (el, value) => {
      const next = value == null ? '' : String(value);
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(el, next);
      else el.value = next;
      el.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
      el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
      return true;
    };
    const setContentEditableValue = (el, value) => {
      const next = value == null ? '' : String(value);
      el.focus();
      el.textContent = next;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: next }));
      el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
      return true;
    };
    const getLabelText = (el) => {
      const parts = [];
      if (el.id) {
        for (const label of Array.from(document.querySelectorAll('label'))) {
          if (label.htmlFor === el.id) {
            parts.push(label.innerText || label.textContent || '');
          }
        }
        const ariaIds = String(el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean);
        for (const id of ariaIds) {
          const node = deepQueryOne(`#${CSS.escape(id)}`);
          if (node) parts.push(node.innerText || node.textContent || '');
        }
      }
      const closestLabel = el.closest('label');
      if (closestLabel) parts.push(closestLabel.innerText || closestLabel.textContent || '');
      const parentText = el.parentElement?.innerText || '';
      if (parentText) parts.push(parentText);
      return normalize(parts.join(' '));
    };
    const getControlHint = (el) => {
      return normalize([
        el.getAttribute('aria-label'),
        el.getAttribute('placeholder'),
        el.getAttribute('name'),
        el.id,
        el.getAttribute('title'),
        el.getAttribute('autocomplete'),
        el.getAttribute('data-testid'),
        el.getAttribute('data-test'),
        el.getAttribute('role'),
        getLabelText(el),
      ].filter(Boolean).join(' '));
    };
    const aliasHints = {
      name: ['name', 'full name', 'your name', 'ім', 'ім’я', 'імя', 'фио', 'fio'],
      firstName: ['first name', 'given name', 'ім’я', 'імя', 'firstname', 'name'],
      lastName: ['last name', 'surname', 'family name', 'прізвище', 'фамилия'],
      middleName: ['middle name', 'patronymic', 'по батькові'],
      age: ['age', 'years', 'вік', 'лет'],
      birthDate: ['birth date', 'date of birth', 'dob', 'birthday', 'дата народження', 'birthdate'],
      email: ['email', 'e-mail', 'mail', 'пошта', 'email address'],
      phone: ['phone', 'mobile', 'tel', 'telephone', 'телефон', 'номер'],
      city: ['city', 'town', 'місто'],
      country: ['country', 'nation', 'країна'],
      address: ['address', 'street', 'адреса', 'вулиця'],
      university: ['university', 'institution', 'college', 'виш', 'університет'],
      group: ['group', 'class', 'section', 'group number', 'група'],
      login: ['login', 'username', 'user', 'account', 'username or email'],
      password: ['password', 'pass', 'пароль'],
      search: ['search', 'query', 'find', 'пошук', 'запит'],
      message: ['message', 'text', 'body', 'повідомлення', 'текст'],
    };
    const typeHints = {
      name: ['text', 'search'],
      firstName: ['text', 'search'],
      lastName: ['text', 'search'],
      middleName: ['text', 'search'],
      age: ['number', 'text'],
      birthDate: ['date', 'text'],
      email: ['email', 'text'],
      phone: ['tel', 'text'],
      city: ['text', 'search'],
      country: ['text', 'search'],
      address: ['text', 'search'],
      university: ['text', 'search'],
      group: ['text', 'search', 'number'],
      login: ['text', 'email', 'search'],
      password: ['password', 'text'],
      search: ['search', 'text'],
      message: ['text', 'textarea'],
    };
    const deepControls = deepQueryAll('input, textarea, select, [contenteditable="true"], button, [role="button"]')
      .filter(isVisible)
      .map((el) => {
        const tag = el.tagName.toLowerCase();
        const type = (el.getAttribute('type') || '').toLowerCase();
        const labelText = getLabelText(el);
        const hint = getControlHint(el);
        return {
          el,
          tag,
          type,
          labelText,
          hint,
          valuePreview: normalize('value' in el ? el.value : el.textContent || '').slice(0, 120),
        };
      });
    const fieldEntries = [];
    if (Array.isArray(payload.entries)) {
      fieldEntries.push(...payload.entries);
    }
    if (payload.fields && typeof payload.fields === 'object' && !Array.isArray(payload.fields)) {
      for (const [key, value] of Object.entries(payload.fields)) {
        fieldEntries.push({ key, value });
      }
    }
    if (Array.isArray(payload.fields)) {
      fieldEntries.push(...payload.fields);
    }
    if (!fieldEntries.length && payload.key != null) {
      fieldEntries.push({ key: payload.key, value: payload.value });
    }
    const hintSetFromEntry = (entry) => {
      const rawKey = normalize(entry.key ?? entry.name ?? entry.label ?? entry.field ?? entry.selector ?? '');
      const manualHints = [];
      if (rawKey) manualHints.push(rawKey);
      if (entry.hint) manualHints.push(normalize(entry.hint));
      if (entry.label) manualHints.push(normalize(entry.label));
      if (entry.name) manualHints.push(normalize(entry.name));
      const aliasKey = lower(rawKey).replace(/\s+/g, '');
      const alias = aliasHints[aliasKey] || aliasHints[rawKey] || aliasHints[lower(rawKey)] || [];
      manualHints.push(...alias);
      return [...new Set(manualHints.filter(Boolean).map((item) => normalize(item)))];
    };
    const typeMatches = (control, entry) => {
      const desired = normalize(entry.type || entry.kind || entry.inputType || '');
      if (!desired) return true;
      const desiredList = desired.split(/[|,]/).map((item) => lower(item).trim()).filter(Boolean);
      const candidate = lower(control.type || control.tag);
      return desiredList.some((item) => candidate === item || candidate.includes(item));
    };
    const scoreControl = (control, entry, needles) => {
      let score = 0;
      const candidate = lower(control.hint);
      const label = lower(control.labelText);
      const combined = `${candidate} ${label}`;
      const controlType = lower(control.type || control.tag);
      const key = lower(entry.key ?? entry.name ?? entry.label ?? entry.field ?? '');
      if (entry.selector) {
        return 10000;
      }
      if (!typeMatches(control, entry)) {
        return -1;
      }
      for (const needle of needles) {
        const n = lower(needle);
        if (!n) continue;
        if (combined === n) score += 700;
        if (candidate === n) score += 650;
        if (label === n) score += 650;
        if (combined.includes(n)) score += 300;
        if (candidate.includes(n)) score += 260;
        if (label.includes(n)) score += 260;
        if (combined.startsWith(n)) score += 140;
        if (candidate.startsWith(n)) score += 120;
        if (label.startsWith(n)) score += 120;
      }
      if (key) {
        if (control.id && lower(control.id) === key) score += 280;
        if (control.el.getAttribute('name') && lower(control.el.getAttribute('name')) === key) score += 260;
        if (control.el.getAttribute('autocomplete') && lower(control.el.getAttribute('autocomplete')).includes(key)) score += 120;
      }
      if (control.el.getAttribute('required') !== null) score += 8;
      if (controlType === 'text' || controlType === 'search' || controlType === 'email' || controlType === 'tel' || controlType === 'number' || controlType === 'date' || controlType === 'textarea') {
        score += 20;
      }
      if (entry.type && typeHints[lower(entry.key ?? entry.name ?? entry.label ?? '')]?.includes(controlType)) {
        score += 140;
      }
      return score;
    };
    const selectOption = (el, entry) => {
      const raw = entry.selectValue ?? entry.optionValue ?? entry.value ?? '';
      const labelNeedle = normalize(entry.optionText ?? entry.optionLabel ?? '');
      const options = Array.from(el.options || []);
      let chosen = null;
      if (raw !== '') {
        chosen = options.find((option) => option.value === String(raw)) || null;
      }
      if (!chosen && labelNeedle) {
        const needle = lower(labelNeedle);
        chosen = options.find((option) => lower(option.label || option.textContent || '').includes(needle)) || null;
      }
      if (!chosen && raw !== '') {
        const needle = lower(raw);
        chosen = options.find((option) => lower(option.textContent || '').includes(needle)) || null;
      }
      if (!chosen && raw !== '') {
        chosen = options.find((option) => lower(option.textContent || '') === lower(raw)) || null;
      }
      if (!chosen) {
        throw new Error(`No matching option found for ${entry.key || entry.name || entry.label || 'select field'}`);
      }
      el.value = chosen.value;
      el.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
      el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
      return chosen;
    };
    const fillControl = (control, entry) => {
      const el = control.el;
      const rawValue = entry.value;
      const wantChecked = typeof entry.checked === 'boolean'
        ? entry.checked
        : typeof rawValue === 'boolean'
          ? rawValue
          : null;
      if (el instanceof HTMLInputElement) {
        const type = lower(el.type);
        if (type === 'checkbox' || type === 'radio') {
          if (wantChecked == null) {
            if (rawValue == null) return { kind: type, skipped: true };
            el.checked = !!rawValue;
          } else {
            el.checked = wantChecked;
          }
          el.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
          el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
          return { kind: type, checked: el.checked };
        }
        if (type === 'file') {
          throw new Error('File inputs are not handled by universal form assist');
        }
        setNativeValue(el, rawValue);
        return { kind: type || 'text', value: String(rawValue ?? '') };
      }
      if (el instanceof HTMLTextAreaElement) {
        setNativeValue(el, rawValue);
        return { kind: 'textarea', value: String(rawValue ?? '') };
      }
      if (el instanceof HTMLSelectElement) {
        const chosen = selectOption(el, entry);
        return { kind: 'select', value: chosen.value, label: chosen.label || chosen.textContent || '' };
      }
      if (el.isContentEditable) {
        setContentEditableValue(el, rawValue);
        return { kind: 'contenteditable', value: String(rawValue ?? '') };
      }
      throw new Error(`Element is not fillable: ${control.tag}`);
    };
    const findBestControl = (entry) => {
      const selector = normalize(entry.selector || entry.fieldSelector || '');
      if (selector) {
        const direct = deepQueryOne(selector);
        if (!direct) return null;
        const rect = direct.getBoundingClientRect();
        return {
          el: direct,
          tag: direct.tagName.toLowerCase(),
          type: (direct.getAttribute('type') || '').toLowerCase(),
          labelText: getLabelText(direct),
          hint: getControlHint(direct),
          valuePreview: normalize('value' in direct ? direct.value : direct.textContent || '').slice(0, 120),
          rect,
        };
      }
      const needles = hintSetFromEntry(entry);
      const ranked = deepControls
        .map((control) => ({
          ...control,
          score: scoreControl(control, entry, needles),
        }))
        .filter((item) => item.score >= 0)
        .sort((a, b) => b.score - a.score);
      return {
        best: ranked[0] || null,
        alternatives: ranked.slice(1, 5).map((item) => ({
          tag: item.tag,
          type: item.type || null,
          labelText: item.labelText || '',
          hint: item.hint.slice(0, 140),
          score: item.score,
        })),
      };
    };
    const buttonLikeNeedles = ['submit', 'send', 'save', 'continue', 'next', 'login', 'sign in', 'sign up', 'register', 'finish', 'upload', 'відправ', 'надісл', 'зберегти', 'далі', 'продовж', 'увійти', 'зареєстр', 'ок', 'apply'];
    const isSubmitLike = (text) => {
      const value = lower(text);
      return buttonLikeNeedles.some((needle) => value.includes(lower(needle)));
    };
    const findAndClickButton = (request) => {
      const selector = normalize(request.buttonSelector || request.selector || '');
      let button = null;
      if (selector) {
        button = deepQueryOne(selector);
        if (!button) throw new Error(`Button not found: ${selector}`);
      } else {
        const needles = [request.buttonText, request.text, request.label, request.value, request.key].map((item) => normalize(item)).filter(Boolean);
        const candidates = deepQueryAll('button, input[type="button"], input[type="submit"], a[role="button"], [role="button"], [onclick]')
          .filter(isVisible)
          .map((el) => ({
            el,
            text: normalize([
              el.innerText,
              el.textContent,
              el.getAttribute('aria-label'),
              el.getAttribute('title'),
              el.getAttribute('value'),
            ].filter(Boolean).join(' ')),
          }))
          .filter((item) => item.text);
        const ranked = candidates
          .map((item) => {
            let score = 0;
            for (const needle of needles) {
              const n = lower(needle);
              if (!n) continue;
              if (lower(item.text) === n) score += 1000;
              if (lower(item.text).startsWith(n)) score += 700;
              if (lower(item.text).includes(n)) score += 500;
            }
            if (request.exactButton) {
              score += needles.some((needle) => lower(item.text) === lower(needle)) ? 40 : 0;
            }
            return { ...item, score };
          })
          .filter((item) => item.score > 0)
          .sort((a, b) => b.score - a.score);
        button = ranked[0]?.el || null;
        if (!button && request.allowFallback) {
          button = candidates[0]?.el || null;
        }
        if (!button) return { clicked: false, reason: 'Button not found', buttonText: request.buttonText || null };
        if (!ranked[0] && !request.allowFallback) {
          return { clicked: false, reason: 'Button not matched', buttonText: request.buttonText || null };
        }
        const matchedText = ranked[0]?.text || candidates[0]?.text || '';
        const submitLike = isSubmitLike(matchedText);
        if (submitLike && !request.confirmSubmit) {
          return {
            clicked: false,
            blocked: true,
            reason: 'CONFIRMATION_REQUIRED',
            matchedText,
          };
        }
        button.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
        const rect = button.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        const eventInit = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: 1, view: window };
        button.dispatchEvent(new PointerEvent('pointerdown', eventInit));
        button.dispatchEvent(new MouseEvent('mousedown', eventInit));
        button.dispatchEvent(new PointerEvent('pointerup', eventInit));
        button.dispatchEvent(new MouseEvent('mouseup', eventInit));
        button.dispatchEvent(new MouseEvent('click', eventInit));
        if (typeof button.click === 'function') button.click();
        return {
          clicked: true,
          selector: selector || null,
          matchedText,
          submitLike,
        };
      }
      const text = normalize([
        button.innerText,
        button.textContent,
        button.getAttribute('aria-label'),
        button.getAttribute('title'),
        button.getAttribute('value'),
      ].filter(Boolean).join(' '));
      const submitLike = isSubmitLike(text);
      if (submitLike && !request.confirmSubmit) {
        return {
          clicked: false,
          blocked: true,
          reason: 'CONFIRMATION_REQUIRED',
          matchedText: text,
        };
      }
      button.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
      const rect = button.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const eventInit = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: 1, view: window };
      button.dispatchEvent(new PointerEvent('pointerdown', eventInit));
      button.dispatchEvent(new MouseEvent('mousedown', eventInit));
      button.dispatchEvent(new PointerEvent('pointerup', eventInit));
      button.dispatchEvent(new MouseEvent('mouseup', eventInit));
      button.dispatchEvent(new MouseEvent('click', eventInit));
      if (typeof button.click === 'function') button.click();
      return {
        clicked: true,
        selector: selector || null,
        matchedText: text,
        submitLike,
      };
    };
    const report = {
      ok: true,
      title: document.title,
      url: location.href,
      fields: [],
      unmatched: [],
      button: null,
    };
    for (const entry of fieldEntries) {
      const key = normalize(entry.key ?? entry.name ?? entry.label ?? entry.field ?? entry.selector ?? '');
      const value = entry.value;
      try {
        const match = findBestControl(entry);
        const control = match?.best || (match?.el ? match : null);
        if (!control?.el) {
          report.unmatched.push({
            key: key || null,
            valuePreview: String(value ?? '').slice(0, 120),
            reason: 'FIELD_NOT_FOUND',
            alternatives: match?.alternatives || [],
          });
          continue;
        }
        control.el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
        control.el.focus();
        const filled = fillControl(control, entry);
        report.fields.push({
          key: key || null,
          matchedTag: control.tag,
          matchedType: control.type || null,
          matchedHint: control.hint.slice(0, 180),
          valuePreview: String(value ?? '').slice(0, 120),
          ...filled,
        });
      } catch (error) {
        report.ok = false;
        report.fields.push({
          key: key || null,
          valuePreview: String(value ?? '').slice(0, 120),
          ok: false,
          error: error.message || String(error),
        });
      }
    }
    if (payload.clickButton || payload.buttonText || payload.buttonSelector) {
      try {
        const buttonResult = findAndClickButton(payload);
        report.button = buttonResult;
        if (buttonResult?.blocked) {
          report.ok = false;
        }
      } catch (error) {
        report.ok = false;
        report.button = {
          clicked: false,
          error: error.message || String(error),
        };
      }
    }
    return report;
  }, [{
    fields: params.fields || null,
    entries: params.entries || null,
    key: params.key || null,
    value: params.value,
    clickButton: !!params.clickButton,
    confirmSubmit: !!params.confirmSubmit,
    buttonText: params.buttonText || null,
    buttonSelector: params.buttonSelector || null,
    exactButton: !!params.exactButton,
    allowFallback: params.allowFallback === true,
  }], resolvedTabId, () => ({
    fieldCount: Array.isArray(params.entries) ? params.entries.length : (params.fields && typeof params.fields === 'object' ? Object.keys(params.fields).length : 0),
    clickButton: !!params.clickButton,
  }));
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
  const normalizedAction = normalizeCommandAction(command.action);
  pushCommandLog({
    action: normalizedAction,
    rawAction: command.action,
    paramsPreview: previewText(JSON.stringify(params)),
  });
  recordMacroAction(normalizedAction, params);
  switch (normalizedAction) {
    case 'getActiveTab':
      return await activeTab();
    case 'listTabs':
      return { tabs: await listTabs(!!params.currentWindowOnly) };
    case 'switchTab':
      return await switchTab(params.tabId);
    case 'openNewTab':
      return await openNewTab(params.url || 'about:blank', params.active !== false);
    case 'searchWeb':
      return await searchWeb(params.query || params.text || params.search || params.url || '', {
        engine: params.engine || 'bing',
        newTab: params.newTab !== false,
        active: params.active !== false,
        timeoutMs: params.timeoutMs || 15000,
        titleContains: params.titleContains || null,
        urlContains: params.urlContains || null,
      }, params.tabId ?? null);
    case 'redditComposeDraft':
      return await redditComposeDraft({
        subreddit: params.subreddit || null,
        title: params.title || '',
        body: params.body || '',
        timeoutMs: params.timeoutMs || 20000,
        titleContains: params.titleContains || 'Reddit',
      }, params.tabId ?? null);
    case 'universalFormAssist':
      return await universalFormAssist({
        fields: params.fields || null,
        entries: params.entries || null,
        key: params.key || null,
        value: params.value,
        clickButton: !!params.clickButton,
        confirmSubmit: !!params.confirmSubmit,
        buttonText: params.buttonText || null,
        buttonSelector: params.buttonSelector || null,
        exactButton: !!params.exactButton,
        allowFallback: params.allowFallback === true,
      }, params.tabId ?? null);
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
    case 'pageSummary':
      return await executeInTab((options) => {
        const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim();
        const visible = (el) => {
          if (!el) return false;
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
        };
        const controls = Array.from(document.querySelectorAll('a[href], button, input, select, textarea, [contenteditable="true"], [role="button"], [role="link"]'))
          .filter(visible)
          .slice(0, Math.max(1, Number(options.maxItems || 14)));
        const headings = Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6'))
          .filter(visible)
          .slice(0, Math.max(1, Number(options.maxItems || 14)))
          .map((el) => ({ level: el.tagName.toLowerCase(), text: norm(el.innerText || el.textContent || '').slice(0, 180) }))
          .filter((item) => item.text);
        const modals = Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"], dialog, [aria-modal="true"], .modal, .dialog, .popover, .toast'))
          .filter(visible)
          .slice(0, 8)
          .map((el) => norm(el.innerText || el.textContent || '').slice(0, 180))
          .filter(Boolean);
        const summary = [
          `Title: ${document.title || '(untitled)'}`,
          `URL: ${location.href}`,
          `Headings: ${headings.length}`,
          `Controls: ${controls.length}`,
          `Forms: ${document.forms.length}`,
          `Modals: ${modals.length}`,
        ];
        return {
          title: document.title,
          url: location.href,
          summary,
          summaryText: summary.join(' | '),
          headings,
          controls: controls.map((el) => ({
            tag: el.tagName.toLowerCase(),
            type: el.getAttribute('type') || null,
            role: el.getAttribute('role') || null,
            text: norm(el.innerText || el.textContent || el.value || '').slice(0, 120),
            placeholder: el.getAttribute('placeholder') || null,
            name: el.getAttribute('name') || null,
            id: el.id || null,
          })),
          modals,
        };
      }, [{ maxItems: params.maxItems || 14 }], params.tabId ?? null);
    case 'pageSectionReader':
      return await executeInTab((options) => {
        const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim();
        const visible = (el) => {
          if (!el) return false;
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
        };
        const sectionSelector = 'main, article, section, nav, aside, dialog, form, header, footer';
        const sections = Array.from(document.querySelectorAll(sectionSelector))
          .filter(visible)
          .slice(0, Math.max(1, Number(options.maxItems || 20)))
          .map((el, index) => {
            const heading = Array.from(el.querySelectorAll('h1, h2, h3, h4, h5, h6'))
              .find((node) => visible(node));
            const buttons = el.querySelectorAll('button, input[type="button"], input[type="submit"], [role="button"]').length;
            const inputs = el.querySelectorAll('input, select, textarea, [contenteditable="true"]').length;
            const text = norm(el.innerText || el.textContent || '').slice(0, 320);
            const rect = el.getBoundingClientRect();
            return {
              index,
              kind: el.tagName.toLowerCase(),
              heading: heading ? norm(heading.innerText || heading.textContent || '').slice(0, 140) : (el.getAttribute('aria-label') || el.getAttribute('title') || '').slice(0, 140),
              selector: el.id ? `#${CSS.escape(el.id)}` : el.tagName.toLowerCase(),
              text,
              buttons,
              inputs,
              links: el.querySelectorAll('a[href]').length,
              x: Math.round(rect.left),
              y: Math.round(rect.top),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
            };
          });
        const byHeading = Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6'))
          .filter(visible)
          .slice(0, Math.max(1, Number(options.maxItems || 20)))
          .map((el) => ({
            heading: norm(el.innerText || el.textContent || '').slice(0, 140),
            level: el.tagName.toLowerCase(),
            selector: el.id ? `#${CSS.escape(el.id)}` : el.tagName.toLowerCase(),
          }))
          .filter((item) => item.heading);
        return {
          title: document.title,
          url: location.href,
          sections,
          headings: byHeading,
        };
      }, [{ maxItems: params.maxItems || 20 }], params.tabId ?? null);
    case 'modalDetector':
      return await executeInTab((options) => {
        const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim();
        const visible = (el) => {
          if (!el) return false;
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
        };
        const modalSelectors = [
          '[role="dialog"]',
          '[role="alertdialog"]',
          'dialog',
          '[aria-modal="true"]',
          '.modal',
          '.dialog',
          '.popover',
          '.toast',
          '.dropdown-menu',
          '.menu',
          '.overlay',
        ];
        const modals = modalSelectors.flatMap((selector) => Array.from(document.querySelectorAll(selector)).map((el) => {
          if (!visible(el)) return null;
          const rect = el.getBoundingClientRect();
          const closeButtons = Array.from(el.querySelectorAll('button, [role="button"], [aria-label], [title]'))
            .filter(visible)
            .map((btn) => norm([
              btn.innerText,
              btn.textContent,
              btn.getAttribute('aria-label'),
              btn.getAttribute('title'),
              btn.getAttribute('value'),
            ].filter(Boolean).join(' ')))
            .filter(Boolean)
            .slice(0, 10);
          return {
            selector,
            tag: el.tagName.toLowerCase(),
            role: el.getAttribute('role') || null,
            text: norm(el.innerText || el.textContent || '').slice(0, 240),
            id: el.id || null,
            className: typeof el.className === 'string' ? el.className.split(/\s+/).slice(0, 4).join(' ') : null,
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            x: Math.round(rect.left),
            y: Math.round(rect.top),
            closeButtons,
          };
        }).filter(Boolean)).slice(0, Math.max(1, Number(options.maxItems || 12)));
        return {
          title: document.title,
          url: location.href,
          count: modals.length,
          modals,
        };
      }, [{ maxItems: params.maxItems || 12 }], params.tabId ?? null);
    case 'repeatedElementMatcher':
      return await executeInTab((options) => {
        const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim();
        const visible = (el) => {
          if (!el) return false;
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
        };
        const selectorMap = {
          all: 'a[href], button, input, select, textarea, [contenteditable="true"], [role], li, article, section, div, span',
          buttons: 'button, input[type="button"], input[type="submit"], [role="button"]',
          links: 'a[href], [role="link"]',
          inputs: 'input, select, textarea, [contenteditable="true"]',
          text: 'li, article, section, div, span, p, td, th',
        };
        const kind = String(options.kind || 'all').toLowerCase();
        const selector = selectorMap[kind] || selectorMap.all;
        const elements = Array.from(document.querySelectorAll(selector))
          .filter(visible)
          .slice(0, Math.max(1, Number(options.maxItems || 500)));
        const signatureFor = (el) => {
          const text = norm([
            el.innerText,
            el.textContent,
            el.value,
            el.getAttribute('aria-label'),
            el.getAttribute('placeholder'),
            el.getAttribute('name'),
            el.id,
          ].filter(Boolean).join(' ')).toLowerCase();
          return [
            el.tagName.toLowerCase(),
            el.getAttribute('role') || '',
            el.getAttribute('type') || '',
            text.slice(0, 100),
          ].join('|');
        };
        const groups = new Map();
        for (const el of elements) {
          const signature = signatureFor(el);
          if (!groups.has(signature)) {
            groups.set(signature, []);
          }
          groups.get(signature).push(el);
        }
        const repeated = Array.from(groups.entries())
          .filter(([, items]) => items.length > 1)
          .map(([signature, items]) => {
            const sample = items[0];
            const rect = sample.getBoundingClientRect();
            return {
              signature,
              count: items.length,
              tag: sample.tagName.toLowerCase(),
              role: sample.getAttribute('role') || null,
              type: sample.getAttribute('type') || null,
              sampleText: norm(sample.innerText || sample.textContent || sample.value || '').slice(0, 160),
              sampleSelector: sample.id ? `#${CSS.escape(sample.id)}` : sample.tagName.toLowerCase(),
              x: Math.round(rect.left),
              y: Math.round(rect.top),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
              items: items.slice(0, 10).map((el) => ({
                selector: el.id ? `#${CSS.escape(el.id)}` : el.tagName.toLowerCase(),
                text: norm(el.innerText || el.textContent || el.value || '').slice(0, 120),
              })),
            };
          })
          .sort((a, b) => b.count - a.count)
          .slice(0, Math.max(1, Number(options.maxGroups || 20)));
        return {
          title: document.title,
          url: location.href,
          kind,
          repeated,
        };
      }, [{ kind: params.kind || 'all', maxItems: params.maxItems || 500, maxGroups: params.maxGroups || 20 }], params.tabId ?? null);
    case 'nextVisibleControl':
      return await executeInTab((options) => {
        const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim();
        const visible = (el) => {
          if (!el) return false;
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
        };
        const controls = Array.from(document.querySelectorAll('a[href], button, input, select, textarea, [contenteditable="true"], [role="button"], [role="link"]'))
          .filter(visible);
        const selectorFor = (el) => {
          if (!el) return null;
          if (el.id) return `#${CSS.escape(el.id)}`;
          const name = el.getAttribute('name');
          if (name) return `${el.tagName.toLowerCase()}[name="${CSS.escape(name)}"]`;
          const role = el.getAttribute('role');
          if (role) return `${el.tagName.toLowerCase()}[role="${CSS.escape(role)}"]`;
          return el.tagName.toLowerCase();
        };
        const currentSelector = norm(options.selector || '');
        const current = currentSelector ? document.querySelector(currentSelector) : document.activeElement;
        let startIndex = current ? controls.indexOf(current) : -1;
        if (startIndex < 0 && current?.form) {
          startIndex = controls.findIndex((el) => el.form && el.form === current.form);
        }
        const wrap = options.wrap !== false;
        const nextIndex = startIndex >= 0 ? startIndex + 1 : 0;
        const chosen = controls[nextIndex] || (wrap ? controls[0] : null);
        if (!chosen) {
          return {
            ok: false,
            reason: 'No visible control found',
            controls: controls.length,
          };
        }
        const rect = chosen.getBoundingClientRect();
        const result = {
          ok: true,
          index: controls.indexOf(chosen),
          total: controls.length,
          tag: chosen.tagName.toLowerCase(),
          type: chosen.getAttribute('type') || null,
          role: chosen.getAttribute('role') || null,
          selector: selectorFor(chosen),
          text: norm(chosen.innerText || chosen.textContent || chosen.value || '').slice(0, 180),
          placeholder: chosen.getAttribute('placeholder') || null,
          name: chosen.getAttribute('name') || null,
          x: Math.round(rect.left),
          y: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        };
        if (options.focus !== false) {
          chosen.focus();
          chosen.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
        }
        if (options.click === true) {
          chosen.click();
          result.clicked = true;
        }
        return result;
      }, [{ selector: params.selector || null, wrap: params.wrap !== false, focus: params.focus !== false, click: !!params.click }], params.tabId ?? null);
    case 'semanticClick':
      return await runAndRemember('semanticClick', (intent, selector) => {
        const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim();
        const lower = (value) => norm(value).toLowerCase();
        const visible = (el) => {
          if (!el) return false;
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
        };
        const query = selector || null;
        const normalizeIntent = lower(intent);
        const intentMap = [
          { match: /(submit|send|save|continue|next|finish|apply|upload|відправ|надісл|зберегти|далі|продовж|увійти|register|sign up)/i, needles: ['submit', 'send', 'save', 'continue', 'next', 'finish', 'apply', 'upload', 'ok', 'continue', 'save changes', 'зберегти', 'далі', 'продовжити', 'увійти', 'зареєструватися'] },
          { match: /(close|dismiss|cancel|back|закр|відміни|сховай|hide|x)/i, needles: ['close', 'dismiss', 'cancel', 'back', 'ok', 'done', 'закрити', 'скасувати', 'відмінити', 'x', '×'] },
          { match: /(search|find|query|пошук)/i, needles: ['search', 'find', 'submit', 'ok', 'пошук'] },
          { match: /(open first result|first result|open result)/i, needles: ['a[href]', 'button', 'result'] },
          { match: /(login|sign in|log in|auth)/i, needles: ['login', 'sign in', 'sign in', 'увійти', 'login'] },
        ];
        const matchedRule = intentMap.find((rule) => rule.match.test(normalizeIntent)) || null;
        const candidateSelectors = query ? [query] : [];
        if (matchedRule?.needles?.includes('a[href]')) {
          const firstLink = Array.from(document.querySelectorAll('a[href]')).find((el) => visible(el));
          if (firstLink) candidateSelectors.unshift(firstLink.id ? `#${CSS.escape(firstLink.id)}` : 'a[href]');
        }
        const controlQuery = query || 'a[href], button, input, select, textarea, [contenteditable="true"], [role="button"], [role="link"]';
        const candidates = Array.from(document.querySelectorAll(controlQuery)).filter(visible);
        const scoreCandidate = (el) => {
          const hay = lower([
            el.innerText,
            el.textContent,
            el.value,
            el.getAttribute('aria-label'),
            el.getAttribute('placeholder'),
            el.getAttribute('title'),
            el.getAttribute('name'),
            el.id,
          ].filter(Boolean).join(' '));
          let score = 0;
          const needles = matchedRule?.needles || [normalizeIntent];
          for (const needle of needles) {
            const n = lower(needle);
            if (!n) continue;
            if (hay === n) score += 1000;
            if (hay.startsWith(n)) score += 700;
            if (hay.includes(n)) score += 500;
          }
          if (hay.includes('result') && /result/.test(normalizeIntent)) score += 120;
          if (el.tagName === 'BUTTON') score += 30;
          return score;
        };
        const ranked = candidates
          .map((el) => ({ el, score: scoreCandidate(el) }))
          .filter((item) => item.score >= 0)
          .sort((a, b) => b.score - a.score);
        let target = ranked[0]?.el || null;
        if (!target && matchedRule?.match?.test(normalizeIntent) && normalizeIntent.includes('first result')) {
          target = Array.from(document.querySelectorAll('a[href]')).find((el) => visible(el)) || null;
        }
        if (!target && selector) {
          target = document.querySelector(selector);
        }
        if (!target) throw new Error(`No semantic click target found for: ${intent}`);
        target.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
        const rect = target.getBoundingClientRect();
        target.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, button: 0, buttons: 1, view: window }));
        target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, button: 0, buttons: 1, view: window }));
        target.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, cancelable: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, button: 0, buttons: 1, view: window }));
        target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, button: 0, buttons: 1, view: window }));
        target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, button: 0, buttons: 1, view: window }));
        if (typeof target.click === 'function') target.click();
        return {
          clicked: true,
          intent,
          selector: target.id ? `#${CSS.escape(target.id)}` : target.tagName.toLowerCase(),
          tag: target.tagName.toLowerCase(),
          text: norm(target.innerText || target.textContent || target.value || '').slice(0, 160),
        };
      }, [params.intent || params.text || '', params.selector || null], params.tabId ?? null, () => ({
        intent: params.intent || params.text || '',
        selector: params.selector || null,
      }));
    case 'pageDiffMemory':
      return await executeInTab((options) => {
        const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim();
        const visible = (el) => {
          if (!el) return false;
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
        };
        const snapshot = {
          title: document.title,
          url: location.href,
          headingTexts: Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6')).filter(visible).slice(0, 20).map((el) => norm(el.innerText || el.textContent || '').slice(0, 120)),
          controlSignatures: Array.from(document.querySelectorAll('a[href], button, input, select, textarea, [contenteditable="true"], [role="button"], [role="link"]'))
            .filter(visible)
            .slice(0, 100)
            .map((el) => [
              el.tagName.toLowerCase(),
              el.getAttribute('role') || '',
              el.getAttribute('type') || '',
              norm(el.innerText || el.textContent || el.value || '').slice(0, 80),
              el.id || '',
              el.getAttribute('name') || '',
            ].join('|')),
          modalSignatures: Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"], dialog, [aria-modal="true"], .modal, .dialog, .popover, .toast'))
            .filter(visible)
            .slice(0, 20)
            .map((el) => norm(el.innerText || el.textContent || '').slice(0, 120)),
          activeElement: document.activeElement ? {
            tag: document.activeElement.tagName?.toLowerCase?.() || null,
            type: document.activeElement.getAttribute?.('type') || null,
            id: document.activeElement.id || null,
            name: document.activeElement.getAttribute?.('name') || null,
            placeholder: document.activeElement.getAttribute?.('placeholder') || null,
            text: norm(document.activeElement.innerText || document.activeElement.textContent || document.activeElement.value || '').slice(0, 120),
          } : null,
        };
        const snapshotKey = String(options.tabId);
        const previous = sessionMemory.pageSnapshotsByTab[snapshotKey] || null;
        const diffSignature = (listA, listB) => {
          const a = new Set(listA || []);
          const b = new Set(listB || []);
          return {
            added: Array.from(a).filter((item) => !b.has(item)).slice(0, 100),
            removed: Array.from(b).filter((item) => !a.has(item)).slice(0, 100),
          };
        };
        const diff = previous ? {
          titleChanged: previous.title !== snapshot.title,
          urlChanged: previous.url !== snapshot.url,
          headingDiff: diffSignature(snapshot.headingTexts, previous.headingTexts),
          controlDiff: diffSignature(snapshot.controlSignatures, previous.controlSignatures),
          modalDiff: diffSignature(snapshot.modalSignatures, previous.modalSignatures),
          activeElementChanged: JSON.stringify(previous.activeElement || null) !== JSON.stringify(snapshot.activeElement || null),
          previousCounts: {
            headings: previous.headingTexts?.length || 0,
            controls: previous.controlSignatures?.length || 0,
            modals: previous.modalSignatures?.length || 0,
          },
          currentCounts: {
            headings: snapshot.headingTexts.length,
            controls: snapshot.controlSignatures.length,
            modals: snapshot.modalSignatures.length,
          },
        } : {
          firstSnapshot: true,
        };
        sessionMemory.pageSnapshotsByTab[snapshotKey] = snapshot;
        return {
          title: document.title,
          url: location.href,
          previousExists: !!previous,
          current: snapshot,
          diff,
        };
      }, [{ tabId: await resolveTargetTabId(params.tabId ?? null) }], params.tabId ?? null);
    case 'resolveDomRoute':
      return await executeInTab((options) => {
        const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim();
        const lower = (value) => norm(value).toLowerCase();
        const selector = norm(options.selector || '');
        const needle = norm(options.needle || '');
        const exact = !!options.exact;
        const visible = (el) => {
          if (!el) return false;
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
        };
        const candidateSelectors = [
          selector,
          needle ? null : null,
        ].filter(Boolean);
        let element = selector ? document.querySelector(selector) : null;
        if (!element && needle) {
          const targets = Array.from(document.querySelectorAll('a[href], button, input, select, textarea, [contenteditable="true"], [role="button"], [role="link"], summary, [role], div, span, p'))
            .filter(visible);
          const ranked = targets.map((el) => {
            const hay = lower([
              el.innerText,
              el.textContent,
              el.value,
              el.getAttribute('aria-label'),
              el.getAttribute('placeholder'),
              el.getAttribute('title'),
              el.getAttribute('name'),
              el.id,
            ].filter(Boolean).join(' '));
            let score = 0;
            const target = lower(needle);
            if (exact) {
              score = hay === target ? 1000 : -1;
            } else {
              if (hay === target) score += 1000;
              if (hay.startsWith(target)) score += 700;
              if (hay.includes(target)) score += 500;
            }
            return { el, score };
          }).filter((item) => item.score >= 0).sort((a, b) => b.score - a.score);
          element = ranked[0]?.el || null;
        }
        if (!element) throw new Error('Element not found');
        const selectorFor = (el) => {
          if (!el) return null;
          if (el.id) return `#${CSS.escape(el.id)}`;
          const name = el.getAttribute('name');
          if (name) return `${el.tagName.toLowerCase()}[name="${CSS.escape(name)}"]`;
          const role = el.getAttribute('role');
          if (role) return `${el.tagName.toLowerCase()}[role="${CSS.escape(role)}"]`;
          return el.tagName.toLowerCase();
        };
        const ancestry = [];
        let node = element;
        while (node && node !== document.documentElement) {
          ancestry.push({
            tag: node.tagName?.toLowerCase?.() || node.nodeName?.toLowerCase?.() || null,
            selector: node.nodeType === Node.ELEMENT_NODE ? selectorFor(node) : null,
            id: node.id || null,
            role: node.getAttribute?.('role') || null,
            name: node.getAttribute?.('name') || null,
          });
          node = node.parentElement || (node.assignedSlot || null);
        }
        const framePath = [];
        let owner = element.ownerDocument;
        while (owner && owner.defaultView && owner.defaultView.frameElement) {
          const frame = owner.defaultView.frameElement;
          framePath.push({
            selector: selectorFor(frame),
            tag: frame.tagName.toLowerCase(),
            id: frame.id || null,
            name: frame.getAttribute('name') || null,
            title: frame.getAttribute('title') || null,
            src: frame.getAttribute('src') || null,
          });
          owner = frame.ownerDocument;
        }
        const shadowPath = [];
        let root = element.getRootNode();
        while (root && root.host) {
          const host = root.host;
          shadowPath.push({
            selector: selectorFor(host),
            tag: host.tagName.toLowerCase(),
            id: host.id || null,
            name: host.getAttribute('name') || null,
            role: host.getAttribute('role') || null,
          });
          root = host.getRootNode();
        }
        const rect = element.getBoundingClientRect();
        return {
          title: document.title,
          url: location.href,
          selector: selectorFor(element),
          route: {
            framePath,
            shadowPath,
            ancestry: ancestry.slice(0, 40),
          },
          element: {
            tag: element.tagName.toLowerCase(),
            type: element.getAttribute('type') || null,
            role: element.getAttribute('role') || null,
            text: norm(element.innerText || element.textContent || element.value || '').slice(0, 180),
            x: Math.round(rect.left),
            y: Math.round(rect.top),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          },
        };
      }, [{ selector: params.selector || null, needle: params.needle || null, exact: !!params.exact }], params.tabId ?? null);
    case 'pageDomOutline':
      return await executeInTab((options) => {
        const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim();
        const maxItems = Math.max(1, Number(options.maxItems || 80));
        const includeFrames = options.includeFrames !== false;
        const includeShadowDom = options.includeShadowDom !== false;
        const includeTextBlocks = options.includeTextBlocks !== false;
        const isVisible = (el) => {
          if (!el) return false;
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
        };
        const seenRoots = new Set();
        const roots = [];
        const pushRoot = (root) => {
          if (!root || seenRoots.has(root)) return;
          seenRoots.add(root);
          roots.push(root);
        };
        pushRoot(document);
        let index = 0;
        while (index < roots.length) {
          const root = roots[index];
          index += 1;
          const all = root.querySelectorAll ? Array.from(root.querySelectorAll('*')) : [];
          if (includeShadowDom) {
            for (const el of all) {
              if (el.shadowRoot) pushRoot(el.shadowRoot);
            }
          }
          if (includeFrames) {
            for (const frame of Array.from(root.querySelectorAll('iframe, frame'))) {
              try {
                if (frame.contentDocument) pushRoot(frame.contentDocument);
              } catch {
                // Cross-origin frame skipped.
              }
            }
          }
        }
        const qAll = (selector) => {
          const out = [];
          const seen = new Set();
          for (const root of roots) {
            if (!root.querySelectorAll) continue;
            for (const el of Array.from(root.querySelectorAll(selector))) {
              if (seen.has(el)) continue;
              seen.add(el);
              out.push(el);
            }
          }
          return out;
        };
        const selectorFor = (el) => {
          if (!el) return null;
          if (el.id) return `#${CSS.escape(el.id)}`;
          const name = el.getAttribute('name');
          if (name) return `${el.tagName.toLowerCase()}[name="${CSS.escape(name)}"]`;
          const role = el.getAttribute('role');
          if (role) return `${el.tagName.toLowerCase()}[role="${CSS.escape(role)}"]`;
          return el.tagName.toLowerCase();
        };
        const labelTextFor = (el) => {
          const parts = [];
          if (el.id) {
            for (const label of Array.from(qAll('label'))) {
              if (label.htmlFor === el.id) parts.push(label.innerText || label.textContent || '');
            }
          }
          const closest = el.closest('label');
          if (closest) parts.push(closest.innerText || closest.textContent || '');
          return norm(parts.join(' '));
        };
        const collect = (selector, kind) => qAll(selector).filter(isVisible).slice(0, maxItems).map((el) => {
          const rect = el.getBoundingClientRect();
          return {
            kind,
            tag: el.tagName.toLowerCase(),
            type: el.getAttribute('type') || null,
            role: el.getAttribute('role') || null,
            selector: selectorFor(el),
            text: norm(el.innerText || el.textContent || el.value || '').slice(0, 180),
            label: labelTextFor(el).slice(0, 180),
            placeholder: el.getAttribute('placeholder') || null,
            name: el.getAttribute('name') || null,
            id: el.id || null,
            href: el.href || null,
            visible: true,
            x: Math.round(rect.left),
            y: Math.round(rect.top),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          };
        });
        const headings = collect('h1, h2, h3, h4, h5, h6', 'heading');
        const forms = qAll('form').slice(0, maxItems).map((form, index) => {
          const rect = form.getBoundingClientRect();
          const fields = Array.from(form.elements || []).slice(0, 40).map((field) => {
            const fRect = field.getBoundingClientRect ? field.getBoundingClientRect() : { left: 0, top: 0, width: 0, height: 0 };
            return {
              tag: field.tagName?.toLowerCase?.() || null,
              type: field.getAttribute?.('type') || null,
              name: field.getAttribute?.('name') || null,
              id: field.id || null,
              selector: selectorFor(field),
              label: labelTextFor(field).slice(0, 160),
              placeholder: field.getAttribute?.('placeholder') || null,
              valuePreview: String('value' in field ? field.value || '' : '').slice(0, 80),
              visible: isVisible(field),
              x: Math.round(fRect.left || 0),
              y: Math.round(fRect.top || 0),
              width: Math.round(fRect.width || 0),
              height: Math.round(fRect.height || 0),
            };
          });
          return {
            kind: 'form',
            index,
            selector: selectorFor(form),
            id: form.id || null,
            name: form.getAttribute('name') || null,
            action: form.getAttribute('action') || null,
            method: form.getAttribute('method') || 'get',
            fieldCount: form.elements?.length || 0,
            x: Math.round(rect.left),
            y: Math.round(rect.top),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            fields,
          };
        });
        const controls = [
          ...collect('input, textarea, select, button, [contenteditable="true"]', 'control'),
          ...collect('a[href], [role="button"], [role="link"], summary', 'interactive'),
        ].slice(0, maxItems);
        const landmarks = ['header', 'nav', 'main', 'aside', 'footer', '[role="main"]', '[role="navigation"]', '[role="dialog"]']
          .flatMap((selector) => collect(selector, 'landmark'))
          .slice(0, maxItems);
        const textBlocks = includeTextBlocks
          ? qAll('p, li, blockquote, article, section, td, th, figcaption')
            .filter(isVisible)
            .slice(0, maxItems)
            .map((el) => {
              const rect = el.getBoundingClientRect();
              return {
                kind: 'text',
                tag: el.tagName.toLowerCase(),
                selector: selectorFor(el),
                text: norm(el.innerText || el.textContent || '').slice(0, 240),
                x: Math.round(rect.left),
                y: Math.round(rect.top),
                width: Math.round(rect.width),
                height: Math.round(rect.height),
              };
            })
          : [];
        return {
          title: document.title,
          url: location.href,
          counts: {
            headings: headings.length,
            forms: forms.length,
            controls: controls.length,
            landmarks: landmarks.length,
            textBlocks: textBlocks.length,
            frames: qAll('iframe, frame').length,
            shadowHosts: qAll('*').filter((el) => !!el.shadowRoot).length,
          },
          headings,
          forms,
          controls,
          landmarks,
          textBlocks,
        };
      }, [{
        maxItems: params.maxItems || 80,
        includeFrames: params.includeFrames !== false,
        includeShadowDom: params.includeShadowDom !== false,
        includeTextBlocks: params.includeTextBlocks !== false,
      }], params.tabId ?? null);
    case 'pageDomSnapshot':
      return await executeInTab((options) => {
        const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim();
        const lower = (value) => norm(value).toLowerCase();
        const includeHidden = !!options.includeHidden;
        const includeFrames = options.includeFrames !== false;
        const includeShadowDom = options.includeShadowDom !== false;
        const maxItems = Math.max(1, Number(options.maxItems || 120));
        const seenRoots = new Set();
        const roots = [];
        const pushRoot = (root) => {
          if (!root || seenRoots.has(root)) return;
          seenRoots.add(root);
          roots.push(root);
        };
        pushRoot(document);
        const visible = (el) => {
          if (!el) return false;
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
        };
        const isDeepRoot = (node) => node && (node.nodeType === Node.DOCUMENT_NODE || node instanceof ShadowRoot);
        const collectRoots = () => {
          let index = 0;
          while (index < roots.length) {
            const root = roots[index];
            index += 1;
            const elements = root.querySelectorAll ? Array.from(root.querySelectorAll('*')) : [];
            if (includeShadowDom) {
              for (const el of elements) {
                if (el.shadowRoot) pushRoot(el.shadowRoot);
              }
            }
            if (includeFrames) {
              for (const frame of Array.from(root.querySelectorAll('iframe, frame'))) {
                try {
                  if (frame.contentDocument && isDeepRoot(frame.contentDocument)) {
                    pushRoot(frame.contentDocument);
                  }
                } catch {
                  // Cross-origin frames are skipped.
                }
              }
            }
          }
        };
        collectRoots();
        const queryAllDeep = (selector) => {
          const results = [];
          const seen = new Set();
          for (const root of roots) {
            if (!root.querySelectorAll) continue;
            for (const el of Array.from(root.querySelectorAll(selector))) {
              if (seen.has(el)) continue;
              seen.add(el);
              results.push(el);
            }
          }
          return results;
        };
        const queryDeep = (selector) => {
          for (const root of roots) {
            if (!root.querySelector) continue;
            const found = root.querySelector(selector);
            if (found) return found;
          }
          return null;
        };
        const selectorFor = (el) => {
          if (!el) return null;
          if (el.id) return `#${CSS.escape(el.id)}`;
          const name = el.getAttribute('name');
          if (name) return `${el.tagName.toLowerCase()}[name="${CSS.escape(name)}"]`;
          const aria = el.getAttribute('aria-label');
          if (aria) return `${el.tagName.toLowerCase()}[aria-label="${CSS.escape(aria.slice(0, 40))}"]`;
          const role = el.getAttribute('role');
          if (role) return `${el.tagName.toLowerCase()}[role="${CSS.escape(role)}"]`;
          return el.tagName.toLowerCase();
        };
        const labelTextFor = (el) => {
          const parts = [];
          if (el.id) {
            for (const label of Array.from(queryAllDeep('label'))) {
              if (label.htmlFor === el.id) parts.push(label.innerText || label.textContent || '');
            }
            const ids = String(el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean);
            for (const id of ids) {
              const ref = queryDeep(`#${CSS.escape(id)}`);
              if (ref) parts.push(ref.innerText || ref.textContent || '');
            }
          }
          const closest = el.closest('label');
          if (closest) parts.push(closest.innerText || closest.textContent || '');
          const parent = el.parentElement?.innerText || '';
          if (parent) parts.push(parent);
          return norm(parts.join(' '));
        };
        const controlHint = (el) => norm([
          el.getAttribute('aria-label'),
          el.getAttribute('placeholder'),
          el.getAttribute('name'),
          el.id,
          el.getAttribute('title'),
          el.getAttribute('autocomplete'),
          el.getAttribute('data-testid'),
          el.getAttribute('data-test'),
          el.getAttribute('role'),
          labelTextFor(el),
        ].filter(Boolean).join(' '));
        const controlEntries = queryAllDeep('a, button, input, select, textarea, [contenteditable="true"], [role="button"], [role="link"], summary')
          .filter((el) => includeHidden || visible(el))
          .slice(0, maxItems)
          .map((el) => {
            const rect = el.getBoundingClientRect();
            const tag = el.tagName.toLowerCase();
            const type = el.getAttribute('type') || null;
            const text = norm(el.innerText || el.textContent || el.value || '').slice(0, 220);
            return {
              tag,
              type,
              role: el.getAttribute('role') || null,
              selector: selectorFor(el),
              text,
              label: labelTextFor(el).slice(0, 220),
              hint: controlHint(el).slice(0, 220),
              id: el.id || null,
              name: el.getAttribute('name') || null,
              href: el.href || null,
              valuePreview: ('value' in el ? String(el.value || '') : '').slice(0, 120),
              visible: visible(el),
              x: Math.round(rect.left),
              y: Math.round(rect.top),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
            };
          });
        const formEntries = Array.from(document.forms).slice(0, maxItems).map((form, index) => {
          const fields = Array.from(form.elements || []).slice(0, 80).map((field) => {
            const rect = field.getBoundingClientRect?.() || { left: 0, top: 0, width: 0, height: 0 };
            return {
              tag: field.tagName?.toLowerCase?.() || null,
              type: field.getAttribute?.('type') || null,
              name: field.getAttribute?.('name') || null,
              id: field.id || null,
              selector: field.id ? `#${CSS.escape(field.id)}` : field.getAttribute?.('name') ? `${field.tagName.toLowerCase()}[name="${CSS.escape(field.getAttribute('name'))}"]` : field.tagName?.toLowerCase?.() || null,
              label: labelTextFor(field).slice(0, 220),
              hint: controlHint(field).slice(0, 220),
              placeholder: field.getAttribute?.('placeholder') || null,
              valuePreview: String('value' in field ? field.value || '' : '').slice(0, 120),
              required: !!field.required,
              disabled: !!field.disabled,
              visible: visible(field),
              x: Math.round(rect.left || 0),
              y: Math.round(rect.top || 0),
              width: Math.round(rect.width || 0),
              height: Math.round(rect.height || 0),
            };
          });
          return {
            index,
            id: form.id || null,
            name: form.getAttribute('name') || null,
            action: form.getAttribute('action') || null,
            method: form.getAttribute('method') || 'get',
            selector: form.id ? `#${CSS.escape(form.id)}` : 'form',
            fieldCount: form.elements?.length || 0,
            fields,
          };
        });
        const frameEntries = includeFrames ? Array.from(queryAllDeep('iframe, frame')).slice(0, maxItems).map((frame, index) => {
          const rect = frame.getBoundingClientRect();
          let sameOrigin = false;
          let innerTitle = null;
          let innerUrl = null;
          let innerControlCount = null;
          try {
            const doc = frame.contentDocument;
            sameOrigin = !!doc;
            innerTitle = doc?.title || null;
            innerUrl = doc?.location?.href || null;
            innerControlCount = doc ? doc.querySelectorAll('a, button, input, select, textarea').length : null;
          } catch {
            sameOrigin = false;
          }
          return {
            index,
            tag: frame.tagName.toLowerCase(),
            id: frame.id || null,
            name: frame.getAttribute('name') || null,
            title: frame.getAttribute('title') || null,
            src: frame.getAttribute('src') || null,
            selector: frame.id ? `#${CSS.escape(frame.id)}` : frame.tagName.toLowerCase(),
            sameOrigin,
            innerTitle,
            innerUrl,
            innerControlCount,
            visible: visible(frame),
            x: Math.round(rect.left),
            y: Math.round(rect.top),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          };
        }) : [];
        const shadowHosts = includeShadowDom ? queryAllDeep('*')
          .filter((el) => !!el.shadowRoot)
          .slice(0, maxItems)
          .map((el) => {
            const rect = el.getBoundingClientRect();
            return {
              tag: el.tagName.toLowerCase(),
              id: el.id || null,
              name: el.getAttribute('name') || null,
              role: el.getAttribute('role') || null,
              selector: selectorFor(el),
              childCount: el.shadowRoot?.querySelectorAll('*').length || 0,
              visible: visible(el),
              x: Math.round(rect.left),
              y: Math.round(rect.top),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
            };
          }) : [];
        const scrollContainers = queryAllDeep('*')
          .filter((el) => {
            if (!visible(el)) return false;
            const style = window.getComputedStyle(el);
            const overflowY = `${style.overflowY || ''}`.toLowerCase();
            const overflowX = `${style.overflowX || ''}`.toLowerCase();
            const rect = el.getBoundingClientRect();
            return (
              ['auto', 'scroll', 'overlay'].includes(overflowY) ||
              ['auto', 'scroll', 'overlay'].includes(overflowX)
            ) && rect.height > 0 && rect.width > 0;
          })
          .slice(0, maxItems)
          .map((el) => {
            const rect = el.getBoundingClientRect();
            return {
              tag: el.tagName.toLowerCase(),
              selector: selectorFor(el),
              text: norm(el.innerText || el.textContent || '').slice(0, 140),
              scrollHeight: el.scrollHeight,
              scrollWidth: el.scrollWidth,
              clientHeight: el.clientHeight,
              clientWidth: el.clientWidth,
              x: Math.round(rect.left),
              y: Math.round(rect.top),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
            };
          });
        const active = document.activeElement ? {
          tag: document.activeElement.tagName?.toLowerCase?.() || null,
          type: document.activeElement.getAttribute?.('type') || null,
          id: document.activeElement.id || null,
          name: document.activeElement.getAttribute?.('name') || null,
          placeholder: document.activeElement.getAttribute?.('placeholder') || null,
          ariaLabel: document.activeElement.getAttribute?.('aria-label') || null,
          selector: selectorFor(document.activeElement),
        } : null;
        return {
          title: document.title,
          url: location.href,
          lang: document.documentElement?.lang || null,
          counts: {
            headings: document.querySelectorAll('h1, h2, h3, h4, h5, h6').length,
            links: queryAllDeep('a[href]').length,
            buttons: queryAllDeep('button, input[type="button"], input[type="submit"], [role="button"]').length,
            inputs: queryAllDeep('input, select, textarea, [contenteditable="true"]').length,
            forms: document.forms.length,
            frames: frameEntries.length,
            shadowHosts: shadowHosts.length,
            scrollContainers: scrollContainers.length,
          },
          activeElement: active,
          headings: Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6')).slice(0, maxItems).map((el) => ({
            level: el.tagName.toLowerCase(),
            text: norm(el.innerText || el.textContent || '').slice(0, 200),
          })).filter((item) => item.text),
          landmarks: ['header', 'nav', 'main', 'aside', 'footer', '[role="dialog"]', '[role="main"]', '[role="navigation"]']
            .flatMap((selector) => Array.from(document.querySelectorAll(selector)).map((el) => ({
              selector,
              tag: el.tagName.toLowerCase(),
              text: norm(el.innerText || el.textContent || '').slice(0, 120),
            })))
            .slice(0, maxItems),
          controls: controlEntries,
          forms: formEntries,
          frames: frameEntries,
          shadowHosts,
          scrollContainers,
        };
      }, [{
        maxItems: params.maxItems || 120,
        includeHidden: !!params.includeHidden,
        includeFrames: params.includeFrames !== false,
        includeShadowDom: params.includeShadowDom !== false,
      }], params.tabId ?? null);
    case 'findDomControl':
      return await executeInTab((needle, options) => {
        const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim();
        const lower = (value) => norm(value).toLowerCase();
        const exact = !!options.exact;
        const maxItems = Math.max(1, Number(options.maxItems || 20));
        const includeFrames = options.includeFrames !== false;
        const includeShadowDom = options.includeShadowDom !== false;
        const kind = String(options.kind || 'all').toLowerCase();
        const target = lower(needle);
        if (!target) throw new Error('needle is required');
        const seenRoots = new Set();
        const roots = [];
        const pushRoot = (root) => {
          if (!root || seenRoots.has(root)) return;
          seenRoots.add(root);
          roots.push(root);
        };
        pushRoot(document);
        const visible = (el) => {
          if (!el) return false;
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
        };
        const selectorFor = (el) => {
          if (!el) return null;
          if (el.id) return `#${CSS.escape(el.id)}`;
          const name = el.getAttribute('name');
          if (name) return `${el.tagName.toLowerCase()}[name="${CSS.escape(name)}"]`;
          const aria = el.getAttribute('aria-label');
          if (aria) return `${el.tagName.toLowerCase()}[aria-label="${CSS.escape(aria.slice(0, 40))}"]`;
          const role = el.getAttribute('role');
          if (role) return `${el.tagName.toLowerCase()}[role="${CSS.escape(role)}"]`;
          return el.tagName.toLowerCase();
        };
        const labelTextFor = (el) => {
          const parts = [];
          if (el.id) {
            for (const label of Array.from(document.querySelectorAll('label'))) {
              if (label.htmlFor === el.id) parts.push(label.innerText || label.textContent || '');
            }
          }
          const closest = el.closest('label');
          if (closest) parts.push(closest.innerText || closest.textContent || '');
          return norm(parts.join(' '));
        };
        const traverseRoots = () => {
          let index = 0;
          while (index < roots.length) {
            const root = roots[index];
            index += 1;
            const elements = root.querySelectorAll ? Array.from(root.querySelectorAll('*')) : [];
            if (includeShadowDom) {
              for (const el of elements) {
                if (el.shadowRoot) pushRoot(el.shadowRoot);
              }
            }
            if (includeFrames) {
              for (const frame of Array.from(root.querySelectorAll('iframe, frame'))) {
                try {
                  if (frame.contentDocument) pushRoot(frame.contentDocument);
                } catch {
                  // Cross-origin frame skipped.
                }
              }
            }
          }
        };
        traverseRoots();
        const candidates = [];
        const allSelectors = {
          all: 'a, button, input, select, textarea, [contenteditable="true"], [role], summary',
          inputs: 'input, select, textarea, [contenteditable="true"]',
          buttons: 'button, input[type="button"], input[type="submit"], [role="button"]',
          links: 'a[href], [role="link"]',
          forms: 'form',
          text: 'body *',
        };
        const selector = allSelectors[kind] || allSelectors.all;
        for (const root of roots) {
          if (!root.querySelectorAll) continue;
          for (const el of Array.from(root.querySelectorAll(selector))) {
            if (!visible(el)) continue;
            const text = norm([
              el.innerText,
              el.textContent,
              el.value,
              el.getAttribute('aria-label'),
              el.getAttribute('placeholder'),
              labelTextFor(el),
            ].filter(Boolean).join(' '));
            if (!text) continue;
            const hint = lower([
              el.getAttribute('aria-label'),
              el.getAttribute('placeholder'),
              el.getAttribute('name'),
              el.id,
              el.getAttribute('title'),
              el.getAttribute('role'),
              labelTextFor(el),
            ].filter(Boolean).join(' '));
            const candidateScore = (() => {
              const hay = lower(text);
              if (!hay) return -1;
              if (exact) {
                return hay === target ? 1000 : -1;
              }
              let score = 0;
              if (hay === target) score += 1000;
              if (hay.startsWith(target)) score += 700;
              if (hay.includes(target)) score += 500;
              const pieces = target.split(' ').filter(Boolean);
              if (pieces.length) {
                const overlap = pieces.filter((piece) => hay.includes(piece)).length;
                score += overlap * 80;
              }
              if (hint.includes(target)) score += 120;
              return score > 0 ? score : -1;
            })();
            if (candidateScore < 0) continue;
            const rect = el.getBoundingClientRect();
            candidates.push({
              tag: el.tagName.toLowerCase(),
              type: el.getAttribute('type') || null,
              role: el.getAttribute('role') || null,
              text: text.slice(0, 220),
              label: labelTextFor(el).slice(0, 220),
              hint: hint.slice(0, 220),
              selector: selectorFor(el),
              href: el.href || null,
              id: el.id || null,
              name: el.getAttribute('name') || null,
              visible: true,
              score: candidateScore,
              x: Math.round(rect.left),
              y: Math.round(rect.top),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
            });
          }
        }
        candidates.sort((a, b) => b.score - a.score);
        return {
          needle: target,
          exact,
          kind,
          matches: candidates.slice(0, maxItems),
        };
      }, [params.needle, {
        kind: params.kind || 'all',
        exact: !!params.exact,
        maxItems: params.maxItems || 20,
        includeFrames: params.includeFrames !== false,
        includeShadowDom: params.includeShadowDom !== false,
      }], params.tabId ?? null);
    case 'describeDomElement':
      return await executeInTab((payload) => {
        const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim();
        const lower = (value) => norm(value).toLowerCase();
        const includeFrames = payload.includeFrames !== false;
        const includeShadowDom = payload.includeShadowDom !== false;
        const selector = norm(payload.selector || '');
        const needle = norm(payload.needle || '');
        const exact = !!payload.exact;
        const seenRoots = new Set();
        const roots = [];
        const pushRoot = (root) => {
          if (!root || seenRoots.has(root)) return;
          seenRoots.add(root);
          roots.push(root);
        };
        pushRoot(document);
        let index = 0;
        while (index < roots.length) {
          const root = roots[index];
          index += 1;
          const all = root.querySelectorAll ? Array.from(root.querySelectorAll('*')) : [];
          if (includeShadowDom) {
            for (const el of all) {
              if (el.shadowRoot) pushRoot(el.shadowRoot);
            }
          }
          if (includeFrames) {
            for (const frame of Array.from(root.querySelectorAll('iframe, frame'))) {
              try {
                if (frame.contentDocument) pushRoot(frame.contentDocument);
              } catch {
                // Cross-origin frame skipped.
              }
            }
          }
        }
        const qAll = (query) => {
          const out = [];
          const seen = new Set();
          for (const root of roots) {
            if (!root.querySelectorAll) continue;
            for (const el of Array.from(root.querySelectorAll(query))) {
              if (seen.has(el)) continue;
              seen.add(el);
              out.push(el);
            }
          }
          return out;
        };
        const selectorFor = (el) => {
          if (!el) return null;
          if (el.id) return `#${CSS.escape(el.id)}`;
          const name = el.getAttribute('name');
          if (name) return `${el.tagName.toLowerCase()}[name="${CSS.escape(name)}"]`;
          const role = el.getAttribute('role');
          if (role) return `${el.tagName.toLowerCase()}[role="${CSS.escape(role)}"]`;
          return el.tagName.toLowerCase();
        };
        const labelTextFor = (el) => {
          const parts = [];
          if (el.id) {
            for (const label of Array.from(qAll('label'))) {
              if (label.htmlFor === el.id) parts.push(label.innerText || label.textContent || '');
            }
            const ids = String(el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean);
            for (const id of ids) {
              const ref = qAll(`#${CSS.escape(id)}`)[0];
              if (ref) parts.push(ref.innerText || ref.textContent || '');
            }
          }
          const closest = el.closest('label');
          if (closest) parts.push(closest.innerText || closest.textContent || '');
          return norm(parts.join(' '));
        };
        const visible = (el) => {
          if (!el) return false;
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
        };
        const describe = (el, source) => {
          if (!el) return null;
          const rect = el.getBoundingClientRect();
          return {
            source,
            tag: el.tagName.toLowerCase(),
            type: el.getAttribute('type') || null,
            role: el.getAttribute('role') || null,
            selector: selectorFor(el),
            text: norm(el.innerText || el.textContent || el.value || '').slice(0, 240),
            label: labelTextFor(el).slice(0, 240),
            placeholder: el.getAttribute('placeholder') || null,
            ariaLabel: el.getAttribute('aria-label') || null,
            title: el.getAttribute('title') || null,
            name: el.getAttribute('name') || null,
            id: el.id || null,
            href: el.href || null,
            valuePreview: ('value' in el ? String(el.value || '') : '').slice(0, 160),
            checked: typeof el.checked === 'boolean' ? !!el.checked : undefined,
            disabled: !!el.disabled,
            required: !!el.required,
            contentEditable: !!el.isContentEditable,
            visible: visible(el),
            attributes: Array.from(el.attributes || []).slice(0, 40).map((attr) => ({ name: attr.name, value: attr.value })).filter((attr) => !['style'].includes(attr.name)),
            form: el.form ? {
              selector: selectorFor(el.form),
              id: el.form.id || null,
              name: el.form.getAttribute('name') || null,
              action: el.form.getAttribute('action') || null,
              method: el.form.getAttribute('method') || 'get',
            } : null,
            x: Math.round(rect.left),
            y: Math.round(rect.top),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          };
        };
        const candidateSelectors = [];
        if (selector) candidateSelectors.push(selector);
        if (needle) {
          const target = lower(needle);
          const byKind = String(payload.kind || 'all').toLowerCase();
          const selectorMap = {
            all: 'a, button, input, select, textarea, [contenteditable="true"], [role], summary',
            inputs: 'input, select, textarea, [contenteditable="true"]',
            buttons: 'button, input[type="button"], input[type="submit"], [role="button"]',
            links: 'a[href], [role="link"]',
            forms: 'form',
            text: 'body *',
          };
          const searchSelector = selectorMap[byKind] || selectorMap.all;
          const candidates = qAll(searchSelector)
            .filter(visible)
            .map((el) => {
              const combined = lower([
                el.innerText,
                el.textContent,
                el.value,
                el.getAttribute('aria-label'),
                el.getAttribute('placeholder'),
                labelTextFor(el),
                el.getAttribute('name'),
                el.id,
              ].filter(Boolean).join(' '));
              let score = 0;
              if (exact ? combined === target : combined.includes(target)) score += exact ? 1000 : 700;
              if (combined.startsWith(target)) score += 120;
              const rect = el.getBoundingClientRect();
              return { el, score, rect };
            })
            .filter((item) => item.score > 0)
            .sort((a, b) => b.score - a.score);
          const top = candidates[0]?.el || null;
          const list = candidates.slice(0, Math.max(1, Number(payload.maxItems || 10))).map((item) => describe(item.el, 'needle'));
          return {
            title: document.title,
            url: location.href,
            found: !!top,
            selector: top ? selectorFor(top) : null,
            exact,
            needle: target,
            element: top ? describe(top, 'needle') : null,
            matches: list,
            activeElement: document.activeElement ? describe(document.activeElement, 'activeElement') : null,
          };
        }
        const source = document.activeElement && document.activeElement !== document.body ? document.activeElement : null;
        const el = source || qAll('input, textarea, select, button, [contenteditable="true"], a[href], [role], summary')[0] || null;
        if (!el) {
          return {
            title: document.title,
            url: location.href,
            found: false,
            element: null,
            activeElement: null,
          };
        }
        return {
          title: document.title,
          url: location.href,
          found: true,
          element: describe(el, source ? 'activeElement' : 'firstInteractive'),
          activeElement: document.activeElement ? describe(document.activeElement, 'activeElement') : null,
        };
      }, [{
        selector: params.selector || null,
        needle: params.needle || null,
        exact: !!params.exact,
        kind: params.kind || 'all',
        maxItems: params.maxItems || 10,
        includeFrames: params.includeFrames !== false,
        includeShadowDom: params.includeShadowDom !== false,
      }], params.tabId ?? null);
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
      downloadMemory.recent = [{
        at: new Date().toISOString(),
        id: downloadId,
        url,
        filename: params.filename || null,
        saveAs: params.saveAs !== false,
      }, ...downloadMemory.recent].slice(0, 40);
      return { ok: true, url, downloadId };
    }
    case 'watchDownloads': {
      const snapshot = await queryDownloadsSnapshot({});
      const needle = String(params.needle || '').trim().toLowerCase();
      const items = needle
        ? snapshot.filter((item) => `${item.filename || ''} ${item.url || ''} ${item.finalUrl || ''}`.toLowerCase().includes(needle))
        : snapshot;
      return {
        ok: true,
        count: items.length,
        recent: downloadMemory.recent,
        downloads: items.slice(0, Math.max(1, params.maxItems || 20)),
      };
    }
    case 'waitForDownload':
      return await waitForDownloadMatch(params.needle || '', {
        timeoutMs: params.timeoutMs || 20000,
        pollMs: params.pollMs || 500,
        waitForComplete: params.waitForComplete !== false,
        filter: params.filter || {},
      });
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
    case 'saveFormProfile': {
      const name = String(params.name || '').trim();
      if (!name) throw new Error('name is required');
      const profile = {
        fields: params.fields || {},
        buttonText: params.buttonText || null,
        buttonSelector: params.buttonSelector || null,
        clickButton: !!params.clickButton,
        confirmSubmit: !!params.confirmSubmit,
        updatedAt: new Date().toISOString(),
      };
      setFormProfile(name, profile);
      await persistFormProfiles();
      return { ok: true, name, profile };
    }
    case 'listFormProfiles':
      return {
        profiles: Object.entries(getFormProfiles()).map(([name, profile]) => ({
          name,
          fieldCount: profile?.fields ? Object.keys(profile.fields).length : 0,
          buttonText: profile?.buttonText || null,
          buttonSelector: profile?.buttonSelector || null,
          clickButton: !!profile?.clickButton,
          confirmSubmit: !!profile?.confirmSubmit,
          updatedAt: profile?.updatedAt || null,
        })),
      };
    case 'deleteFormProfile': {
      const name = String(params.name || '').trim();
      if (!name) throw new Error('name is required');
      delete formProfiles[name];
      await persistFormProfiles();
      return { ok: true, deleted: name };
    }
    case 'formProfileAutofill': {
      const name = String(params.profileName || params.name || '').trim();
      const saved = name ? (formProfiles[name] || null) : null;
      const profile = params.profile || saved || {};
      const fields = params.fields || profile.fields || {};
      return await universalFormAssist({
        fields,
        entries: params.entries || null,
        clickButton: params.clickButton ?? !!profile.clickButton,
        confirmSubmit: params.confirmSubmit ?? !!profile.confirmSubmit,
        buttonText: params.buttonText || profile.buttonText || null,
        buttonSelector: params.buttonSelector || profile.buttonSelector || null,
        exactButton: !!params.exactButton,
        allowFallback: params.allowFallback === true,
      }, params.tabId ?? null);
    }
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
        assistantApiEndpoint: state.assistantApiEndpoint,
        assistantModel: state.assistantModel,
        assistantApiKey: state.assistantApiKey,
        assistantTask: state.assistantTask,
        assistantRememberApiKey: state.assistantRememberApiKey,
        assistantChatLog,
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
    if (message?.type === 'popup-save-assistant-settings') {
      state.assistantApiEndpoint = String(message.assistantApiEndpoint || '').trim();
      state.assistantModel = String(message.assistantModel || '').trim();
      state.assistantApiKey = String(message.assistantApiKey || '').trim();
      state.assistantTask = String(message.assistantTask || '').trim();
      state.assistantRememberApiKey = message.assistantRememberApiKey === true;
      await chrome.storage.local.set({
        assistantApiEndpoint: state.assistantApiEndpoint,
        assistantModel: state.assistantModel,
        assistantTask: state.assistantTask,
        assistantRememberApiKey: state.assistantRememberApiKey,
        assistantChatLog,
      });
      if (state.assistantRememberApiKey) {
        await chrome.storage.local.set({ assistantApiKey: state.assistantApiKey });
      } else {
        await chrome.storage.local.remove('assistantApiKey');
      }
      sendResponse({
        ok: true,
        assistantApiEndpoint: state.assistantApiEndpoint,
        assistantModel: state.assistantModel,
        assistantApiKey: state.assistantApiKey,
        assistantTask: state.assistantTask,
        assistantRememberApiKey: state.assistantRememberApiKey,
      });
      return;
    }
    if (message?.type === 'popup-run-assistant-task') {
      const assistantTask = String(message.assistantTask ?? state.assistantTask ?? '').trim();
      if (assistantTask) {
        pushAssistantChat({ role: 'user', text: assistantTask });
        pushCommandLog({
          action: 'assistantTask',
          paramsPreview: assistantTask.length > 180 ? `${assistantTask.slice(0, 177)}...` : assistantTask,
        });
        try {
          const endpoint = String(message.assistantApiEndpoint || state.assistantApiEndpoint || '').trim();
          const apiKey = String(message.assistantApiKey || state.assistantApiKey || '').trim();
          const model = String(message.assistantModel || state.assistantModel || '').trim();
          if (!endpoint) throw new Error('Missing API endpoint');
          if (!apiKey) throw new Error('Missing API key');
          const browserContext = await collectAssistantPageContext();
          const completion = await callAssistantApi({
            endpoint,
            apiKey,
            model,
            task: assistantTask,
            context: {
              activeTab: browserContext.activeTab,
              accessProfile: state.accessProfile,
              bridgeConnected: state.connected,
              pageSummary: browserContext.pageSummary,
              pageOutline: browserContext.pageOutline,
              pageSnapshot: browserContext.pageSnapshot,
              pageDigest: browserContext.pageDigest,
            },
          });
          const parsedPlan = normalizeAssistantPlan(parseAssistantPlan(completion.reply));
          const assistantText = parsedPlan?.assistantText || completion.reply || 'No response text returned.';
          pushAssistantChat({ role: 'assistant', text: assistantText });
          let assistantActionResults = [];
          if (parsedPlan?.actions?.length) {
            assistantActionResults = await runAssistantActionPlan(parsedPlan.actions, browserContext.activeTab?.id ?? null);
            pushAssistantChat({
              role: 'assistant',
              text: summarizeAssistantActions(assistantActionResults),
            });
          }
          state.assistantModel = completion.model || state.assistantModel;
          state.assistantTask = '';
          await chrome.storage.local.set({
            assistantTask: state.assistantTask,
            assistantChatLog,
            assistantApiEndpoint: endpoint,
            assistantModel: state.assistantModel,
          });
          sendResponse({
            ok: true,
            assistantTask: state.assistantTask,
            assistantReply: assistantText,
            assistantActionResults,
            assistantChatLog,
            assistantModel: state.assistantModel,
          });
          return;
        } catch (error) {
          const messageText = error.message || String(error);
          pushAssistantChat({ role: 'assistant', text: `Error: ${messageText}` });
          state.assistantTask = '';
          await chrome.storage.local.set({ assistantTask: state.assistantTask, assistantChatLog });
          sendResponse({
            ok: false,
            error: messageText,
            assistantChatLog,
            assistantTask: state.assistantTask,
          });
          return;
        }
      }
      sendResponse({ ok: true, assistantTask: state.assistantTask, assistantChatLog });
      return;
    }
    if (message?.type === 'popup-clear-assistant-chat') {
      assistantChatLog = [];
      await chrome.storage.local.set({ assistantChatLog });
      sendResponse({ ok: true, assistantChatLog });
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
