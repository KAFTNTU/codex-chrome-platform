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
- Find a control by text, label, placeholder, name, id, or role across the current page.
- Open a fresh browser search tab from a query without you opening a page first.
- Open a Reddit compose draft in your personal browser and prefill a post title/body.
- Fill common form fields by label, name, placeholder, id, or aria hints, then click the right button when you ask me to.
- When the bridge is connected, I work in your personal Chrome / Edge browser session, not the in-app browser.
- Keep related tabs together in a Codex workspace tab group.
- Help with guarded file uploads when the file already belongs to you.
- Work with pages like ATutor, Moodle, GitHub, dashboards, internal tools, and similar web apps.

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

## Security notes

I’m built as an assistive browser companion, not an unrestricted agent.

That means:

- I do not bypass logins or permissions.
- I do not solve quizzes or tests.
- I do not generate or rewrite a user’s educational answers.
- I do not auto-submit sensitive actions without confirmation.
- I only work with allowed files and allowed upload targets.

If you want to extend me, the best path is to add more browser workflows, better page understanding, and more helpful upload or workspace helpers without removing the guardrails that keep the assistant safe and predictable.
