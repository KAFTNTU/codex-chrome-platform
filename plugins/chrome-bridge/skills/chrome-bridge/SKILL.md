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
- `chrome_bridge_list_tabs`: list open tabs
- `chrome_bridge_switch_tab`: activate a tab by id
- `chrome_bridge_open_tab`: open a new tab
- `chrome_bridge_close_tab`: close a tab
- `chrome_bridge_extract_text`: visible page text
- `chrome_bridge_extract_html`: page HTML
- `chrome_bridge_extract_visible_dom`: compact visible interactive DOM summary
- `chrome_bridge_get_elements`: visible links, buttons, inputs, or all common interactives
- `chrome_bridge_scroll`: scroll active tab vertically
- `chrome_bridge_scroll_to_selector`: scroll to a CSS selector
- `chrome_bridge_click`: click CSS selector in active tab
- `chrome_bridge_type`: type into a CSS selector
- `chrome_bridge_press_key`: dispatch keyboard input
- `chrome_bridge_wait_for_selector`: wait for a selector to appear and become visible
- `chrome_bridge_select_option`: select an option in a native `<select>`
- `chrome_bridge_highlight_element`: temporarily highlight an element
- `chrome_bridge_screenshot`: capture the visible tab
- `chrome_bridge_copy_page_content`: copy page text or HTML to the local clipboard
- `chrome_bridge_navigate`: navigate active tab to URL
- `chrome_bridge_back`: go back in history
- `chrome_bridge_forward`: go forward in history
- `chrome_bridge_reload`: reload the current tab

## Guidance

- Prefer `chrome_bridge_status` first if connection is uncertain.
- For interaction flows, use the smallest destructive action possible.
- If the bridge is disconnected, tell the user to start the bridge server and ensure the extension popup says `Connected`.
- After changing `assets/companion-extension`, reload the unpacked extension in `chrome://extensions` so the service worker picks up the new code.
