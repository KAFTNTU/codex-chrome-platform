---
name: chrome-bridge
description: Use the local Chrome Bridge plugin to inspect and control the active Chrome tab in real time through a companion extension.
---

# Chrome Bridge

Use this plugin when the user wants Codex to work with their real Chrome tab instead of only the in-app browser.
When the bridge is connected, prefer the user's personal Chrome / Edge session for search and navigation.

## What this plugin expects

1. The companion localhost bridge is running:
   - `node ./scripts/bridge_autostart.js`
   - or `node ./plugins/chrome-bridge/scripts/bridge_hub.js` for direct start
2. The companion Chrome extension from `assets/companion-extension/` is loaded with `Load unpacked`.
3. The extension popup shows `Connected`.

## Agent Guide

For a compact human-readable guide, see:
- `plugins/chrome-bridge/assets/companion-extension/AGENT_GUIDE.md`

That file explains:
- what the extension can do
- what other desktop AIs can safely do with it
- what is blocked by design
- how to use the bridge from browser and MCP workflows

## What the MCP side exposes

- `chrome_bridge_status`: connectivity and active client info
- `chrome_bridge_get_active_tab`: current active tab metadata
- `chrome_bridge_list_tabs`: list open tabs
- `chrome_bridge_switch_tab`: activate a tab by id
- `chrome_bridge_open_tab`: open a new tab
- `chrome_bridge_create_tab_group`: open a new tab inside a Codex tab workspace
- `chrome_bridge_open_in_codex_workspace`: open a new tab and add it to the workspace group
- `chrome_bridge_get_tab_workspace_state`: inspect the workspace group
- `chrome_bridge_add_active_tab_to_workspace`: move the active tab into the workspace group
- `chrome_bridge_close_tab`: close a tab
- `chrome_bridge_extract_text`: visible page text
- `chrome_bridge_extract_html`: page HTML
- `chrome_bridge_extract_visible_dom`: compact visible interactive DOM summary
- `chrome_bridge_page_dom_snapshot`: deep DOM snapshot with forms, controls, frames, and shadow hosts
- `chrome_bridge_page_dom_outline`: compact DOM outline with headings, forms, controls, landmarks, and text blocks
- `chrome_bridge_page_summary`: short page summary with the key visible structure
- `chrome_bridge_wordpress_inspect`: detect WordPress and the active editor context
- `chrome_bridge_elementor_wait_ready`: wait for the panel and preview document to become usable
- `chrome_bridge_elementor_inspect`: map Elementor widgets, containers, preview, and panel controls
- `chrome_bridge_elementor_navigator`: return a compact Elementor hierarchy with stable ids and parent relationships
- `chrome_bridge_elementor_find_elements`: narrowly search Elementor elements without reading the full tree
- `chrome_bridge_elementor_audit`: check accessibility names, alt text, headings, ids, labels, overflow, and hit targets
- `chrome_bridge_elementor_responsive_audit`: audit desktop, tablet, and mobile previews and restore the editor mode
- `chrome_bridge_elementor_create_checkpoint`: store a named session snapshot of the Elementor hierarchy
- `chrome_bridge_elementor_compare_checkpoint`: report elements added, removed, moved, or changed since a checkpoint
- `chrome_bridge_elementor_list_checkpoints`: list checkpoints for the active Elementor tab
- `chrome_bridge_elementor_select_element`: select a widget/container by stable Elementor id or semantic fallback
- `chrome_bridge_elementor_edit_text`: edit widget text through the real Elementor panel control
- `chrome_bridge_elementor_set_control`: update a named Elementor setting
- `chrome_bridge_elementor_set_controls`: update and verify several controls on one element
- `chrome_bridge_elementor_add_widget`: add a widget through verified drag-and-drop
- `chrome_bridge_elementor_move_element`: move an element into another container and verify its hierarchy
- `chrome_bridge_elementor_duplicate_element`: duplicate an Elementor element and verify the new node
- `chrome_bridge_elementor_delete_element`: delete only after explicit confirmation
- `chrome_bridge_elementor_panel_tab`: open Content, Style, Advanced, or Layout controls
- `chrome_bridge_elementor_responsive_mode`: switch desktop/tablet/mobile preview
- `chrome_bridge_elementor_undo` / `chrome_bridge_elementor_redo`: safely iterate editor changes
- `chrome_bridge_elementor_preview`: open preview without saving
- `chrome_bridge_elementor_run_workflow`: run a verified multi-step edit with optional rollback and preview
- `chrome_bridge_elementor_save`: confirmed draft/update/publish action
- `chrome_bridge_page_section_reader`: split the page into logical sections
- `chrome_bridge_find_dom_control`: find a control by text, label, placeholder, name, id, or role
- `chrome_bridge_describe_dom_element`: inspect one DOM element in detail, including form context and geometry
- `chrome_bridge_modal_detector`: detect dialogs, popovers, toasts, and overlays
- `chrome_bridge_repeated_element_matcher`: group repeated similar UI elements
- `chrome_bridge_next_visible_control`: find the next visible control instead of a brittle selector
- `chrome_bridge_semantic_click`: click by intent and visible meaning
- `chrome_bridge_page_diff_memory`: compare the page to the previous short-term snapshot
- `chrome_bridge_resolve_dom_route`: get the frame/shadow/ancestry route for an element
- `chrome_bridge_page_intent_map`: map visible controls to likely intents
- `chrome_bridge_page_interact_map`: build a numbered interaction map of visible controls
- `chrome_bridge_page_interact_click`: click a control by index, intent, or needle
- `chrome_bridge_ocr_from_screenshot`: OCR text from screenshots or element captures
- `chrome_bridge_visual_page_compare`: compare a screenshot against the previous baseline
- `chrome_bridge_site_memory_snapshot`: save a page summary into site memory
- `chrome_bridge_get_site_memory`: inspect saved site memory for the current host
- `chrome_bridge_clear_site_memory`: clear site memory for the current host
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
- `chrome_bridge_watch_downloads`: inspect recent browser downloads
- `chrome_bridge_wait_for_download`: wait for a matching download to appear or complete
- `chrome_bridge_copy_page_content`: copy page text or HTML to the local clipboard
- `chrome_bridge_navigate`: navigate active tab to URL
- `chrome_bridge_back`: go back in history
- `chrome_bridge_forward`: go forward in history
- `chrome_bridge_reload`: reload the current tab
- `chrome_bridge_universal_form_assist`: fill common fields by label/name/placeholder/id and optionally click a button after confirmation
- `chrome_bridge_save_form_profile`: save a reusable form profile
- `chrome_bridge_list_form_profiles`: list saved form profiles
- `chrome_bridge_delete_form_profile`: delete a saved form profile
- `chrome_bridge_form_profile_autofill`: replay a saved form profile on the current page
- `chrome_bridge_file_upload_assistant_*`: guarded file attachment flows for user-owned files
- `chrome_bridge_universal_file_upload_*`: universal guarded file lookup/attach/preflight flows

## Guidance

- Prefer `chrome_bridge_status` first if connection is uncertain.
- For interaction flows, use the smallest destructive action possible.
- If the bridge is disconnected, tell the user to start the bridge server and ensure the extension popup says `Connected`.
- Do not send user-facing search or navigation flows to the in-app browser when the bridge is available; use the real browser session instead.
- After changing `assets/companion-extension`, reload the unpacked extension in `chrome://extensions` so the service worker picks up the new code.
- For folder-only usage, prefer `npm run bridge:autostart` so the server survives browser restarts on Windows, macOS, and Linux.
- When creating many related tabs, use the workspace tab group tools instead of opening isolated tabs.

## Auto-start Checklist for the Bridge

When the user wants the bridge to start automatically, follow this checklist:

1. Add `nativeMessaging` to the extension permissions.
2. Create the native host manifest `com.codex.bridge`.
3. Point the native host `path` to `scripts/start-bridge.bat` on Windows or `scripts/start-bridge.sh` on macOS/Linux.
4. Put the correct extension ID into `allowed_origins`.
5. Register the host manifest with the OS.
6. Call `chrome.runtime.connectNative('com.codex.bridge')` from `runtime.onStartup` and `runtime.onInstalled`.
7. Keep a reconnect/backoff loop for host disconnects.
8. Reload the unpacked extension after any manifest change.
9. Confirm the popup reports `Connected`.

Do not confuse:
- `extension ID`
- `client ID`
- `bridge token`

Only the extension ID belongs in the native host manifest `allowed_origins`.
