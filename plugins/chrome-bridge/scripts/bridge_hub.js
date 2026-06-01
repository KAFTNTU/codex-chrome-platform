const http = require('http');
const { URL } = require('url');
const { randomUUID } = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  loadRuntime,
  saveRuntime,
  maskToken,
  getPermissionsForMode,
  isSensitiveUrl,
  normalizeActionName,
  errorPayload,
  actionNeedsConfirmation,
  actionAllowedInSafeMode,
} = require('./bridge_runtime');

const PORT = Number(process.env.CHROME_BRIDGE_PORT || 17373);
const runtime = loadRuntime();
const HOST = process.env.CHROME_BRIDGE_HOST || (runtime.localNetworkEnabled ? '0.0.0.0' : '127.0.0.1');
const clients = new Map();
const results = new Map();
const OUTPUT_DIR = path.join(os.homedir(), '.chrome-bridge', 'output');
const LOGS_DIR = path.join(os.homedir(), '.chrome-bridge', 'logs');
const ASSISTIVE_UPLOAD_LOG = path.join(LOGS_DIR, 'assistive_upload.log');
const EDUCATIONAL_HOST_HINTS = ['atutor', 'moodle', 'canvas', 'blackboard', 'school', 'edu.'];

function now() { return new Date().toISOString(); }

function getClient(clientId) {
  if (!clients.has(clientId)) {
    clients.set(clientId, {
      clientId,
      registeredAt: now(),
      lastSeen: now(),
      lastTab: null,
      queue: [],
    });
  }
  return clients.get(clientId);
}

function latestClient() {
  return [...clients.values()].sort((a, b) => Date.parse(b.lastSeen) - Date.parse(a.lastSeen))[0] || null;
}

function sendJson(res, code, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Bridge-Token',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function getAuthToken(req, body = {}) {
  const header = req.headers['x-bridge-token'] || req.headers.authorization || '';
  if (String(header).startsWith('Bearer ')) {
    return String(header).slice(7).trim();
  }
  return body.token || header || '';
}

function authorize(req, body = {}, { required = true } = {}) {
  const token = getAuthToken(req, body);
  if (!required) return { ok: true, token };
  if (!token) {
    return { ok: false, status: 401, payload: errorPayload('TOKEN_REQUIRED', 'A bridge token is required.') };
  }
  if (token !== runtime.token) {
    return { ok: false, status: 403, payload: errorPayload('INVALID_TOKEN', 'The provided bridge token is invalid.') };
  }
  return { ok: true, token };
}

function queueCommand(payload) {
  const targetClient = payload.clientId ? clients.get(payload.clientId) : latestClient();
  if (!targetClient) {
    throw Object.assign(new Error('Chrome extension is not connected'), { bridgeCode: 'EXTENSION_NOT_CONNECTED' });
  }
  const commandId = randomUUID();
  const command = {
    commandId,
    action: payload.action,
    params: payload.params || {},
    createdAt: now(),
  };
  results.set(commandId, { status: 'pending', command, createdAt: now() });
  targetClient.queue.push(command);
  return { commandId, clientId: targetClient.clientId };
}

function ensureOutputDir() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

function ensureLogsDir() {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

function appendAssistiveUploadLog(entry) {
  ensureLogsDir();
  fs.appendFileSync(ASSISTIVE_UPLOAD_LOG, `${JSON.stringify({ ts: now(), ...entry })}\n`, 'utf8');
}

function isEducationalUrl(rawUrl = '') {
  try {
    const u = new URL(rawUrl);
    const host = String(u.hostname || '').toLowerCase();
    return EDUCATIONAL_HOST_HINTS.some((hint) => host.includes(hint));
  } catch {
    return false;
  }
}

function normalizeFsPath(filePath) {
  return path.resolve(String(filePath || '')).toLowerCase();
}

function isWithinFolder(filePath, folderPath) {
  const fileNorm = normalizeFsPath(filePath);
  const folderNorm = normalizeFsPath(folderPath);
  return fileNorm === folderNorm || fileNorm.startsWith(`${folderNorm}${path.sep}`);
}

function validateUploadFiles(runtimeConfig, files = [], manualSelectedFiles = false) {
  if (!Array.isArray(files) || !files.length) {
    throw Object.assign(new Error('files is required'), { bridgeCode: 'INVALID_PARAMS' });
  }
  const allowedFolders = Array.isArray(runtimeConfig.allowedUploadFolders) ? runtimeConfig.allowedUploadFolders : [];
  const validated = files.map((rawPath) => {
    const resolved = path.resolve(String(rawPath || ''));
    if (!fs.existsSync(resolved)) {
      throw Object.assign(new Error(`File does not exist: ${resolved}`), { bridgeCode: 'INVALID_PARAMS' });
    }
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) {
      throw Object.assign(new Error(`Not a file: ${resolved}`), { bridgeCode: 'INVALID_PARAMS' });
    }
    const fromAllowedFolder = allowedFolders.some((folder) => isWithinFolder(resolved, folder));
    if (!manualSelectedFiles && !fromAllowedFolder) {
      throw Object.assign(new Error(`File outside allowed folders: ${resolved}`), { bridgeCode: 'UPLOAD_POLICY_BLOCK' });
    }
    return {
      path: resolved,
      name: path.basename(resolved),
      size: stat.size,
      fromAllowedFolder,
      manualSelected: !!manualSelectedFiles,
    };
  });
  return validated;
}

function domainAllowedByPolicy(runtimeConfig, siteUrl) {
  const policy = getUploadPolicy(runtimeConfig);
  let host = '';
  try {
    host = String(new URL(siteUrl).hostname || '').toLowerCase();
  } catch {
    return { ok: false, code: 'POLICY_BLOCKED', message: 'Invalid current site URL.' };
  }
  const blocked = policy.blockedDomains;
  const allowed = policy.allowedUploadDomains;
  const allowUnknown = policy.allowUnknownDomains;
  const blockedHit = blocked.some((d) => host === String(d).toLowerCase() || host.endsWith(`.${String(d).toLowerCase()}`));
  if (blockedHit) return { ok: false, code: 'POLICY_BLOCKED', message: `Domain is blocked: ${host}` };
  if (!allowUnknown && !allowed.some((d) => host === String(d).toLowerCase() || host.endsWith(`.${String(d).toLowerCase()}`))) {
    return { ok: false, code: 'POLICY_BLOCKED', message: `Domain is not allowed: ${host}` };
  }
  return { ok: true, host };
}

function isLikelyQuizOrTestContext(tab = null) {
  const text = `${tab?.url || ''} ${tab?.title || ''}`.toLowerCase();
  return /(quiz|test|exam|attempt|assessment|контроль|тест)/i.test(text);
}

function extAllowed(runtimeConfig, fileName) {
  const allowed = Array.isArray(runtimeConfig.allowedExtensions) ? runtimeConfig.allowedExtensions : [];
  const ext = path.extname(String(fileName || '')).toLowerCase();
  return allowed.length ? allowed.includes(ext) : true;
}

function maxFileSizeBytes(runtimeConfig) {
  const mb = Number(runtimeConfig.maxFileSizeMb || 25);
  return Math.max(1, mb) * 1024 * 1024;
}

function findFileByNameInAllowedFolders(runtimeConfig, fileName) {
  const target = String(fileName || '').trim().toLowerCase();
  if (!target) return null;
  const roots = Array.isArray(runtimeConfig.allowedUploadFolders) ? runtimeConfig.allowedUploadFolders : [];
  const queue = roots.map((root) => path.resolve(root));
  const maxDirs = 4000;
  let visited = 0;
  while (queue.length && visited < maxDirs) {
    const dir = queue.shift();
    visited += 1;
    if (!fs.existsSync(dir)) continue;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isFile() && entry.name.toLowerCase() === target) return full;
      if (entry.isDirectory()) queue.push(full);
    }
  }
  return null;
}

function getUploadPolicy(runtimeConfig) {
  const upload = runtimeConfig.upload || {};
  const sites = runtimeConfig.sites || {};
  const allowedFolders = (upload.allowedFolders && upload.allowedFolders.length
    ? upload.allowedFolders
    : runtimeConfig.allowedUploadFolders) || [];
  const allowedExtensions = (upload.allowedExtensions && upload.allowedExtensions.length
    ? upload.allowedExtensions
    : runtimeConfig.allowedExtensions) || [];
  const maxFileSizeMb = Number(upload.maxFileSizeMb || runtimeConfig.maxFileSizeMb || 50);
  const allowedUploadDomains = (sites.allowedUploadDomains && sites.allowedUploadDomains.length
    ? sites.allowedUploadDomains
    : runtimeConfig.allowedUploadDomains) || [];
  const blockedDomains = (sites.blockedDomains && sites.blockedDomains.length
    ? sites.blockedDomains
    : runtimeConfig.blockedDomains) || [];
  const allowUnknownDomains = sites.allowUnknownDomains ?? runtimeConfig.allowUnknownDomains ?? false;
  return {
    upload,
    sites,
    allowedFolders: allowedFolders.map((x) => path.resolve(String(x))),
    allowedExtensions: allowedExtensions.map((x) => String(x).toLowerCase()),
    maxFileSizeMb,
    allowedUploadDomains,
    blockedDomains,
    allowUnknownDomains: !!allowUnknownDomains,
  };
}

function scanFilesInFolders(folders) {
  const out = [];
  const queue = [...folders];
  let visited = 0;
  while (queue.length && visited < 12000) {
    const dir = queue.shift();
    visited += 1;
    if (!fs.existsSync(dir)) continue;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        queue.push(full);
      } else if (entry.isFile()) {
        let stat = null;
        try { stat = fs.statSync(full); } catch { stat = null; }
        if (!stat) continue;
        out.push({
          path: full,
          name: entry.name,
          size: stat.size,
          modifiedAt: stat.mtime.toISOString(),
          mtimeMs: stat.mtimeMs,
          folder: path.dirname(full),
          extension: path.extname(entry.name).toLowerCase(),
        });
      }
    }
  }
  return out;
}

function globToRegex(mask) {
  const escaped = String(mask).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

function matchFilesByQuery(files, fileQuery, policy, allowMultiple = false) {
  const q = String(fileQuery || '').trim();
  if (!q) throw Object.assign(new Error('fileQuery is required'), { bridgeCode: 'INVALID_PARAMS' });
  let candidates = files.filter((f) => policy.allowedExtensions.includes(f.extension));
  if (q.toLowerCase() === 'newest') {
    candidates = candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  } else if (q.toLowerCase().startsWith('newest:')) {
    const ext = q.slice('newest:'.length).trim().toLowerCase();
    candidates = candidates.filter((f) => f.extension === ext).sort((a, b) => b.mtimeMs - a.mtimeMs);
  } else if (q.includes('*') || q.includes('?')) {
    if (!policy.upload.allowGlobFileSearch) throw Object.assign(new Error('Glob search is disabled by policy'), { bridgeCode: 'POLICY_BLOCKED' });
    const rx = globToRegex(q);
    candidates = candidates.filter((f) => rx.test(f.name));
  } else {
    const lower = q.toLowerCase();
    const exact = candidates.filter((f) => f.name.toLowerCase() === lower);
    if (exact.length) {
      candidates = exact;
    } else {
      if (!policy.upload.allowFuzzyFileSearch) throw Object.assign(new Error('Fuzzy search is disabled by policy'), { bridgeCode: 'POLICY_BLOCKED' });
      candidates = candidates.filter((f) => f.name.toLowerCase().includes(lower));
    }
  }
  if (!candidates.length) return { status: 'NO_MATCHES', candidates: [] };
  if (!allowMultiple && candidates.length > 1) {
    return { status: 'MULTIPLE_MATCHES', candidates: candidates.slice(0, 30) };
  }
  return { status: 'OK', candidates: allowMultiple ? candidates : [candidates[0]] };
}

function saveDataUrlPng(dataUrl, prefix = 'upload') {
  if (!dataUrl || !String(dataUrl).startsWith('data:image/png;base64,')) return null;
  ensureOutputDir();
  const stamp = Date.now();
  const filePath = path.join(OUTPUT_DIR, `${prefix}_${stamp}.png`);
  const b64 = String(dataUrl).slice('data:image/png;base64,'.length);
  fs.writeFileSync(filePath, Buffer.from(b64, 'base64'));
  return filePath;
}

async function waitForResult(commandId, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const entry = results.get(commandId);
    if (entry && entry.status !== 'pending') return entry;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return null;
}

function currentStatus() {
  const latest = latestClient();
  return {
    ok: true,
    bridge: {
      host: HOST,
      port: PORT,
      mode: runtime.mode,
      developerModeEnabled: !!runtime.developerModeEnabled,
      localNetworkEnabled: !!runtime.localNetworkEnabled,
      runtimeTokenMasked: maskToken(runtime.token),
      runtimePath: require('./bridge_runtime').getRuntimePath(),
    },
    extensionConnected: !!latest,
    activeTab: latest?.lastTab || null,
    connectedClients: [...clients.values()].map((client) => ({
      clientId: client.clientId,
      lastSeen: client.lastSeen,
      lastTab: client.lastTab,
    })),
    permissions: getPermissionsForMode(runtime),
    pendingResults: [...results.values()].filter((entry) => entry.status === 'pending').length,
    tokenAuthEnabled: true,
  };
}

function dispatchActionRequest(body) {
  const requested = body.action;
  if (!requested) {
    return { ok: false, status: 400, payload: errorPayload('INVALID_PARAMS', 'action is required') };
  }
  const normalizedAction = normalizeActionName(requested);
  const active = latestClient()?.lastTab || null;

  if (runtime.mode === 'safe') {
    if (normalizedAction === 'submitForm') {
      return {
        ok: false,
        status: 403,
        payload: errorPayload('SAFE_MODE_SUBMIT_BLOCKED', 'Submit actions are blocked in safe mode. Use manual submit in browser.'),
      };
    }
    if (!actionAllowedInSafeMode(normalizedAction)) {
      return {
        ok: false,
        status: 403,
        payload: errorPayload('ACTION_NOT_ALLOWED_IN_SAFE_MODE', `Action ${normalizedAction} is blocked in safe mode.`),
      };
    }
    if (active?.url && isSensitiveUrl(active.url, runtime) && !['getActiveTab', 'extractTitle', 'currentUrl', 'basicStatus'].includes(normalizedAction)) {
      return {
        ok: false,
        status: 403,
        payload: errorPayload('SENSITIVE_DOMAIN_BLOCKED', 'Sensitive domain is blocked in safe mode.'),
      };
    }
    if (actionNeedsConfirmation(requested) || actionNeedsConfirmation(normalizedAction)) {
      return {
        ok: false,
        status: 409,
        payload: errorPayload('CONFIRMATION_REQUIRED', `Action ${normalizedAction} requires explicit confirmation in safe mode.`),
      };
    }
  }

  return {
    ok: true,
    action: normalizedAction,
    params: body.params || {},
  };
}

async function executeRemoteAction(action, params = {}, waitMs = 20000) {
  const queued = queueCommand({ action, params });
  const result = await waitForResult(queued.commandId, waitMs);
  if (!result) {
    throw Object.assign(new Error('Bridge action timeout'), { bridgeCode: 'TIMEOUT', queued });
  }
  if (result.status === 'error') {
    throw Object.assign(new Error(result.error || 'Remote bridge action failed'), { bridgeCode: 'INTERNAL_ERROR', queued });
  }
  return result.data;
}

function normalizeExtractedTables(rawData) {
  const tables = Array.isArray(rawData?.tables) ? rawData.tables : [];
  return {
    tables: tables.map((table, index) => {
      const rows = Array.isArray(table.rows) ? table.rows : [];
      const headers = Array.isArray(table.headers) ? table.headers : [];
      const columnCount = Math.max(
        headers.length,
        ...rows.map((row) => (Array.isArray(row) ? row.length : 0)),
      );
      return {
        id: `table_${index + 1}`,
        caption: table.caption || '',
        rows: rows.length,
        columns: columnCount,
        headers,
        preview: rows.slice(0, 5),
        rawRows: rows,
      };
    }),
  };
}

function pickTableById(extracted, tableId = 'all') {
  if (tableId === 'all') return extracted.tables;
  return extracted.tables.filter((table) => table.id === tableId);
}

function escapeCsv(value) {
  const raw = String(value ?? '');
  if (raw.includes(',') || raw.includes('"') || raw.includes('\n') || raw.includes('\r')) {
    return `"${raw.replaceAll('"', '""')}"`;
  }
  return raw;
}

function toCsvWithBom(table) {
  const lines = [];
  if (Array.isArray(table.headers) && table.headers.length) {
    lines.push(table.headers.map(escapeCsv).join(','));
  }
  for (const row of table.rawRows || []) {
    lines.push((Array.isArray(row) ? row : []).map(escapeCsv).join(','));
  }
  return `\uFEFF${lines.join('\r\n')}`;
}

async function executeLocalApiAction(action, params = {}) {
  const aliasAction = {
    fileUploadAssistantPreview: 'universalFileUploadPreview',
    fileUploadAssistantAttach: 'universalFileUploadAttach',
    fileUploadAssistantAttachAndSubmit: 'universalFileUploadAttachAndSubmit',
  }[action] || action;
  action = aliasAction;
  if (!params.fileQuery && params.fileName) {
    params.fileQuery = params.fileName;
  }

  if (action === 'universalFileUploadPreflight' || action === 'universalFileUploadPreview') {
    const active = latestClient()?.lastTab || null;
    if (!active?.url) return errorPayload('EXTENSION_NOT_CONNECTED', 'No active tab found.');
    if (isLikelyQuizOrTestContext(active)) return errorPayload('POLICY_BLOCKED', 'Quiz/test contexts are blocked.');
    const policy = getUploadPolicy(runtime);
    if (!policy.upload.enabled) return errorPayload('POLICY_BLOCKED', 'Upload feature is disabled by policy.');
    const domain = domainAllowedByPolicy(runtime, active.url);
    if (!domain.ok) return errorPayload(domain.code, domain.message);

    const allowedFolders = policy.allowedFolders;
    const files = scanFilesInFolders(allowedFolders);
    const manualFiles = Array.isArray(params.manualSelectedFiles) ? params.manualSelectedFiles.map((x) => path.resolve(String(x))) : [];
    const manualEntries = manualFiles.filter((f) => fs.existsSync(f)).map((f) => {
      const s = fs.statSync(f);
      return { path: f, name: path.basename(f), size: s.size, modifiedAt: s.mtime.toISOString(), mtimeMs: s.mtimeMs, folder: path.dirname(f), extension: path.extname(f).toLowerCase() };
    });
    const pool = [...files, ...manualEntries];
    const matched = matchFilesByQuery(pool, params.fileQuery, policy, !!params.multiple);
    if (matched.status === 'NO_MATCHES') return errorPayload('NO_MATCHES', 'No files matched fileQuery.');
    if (matched.status === 'MULTIPLE_MATCHES') {
      return errorPayload('MULTIPLE_MATCHES', 'Multiple files matched. Provide more exact fileQuery.', {
        candidates: matched.candidates.map((f) => ({ name: f.name, size: f.size, modifiedAt: f.modifiedAt, folder: f.folder })),
      });
    }
    const maxBytes = maxFileSizeBytes({ maxFileSizeMb: policy.maxFileSizeMb });
    const selected = matched.candidates.filter((f) => policy.allowedExtensions.includes(f.extension)).filter((f) => f.size <= maxBytes);
    if (!selected.length) return errorPayload('POLICY_BLOCKED', 'Matched files do not pass extension/size policy.');
    const field = await executeRemoteAction('inspectUploadField', { selector: params.selector || 'input[type="file"]', tabId: params.tabId });
    const screenshot = await executeRemoteAction('screenshot', { tabId: params.tabId });
    const shotPath = saveDataUrlPng(screenshot?.dataUrl || '', 'universal_preflight');
    return {
      ok: true,
      assistant: 'Universal File Upload Assistant',
      status: 'ready',
      site: active.url,
      fileQuery: params.fileQuery,
      uploadSelector: params.selector || 'input[type="file"]',
      uploadField: field,
      files: selected.map((f) => ({ name: f.name, size: f.size, modifiedAt: f.modifiedAt, folder: f.folder, path: f.path })),
      screenshotPath: shotPath,
      logPath: ASSISTIVE_UPLOAD_LOG,
    };
  }

  if (action === 'universalFileUploadAttach' || action === 'universalFileUploadAttachAndSubmit' || action === 'universalFileUploadPreflightAttachAndSubmit') {
    const active = latestClient()?.lastTab || null;
    if (!active?.url) return errorPayload('EXTENSION_NOT_CONNECTED', 'No active tab found.');
    if (isLikelyQuizOrTestContext(active)) return errorPayload('POLICY_BLOCKED', 'Quiz/test contexts are blocked.');
    const policy = getUploadPolicy(runtime);
    if (!policy.upload.enabled) return errorPayload('POLICY_BLOCKED', 'Upload feature is disabled by policy.');
    const domain = domainAllowedByPolicy(runtime, active.url);
    if (!domain.ok) return errorPayload(domain.code, domain.message);
    if (isEducationalUrl(active.url) && params.allowEducationPlatformUpload !== true) {
      return errorPayload('POLICY_BLOCKED', 'allowEducationPlatformUpload=true is required.');
    }
    if (runtime.educationMode?.requireUserOwnedCompletedWorkFlag && !params.userOwnedCompletedWork) {
      return errorPayload('POLICY_BLOCKED', 'userOwnedCompletedWork=true is required.');
    }
    if (!params.confirmAttach) return errorPayload('CONFIRMATION_REQUIRED', 'confirmAttach=true is required.');

    const allowedFolders = policy.allowedFolders;
    const files = scanFilesInFolders(allowedFolders);
    const manualFiles = Array.isArray(params.manualSelectedFiles) ? params.manualSelectedFiles.map((x) => path.resolve(String(x))) : [];
    const manualEntries = manualFiles.filter((f) => fs.existsSync(f)).map((f) => {
      const s = fs.statSync(f);
      return { path: f, name: path.basename(f), size: s.size, modifiedAt: s.mtime.toISOString(), mtimeMs: s.mtimeMs, folder: path.dirname(f), extension: path.extname(f).toLowerCase() };
    });
    const pool = [...files, ...manualEntries];
    const matched = matchFilesByQuery(pool, params.fileQuery, policy, !!params.multiple);
    if (matched.status === 'NO_MATCHES') return errorPayload('NO_MATCHES', 'No files matched fileQuery.');
    if (matched.status === 'MULTIPLE_MATCHES') {
      return errorPayload('MULTIPLE_MATCHES', 'Multiple files matched. Provide more exact fileQuery.', {
        candidates: matched.candidates.map((f) => ({ name: f.name, size: f.size, modifiedAt: f.modifiedAt, folder: f.folder })),
      });
    }
    const maxBytes = maxFileSizeBytes({ maxFileSizeMb: policy.maxFileSizeMb });
    const selected = matched.candidates.filter((f) => policy.allowedExtensions.includes(f.extension)).filter((f) => f.size <= maxBytes);
    if (!selected.length) return errorPayload('POLICY_BLOCKED', 'Matched files do not pass extension/size policy.');
    if (!policy.upload.allowMultipleFiles && selected.length > 1) return errorPayload('POLICY_BLOCKED', 'Multiple file upload is disabled by policy.');

    let uploadFiles = selected.map((f) => f.path);
    if (params.usePreflightCopy || policy.upload.requirePreflightForSubmit) {
      ensureOutputDir();
      uploadFiles = selected.map((f, idx) => {
        const dest = path.join(OUTPUT_DIR, `preflight_${Date.now()}_${idx}_${f.name}`);
        fs.copyFileSync(f.path, dest);
        return dest;
      });
    }

    const uploadSelector = params.selector || 'input[type="file"]';
    const field = await executeRemoteAction('inspectUploadField', { selector: uploadSelector, tabId: params.tabId });
    if (!field?.found) return errorPayload('POLICY_BLOCKED', 'Upload field not found.');
    await executeRemoteAction('setFileInputFiles', { selector: uploadSelector, files: uploadFiles, tabId: params.tabId });
    const attachShot = await executeRemoteAction('screenshot', { tabId: params.tabId });
    const attachShotPath = saveDataUrlPng(attachShot?.dataUrl || '', 'universal_attach');

    let submitText = '';
    let submitStatus = 'attached';
    let submitShotPath = null;
    if (action !== 'universalFileUploadAttach') {
      if (!params.confirmSubmit) return errorPayload('CONFIRMATION_REQUIRED', 'confirmSubmit=true is required for submit.');
      const submitCandidates = ['Submit', 'Send', 'Upload', 'Здати', 'Надіслати', 'Завантажити', 'Відправити'];
      let submitResult = null;
      for (const label of submitCandidates) {
        try {
          submitResult = await executeRemoteAction('clickByText', { text: label, exact: false, selector: 'button, input[type="submit"], [role="button"]', tabId: params.tabId });
          submitText = submitResult?.matchedText || label;
          break;
        } catch {}
      }
      if (!submitResult) {
        submitResult = await executeRemoteAction('submitForm', { selector: 'input[type="submit"], button[type="submit"]', tabId: params.tabId });
        submitText = 'submitForm fallback';
      }
      submitStatus = 'submitted';
      const submitShot = await executeRemoteAction('screenshot', { tabId: params.tabId });
      submitShotPath = saveDataUrlPng(submitShot?.dataUrl || '', 'universal_submit');
    }
    appendAssistiveUploadLog({
      kind: 'assistive_upload_universal',
      action,
      site: active.url,
      fileQuery: params.fileQuery,
      files: selected.map((f) => ({ name: f.name, size: f.size })),
      uploadSelector,
      submitButtonText: submitText,
      status: submitStatus,
    });
    return {
      ok: true,
      assistant: 'Universal File Upload Assistant',
      fileQuery: params.fileQuery,
      files: selected.map((f) => ({ name: f.name, size: f.size, modifiedAt: f.modifiedAt, folder: f.folder })),
      site: active.url,
      uploadSelector,
      submitButtonText: submitText,
      status: submitStatus,
      screenshotPath: {
        afterAttach: attachShotPath,
        afterSubmit: submitShotPath,
      },
      logPath: ASSISTIVE_UPLOAD_LOG,
    };
  }

  if (action === 'fileUploadAssistantAttachAndSubmit') {
    const active = latestClient()?.lastTab || null;
    if (!active?.url) return errorPayload('EXTENSION_NOT_CONNECTED', 'No active tab found.');
    if (isLikelyQuizOrTestContext(active)) {
      return errorPayload('POLICY_BLOCKED', 'Quiz/test contexts are blocked for this action.');
    }
    const policy = domainAllowedByPolicy(runtime, active.url);
    if (!policy.ok) return errorPayload(policy.code, policy.message);
    if (runtime.mode === 'safe') {
      if (!params.userOwnedCompletedWork || !params.confirmSubmit) {
        return errorPayload('CONFIRMATION_REQUIRED', 'Safe mode requires userOwnedCompletedWork=true and confirmSubmit=true.');
      }
    }
    if (runtime.educationMode?.enabled && runtime.educationMode?.requireUserOwnedCompletedWorkFlag && !params.userOwnedCompletedWork) {
      return errorPayload('POLICY_BLOCKED', 'userOwnedCompletedWork=true is required by education policy.');
    }
    if (runtime.educationMode?.enabled && runtime.educationMode?.allowAttachAndSubmitOwnCompletedWork !== true) {
      return errorPayload('POLICY_BLOCKED', 'Attach & submit is disabled by education policy.');
    }
    if (runtime.actions?.allowAutoSubmit === false && !params.confirmSubmit) {
      return errorPayload('CONFIRMATION_REQUIRED', 'confirmSubmit=true is required.');
    }
    if (runtime.upload?.allowAttachAndSubmit !== true) {
      return errorPayload('POLICY_BLOCKED', 'Attach & submit is disabled by upload policy.');
    }
    if (params.allowEducationPlatformUpload !== true && isEducationalUrl(active.url)) {
      return errorPayload('POLICY_BLOCKED', 'allowEducationPlatformUpload=true is required for education platforms.');
    }

    const manualFiles = Array.isArray(params.manualSelectedFiles) ? params.manualSelectedFiles : [];
    let resolvedPath = '';
    if (manualFiles.length && params.fileName) {
      const candidate = manualFiles.find((f) => path.basename(String(f || '')).toLowerCase() === String(params.fileName).toLowerCase());
      if (candidate) resolvedPath = path.resolve(candidate);
    }
    if (!resolvedPath && params.fileName) {
      resolvedPath = findFileByNameInAllowedFolders(runtime, params.fileName) || '';
    }
    if (!resolvedPath) {
      return errorPayload('POLICY_BLOCKED', 'File not found in allowed folders or manual selection list.');
    }
    const validated = validateUploadFiles(runtime, [resolvedPath], manualFiles.includes(resolvedPath) || !!params.manualSelectedFiles)[0];
    if (!extAllowed(runtime, validated.name)) {
      return errorPayload('POLICY_BLOCKED', `Extension is not allowed: ${path.extname(validated.name)}`);
    }
    if (validated.size > maxFileSizeBytes(runtime)) {
      return errorPayload('POLICY_BLOCKED', `File exceeds max size ${runtime.maxFileSizeMb} MB.`);
    }

    const uploadField = await executeRemoteAction('inspectUploadField', { selector: params.selector || 'input[type="file"]', tabId: params.tabId });
    if (!uploadField?.found) return errorPayload('POLICY_BLOCKED', 'Upload field not found.');
    if (!params.confirmAttach) return errorPayload('CONFIRMATION_REQUIRED', 'confirmAttach=true is required.');
    await executeRemoteAction('setFileInputFiles', { selector: params.selector || 'input[type="file"]', files: [validated.path], tabId: params.tabId });
    const afterAttach = await executeRemoteAction('screenshot', { tabId: params.tabId });
    const afterAttachPath = saveDataUrlPng(afterAttach?.dataUrl || '', 'assistive_attach');

    if (!params.confirmSubmit) return errorPayload('CONFIRMATION_REQUIRED', 'confirmSubmit=true is required.');
    const submitCandidates = ['Submit', 'Send', 'Upload', 'Здати', 'Надіслати', 'Завантажити', 'Відправити'];
    let submitResult = null;
    let submitText = '';
    for (const label of submitCandidates) {
      try {
        submitResult = await executeRemoteAction('clickByText', { text: label, exact: false, selector: 'button, input[type="submit"], [role="button"]', tabId: params.tabId });
        submitText = submitResult?.matchedText || label;
        break;
      } catch {
        // try next label
      }
    }
    if (!submitResult) {
      submitResult = await executeRemoteAction('submitForm', { selector: 'input[type="submit"], button[type="submit"]', tabId: params.tabId });
      submitText = 'submitForm fallback';
    }
    const afterSubmit = await executeRemoteAction('screenshot', { tabId: params.tabId });
    const afterSubmitPath = saveDataUrlPng(afterSubmit?.dataUrl || '', 'assistive_submit');

    appendAssistiveUploadLog({
      kind: 'assistive_upload_attach_and_submit',
      site: active.url,
      fileName: validated.name,
      uploadSelector: params.selector || 'input[type="file"]',
      submitButtonText: submitText,
      status: 'submitted',
      mode: runtime.mode,
      logType: 'assistive upload submit',
    });
    return {
      ok: true,
      assistant: 'Attach & Submit own completed file',
      fileName: validated.name,
      site: active.url,
      uploadSelector: params.selector || 'input[type="file"]',
      submitButtonText: submitText,
      status: 'submitted',
      screenshotPath: {
        afterAttach: afterAttachPath,
        afterSubmit: afterSubmitPath,
      },
      logPath: ASSISTIVE_UPLOAD_LOG,
    };
  }
  if (action === 'fileUploadAssistantPreview') {
    const active = latestClient()?.lastTab || null;
    if (!active?.url) {
      return errorPayload('EXTENSION_NOT_CONNECTED', 'No active tab found for upload preview.');
    }
    const educational = isEducationalUrl(active.url);
    if (educational && !params.userOwnedCompletedWork) {
      return errorPayload('UPLOAD_POLICY_BLOCK', 'Educational platform uploads are allowed only for user-owned completed work.');
    }
    const files = validateUploadFiles(runtime, params.files || [], !!params.manualSelectedFiles);
    const selector = String(params.selector || 'input[type="file"]');
    const fieldInfo = await executeRemoteAction('inspectUploadField', { selector, tabId: params.tabId });
    const screenshot = await executeRemoteAction('screenshot', { tabId: params.tabId });
    const preview = {
      assistant: 'File Upload Assistant',
      mode: runtime.mode,
      site: active.url,
      title: active.title || '',
      uploadField: selector,
      uploadFieldInfo: fieldInfo || null,
      files: files.map((f) => ({ name: f.name, size: f.size, path: f.path })),
      screenshotDataUrl: screenshot?.dataUrl || null,
      note: 'Preview only. No submit is performed.',
    };
    appendAssistiveUploadLog({
      kind: 'assistive_upload_preview',
      site: active.url,
      uploadField: selector,
      files: preview.files.map((f) => ({ name: f.name, size: f.size })),
      userOwnedCompletedWork: !!params.userOwnedCompletedWork,
    });
    return { ok: true, preview };
  }
  if (action === 'fileUploadAssistantAttach') {
    const active = latestClient()?.lastTab || null;
    if (!active?.url) {
      return errorPayload('EXTENSION_NOT_CONNECTED', 'No active tab found for upload attach.');
    }
    const educational = isEducationalUrl(active.url);
    if (educational && !params.userOwnedCompletedWork) {
      return errorPayload('UPLOAD_POLICY_BLOCK', 'Educational platform uploads are allowed only for user-owned completed work.');
    }
    if (!params.confirmAttach) {
      return errorPayload('CONFIRMATION_REQUIRED', 'Set confirmAttach=true after preview to proceed with attachment.');
    }
    const selector = String(params.selector || 'input[type="file"]');
    const files = validateUploadFiles(runtime, params.files || [], !!params.manualSelectedFiles);
    const attach = await executeRemoteAction('setFileInputFiles', {
      selector,
      files: files.map((f) => f.path),
      tabId: params.tabId,
    });
    appendAssistiveUploadLog({
      kind: 'assistive_upload_attach',
      site: active.url,
      uploadField: selector,
      files: files.map((f) => ({ name: f.name, size: f.size })),
      submitPerformed: false,
      mode: runtime.mode,
    });
    return {
      ok: true,
      assistant: 'File Upload Assistant',
      attached: true,
      submitPerformed: false,
      uploadField: selector,
      files: files.map((f) => ({ name: f.name, size: f.size, path: f.path })),
      result: attach,
      nextStep: 'User must manually confirm and click Submit.',
    };
  }
  if (action === 'fileUploadAssistantSubmit') {
    if (runtime.mode === 'safe') {
      return errorPayload('SAFE_MODE_SUBMIT_BLOCKED', 'Auto-submit is blocked in safe mode.');
    }
    const active = latestClient()?.lastTab || null;
    if (!active?.url) {
      return errorPayload('EXTENSION_NOT_CONNECTED', 'No active tab found for submit.');
    }
    if (!params.confirmSubmit) {
      return errorPayload('CONFIRMATION_REQUIRED', 'Set confirmSubmit=true for explicit manual authorization.');
    }
    const selector = String(params.selector || '').trim();
    if (!selector) {
      return errorPayload('INVALID_PARAMS', 'selector is required for assistive submit.');
    }
    const expectedHost = String(params.expectedHost || '').trim().toLowerCase();
    const expectedUrlContains = String(params.expectedUrlContains || '').trim().toLowerCase();
    let currentHost = '';
    let currentUrl = '';
    try {
      const u = new URL(active.url);
      currentHost = String(u.hostname || '').toLowerCase();
      currentUrl = String(active.url || '').toLowerCase();
    } catch {
      currentUrl = String(active.url || '').toLowerCase();
    }
    if (expectedHost && currentHost !== expectedHost) {
      return errorPayload('SUBMIT_GUARD_HOST_MISMATCH', `Current host ${currentHost || '-'} does not match expectedHost ${expectedHost}.`);
    }
    if (expectedUrlContains && !currentUrl.includes(expectedUrlContains)) {
      return errorPayload('SUBMIT_GUARD_URL_MISMATCH', `Current URL does not include expectedUrlContains: ${expectedUrlContains}.`);
    }
    if (isEducationalUrl(active.url) && !params.userOwnedCompletedWork) {
      return errorPayload('UPLOAD_POLICY_BLOCK', 'Educational platform submit is allowed only for user-owned completed work.');
    }
    const submit = await executeRemoteAction('submitForm', { selector, tabId: params.tabId });
    appendAssistiveUploadLog({
      kind: 'assistive_upload_submit',
      site: active.url,
      submitSelector: selector,
      expectedHost,
      expectedUrlContains,
      mode: runtime.mode,
      userOwnedCompletedWork: !!params.userOwnedCompletedWork,
      manualConfirmation: true,
    });
    return {
      ok: true,
      assistant: 'File Upload Assistant',
      submitted: true,
      selector,
      site: active.url,
      result: submit,
    };
  }
  if (action === 'getActiveTab') {
    const status = currentStatus();
    return { ok: true, activeTab: status.activeTab };
  }
  if (action === 'extractText') {
    return await executeRemoteAction('extractText', params);
  }
  if (action === 'extractHtml') {
    return await executeRemoteAction('extractHtml', params);
  }
  if (action === 'extractTables') {
    const raw = await executeRemoteAction('extractTables', params);
    return { ok: true, ...normalizeExtractedTables(raw) };
  }
  if (action === 'screenshot') {
    return await executeRemoteAction('screenshot', params);
  }
  if (action === 'fullPageScreenshot') {
    return await executeRemoteAction('fullPageScreenshot', params);
  }
  if (action === 'click') {
    return await executeRemoteAction('click', params);
  }
  if (action === 'clickByText') {
    return await executeRemoteAction('clickByText', params);
  }
  if (action === 'type') {
    return await executeRemoteAction('type', params);
  }
  if (action === 'pasteText') {
    return await executeRemoteAction('pasteText', params);
  }
  if (action === 'scroll') {
    return await executeRemoteAction('scroll', params);
  }
  if (action === 'getForms') {
    return await executeRemoteAction('getForms', params);
  }
  if (action === 'export_data_csv') {
    ensureOutputDir();
    const extractedRaw = await executeRemoteAction('extractTables', {});
    const extracted = normalizeExtractedTables(extractedRaw);
    const targetId = params.tableId || 'all';
    const selected = pickTableById(extracted, targetId);
    if (!selected.length) {
      return errorPayload('INVALID_PARAMS', `No table found for tableId=${targetId}`);
    }
    const stamp = Date.now();
    const filePath = path.join(OUTPUT_DIR, selected.length === 1 ? `table_${targetId}_${stamp}.csv` : `tables_${stamp}.csv`);
    const csvBlocks = selected.map((table) => {
      const caption = table.caption ? `# ${table.caption}` : `# ${table.id}`;
      return `${caption}\r\n${toCsvWithBom(table)}`;
    });
    fs.writeFileSync(filePath, csvBlocks.join('\r\n\r\n'), 'utf8');
    return { ok: true, filePath, tableCount: selected.length, encoding: 'utf-8-bom' };
  }
  if (action === 'fill_form_preview') {
    return {
      ok: true,
      status: 'preview_only',
      message: 'fill_form_preview is planned. Current step validates and reserves this API surface.',
      params,
    };
  }
  if (action === 'fill_form_confirmed') {
    return errorPayload('CONFIRMATION_REQUIRED', 'fill_form_confirmed requires explicit interactive confirmation flow.');
  }
  if (action === 'macro_start_recording') {
    return await executeRemoteAction('startMacroRecording', params);
  }
  if (action === 'macro_stop_recording') {
    return await executeRemoteAction('stopMacroRecording', params);
  }
  if (action === 'macro_run') {
    return await executeRemoteAction('runRecipe', { name: params.name || 'desktop_macro' });
  }
  return null;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === 'OPTIONS') return sendJson(res, 200, { ok: true });

    if (req.method === 'GET' && url.pathname === '/health') {
      const status = currentStatus();
      return sendJson(res, 200, {
        ok: true,
        mode: runtime.mode,
        extensionConnected: status.extensionConnected,
        activeTab: status.activeTab,
      });
    }

    if (req.method === 'GET' && (url.pathname === '/status' || url.pathname === '/api/status')) {
      return sendJson(res, 200, currentStatus());
    }

    if (req.method === 'POST' && url.pathname === '/api/register') {
      const body = await readBody(req);
      const auth = authorize(req, body);
      if (!auth.ok) return sendJson(res, auth.status, auth.payload);
      const client = getClient(body.clientId || randomUUID());
      client.lastSeen = now();
      if (body.lastTab) client.lastTab = body.lastTab;
      return sendJson(res, 200, {
        ok: true,
        clientId: client.clientId,
        port: PORT,
        mode: runtime.mode,
        tokenMasked: maskToken(runtime.token),
      });
    }

    if (req.method === 'GET' && url.pathname === '/api/pull') {
      const auth = authorize(req, { token: url.searchParams.get('token') });
      if (!auth.ok) return sendJson(res, auth.status, auth.payload);
      const clientId = url.searchParams.get('clientId');
      if (!clientId) return sendJson(res, 400, errorPayload('INVALID_PARAMS', 'clientId is required'));
      const client = getClient(clientId);
      client.lastSeen = now();
      const command = client.queue.shift() || null;
      return sendJson(res, 200, { ok: true, command });
    }

    if (req.method === 'POST' && url.pathname === '/api/result') {
      const body = await readBody(req);
      const auth = authorize(req, body);
      if (!auth.ok) return sendJson(res, auth.status, auth.payload);
      const client = getClient(body.clientId || 'unknown');
      client.lastSeen = now();
      if (body.lastTab) client.lastTab = body.lastTab;
      if (!body.commandId) return sendJson(res, 400, errorPayload('INVALID_PARAMS', 'commandId is required'));
      results.set(body.commandId, {
        status: body.ok === false ? 'error' : 'done',
        clientId: client.clientId,
        commandId: body.commandId,
        data: body.data || null,
        error: body.error || null,
        completedAt: now(),
      });
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'GET' && url.pathname === '/api/result') {
      const auth = authorize(req, { token: url.searchParams.get('token') });
      if (!auth.ok) return sendJson(res, auth.status, auth.payload);
      const commandId = url.searchParams.get('commandId');
      const entry = commandId ? results.get(commandId) : null;
      if (!entry) return sendJson(res, 404, errorPayload('INVALID_PARAMS', 'Unknown commandId'));
      return sendJson(res, 200, { ok: true, result: entry });
    }

    if (req.method === 'POST' && (url.pathname === '/api/command' || url.pathname === '/api/action')) {
      const body = await readBody(req);
      const requested = body.action;
      const auth = authorize(req, body);
      if (!auth.ok) return sendJson(res, auth.status, auth.payload);

      const dispatch = dispatchActionRequest(body);
      if (!dispatch.ok) return sendJson(res, dispatch.status, dispatch.payload);

      try {
        const localResult = await executeLocalApiAction(dispatch.action, body.params || {});
        if (localResult && localResult.ok === false && localResult.error) {
          return sendJson(res, 400, localResult);
        }
        if (localResult && localResult.ok !== false) {
          return sendJson(res, 200, localResult);
        }
      } catch {
        // Fall through to command queue for actions that are not handled locally.
      }

      let queued;
      try {
        queued = queueCommand({ action: dispatch.action, params: dispatch.params, clientId: body.clientId });
      } catch (error) {
        const code = error.bridgeCode || 'INTERNAL_ERROR';
        const message = error.message || String(error);
        const status = code === 'EXTENSION_NOT_CONNECTED' ? 503 : 500;
        return sendJson(res, status, errorPayload(code, message));
      }

      const waitMs = Number(body.waitMs || 15000);
      const result = await waitForResult(queued.commandId, waitMs);
      if (!result) return sendJson(res, 202, errorPayload('TIMEOUT', 'Action execution timeout', { queued }));
      if (result.status === 'error') {
        return sendJson(res, 500, errorPayload('INTERNAL_ERROR', result.error || 'Bridge action failed', { queued }));
      }
      return sendJson(res, 200, { ok: true, ...queued, result });
    }

    if (req.method === 'POST' && url.pathname === '/api/mode') {
      const body = await readBody(req);
      const auth = authorize(req, body);
      if (!auth.ok) return sendJson(res, auth.status, auth.payload);
      const allowed = new Set(['safe', 'developer', 'local_network']);
      if (!allowed.has(body.mode)) {
        return sendJson(res, 400, errorPayload('INVALID_PARAMS', 'mode must be one of safe, developer, local_network'));
      }
      runtime.mode = body.mode;
      runtime.developerModeEnabled = body.mode === 'developer';
      runtime.localNetworkEnabled = body.mode === 'local_network';
      saveRuntime(runtime);
      return sendJson(res, 200, { ok: true, mode: runtime.mode, permissions: getPermissionsForMode(runtime) });
    }

    return sendJson(res, 404, errorPayload('INTERNAL_ERROR', 'Not found'));
  } catch (error) {
    return sendJson(res, 500, errorPayload('INTERNAL_ERROR', error.message || String(error)));
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Chrome Bridge hub listening on http://${HOST}:${PORT}`);
  console.log(`Mode: ${runtime.mode} | Token: ${maskToken(runtime.token)}`);
});
