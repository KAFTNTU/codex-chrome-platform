# Codex Chrome Platform

Hi, I’m Codex. I built this browser companion so you can do real work in Chrome or Edge with a local bridge, a browser extension, and a few carefully guarded automation tools.

If you want the short version: I help you read pages, move through tabs, fill forms, inspect console/network activity, work with files, and keep related tabs organized in a Codex workspace. If you want to go further, you can also extend me with your own workflows and local bridge commands.

## What I can do in the browser

I’m designed for real browser tasks, not just demos:

- Read the current tab and inspect what’s actually on the page.
- Navigate, click, type, scroll, wait for content, and work with forms.
- Capture screenshots of the whole page or a specific element.
- Read tables, visible text, HTML, console output, and network activity.
- Take a deep DOM snapshot with forms, controls, frames, and shadow hosts.
- Read a compact DOM outline or inspect a single element in detail.
- Summarize a page, split it into sections, detect modals, compare screenshots, and remember the last state for a site.
- Find a control by text, label, placeholder, name, id, or role across the current page.
- Build a numbered interaction map of visible controls and click by index or intent.
- Find the next visible control, match repeated UI blocks, resolve a DOM route, and click by intent.
- Run OCR on screenshots when text is baked into images or canvas elements.
- Watch downloads, keep a short memory of page/session changes, and build a site memory by host.
- Open a fresh browser search tab from a query without you opening a page first.
- Open a Reddit compose draft in your personal browser and prefill a post title/body.
- Fill common form fields by label, name, placeholder, id, or aria hints, then click the right button when you ask me to.
- When the bridge is connected, I work in your personal Chrome / Edge browser session, not the in-app browser.
- Keep related tabs together in a Codex workspace tab group.
- Help with guarded file uploads when the file already belongs to you.
- Work with pages like ATutor, Moodle, GitHub, dashboards, internal tools, and similar web apps.
- Work inside WordPress and Elementor as a structured editor: wait for the editor, search the Navigator tree, select and move elements, batch-edit settings, duplicate widgets, audit accessibility/layout, test responsive layouts, preview changes, and save only after confirmation.

## WordPress and Elementor

I can treat Elementor as an editor instead of a flat webpage. I read both the settings panel and the live preview iframe, map sections/containers/widgets by stable Elementor `data-id`, and then make changes through the real Elementor controls so they can be saved.

The practical workflow is:

1. Wait for the editor with `chrome_bridge_elementor_wait_ready`, then detect WordPress and the current editor.
2. Search with `chrome_bridge_elementor_find_elements` when the target is known, or map the compact hierarchy with `chrome_bridge_elementor_navigator`.
3. Select one widget or container by id, text, type, or map index.
4. Edit text, apply one setting, or apply a verified batch with `chrome_bridge_elementor_set_controls`.
5. Move or duplicate elements, add widgets, and use undo when an experiment does not work.
6. Run a multi-step plan with `chrome_bridge_elementor_run_workflow`; it can stop on failure, roll back successful mutations, and preview the result.
7. Run `chrome_bridge_elementor_audit` to find missing alt text, unnamed controls, heading-order problems, duplicate IDs, missing field labels, horizontal overflow, and small hit targets.
8. Check desktop, tablet, and mobile modes.
9. Save as draft, update, or publish only after an explicit confirmation.

The workflow can work independently through routine reversible edits without asking after every click. Deleting an Elementor element still requires `confirmDelete: true`, and saving or publishing still requires `confirmSave: true`. Direct preview-DOM edits are intentionally avoided because they would disappear instead of updating Elementor's document model.

## Two access profiles

I keep the UI simple on purpose:

- `Controlled`
  - Best for everyday use.
  - Safer defaults.
  - Good for reading pages, tab work, screenshots, forms, uploads, and general navigation.
  - Sensitive actions still ask for confirmation.

- `Expanded`
  - Best when you want more power for local development or heavier browser workflows.
  - Combines developer-style capabilities with local-network bridge access.
  - Useful for debugging, local bridge work, and more advanced browser automation.
  - Still keeps guardrails in place for sensitive actions.

## File Upload Assistant

I also include a universal upload assistant for files you already own.

It can:

- Find files by exact name, fuzzy name, glob, or newest match.
- Look only in allowed folders or user-selected files.
- Preflight a temporary copy before attach or submit.
- Attach files to a form.
- Submit only when policy and confirmations allow it.

Supported query styles:

- `report.docx`
- `звіт`
- `*.pdf`
- `newest:.pdf`
- `newest`

I do **not** search the whole disk.
I do **not** generate or edit educational answers.
I do **not** auto-submit in the background.

## Tab workspace

When you want several related pages together, I can keep them in a Codex tab workspace group. That makes it easier to move through a session without losing the main thread of work.

## MCP tools

This project exposes a local bridge plus MCP-style tools so other compatible AI agents can work with the same browser session.

Common examples:

- `chrome_bridge_open_in_codex_workspace`
- `chrome_bridge_create_tab_group`
- `chrome_bridge_get_tab_workspace_state`
- `chrome_bridge_add_active_tab_to_workspace`
- `chrome_bridge_universal_file_upload_preflight`
- `chrome_bridge_universal_file_upload_attach_and_submit`
- `chrome_bridge_universal_form_assist`
- `chrome_bridge_page_dom_snapshot`
- `chrome_bridge_page_dom_outline`
- `chrome_bridge_find_dom_control`
- `chrome_bridge_describe_dom_element`
- `chrome_bridge_page_summary`
- `chrome_bridge_wordpress_inspect`
- `chrome_bridge_elementor_inspect`
- `chrome_bridge_elementor_select_element`
- `chrome_bridge_elementor_edit_text`
- `chrome_bridge_elementor_set_control`
- `chrome_bridge_elementor_add_widget`
- `chrome_bridge_elementor_panel_tab`
- `chrome_bridge_elementor_responsive_mode`
- `chrome_bridge_elementor_undo`
- `chrome_bridge_elementor_redo`
- `chrome_bridge_elementor_preview`
- `chrome_bridge_elementor_save`
- `chrome_bridge_page_section_reader`
- `chrome_bridge_modal_detector`
- `chrome_bridge_repeated_element_matcher`
- `chrome_bridge_next_visible_control`
- `chrome_bridge_semantic_click`
- `chrome_bridge_page_diff_memory`
- `chrome_bridge_resolve_dom_route`
- `chrome_bridge_page_intent_map`
- `chrome_bridge_page_interact_map`
- `chrome_bridge_page_interact_click`
- `chrome_bridge_ocr_from_screenshot`
- `chrome_bridge_visual_page_compare`
- `chrome_bridge_site_memory_snapshot`
- `chrome_bridge_get_site_memory`
- `chrome_bridge_clear_site_memory`
- `chrome_bridge_watch_downloads`
- `chrome_bridge_wait_for_download`
- `chrome_bridge_save_form_profile`
- `chrome_bridge_list_form_profiles`
- `chrome_bridge_delete_form_profile`
- `chrome_bridge_form_profile_autofill`

## Quick start

```powershell
npm install
npm run bridge:autostart
```

Then load the unpacked extension from:

`plugins/chrome-bridge/assets/companion-extension`

## Native messaging auto-start

If you want the browser to start the bridge automatically when it opens, use the files in:

- `native-messaging/README.md`
- `native-messaging/AI_SETUP.md`

## Cursor setup

If you want Cursor to talk to this bridge, add the project MCP config from:

- `.cursor/mcp.json`

If you want a ready-made prompt for Codex or Cursor, use:

- `CODEX_CURSOR_PROMPT.md`

The flow is:

1. Register the native host in the OS.
2. Point it at the local bridge launcher.
3. Add the extension ID to `allowed_origins`.
4. Reload the unpacked extension.
5. Open Chrome or Edge and confirm the popup shows `Connected`.

## Paths

- Runtime: `%USERPROFILE%\.chrome-bridge\runtime.json`
- Logs: `%USERPROFILE%\.chrome-bridge\logs\`
- Output: `%USERPROFILE%\.chrome-bridge\output\`
- Preflight copies: `%USERPROFILE%\.chrome-bridge\preflight\`
- OCR cache: `%USERPROFILE%\.chrome-bridge\ocr-cache\`
- Site memory: `%USERPROFILE%\.chrome-bridge\site-memory.json`

## Security notes

I’m built as an assistive browser companion, not an unrestricted agent.

That means:

- I do not bypass logins or permissions.
- I do not solve quizzes or tests.
- I do not generate or rewrite a user’s educational answers.
- I do not auto-submit sensitive actions without confirmation.
- I only work with allowed files and allowed upload targets.

If you want to extend me, the best path is to add more browser workflows, better page understanding, and more helpful upload or workspace helpers without removing the guardrails that keep the assistant safe and predictable.
