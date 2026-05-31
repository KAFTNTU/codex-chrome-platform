const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, BrowserWindow, ipcMain, shell, utilityProcess } = require('electron');

const APP_ROOT = path.resolve(__dirname, '..');
const APP_FS_ROOT = APP_ROOT.endsWith('.asar') ? `${APP_ROOT}.unpacked` : APP_ROOT;
const BRIDGE_SCRIPT = path.join(APP_FS_ROOT, 'plugins', 'chrome-bridge', 'scripts', 'bridge_hub.js');
const RUNTIME_PATH = path.join(os.homedir(), '.chrome-bridge', 'runtime.json');
const LAUNCHER_PATH = path.join(os.homedir(), '.chrome-bridge', 'launcher.json');
const LOG_DIR = path.join(os.homedir(), '.chrome-bridge', 'logs');
const OUTPUT_DIR = path.join(os.homedir(), '.chrome-bridge', 'output');
const MACROS_DIR = path.join(os.homedir(), '.chrome-bridge', 'macros');
const DEFAULT_BRIDGE_URL = process.env.BRIDGE_URL || 'http://127.0.0.1:17373';

let bridgeProcess = null;
let mainWindow = null;
let bridgeLog = [];
let launcherConfig = { bridgeUrl: DEFAULT_BRIDGE_URL, tokenOverride: '', autoStartBridge: true };

function ensureDirs() {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.mkdirSync(MACROS_DIR, { recursive: true });
}

function pushLog(line) {
  const stamped = `[${new Date().toISOString()}] ${line}`;
  bridgeLog = [stamped, ...bridgeLog].slice(0, 400);
  try {
    fs.appendFileSync(path.join(LOG_DIR, 'bridge.log'), `${stamped}\n`, 'utf8');
  } catch {
    // best effort log file
  }
}

function readRuntime() {
  try {
    if (!fs.existsSync(RUNTIME_PATH)) return null;
    return JSON.parse(fs.readFileSync(RUNTIME_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function loadLauncherConfig() {
  try {
    if (!fs.existsSync(LAUNCHER_PATH)) return { bridgeUrl: DEFAULT_BRIDGE_URL, tokenOverride: '', autoStartBridge: true };
    return {
      bridgeUrl: DEFAULT_BRIDGE_URL,
      tokenOverride: '',
      autoStartBridge: true,
      ...JSON.parse(fs.readFileSync(LAUNCHER_PATH, 'utf8')),
    };
  } catch {
    return { bridgeUrl: DEFAULT_BRIDGE_URL, tokenOverride: '', autoStartBridge: true };
  }
}

function saveLauncherConfig(nextConfig) {
  ensureDirs();
  launcherConfig = {
    bridgeUrl: DEFAULT_BRIDGE_URL,
    tokenOverride: '',
    autoStartBridge: true,
    ...nextConfig,
  };
  fs.writeFileSync(LAUNCHER_PATH, JSON.stringify(launcherConfig, null, 2), 'utf8');
}

function getBridgeUrl() {
  return launcherConfig.bridgeUrl || DEFAULT_BRIDGE_URL;
}

function getBridgeToken() {
  const runtime = readRuntime();
  return launcherConfig.tokenOverride || runtime?.token || '';
}

async function getHealth() {
  try {
    const res = await fetch(`${getBridgeUrl()}/health`);
    if (!res.ok) return { ok: false, status: res.status };
    return await res.json();
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
}

async function getStatus() {
  try {
    const res = await fetch(`${getBridgeUrl()}/status`);
    if (!res.ok) return { ok: false, status: res.status };
    return await res.json();
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
}

function startBridge() {
  if (bridgeProcess && !bridgeProcess.killed) {
    return { ok: true, alreadyRunning: true };
  }
  ensureDirs();
  bridgeProcess = utilityProcess.fork(BRIDGE_SCRIPT, [], {
    cwd: APP_FS_ROOT,
    stdio: 'pipe',
    serviceName: 'bridge-hub',
  });
  if (bridgeProcess.stdout) {
    bridgeProcess.stdout.on('data', (chunk) => pushLog(chunk.toString().trim()));
  }
  if (bridgeProcess.stderr) {
    bridgeProcess.stderr.on('data', (chunk) => pushLog(`[stderr] ${chunk.toString().trim()}`));
  }
  bridgeProcess.on('exit', (code) => {
    pushLog(`Bridge exited with code ${code}`);
    bridgeProcess = null;
  });
  pushLog('Bridge start requested');
  return { ok: true };
}

async function stopBridge() {
  if (!bridgeProcess) {
    const health = await getHealth();
    return { ok: true, alreadyStopped: true, stillReachable: !!health?.ok };
  }
  bridgeProcess.kill();
  bridgeProcess = null;
  pushLog('Bridge stop requested');
  await new Promise((resolve) => setTimeout(resolve, 350));
  const health = await getHealth();
  return { ok: true, stopped: true, stillReachable: !!health?.ok };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1160,
    height: 820,
    minWidth: 940,
    minHeight: 700,
    backgroundColor: '#0b1020',
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
}

ipcMain.handle('desktop:get-state', async () => {
  const runtime = readRuntime();
  const health = await getHealth();
  const status = await getStatus();
  return {
    bridgeRunning: !!bridgeProcess,
    runtimeToken: runtime?.token || '',
    health,
    status,
    runtime: runtime
      ? {
          mode: runtime.mode,
          developerModeEnabled: !!runtime.developerModeEnabled,
          localNetworkEnabled: !!runtime.localNetworkEnabled,
          tokenMasked: runtime.token ? `${runtime.token.slice(0, 4)}...${runtime.token.slice(-4)}` : '',
        }
      : null,
    launcher: {
      bridgeUrl: getBridgeUrl(),
      autoStartBridge: !!launcherConfig.autoStartBridge,
      tokenOverrideMasked: launcherConfig.tokenOverride
        ? `${launcherConfig.tokenOverride.slice(0, 4)}...${launcherConfig.tokenOverride.slice(-4)}`
        : '',
    },
    paths: {
      appRoot: APP_ROOT,
      appFsRoot: APP_FS_ROOT,
      runtimePath: RUNTIME_PATH,
      extensionPath: path.join(APP_FS_ROOT, 'plugins', 'chrome-bridge', 'assets', 'companion-extension'),
      logsPath: LOG_DIR,
      outputPath: OUTPUT_DIR,
      macrosPath: MACROS_DIR,
    },
    bridgeLog,
  };
});

ipcMain.handle('desktop:start-bridge', async () => {
  const health = await getHealth();
  if (health?.ok && !bridgeProcess) {
    return { ok: true, alreadyRunning: true, external: true };
  }
  return startBridge();
});
ipcMain.handle('desktop:stop-bridge', async () => stopBridge());
ipcMain.handle('desktop:restart-bridge', async () => {
  await stopBridge();
  return startBridge();
});

ipcMain.handle('desktop:set-mode', async (_event, mode) => {
  const token = getBridgeToken();
  if (!token) {
    return { ok: false, error: 'Token is missing in runtime.json. Start bridge first.' };
  }
  const res = await fetch(`${getBridgeUrl()}/api/mode`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Bridge-Token': token,
    },
    body: JSON.stringify({ mode, token }),
  });
  const json = await res.json();
  return json;
});

ipcMain.handle('desktop:quick-action', async (_event, action) => {
  const token = getBridgeToken();
  if (!token) {
    return { ok: false, error: { code: 'TOKEN_REQUIRED', message: 'Token is missing in runtime.json' } };
  }
  const payloadByAction = {
    extract_tables: { action: 'extract_tables', params: {} },
    export_tables_xlsx: { action: 'export_tables_xlsx', params: { tableId: 'all' } },
    generate_docx_report: { action: 'generate_docx_report', params: { title: 'Bridge Report', includeText: true, includeTables: true, includeScreenshots: true, includeCharts: false } },
    macro_start_recording: { action: 'macro_start_recording', params: { name: 'desktop_macro' } },
    macro_stop_recording: { action: 'macro_stop_recording', params: { saveAs: 'desktop_macro' } },
    macro_run: { action: 'macro_run', params: { name: 'desktop_macro' } },
  };
  const body = payloadByAction[action];
  if (!body) return { ok: false, error: { code: 'INVALID_PARAMS', message: `Unknown quick action: ${action}` } };
  const res = await fetch(`${getBridgeUrl()}/api/action`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Bridge-Token': token,
    },
    body: JSON.stringify({ ...body, token }),
  });
  return await res.json();
});

ipcMain.handle('desktop:navigate', async (_event, payload) => {
  const token = getBridgeToken();
  const url = String(payload?.url || '').trim();
  if (!token) {
    return { ok: false, error: { code: 'TOKEN_REQUIRED', message: 'Token is missing in runtime.json' } };
  }
  if (!/^https?:\/\//i.test(url)) {
    return { ok: false, error: { code: 'INVALID_PARAMS', message: 'URL must start with http:// or https://' } };
  }
  const res = await fetch(`${getBridgeUrl()}/api/action`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Bridge-Token': token,
    },
    body: JSON.stringify({
      action: 'navigate',
      params: { url },
      token,
    }),
  });
  return await res.json();
});

ipcMain.handle('desktop:set-connection', async (_event, payload) => {
  const next = {
    bridgeUrl: String(payload?.bridgeUrl || '').trim() || DEFAULT_BRIDGE_URL,
    tokenOverride: String(payload?.tokenOverride || '').trim(),
    autoStartBridge: payload?.autoStartBridge !== false,
  };
  saveLauncherConfig(next);
  return { ok: true, launcher: launcherConfig };
});

ipcMain.handle('desktop:open-path', async (_event, target) => {
  const map = {
    extensions: 'edge://extensions',
    extensionPath: path.join(APP_FS_ROOT, 'plugins', 'chrome-bridge', 'assets', 'companion-extension'),
    logsPath: LOG_DIR,
    outputPath: OUTPUT_DIR,
    macrosPath: MACROS_DIR,
    runtimePath: RUNTIME_PATH,
  };
  const value = map[target];
  if (!value) return { ok: false, error: 'Unknown path target' };
  if (value.startsWith('edge://') || value.startsWith('chrome://')) {
    await shell.openExternal(value);
    return { ok: true };
  }
  await shell.openPath(value);
  return { ok: true, path: value };
});

app.whenReady().then(() => {
  launcherConfig = loadLauncherConfig();
  if (launcherConfig.autoStartBridge) {
    startBridge();
  }
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
