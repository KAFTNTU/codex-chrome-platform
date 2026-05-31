const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { app, BrowserWindow, ipcMain, shell } = require('electron');

const APP_ROOT = path.resolve(__dirname, '..');
const BRIDGE_SCRIPT = path.join(APP_ROOT, 'plugins', 'chrome-bridge', 'scripts', 'bridge_hub.js');
const RUNTIME_PATH = path.join(os.homedir(), '.chrome-bridge', 'runtime.json');
const LOG_DIR = path.join(os.homedir(), '.chrome-bridge', 'logs');
const OUTPUT_DIR = path.join(os.homedir(), '.chrome-bridge', 'output');
const MACROS_DIR = path.join(os.homedir(), '.chrome-bridge', 'macros');
const BRIDGE_URL = process.env.BRIDGE_URL || 'http://127.0.0.1:17373';

let bridgeProcess = null;
let mainWindow = null;
let bridgeLog = [];

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

async function getHealth() {
  try {
    const res = await fetch(`${BRIDGE_URL}/health`);
    if (!res.ok) return { ok: false, status: res.status };
    return await res.json();
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
}

async function getStatus() {
  try {
    const res = await fetch(`${BRIDGE_URL}/status`);
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
  bridgeProcess = spawn(process.execPath, [BRIDGE_SCRIPT], {
    cwd: APP_ROOT,
    env: process.env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  bridgeProcess.stdout.on('data', (chunk) => pushLog(chunk.toString().trim()));
  bridgeProcess.stderr.on('data', (chunk) => pushLog(`[stderr] ${chunk.toString().trim()}`));
  bridgeProcess.on('exit', (code) => {
    pushLog(`Bridge exited with code ${code}`);
    bridgeProcess = null;
  });
  pushLog('Bridge start requested');
  return { ok: true };
}

function stopBridge() {
  if (!bridgeProcess) return { ok: true, alreadyStopped: true };
  bridgeProcess.kill();
  bridgeProcess = null;
  pushLog('Bridge stop requested');
  return { ok: true };
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
    paths: {
      appRoot: APP_ROOT,
      runtimePath: RUNTIME_PATH,
      extensionPath: path.join(APP_ROOT, 'plugins', 'chrome-bridge', 'assets', 'companion-extension'),
      logsPath: LOG_DIR,
      outputPath: OUTPUT_DIR,
      macrosPath: MACROS_DIR,
    },
    bridgeLog,
  };
});

ipcMain.handle('desktop:start-bridge', async () => startBridge());
ipcMain.handle('desktop:stop-bridge', async () => stopBridge());
ipcMain.handle('desktop:restart-bridge', async () => {
  stopBridge();
  return startBridge();
});

ipcMain.handle('desktop:set-mode', async (_event, mode) => {
  const runtime = readRuntime();
  if (!runtime?.token) {
    return { ok: false, error: 'Token is missing in runtime.json. Start bridge first.' };
  }
  const res = await fetch(`${BRIDGE_URL}/api/mode`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Bridge-Token': runtime.token,
    },
    body: JSON.stringify({ mode, token: runtime.token }),
  });
  const json = await res.json();
  return json;
});

ipcMain.handle('desktop:quick-action', async (_event, action) => {
  const runtime = readRuntime();
  if (!runtime?.token) {
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
  const res = await fetch(`${BRIDGE_URL}/api/action`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Bridge-Token': runtime.token,
    },
    body: JSON.stringify({ ...body, token: runtime.token }),
  });
  return await res.json();
});

ipcMain.handle('desktop:open-path', async (_event, target) => {
  const map = {
    extensions: 'edge://extensions',
    extensionPath: path.join(APP_ROOT, 'plugins', 'chrome-bridge', 'assets', 'companion-extension'),
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
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
