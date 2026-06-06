let currentTabId = null;
let pollTimer = null;
let noticeTimer = null;
let saveTimer = null;
let currentAccessProfile = 'controlled';
let connectionDetailsVisible = false;
let pendingAttachmentDestination = 'draft';
let assistantDraftAttachments = [];
let assistantArchiveAttachments = [];

function el(id) {
  return document.getElementById(id);
}

function esc(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function isTextLikeFile(file) {
  const name = String(file?.name || '').toLowerCase();
  const type = String(file?.type || '').toLowerCase();
  return (
    type.startsWith('text/') ||
    ['application/json', 'application/xml', 'application/csv', 'application/javascript'].includes(type) ||
    /\.(txt|md|csv|json|xml|html?|js|ts|css|yml|yaml|log|ini|conf|py|c|cpp|h|java|sh|bat)$/i.test(name)
  );
}

function readFileText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('Failed to read file'));
    reader.readAsText(file);
  });
}

function readFileArrayBuffer(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('Failed to read file'));
    reader.readAsArrayBuffer(file);
  });
}

function readFileDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}

let pdfJsLoader = null;
async function getPdfJs() {
  if (!pdfJsLoader) {
    pdfJsLoader = import(chrome.runtime.getURL('vendor/pdf.min.mjs')).then((mod) => {
      mod.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('vendor/pdf.worker.min.mjs');
      return mod;
    });
  }
  return pdfJsLoader;
}

function extractPlainTextFromXml(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  const parts = [];
  const nodeSets = [
    Array.from(doc.getElementsByTagNameNS('*', 't')),
    Array.from(doc.getElementsByTagName('t')),
  ];
  for (const nodes of nodeSets) {
    for (const node of nodes) {
      const value = String(node.textContent || '').trim();
      if (value) parts.push(value);
    }
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

async function extractDocxText(file) {
  if (typeof JSZip === 'undefined') return '';
  const buffer = await readFileArrayBuffer(file);
  const zip = await JSZip.loadAsync(buffer);
  const mainDoc = zip.file('word/document.xml');
  if (!mainDoc) return '';
  const xmlText = await mainDoc.async('text');
  return extractPlainTextFromXml(xmlText).slice(0, 12000);
}

async function extractPdfText(file) {
  const pdfjsLib = await getPdfJs();
  const buffer = await readFileArrayBuffer(file);
  const data = new Uint8Array(buffer);
  const pdf = await pdfjsLib.getDocument({ data }).promise;
  const pages = [];
  const maxPages = Math.min(pdf.numPages || 0, 20);
  for (let pageNumber = 1; pageNumber <= maxPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    const pageText = (content.items || [])
      .map((item) => String(item.str || '').trim())
      .filter(Boolean)
      .join(' ');
    if (pageText) pages.push(pageText);
  }
  return pages.join('\n\n').replace(/\s+/g, ' ').trim().slice(0, 12000);
}

async function extractZipSummary(file) {
  if (typeof JSZip === 'undefined') return '';
  const buffer = await readFileArrayBuffer(file);
  const zip = await JSZip.loadAsync(buffer);
  const names = [];
  const textBlocks = [];
  zip.forEach((relativePath, entry) => {
    if (entry.dir) return;
    names.push(relativePath);
  });
  const previewFiles = names.filter((name) => /\.(txt|md|csv|json|xml|html?|js|ts|log|yml|yaml)$/i.test(name)).slice(0, 5);
  for (const name of previewFiles) {
    const entry = zip.file(name);
    if (!entry) continue;
    try {
      const text = String(await entry.async('text')).slice(0, 3000).trim();
      if (text) {
        textBlocks.push(`File: ${name}\n${text}`);
      }
    } catch {
      // ignore extraction failures
    }
  }
  const header = `Archive files: ${names.length ? names.join(', ') : 'none'}`;
  return [header, ...textBlocks].join('\n\n').slice(0, 12000);
}

function fileToAttachment(file, source) {
  return (async () => {
    const name = String(file?.name || '').toLowerCase();
    const mime = String(file?.type || '').toLowerCase();
    const kind = isTextLikeFile(file)
      ? 'text'
      : mime.startsWith('image/')
        ? 'image'
        : /\.(docx)$/i.test(name)
          ? 'docx'
          : /\.(pdf)$/i.test(name)
            ? 'pdf'
            : /\.(zip)$/i.test(name)
              ? 'zip'
              : 'binary';
    const attachment = {
      id: crypto.randomUUID(),
      name: file.name,
      size: file.size,
      type: file.type || '',
      lastModified: file.lastModified || Date.now(),
      source,
      addedAt: new Date().toISOString(),
      kind,
      text: '',
      preview: '',
      dataUrl: '',
    };
    if (kind === 'text') {
      const text = await readFileText(file);
      const clipped = text.slice(0, 12000);
      attachment.text = clipped;
      attachment.preview = clipped.slice(0, 900);
    } else if (kind === 'image' && file.size <= 4_000_000) {
      attachment.dataUrl = await readFileDataUrl(file);
      attachment.preview = 'Image attached.';
    } else if (kind === 'docx') {
      const text = await extractDocxText(file).catch(() => '');
      const clipped = String(text || '').slice(0, 12000);
      attachment.text = clipped;
      attachment.preview = clipped ? clipped.slice(0, 900) : 'DOCX file attached.';
    } else if (kind === 'pdf') {
      const text = await extractPdfText(file).catch(() => '');
      const clipped = String(text || '').slice(0, 12000);
      attachment.text = clipped;
      attachment.preview = clipped ? clipped.slice(0, 900) : 'PDF file attached.';
    } else if (kind === 'zip') {
      const summary = await extractZipSummary(file).catch(() => '');
      const clipped = String(summary || '').slice(0, 12000);
      attachment.text = clipped;
      attachment.preview = clipped ? clipped.slice(0, 900) : 'ZIP archive attached.';
    }
    return attachment;
  })();
}

async function pickFiles(destination) {
  pendingAttachmentDestination = destination === 'archive' ? 'archive' : 'draft';
  el('assistantFileInput').value = '';
  el('assistantFileInput').click();
}

function renderFileEntry(item, destination) {
  const metaBits = [formatBytes(item.size)];
  if (item.type) metaBits.push(item.type);
  const previewText = item.text || item.preview || '';
  const fallbackPreview = item.kind === 'image'
    ? 'Image attached. The assistant can inspect it as a screenshot.'
    : item.kind === 'binary'
      ? 'Binary file stored locally as an attachment.'
      : 'No text preview available.';
  const actions = destination === 'archive'
    ? `
      <button data-archive-use="${esc(item.id)}" class="primary">Use in chat</button>
      <button data-file-remove="${esc(item.id)}" class="warn">Delete</button>
    `
    : `
      <button data-file-remove="${esc(item.id)}" class="warn">Remove</button>
    `;
  return `
    <div class="file-card">
      <div class="file-card-top">
        <div>
          <div class="file-card-name">${esc(item.name || 'attachment')}</div>
          <div class="file-card-meta">${metaBits.map((bit) => `<span class="pill">${esc(bit)}</span>`).join('')}</div>
        </div>
        <div class="sub">${destination === 'archive' ? 'Archive' : 'Chat draft'}</div>
      </div>
      ${previewText ? `<div class="file-preview">${esc(previewText)}</div>` : `<div class="file-preview">${esc(fallbackPreview)}</div>`}
      <div class="file-actions">${actions}</div>
    </div>
  `;
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
  const prevScrollTop = list.scrollTop;
  const prevScrollHeight = list.scrollHeight || 0;
  const prevClientHeight = list.clientHeight || 0;
  const wasAtBottom = prevScrollTop + prevClientHeight >= prevScrollHeight - 24;
  const items = Array.isArray(chatLog) ? chatLog.slice().reverse() : [];
  if (!items.length) {
    list.innerHTML = '<div class="empty">No messages yet</div>';
    return;
  }
  list.innerHTML = items.map((item) => {
    const role = item.role === 'assistant' ? 'assistant' : 'user';
    const attachments = Array.isArray(item.attachments) && item.attachments.length
      ? `
        <div class="file-pills">
          ${item.attachments.map((file) => `
            <span class="file-pill">📎 ${esc(file.name || 'attachment')} <small>${esc(formatBytes(file.size))}</small></span>
          `).join('')}
        </div>
      `
      : '';
    return `
      <div class="chat-msg ${role}">
        <div>${esc(item.text || '')}</div>
        ${attachments}
        <div class="chat-meta">
          <span>${role === 'assistant' ? 'Codex' : 'You'}</span>
          <span>${new Date(item.at || Date.now()).toLocaleTimeString()}</span>
        </div>
      </div>
    `;
  }).join('');
  if (wasAtBottom) {
    list.scrollTop = list.scrollHeight;
  } else {
    const maxScrollTop = Math.max(0, list.scrollHeight - list.clientHeight);
    list.scrollTop = Math.min(prevScrollTop, maxScrollTop);
  }
}

function renderAssistantFiles() {
  const draftList = el('assistantDraftFiles');
  const archiveList = el('assistantArchiveFiles');
  const draft = Array.isArray(assistantDraftAttachments) ? assistantDraftAttachments : [];
  const archive = Array.isArray(assistantArchiveAttachments) ? assistantArchiveAttachments : [];
  el('archiveFileCount').textContent = String(archive.length);

  if (!draft.length) {
    draftList.innerHTML = '<div class="empty">No files attached to the current chat draft.</div>';
  } else {
    draftList.innerHTML = draft.map((item) => renderFileEntry(item, 'draft')).join('');
  }

  if (!archive.length) {
    archiveList.innerHTML = '<div class="empty">No archived files yet.</div>';
  } else {
    archiveList.innerHTML = archive.map((item) => renderFileEntry(item, 'archive')).join('');
  }
}

async function syncAssistantFiles(destination, attachments) {
  const response = await chrome.runtime.sendMessage({
    type: 'popup-add-assistant-files',
    destination,
    attachments,
  });
  if (response?.assistantDraftAttachments) assistantDraftAttachments = response.assistantDraftAttachments;
  if (response?.assistantArchiveAttachments) assistantArchiveAttachments = response.assistantArchiveAttachments;
  renderAssistantFiles();
}

async function handleAssistantFileSelection(destination) {
  const files = Array.from(el('assistantFileInput')?.files || []);
  if (!files.length) return;
  try {
    const attachments = [];
    for (const file of files) {
      attachments.push(await fileToAttachment(file, destination));
    }
    await syncAssistantFiles(destination, attachments);
  } catch (error) {
    showNotice(error.message || String(error), true);
  } finally {
    if (el('assistantFileInput')) {
      el('assistantFileInput').value = '';
    }
  }
}

async function removeAssistantFile(destination, id) {
  const response = await chrome.runtime.sendMessage({
    type: 'popup-remove-assistant-file',
    destination,
    id,
  });
  if (response?.assistantDraftAttachments) assistantDraftAttachments = response.assistantDraftAttachments;
  if (response?.assistantArchiveAttachments) assistantArchiveAttachments = response.assistantArchiveAttachments;
  renderAssistantFiles();
}

async function copyArchiveFileToDraft(id) {
  const response = await chrome.runtime.sendMessage({
    type: 'popup-copy-assistant-archive-file',
    id,
  });
  if (response?.assistantDraftAttachments) assistantDraftAttachments = response.assistantDraftAttachments;
  if (response?.assistantArchiveAttachments) assistantArchiveAttachments = response.assistantArchiveAttachments;
  renderAssistantFiles();
}

async function clearAssistantFiles(destination) {
  const response = await chrome.runtime.sendMessage({
    type: 'popup-clear-assistant-files',
    destination,
  });
  if (response?.assistantDraftAttachments) assistantDraftAttachments = response.assistantDraftAttachments;
  if (response?.assistantArchiveAttachments) assistantArchiveAttachments = response.assistantArchiveAttachments;
  renderAssistantFiles();
}

function renderConnectionDetailsVisibility() {
  const node = el('connectionDetails');
  if (!node) return;
  node.classList.toggle('hidden', !connectionDetailsVisible);
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
    assistantDraftAttachments = Array.isArray(state.assistantDraftAttachments) ? state.assistantDraftAttachments : [];
    assistantArchiveAttachments = Array.isArray(state.assistantArchiveAttachments) ? state.assistantArchiveAttachments : [];
    el('rememberApiKey').checked = !!state.assistantRememberApiKey;
    el('mouseCueEnabled').checked = state.mouseCueEnabled !== false;
    renderStatus(state.bridgeState);
    renderActiveTab(state.activeTab);
    renderMonitorState(state.network);
    renderNetwork(state.network);
    renderConsole(state.console);
    renderCommands(state.commandLog);
    renderAssistantChat(state.assistantChatLog || []);
    renderAssistantFiles();
  } catch (error) {
    renderStatus({ connected: false, lastError: error.message || String(error) });
    renderMonitorState({ attachedTabId: null, logs: [] });
    renderNetwork({ logs: [] });
    renderConsole({ logs: [] });
    renderCommands([]);
    renderAssistantChat([]);
    renderAssistantFiles();
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
  const taskText = el('assistantTask').value.trim();
  if (!taskText) return;
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  el('assistantTask').value = '';
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'popup-run-assistant-task',
      assistantTask: taskText,
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

async function clearAssistantTask() {
  el('assistantTask').value = '';
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
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
el('sendAssistantTask').addEventListener('click', runAssistantTask);
el('clearAssistantTask').addEventListener('click', clearAssistantTask);
el('clearAssistantChat').addEventListener('click', clearAssistantChat);
el('addFilesToChat').addEventListener('click', () => {
  void pickFiles('draft');
});
el('addFilesToArchive').addEventListener('click', () => {
  void pickFiles('archive');
});
el('clearDraftFiles').addEventListener('click', () => {
  void clearAssistantFiles('draft');
});
el('clearArchiveFiles').addEventListener('click', () => {
  void clearAssistantFiles('archive');
});
el('statusPill').addEventListener('click', () => {
  connectionDetailsVisible = !connectionDetailsVisible;
  renderConnectionDetailsVisibility();
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

el('assistantTask').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    void runAssistantTask();
  }
});

el('assistantFileInput').addEventListener('change', () => {
  void handleAssistantFileSelection(pendingAttachmentDestination);
});

el('assistantDraftFiles').addEventListener('click', (event) => {
  const removeId = event.target?.closest?.('[data-file-remove]')?.dataset?.fileRemove;
  if (removeId) {
    void removeAssistantFile('draft', removeId);
  }
});

el('assistantArchiveFiles').addEventListener('click', (event) => {
  const removeId = event.target?.closest?.('[data-file-remove]')?.dataset?.fileRemove;
  const useId = event.target?.closest?.('[data-archive-use]')?.dataset?.archiveUse;
  if (removeId) {
    void removeAssistantFile('archive', removeId);
  } else if (useId) {
    void copyArchiveFileToDraft(useId);
  }
});

el('assistantChatList')?.addEventListener('wheel', (event) => {
  event.stopPropagation();
}, { passive: true });

el('assistantDropzone')?.addEventListener('dragover', (event) => {
  event.preventDefault();
  el('assistantDropzone').classList.add('dragover');
});
el('assistantDropzone')?.addEventListener('dragleave', () => {
  el('assistantDropzone').classList.remove('dragover');
});
el('assistantDropzone')?.addEventListener('drop', async (event) => {
  event.preventDefault();
  el('assistantDropzone').classList.remove('dragover');
  const files = Array.from(event.dataTransfer?.files || []);
  if (!files.length) return;
  try {
    const attachments = [];
    for (const file of files) {
      attachments.push(await fileToAttachment(file, 'draft'));
    }
    await syncAssistantFiles('draft', attachments);
  } catch (error) {
    showNotice(error.message || String(error), true);
  }
});

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    connectionDetailsVisible = false;
    renderConnectionDetailsVisibility();
  }
});

refresh();
pollTimer = setInterval(refresh, 1500);
window.addEventListener('beforeunload', () => {
  if (pollTimer) clearInterval(pollTimer);
  if (saveTimer) clearTimeout(saveTimer);
});
