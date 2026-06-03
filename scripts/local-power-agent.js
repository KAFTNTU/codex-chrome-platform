// Local Power Agent (Windows-only helper)
// Exposes a tiny localhost HTTP API to request shutdown with explicit confirmation + token.
//
// Usage:
//   set POWER_AGENT_TOKEN=... (or pass --token)
//   node scripts/local-power-agent.js --port 17444 --token YOUR_TOKEN
//
// Request:
//   POST http://127.0.0.1:17444/shutdown
//   Headers: X-Agent-Token: YOUR_TOKEN
//   Body:    {"confirm":"SHUTDOWN_NOW"}
//
// Safety:
// - Listens only on 127.0.0.1 (not LAN)
// - Requires token header
// - Requires confirm phrase in JSON body

const http = require('http');
const { spawn } = require('child_process');

function parseArgs(argv) {
  const args = { port: 17444, token: process.env.POWER_AGENT_TOKEN || '' };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--port') args.port = Number(argv[++i]);
    else if (a === '--token') args.token = String(argv[++i] || '');
  }
  return args;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (chunk) => { buf += chunk; });
    req.on('end', () => {
      if (!buf) return resolve({});
      try { resolve(JSON.parse(buf)); } catch (e) { reject(e); }
    });
  });
}

function send(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

function shutdownWindows() {
  // Immediate shutdown
  return spawn('shutdown', ['/s', '/t', '0'], { windowsHide: true, stdio: 'ignore' });
}

async function main() {
  const { port, token } = parseArgs(process.argv);
  if (!token) {
    console.error('POWER_AGENT_TOKEN is required (env or --token).');
    process.exit(2);
  }

  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/health') {
        return send(res, 200, { ok: true });
      }
      if (req.method !== 'POST' || req.url !== '/shutdown') {
        return send(res, 404, { ok: false, error: 'NOT_FOUND' });
      }

      const headerToken = String(req.headers['x-agent-token'] || '');
      if (headerToken !== token) {
        return send(res, 401, { ok: false, error: 'BAD_TOKEN' });
      }

      const body = await readJson(req);
      if (body.confirm !== 'SHUTDOWN_NOW') {
        return send(res, 400, { ok: false, error: 'CONFIRM_REQUIRED', hint: 'Send {\"confirm\":\"SHUTDOWN_NOW\"}' });
      }

      shutdownWindows();
      return send(res, 200, { ok: true, shuttingDown: true });
    } catch (e) {
      return send(res, 500, { ok: false, error: 'INTERNAL', message: e && e.message ? e.message : String(e) });
    }
  });

  server.listen(port, '127.0.0.1', () => {
    console.log(`Local Power Agent listening on http://127.0.0.1:${port}`);
  });
}

main();

