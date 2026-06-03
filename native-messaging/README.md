# Native Messaging Host

This folder contains the native host bootstrap for the browser extension.

## Files

- `com.codex.bridge.template.json` - manifest template for the native host
- `install-native-host.ps1` - Windows installer helper
- `install-native-host.sh` - macOS/Linux installer helper
- `scripts/start-bridge.bat` - Windows launcher
- `scripts/start-bridge.sh` - macOS/Linux launcher
- `scripts/bridge_native_host.js` - stdio native host that boots the local bridge supervisor
- `AI_SETUP.md` - short setup checklist for other AI agents

## What to do

1. Open `chrome://extensions` or `edge://extensions` and copy the extension ID.
2. Replace `REPLACE_WITH_EXTENSION_ID` in the template.
3. Register the native host manifest in the OS-native location:
   - Windows: registry key under `HKEY_CURRENT_USER\Software\Google\Chrome\NativeMessagingHosts\com.codex.bridge`
   - macOS: `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`
   - Linux: `~/.config/google-chrome/NativeMessagingHosts/` or Chromium equivalent
4. Run the matching installer helper, or make sure the launcher path points at the matching `start-bridge` script for your OS.
5. Reload the extension after updating the manifest.

## How it works

When the extension starts, it calls `chrome.runtime.connectNative('com.codex.bridge')`.
That launches the native host, which in turn starts the cross-platform bridge supervisor.
The supervisor keeps the HTTP bridge alive and reconnects if needed.

## AI-ready instructions

If an AI agent is doing the setup, tell it to:

1. Insert the real extension ID into `allowed_origins`.
2. Run `install-native-host.ps1` on Windows or `install-native-host.sh` on macOS/Linux.
3. Add `nativeMessaging` to the extension permissions.
4. Reload the extension after any manifest or background change.
5. Verify the popup shows `Connected` after the browser starts.

Do not use:
- `client ID` in the native host manifest
- `bridge token` in the native host manifest

Those are runtime connection values, not extension identity.
