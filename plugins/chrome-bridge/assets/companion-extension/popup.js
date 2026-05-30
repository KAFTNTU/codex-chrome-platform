async function render() {
  const { clientId, serverUrl, bridgeState } = await chrome.storage.local.get(['clientId', 'serverUrl', 'bridgeState']);
  document.getElementById('clientId').textContent = clientId || '-';
  document.getElementById('serverUrl').value = serverUrl || 'http://127.0.0.1:17373';
  document.getElementById('status').textContent = bridgeState?.connected ? 'Connected' : 'Disconnected';
  document.getElementById('error').textContent = bridgeState?.lastError || '-';
}
document.getElementById('save').addEventListener('click', async () => {
  const value = document.getElementById('serverUrl').value.trim();
  await chrome.storage.local.set({ serverUrl: value || 'http://127.0.0.1:17373' });
  await render();
});
render();