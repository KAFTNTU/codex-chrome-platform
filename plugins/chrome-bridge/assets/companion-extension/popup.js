let currentTabId = null;
let pollTimer = null;
let noticeTimer = null;

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

function renderActiveTab(activeTab) {
  currentTabId = activeTab?.id ?? null;
  el('activeTabTitle').textContent = activeTab?.title || 'Немає активної вкладки';
  el('activeTabUrl').textContent = activeTab?.url || '-';
  el('activeTabId').textContent = activeTab?.id ?? '-';
  el('activeWindowId').textContent = activeTab?.windowId ?? '-';
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
  if (!logs.length) {
    list.innerHTML = '<div class="empty">Поки що немає мережевих подій</div>';
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

function renderCommands(commandLog) {
  const list = el('commandList');
  const items = commandLog || [];
  if (!items.length) {
    list.innerHTML = '<div class="empty">Поки що немає команд bridge</div>';
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
    el('serverUrl').value = state.serverUrl || 'http://127.0.0.1:17373';
    renderStatus(state.bridgeState);
    renderActiveTab(state.activeTab);
    renderMonitorState(state.network);
    renderNetwork(state.network);
    renderCommands(state.commandLog);
  } catch (error) {
    renderStatus({ connected: false, lastError: error.message || String(error) });
    renderMonitorState({ attachedTabId: null, logs: [] });
    renderNetwork({ logs: [] });
    renderCommands([]);
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
el('attachMonitor').addEventListener('click', attachMonitor);
el('detachMonitor').addEventListener('click', detachMonitor);
el('clearMonitor').addEventListener('click', clearMonitor);
el('refreshState').addEventListener('click', refresh);

refresh();
pollTimer = setInterval(refresh, 1500);
window.addEventListener('beforeunload', () => {
  if (pollTimer) clearInterval(pollTimer);
});
