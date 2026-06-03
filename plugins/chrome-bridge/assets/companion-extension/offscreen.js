let keepaliveTimer = null;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'clipboard-write-text') return undefined;
  navigator.clipboard.writeText(message.text || '')
    .then(() => sendResponse({ ok: true }))
    .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
  return true;
});

function startKeepAlive() {
  if (keepaliveTimer) return;
  keepaliveTimer = setInterval(() => {
    chrome.runtime.sendMessage({ type: 'offscreen-heartbeat' }).catch(() => {
      // Ignore bridge warm-up failures. The background worker will recover on the next pulse.
    });
  }, 5000);
}

startKeepAlive();
