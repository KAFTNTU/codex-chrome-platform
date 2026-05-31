const http = require('http');
const { URL } = require('url');
const { randomUUID } = require('crypto');
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
      const auth = authorize(req, body);
      if (!auth.ok) return sendJson(res, auth.status, auth.payload);

      const dispatch = dispatchActionRequest(body);
      if (!dispatch.ok) return sendJson(res, dispatch.status, dispatch.payload);

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
      if (!result) return sendJson(res, 202, { ok: true, pending: true, ...queued });
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
