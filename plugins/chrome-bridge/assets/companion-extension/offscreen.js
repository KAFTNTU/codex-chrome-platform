chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'clipboard-write-text') return undefined;
  navigator.clipboard.writeText(message.text || '')
    .then(() => sendResponse({ ok: true }))
    .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
  return true;
});
