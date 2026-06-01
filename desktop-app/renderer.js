const statusBox = document.getElementById('statusBox');
const logBox = document.getElementById('logBox');
const bridgeUrlInput = document.getElementById('bridgeUrlInput');
const tokenOverrideInput = document.getElementById('tokenOverrideInput');
const autoStartBridgeInput = document.getElementById('autoStartBridgeInput');
const saveConnectionBtn = document.getElementById('saveConnection');
const langUaBtn = document.getElementById('langUa');
const langEnBtn = document.getElementById('langEn');
const currentModeBadge = document.getElementById('currentModeBadge');
const bridgeProcessIndicator = document.getElementById('bridgeProcessIndicator');
const bridgeApiIndicator = document.getElementById('bridgeApiIndicator');
const bridgeTokenInput = document.getElementById('bridgeTokenInput');
const toggleTokenBtn = document.getElementById('toggleToken');
const copyTokenBtn = document.getElementById('copyToken');
const targetUrlInput = document.getElementById('targetUrlInput');
const openTargetUrlBtn = document.getElementById('openTargetUrl');
const uploadFoldersInput = document.getElementById('uploadFoldersInput');
const uploadDomainsInput = document.getElementById('uploadDomainsInput');
const uploadExtInput = document.getElementById('uploadExtInput');
const uploadFileQueryInput = document.getElementById('uploadFileQueryInput');
const usePreflightCopyInput = document.getElementById('usePreflightCopyInput');

let currentLang = 'en';
let selectedMode = '';
let currentToken = '';

const I18N = {
  en: {
    title: 'Codex Chrome Platform',
    subtitle: 'Desktop launcher for bridge, modes, logs, and fast automation actions.',
    connectionTitle: 'Local Connection',
    bridgeUrl: 'Bridge URL',
    tokenOverride: 'Token override (optional)',
    autoStartBridge: 'Auto-start Bridge on app launch',
    saveConnection: 'Save connection',
    connectionHint: 'You can keep token empty to use runtime.json token.',
    bridgeControls: 'Bridge Controls',
    startBridge: 'Start Bridge',
    stopBridge: 'Stop Bridge',
    restartBridge: 'Restart Bridge',
    refreshStatus: 'Refresh Status',
    securityModes: 'Security Modes',
    modeSafe: 'Safe',
    modeDeveloper: 'Developer',
    modeLocalNetwork: 'Local Network',
    quickActions: 'Quick Actions',
    qaExtractTables: 'Extract tables',
    qaExportExcel: 'Export Excel',
    qaWordReport: 'Generate Word report',
    qaStartMacro: 'Start macro recording',
    qaStopMacro: 'Stop macro recording',
    qaRunMacro: 'Run macro',
    openPaths: 'Open Paths',
    openExtensions: 'Open Extensions Page',
    openExtensionFolder: 'Open Extension Folder',
    openRuntime: 'Open runtime.json',
    openLogs: 'Open logs folder',
    openOutput: 'Open output folder',
    openMacros: 'Open macros folder',
    status: 'Status',
    bridgeLog: 'Bridge Log',
    noLogs: 'No logs yet.',
    modeLabel: 'Mode',
    processLabel: 'Bridge process',
    apiLabel: 'API',
    running: 'running',
    stopped: 'stopped',
    reachable: 'reachable',
    unreachable: 'unreachable',
    bridgeToken: 'Bridge token',
    showToken: 'Show',
    hideToken: 'Hide',
    copyToken: 'Copy',
  },
  ua: {
    title: 'Codex Chrome Platform',
    subtitle: 'Десктоп-лаунчер для bridge, режимів, логів і швидких дій автоматизації.',
    connectionTitle: 'Локальне підключення',
    bridgeUrl: 'URL bridge-сервера',
    tokenOverride: 'Token override (необовʼязково)',
    autoStartBridge: 'Автозапуск Bridge при старті додатка',
    saveConnection: 'Зберегти підключення',
    connectionHint: 'Можна лишити token порожнім, тоді візьметься з runtime.json.',
    bridgeControls: 'Керування Bridge',
    startBridge: 'Запустити Bridge',
    stopBridge: 'Зупинити Bridge',
    restartBridge: 'Перезапустити Bridge',
    refreshStatus: 'Оновити статус',
    securityModes: 'Режими безпеки',
    modeSafe: 'Safe',
    modeDeveloper: 'Developer',
    modeLocalNetwork: 'Local Network',
    quickActions: 'Швидкі дії',
    qaExtractTables: 'Витягнути таблиці',
    qaExportExcel: 'Експорт Excel',
    qaWordReport: 'Згенерувати Word звіт',
    qaStartMacro: 'Почати запис макро',
    qaStopMacro: 'Зупинити запис макро',
    qaRunMacro: 'Запустити макро',
    openPaths: 'Відкрити шляхи',
    openExtensions: 'Відкрити сторінку розширень',
    openExtensionFolder: 'Відкрити папку розширення',
    openRuntime: 'Відкрити runtime.json',
    openLogs: 'Відкрити папку логів',
    openOutput: 'Відкрити папку output',
    openMacros: 'Відкрити папку macros',
    status: 'Статус',
    bridgeLog: 'Лог Bridge',
    noLogs: 'Логів поки немає.',
    modeLabel: 'Режим',
    processLabel: 'Bridge процес',
    apiLabel: 'API',
    running: 'запущено',
    stopped: 'зупинено',
    reachable: 'доступний',
    unreachable: 'недоступний',
    bridgeToken: 'Bridge токен',
    showToken: 'Показати',
    hideToken: 'Сховати',
    copyToken: 'Копіювати',
  },
};

function formatJson(data) {
  return JSON.stringify(data, null, 2);
}

function updateModeBadge() {
  currentModeBadge.textContent = `${I18N[currentLang].modeLabel}: ${selectedMode || '-'}`;
}

function applyLanguage(lang) {
  currentLang = lang in I18N ? lang : 'en';
  const dict = I18N[currentLang];
  for (const node of document.querySelectorAll('[data-i18n]')) {
    const key = node.getAttribute('data-i18n');
    if (dict[key]) node.textContent = dict[key];
  }
  langUaBtn.classList.toggle('active', currentLang === 'ua');
  langEnBtn.classList.toggle('active', currentLang === 'en');
  if (!logBox.textContent.trim()) {
    logBox.textContent = dict.noLogs;
  }
  updateModeBadge();
  toggleTokenBtn.textContent = bridgeTokenInput.type === 'password'
    ? I18N[currentLang].showToken
    : I18N[currentLang].hideToken;
}

function markActiveMode(mode) {
  selectedMode = mode || '';
  for (const btn of document.querySelectorAll('[data-mode]')) {
    btn.classList.toggle('active', btn.getAttribute('data-mode') === selectedMode);
  }
  updateModeBadge();
}

function setIndicatorState(el, isOnline, text) {
  el.textContent = text;
  el.classList.toggle('online', !!isOnline);
  el.classList.toggle('offline', !isOnline);
}

async function refreshState() {
  const state = await window.desktopApi.getState();
  const dict = I18N[currentLang];
  currentToken = state.runtimeToken || '';
  bridgeTokenInput.value = currentToken;
  bridgeUrlInput.value = state.launcher?.bridgeUrl || '';
  autoStartBridgeInput.checked = !!state.launcher?.autoStartBridge;
  const mode = state.runtime?.mode || state.status?.mode || '';
  markActiveMode(mode);
  setIndicatorState(
    bridgeProcessIndicator,
    !!state.bridgeRunning,
    `${dict.processLabel}: ${state.bridgeRunning ? dict.running : dict.stopped}`
  );
  const apiReachable = !!state.health?.ok;
  setIndicatorState(
    bridgeApiIndicator,
    apiReachable,
    `${dict.apiLabel}: ${apiReachable ? dict.reachable : dict.unreachable}`
  );
  statusBox.textContent = formatJson({
    bridgeRunning: state.bridgeRunning,
    runtime: state.runtime,
    launcher: state.launcher,
    health: state.health,
    status: state.status,
    paths: state.paths,
  });
  logBox.textContent = (state.bridgeLog || []).join('\n') || I18N[currentLang].noLogs;
  if (state.runtime) {
    const folders = state.runtime.upload?.allowedFolders || state.runtime.allowedUploadFolders || [];
    const domains = state.runtime.sites?.allowedUploadDomains || state.runtime.allowedUploadDomains || [];
    const exts = state.runtime.upload?.allowedExtensions || state.runtime.allowedExtensions || [];
    if (uploadFoldersInput && !uploadFoldersInput.dataset.touched) uploadFoldersInput.value = folders.join(';');
    if (uploadDomainsInput && !uploadDomainsInput.dataset.touched) uploadDomainsInput.value = domains.join(';');
    if (uploadExtInput && !uploadExtInput.dataset.touched) uploadExtInput.value = exts.join(';');
  }
}

function withRefresh(handler) {
  return async () => {
    try {
      await handler();
    } finally {
      await refreshState();
    }
  };
}

saveConnectionBtn.addEventListener('click', withRefresh(async () => {
  await window.desktopApi.setConnection({
    bridgeUrl: bridgeUrlInput.value.trim(),
    tokenOverride: tokenOverrideInput.value.trim(),
    autoStartBridge: autoStartBridgeInput.checked,
  });
  tokenOverrideInput.value = '';
}));

document.getElementById('startBridge').addEventListener('click', withRefresh(() => window.desktopApi.startBridge()));
document.getElementById('stopBridge').addEventListener('click', withRefresh(() => window.desktopApi.stopBridge()));
document.getElementById('restartBridge').addEventListener('click', withRefresh(() => window.desktopApi.restartBridge()));
document.getElementById('checkState').addEventListener('click', refreshState);

for (const modeButton of document.querySelectorAll('[data-mode]')) {
  modeButton.addEventListener('click', withRefresh(async () => {
    const mode = modeButton.getAttribute('data-mode');
    await window.desktopApi.setMode(mode);
    markActiveMode(mode);
  }));
}

for (const quickButton of document.querySelectorAll('[data-quick]')) {
  quickButton.addEventListener('click', withRefresh(async () => {
    const quick = quickButton.getAttribute('data-quick');
    const result = await window.desktopApi.quickAction(quick);
    statusBox.textContent = formatJson({ lastQuickAction: quick, result });
    quickButton.classList.add('active');
    setTimeout(() => quickButton.classList.remove('active'), 900);
  }));
}

for (const openButton of document.querySelectorAll('[data-open]')) {
  openButton.addEventListener('click', async () => {
    const target = openButton.getAttribute('data-open');
    await window.desktopApi.openPath(target);
    openButton.classList.add('active');
    setTimeout(() => openButton.classList.remove('active'), 600);
  });
}

langUaBtn.addEventListener('click', () => applyLanguage('ua'));
langEnBtn.addEventListener('click', () => applyLanguage('en'));
toggleTokenBtn.addEventListener('click', () => {
  bridgeTokenInput.type = bridgeTokenInput.type === 'password' ? 'text' : 'password';
  toggleTokenBtn.textContent = bridgeTokenInput.type === 'password'
    ? I18N[currentLang].showToken
    : I18N[currentLang].hideToken;
});
copyTokenBtn.addEventListener('click', async () => {
  if (!currentToken) return;
  await navigator.clipboard.writeText(currentToken);
  copyTokenBtn.classList.add('active');
  setTimeout(() => copyTokenBtn.classList.remove('active'), 700);
});
openTargetUrlBtn.addEventListener('click', withRefresh(async () => {
  const url = targetUrlInput.value.trim();
  if (!url) return;
  const result = await window.desktopApi.navigate({ url });
  statusBox.textContent = formatJson({ navigate: { url, result } });
}));

for (const id of ['uploadFoldersInput', 'uploadDomainsInput', 'uploadExtInput']) {
  const el = document.getElementById(id);
  if (el) el.addEventListener('input', () => { el.dataset.touched = '1'; });
}

document.getElementById('saveUploadPolicy')?.addEventListener('click', withRefresh(async () => {
  const split = (value) => String(value || '').split(';').map((x) => x.trim()).filter(Boolean);
  const result = await window.desktopApi.updateUploadPolicy({
    allowedFolders: split(uploadFoldersInput.value),
    allowedUploadDomains: split(uploadDomainsInput.value),
    allowedExtensions: split(uploadExtInput.value),
  });
  statusBox.textContent = formatJson({ uploadPolicy: result });
}));

document.getElementById('findMatchingFiles')?.addEventListener('click', withRefresh(async () => {
  const result = await window.desktopApi.bridgeAction({
    action: 'universalFileUploadPreview',
    params: {
      fileQuery: uploadFileQueryInput.value.trim(),
    },
  });
  statusBox.textContent = formatJson({ universalFind: result });
}));

document.getElementById('preflightSelectedFile')?.addEventListener('click', withRefresh(async () => {
  const result = await window.desktopApi.bridgeAction({
    action: 'universalFileUploadPreflight',
    params: {
      fileQuery: uploadFileQueryInput.value.trim(),
    },
  });
  statusBox.textContent = formatJson({ universalPreflight: result });
}));

document.getElementById('attachSelectedFile')?.addEventListener('click', withRefresh(async () => {
  const result = await window.desktopApi.bridgeAction({
    action: 'universalFileUploadAttach',
    params: {
      fileQuery: uploadFileQueryInput.value.trim(),
      confirmAttach: true,
      userOwnedCompletedWork: true,
      allowEducationPlatformUpload: true,
      usePreflightCopy: !!usePreflightCopyInput?.checked,
    },
  });
  statusBox.textContent = formatJson({ universalAttach: result });
}));

document.getElementById('attachAndSubmitSelectedFile')?.addEventListener('click', withRefresh(async () => {
  const result = await window.desktopApi.bridgeAction({
    action: 'universalFileUploadAttachAndSubmit',
    params: {
      fileQuery: uploadFileQueryInput.value.trim(),
      confirmAttach: true,
      confirmSubmit: true,
      userOwnedCompletedWork: true,
      allowEducationPlatformUpload: true,
      usePreflightCopy: !!usePreflightCopyInput?.checked,
    },
  });
  statusBox.textContent = formatJson({ universalAttachSubmit: result });
}));

applyLanguage('en');
refreshState();
setInterval(refreshState, 3500);
