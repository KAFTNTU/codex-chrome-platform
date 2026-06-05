let currentTabId = null;
let pollTimer = null;
let noticeTimer = null;
let saveTimer = null;
let currentAccessProfile = 'controlled';

function el(id) {
  return document.getElementById(id);
}

function esc(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function renderStatus(bridgeState) {
  const connected = !!bridgeState?.connected;
  el('statusPill').textContent = connected ? 'Connected' : 'Disconnected';
  el('statusPill').className = `pill ${connected ? 'ok' : 'bad'}`;
  el('error').textContent = bridgeState?.lastError || '-';
}

function renderAccessProfile(profile) {
  currentAccessProfile = profile === 'expanded' ? 'expanded' : 'controlled';
  const controlled = el('controlledProfile');
  const expanded = el('expandedProfile');
  controlled.classList.toggle('active', currentAccessProfile === 'controlled');
  expanded.classList.toggle('active', currentAccessProfile === 'expanded');
}

function renderAssistantChat(chatLog) {
  const list = el('assistantChatList');
  const items = Array.isArray(chatLog) ? chatLog.slice().reverse() : [];
  if (!items.length) {
    list.innerHTML = '<div class="empty">No messages yet</div>';
    return;
  }
  list.innerHTML = items.map((item) => {
    const role = item.role === 'assistant' ? 'assistant' : 'user';
    return `
      <div class="chat-msg ${role}">
        <div>${esc(item.text || '')}</div>
        <div class="chat-meta">
          <span>${role === 'assistant' ? 'Codex' : 'You'}</span>
          <span>${new Date(item.at || Date.now()).toLocaleTimeString()}</span>
        </div>
      </div>
    `;
  }).join('');
  list.scrollTop = list.scrollHeight;
}

function openSettingsModal() {
  const modal = el('settingsModal');
  modal.classList.add('open');
  modal.setAttribute('aria-hidden', 'false');
}

function closeSettingsModal() {
  const modal = el('settingsModal');
  modal.classList.remove('open');
  modal.setAttribute('aria-hidden', 'true');
}

function syncFieldValue(id, value) {
  const node = el(id);
  if (!node) return;
  if (document.activeElement === node) return;
  const next = value ?? '';
  if (node.value !== next) node.value = next;
}

function queueSaveAssistantSettings(delay = 200) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void saveAssistantSettings();
  }, delay);
}

function renderActiveTab(activeTab) {
  currentTabId = activeTab?.id ?? null;
  el('activeTabTitle').textContent = activeTab?.title || 'No active tab';
  el('activeTabUrl').textContent = activeTab?.url || '-';
}

function renderMonitorState(network) {
  const attached = network?.attachedTabId != null && network?.attachedTabId === currentTabId;
  el('monitorState').textContent = attached
    ? `Monitoring tab ${network.attachedTabId}`
    : 'Monitor inactive';
}

function showNotice(text, isError = false) {
  const node = el('notice');
  node.textContent = text || '';
  node.style.color = isError ? 'var(--danger)' : 'var(--accent)';
  if (noticeTimer) clearTimeout(noticeTimer);
  if (text) {
    noticeTimer = setTimeout(() => {
      node.textContent = '';
    }, 2200);
  }
}

function renderNetwork(network) {
  const list = el('networkList');
  const logs = network?.logs || [];
  el('networkCount').textContent = String(logs.length);
  if (!logs.length) {
    list.innerHTML = '<div class="empty">No network events yet</div>';
    return;
  }
  list.innerHTML = logs.map((item) => {
    const left = item.kind === 'finished'
      ? `${esc(item.method || '')} ${esc(item.status || '')}`
      : item.kind === 'response'
        ? `Response ${esc(item.status || '')}`
        : item.kind === 'failed'
          ? 'Failed'
          : item.kind === 'system'
            ? 'System'
            : esc(item.method || item.kind);
    const right = item.durationMs != null ? `${item.durationMs} ms` : new Date(item.at).toLocaleTimeString();
    return `
      <div class="entry">
        <div class="entry-top">
          <strong>${left}</strong>
          <span class="sub">${right}</span>
        </div>
        ${item.url ? `<div class="entry-url mono">${esc(item.url)}</div>` : ''}
        ${item.message ? `<div class="entry-meta">${esc(item.message)}</div>` : ''}
        ${(item.requestBodyPreview || item.responseBodyPreview || item.errorText || item.mimeType) ? `
          <div class="entry-meta">
            ${item.mimeType ? `<div>MIME: ${esc(item.mimeType)}</div>` : ''}
            ${item.errorText ? `<div>Error: ${esc(item.errorText)}</div>` : ''}
            ${item.requestBodyPreview ? `<div>Req: ${esc(item.requestBodyPreview)}</div>` : ''}
            ${item.responseBodyPreview ? `<div>Res: ${esc(item.responseBodyPreview)}</div>` : ''}
          </div>
        ` : ''}
      </div>
    `;
  }).join('');
}

function renderConsole(consoleState) {
  const list = el('consoleList');
  const logs = consoleState?.logs || [];
  el('consoleCount').textContent = String(logs.length);
  if (!logs.length) {
    list.innerHTML = '<div class="empty">No console logs yet</div>';
    return;
  }
  list.innerHTML = logs.map((item) => `
    <div class="entry">
      <div class="entry-top">
        <strong>${esc(item.level || item.kind || 'log')}</strong>
        <span class="sub">${new Date(item.at).toLocaleTimeString()}</span>
      </div>
      <div class="entry-meta">${esc(item.text || '')}</div>
      ${item.url ? `<div class="entry-url mono">${esc(item.url)}</div>` : ''}
      ${Array.isArray(item.stack) && item.stack.length ? `
        <div class="entry-meta mono">${esc(item.stack.map((frame) => `${frame.functionName || '(anonymous)'} @ ${frame.url || ''}:${frame.lineNumber ?? ''}`).join(' | '))}</div>
      ` : ''}
    </div>
  `).join('');
}

function renderCommands(commandLog) {
  const list = el('commandList');
  const items = commandLog || [];
  el('commandCount').textContent = String(items.length);
  if (!items.length) {
    list.innerHTML = '<div class="empty">No bridge commands yet</div>';
    return;
  }
  list.innerHTML = items.map((item) => `
    <div class="entry">
      <div class="entry-top">
        <strong>${esc(item.action)}</strong>
        <span class="sub">${new Date(item.at).toLocaleTimeString()}</span>
      </div>
      <div class="entry-meta mono">${esc(item.paramsPreview || '')}</div>
    </div>
  `).join('');
}

async function refresh() {
  try {
    const state = await chrome.runtime.sendMessage({ type: 'popup-get-state', tabId: currentTabId });
    el('clientId').textContent = state.clientId || '-';
    syncFieldValue('serverUrl', state.serverUrl || 'http://127.0.0.1:17373');
    renderAccessProfile(state.accessProfile || 'controlled');
    syncFieldValue('assistantApiEndpoint', state.assistantApiEndpoint || '');
    syncFieldValue('assistantModel', state.assistantModel || '');
    syncFieldValue('assistantApiKey', state.assistantApiKey || '');
    syncFieldValue('assistantTask', state.assistantTask || '');
    el('rememberApiKey').checked = !!state.assistantRememberApiKey;
    el('mouseCueEnabled').checked = state.mouseCueEnabled !== false;
    renderStatus(state.bridgeState);
    renderActiveTab(state.activeTab);
    renderMonitorState(state.network);
    renderNetwork(state.network);
    renderConsole(state.console);
    renderCommands(state.commandLog);
    renderAssistantChat(state.assistantChatLog || []);
  } catch (error) {
    renderStatus({ connected: false, lastError: error.message || String(error) });
    renderMonitorState({ attachedTabId: null, logs: [] });
    renderNetwork({ logs: [] });
    renderConsole({ logs: [] });
    renderCommands([]);
    renderAssistantChat([]);
    showNotice('Bridge service worker is restarting', true);
  }
}

async function saveServerUrl() {
  try {
    await chrome.runtime.sendMessage({
      type: 'popup-save-server-url',
      serverUrl: el('serverUrl').value.trim(),
    });
  } catch (error) {
    showNotice(error.message || String(error), true);
    return;
  }
  await refresh();
}

async function saveAssistantSettings() {
  try {
    await chrome.runtime.sendMessage({
      type: 'popup-save-assistant-settings',
      assistantApiEndpoint: el('assistantApiEndpoint').value.trim(),
      assistantModel: el('assistantModel').value.trim(),
      assistantApiKey: el('assistantApiKey').value.trim(),
      assistantTask: el('assistantTask').value.trim(),
      assistantRememberApiKey: !!el('rememberApiKey').checked,
    });
  } catch (error) {
    showNotice(error.message || String(error), true);
    return;
  }
  await refresh();
}

async function runAssistantTask() {
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'popup-run-assistant-task',
      assistantTask: el('assistantTask').value.trim(),
      assistantApiEndpoint: el('assistantApiEndpoint').value.trim(),
      assistantModel: el('assistantModel').value.trim(),
      assistantApiKey: el('assistantApiKey').value.trim(),
    });
    if (response?.assistantChatLog) {
      renderAssistantChat(response.assistantChatLog);
    }
    if (response?.assistantReply) {
      showNotice(response.assistantReply);
    }
  } catch (error) {
    showNotice(error.message || String(error), true);
    return;
  }
  await refresh();
}

async function clearAssistantTask() {
  el('assistantTask').value = '';
  try {
    await chrome.runtime.sendMessage({
      type: 'popup-save-assistant-settings',
      assistantApiEndpoint: el('assistantApiEndpoint').value.trim(),
      assistantModel: el('assistantModel').value.trim(),
      assistantApiKey: el('assistantApiKey').value.trim(),
      assistantTask: '',
      assistantRememberApiKey: !!el('rememberApiKey').checked,
    });
  } catch (error) {
    showNotice(error.message || String(error), true);
    return;
  }
  await refresh();
}

async function clearAssistantChat() {
  try {
    await chrome.runtime.sendMessage({ type: 'popup-clear-assistant-chat' });
  } catch (error) {
    showNotice(error.message || String(error), true);
    return;
  }
  await refresh();
}

async function saveAccessProfile() {
  try {
    await chrome.runtime.sendMessage({
      type: 'popup-save-access-profile',
      accessProfile: currentAccessProfile,
    });
  } catch (error) {
    showNotice(error.message || String(error), true);
    return;
  }
  await refresh();
}

async function saveMouseCueEnabled() {
  try {
    await chrome.runtime.sendMessage({
      type: 'popup-save-mouse-cue',
      mouseCueEnabled: !!el('mouseCueEnabled').checked,
    });
  } catch (error) {
    showNotice(error.message || String(error), true);
    return;
  }
  await refresh();
}

async function attachMonitor() {
  try {
    await chrome.runtime.sendMessage({ type: 'popup-network-attach', tabId: currentTabId });
  } catch (error) {
    showNotice(error.message || String(error), true);
    return;
  }
  await refresh();
}

async function detachMonitor() {
  try {
    await chrome.runtime.sendMessage({ type: 'popup-network-detach', tabId: currentTabId });
  } catch (error) {
    showNotice(error.message || String(error), true);
    return;
  }
  await refresh();
}

async function clearMonitor() {
  try {
    await chrome.runtime.sendMessage({ type: 'popup-network-clear', tabId: currentTabId });
  } catch (error) {
    showNotice(error.message || String(error), true);
    return;
  }
  await refresh();
}

el('save').addEventListener('click', saveServerUrl);
el('saveAssistant').addEventListener('click', saveAssistantSettings);
el('runAssistantTask').addEventListener('click', runAssistantTask);
el('clearAssistantTask').addEventListener('click', clearAssistantTask);
el('clearAssistantChat').addEventListener('click', clearAssistantChat);
el('statusPill').addEventListener('click', openSettingsModal);
el('closeSettingsModal').addEventListener('click', closeSettingsModal);
el('settingsModal').addEventListener('click', (event) => {
  if (event.target === el('settingsModal')) closeSettingsModal();
});
el('controlledProfile').addEventListener('click', async () => {
  currentAccessProfile = 'controlled';
  await saveAccessProfile();
});
el('expandedProfile').addEventListener('click', async () => {
  currentAccessProfile = 'expanded';
  await saveAccessProfile();
});
el('mouseCueEnabled').addEventListener('change', saveMouseCueEnabled);
el('attachMonitor').addEventListener('click', attachMonitor);
el('detachMonitor').addEventListener('click', detachMonitor);
el('clearMonitor').addEventListener('click', clearMonitor);

for (const id of ['serverUrl', 'assistantApiEndpoint', 'assistantModel', 'assistantApiKey', 'assistantTask', 'rememberApiKey']) {
  el(id).addEventListener('input', () => queueSaveAssistantSettings());
  el(id).addEventListener('change', () => queueSaveAssistantSettings(0));
}

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeSettingsModal();
});

refresh();
pollTimer = setInterval(refresh, 1500);
window.addEventListener('beforeunload', () => {
  if (pollTimer) clearInterval(pollTimer);
  if (saveTimer) clearTimeout(saveTimer);
});
