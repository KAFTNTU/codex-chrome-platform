# AI Setup Checklist

Use this when another AI agent needs the bridge to auto-start by itself.

## What the AI must fill in

- `extension ID` from `chrome://extensions` or `edge://extensions`
- `Repo root` path for the current checkout
- Browser target: `chrome`, `edge`, or `chromium`

## Files to update

- `native-messaging/com.codex.bridge.template.json`
- `native-messaging/install-native-host.ps1`
- `native-messaging/install-native-host.sh`
- `plugins/chrome-bridge/assets/companion-extension/manifest.json`
- `plugins/chrome-bridge/assets/companion-extension/background.js`

## Required steps

1. Put the real extension ID into `allowed_origins`.
2. Keep `path` pointing to the launcher script for the OS.
3. Register the native host manifest in the OS.
4. Add `nativeMessaging` to the extension permissions.
5. Call `chrome.runtime.connectNative('com.codex.bridge')` on startup.
6. Keep a reconnect loop if the host disconnects.
7. Reload the unpacked extension.
8. Confirm the popup says `Connected`.

## Windows quick path

```powershell
cd "C:\Users\Admin\OneDrive\Робочий стіл\githubnewfunction"
powershell -ExecutionPolicy Bypass -File .\native-messaging\install-native-host.ps1 -ExtensionId "REPLACE_ME"
```

## macOS / Linux quick path

```bash
cd /path/to/githubnewfunction
bash ./native-messaging/install-native-host.sh "$PWD" "REPLACE_ME" chrome
```

## Notes

- `Client ID` is not the extension ID.
- `Bridge token` is not the extension ID.
- The host manifest should only contain the browser extension origin and the launcher path.
