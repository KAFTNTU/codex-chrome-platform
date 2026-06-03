const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const BRIDGE_AUTOSTART = path.join(__dirname, 'bridge_autostart.js');
const LOG_DIR = path.join(os.homedir(), '.chrome-bridge', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'native-host.log');

let inputBuffer = Buffer.alloc(0);
let bridgeProcess = null;
let shuttingDown = false;

function ensureLogDir() {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

function log(message) {
  ensureLogDir();
  fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${message}\n`, 'utf8');
}

function sendMessage(message) {
  const payload = Buffer.from(JSON.stringify(message), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length, 0);
  process.stdout.write(header);
  process.stdout.write(payload);
}

function startBridgeSupervisor() {
  if (bridgeProcess) return bridgeProcess;
  bridgeProcess = spawn(process.execPath, [BRIDGE_AUTOSTART], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  bridgeProcess.unref();
  log(`Spawned bridge supervisor: ${BRIDGE_AUTOSTART}`);
  return bridgeProcess;
}

function handleMessage(message) {
  if (!message || typeof message !== 'object') return;
  if (message.type === 'bootstrap' || message.type === 'ping') {
    startBridgeSupervisor();
    sendMessage({
      ok: true,
      type: 'bootstrap-ack',
      bridgeStarted: true,
      host: 'com.codex.bridge',
      pid: process.pid,
    });
    return;
  }
  if (message.type === 'status') {
    sendMessage({
      ok: true,
      type: 'status',
      bridgeStarted: !!bridgeProcess,
      pid: process.pid,
    });
    return;
  }
  if (message.type === 'shutdown') {
    sendMessage({ ok: true, type: 'shutdown-ack' });
    shutdown();
  }
}

function readMessages(chunk) {
  inputBuffer = Buffer.concat([inputBuffer, chunk]);
  while (inputBuffer.length >= 4) {
    const length = inputBuffer.readUInt32LE(0);
    if (inputBuffer.length < 4 + length) return;
    const payload = inputBuffer.subarray(4, 4 + length);
    inputBuffer = inputBuffer.subarray(4 + length);
    try {
      const message = JSON.parse(payload.toString('utf8'));
      handleMessage(message);
    } catch (error) {
      log(`Invalid native message: ${error.message || String(error)}`);
    }
  }
}

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  log('Native host shutting down.');
  try {
    process.stdin.pause();
  } catch {
    // ignore
  }
  setTimeout(() => process.exit(0), 100);
}

process.stdin.on('data', readMessages);
process.stdin.on('end', shutdown);
process.stdin.on('error', (error) => {
  log(`stdin error: ${error.message || String(error)}`);
  shutdown();
});
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', (error) => {
  log(`uncaughtException: ${error.message || String(error)}`);
});

log('Native host started.');
