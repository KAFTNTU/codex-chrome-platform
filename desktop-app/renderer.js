const statusBox = document.getElementById('statusBox');
const logBox = document.getElementById('logBox');

function formatJson(data) {
  return JSON.stringify(data, null, 2);
}

async function refreshState() {
  const state = await window.desktopApi.getState();
  statusBox.textContent = formatJson({
    bridgeRunning: state.bridgeRunning,
    runtime: state.runtime,
    health: state.health,
    status: state.status,
    paths: state.paths,
  });
  logBox.textContent = (state.bridgeLog || []).join('\n') || 'No logs yet.';
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

document.getElementById('startBridge').addEventListener('click', withRefresh(() => window.desktopApi.startBridge()));
document.getElementById('stopBridge').addEventListener('click', withRefresh(() => window.desktopApi.stopBridge()));
document.getElementById('restartBridge').addEventListener('click', withRefresh(() => window.desktopApi.restartBridge()));
document.getElementById('checkState').addEventListener('click', refreshState);

for (const modeButton of document.querySelectorAll('[data-mode]')) {
  modeButton.addEventListener('click', withRefresh(async () => {
    const mode = modeButton.getAttribute('data-mode');
    await window.desktopApi.setMode(mode);
  }));
}

for (const quickButton of document.querySelectorAll('[data-quick]')) {
  quickButton.addEventListener('click', withRefresh(async () => {
    const quick = quickButton.getAttribute('data-quick');
    const result = await window.desktopApi.quickAction(quick);
    statusBox.textContent = formatJson({ lastQuickAction: quick, result });
  }));
}

for (const openButton of document.querySelectorAll('[data-open]')) {
  openButton.addEventListener('click', async () => {
    const target = openButton.getAttribute('data-open');
    await window.desktopApi.openPath(target);
  });
}

refreshState();
setInterval(refreshState, 3500);
