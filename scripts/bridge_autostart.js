const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const BRIDGE_ENTRY = path.join(__dirname, '..', 'plugins', 'chrome-bridge', 'scripts', 'bridge_hub.js');
const HEALTH_URL = process.env.CHROME_BRIDGE_HEALTH_URL || 'http://127.0.0.1:17373/health';
const LOG_DIR = path.join(os.homedir(), '.chrome-bridge', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'bridge-autostart.log');
const CHECK_INTERVAL_MS = Math.max(3000, Number(process.env.CHROME_BRIDGE_CHECK_INTERVAL_MS || 5000));
const RESTART_MIN_MS = Math.max(1000, Number(process.env.CHROME_BRIDGE_RESTART_MIN_MS || 1500));
const RESTART_MAX_MS = Math.max(RESTART_MIN_MS, Number(process.env.CHROME_BRIDGE_RESTART_MAX_MS || 30000));

let child = null;
let stopping = false;
let restartDelay = RESTART_MIN_MS;
let superviseInFlight = false;

function ensureLogDir() {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

function writeLog(message) {
  ensureLogDir();
  fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${message}\n`, 'utf8');
}

async function isBridgeHealthy() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, Math.min(3000, CHECK_INTERVAL_MS - 250)));
  try {
    const response = await fetch(HEALTH_URL, { signal: controller.signal });
    if (!response.ok) return false;
    const data = await response.json().catch(() => null);
    return !!data?.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function startChild() {
  if (stopping || child) return;
  writeLog(`Starting bridge process: ${BRIDGE_ENTRY}`);
  child = spawn(process.execPath, [BRIDGE_ENTRY], {
    env: {
      ...process.env,
      CHROME_BRIDGE_AUTOSTART: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  child.stdout.on('data', (chunk) => {
    const text = String(chunk || '').trimEnd();
    if (text) writeLog(`[stdout] ${text}`);
  });

  child.stderr.on('data', (chunk) => {
    const text = String(chunk || '').trimEnd();
    if (text) writeLog(`[stderr] ${text}`);
  });

  child.on('exit', (code, signal) => {
    writeLog(`Bridge exited: code=${code ?? 'null'} signal=${signal ?? 'null'}`);
    child = null;
    if (!stopping) {
      const delay = restartDelay;
      restartDelay = Math.min(Math.max(RESTART_MIN_MS, restartDelay * 2), RESTART_MAX_MS);
      setTimeout(() => {
        void supervise();
      }, delay);
    }
  });

  child.on('error', (error) => {
    writeLog(`Bridge spawn error: ${error.message || String(error)}`);
  });

  restartDelay = RESTART_MIN_MS;
}

async function supervise() {
  if (superviseInFlight) return;
  superviseInFlight = true;
  try {
    if (stopping) return;
    const healthy = await isBridgeHealthy();
    if (healthy) {
      if (child) {
        writeLog('Bridge already healthy; child process is running.');
      } else {
        writeLog('Bridge already healthy; waiting for a future restart.');
      }
      return;
    }
    if (!child) {
      startChild();
    }
  } finally {
    superviseInFlight = false;
  }
}

async function main() {
  ensureLogDir();
  writeLog('Bridge autostart supervisor started.');
  process.stdin.resume();

  await supervise();
  setInterval(() => {
    void supervise();
  }, CHECK_INTERVAL_MS);
}

function shutdown() {
  stopping = true;
  writeLog('Bridge autostart supervisor stopping.');
  if (child && !child.killed) {
    try {
      child.kill();
    } catch {
      // ignore
    }
  }
  setTimeout(() => process.exit(0), 250);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', (error) => {
  writeLog(`Supervisor uncaught exception: ${error.message || String(error)}`);
});

main().catch((error) => {
  writeLog(`Supervisor fatal error: ${error.message || String(error)}`);
  process.exitCode = 1;
});
