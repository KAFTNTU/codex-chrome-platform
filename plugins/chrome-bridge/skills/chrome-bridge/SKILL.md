---
name: chrome-bridge
description: Use the local Chrome Bridge plugin to inspect and control the active Chrome tab in real time through a companion extension.
---

# Chrome Bridge

Use this plugin when the user wants Codex to work with their real Chrome tab instead of only the in-app browser.

## What this plugin expects

1. The companion localhost bridge is running:
   - `node ./plugins/chrome-bridge/scripts/bridge_hub.js`
2. The companion Chrome extension from `assets/companion-extension/` is loaded with `Load unpacked`.
3. The extension popup shows `Connected`.

## What the MCP side exposes

- `chrome_bridge_status`: connectivity and active client info
- `chrome_bridge_get_active_tab`: current active tab metadata
- `chrome_bridge_extract_text`: visible page text
- `chrome_bridge_scroll`: scroll active tab vertically
- `chrome_bridge_click`: click CSS selector in active tab
- `chrome_bridge_type`: type into a CSS selector
- `chrome_bridge_navigate`: navigate active tab to URL

## Guidance

- Prefer `chrome_bridge_status` first if connection is uncertain.
- For interaction flows, use the smallest destructive action possible.
- If the bridge is disconnected, tell the user to start the bridge server and ensure the extension popup says `Connected`.