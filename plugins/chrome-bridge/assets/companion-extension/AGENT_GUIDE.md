# Chrome Bridge Agent Guide

This extension is a browser-side companion for a local bridge server.
It is designed for Codex and other desktop AI agents that can talk to the local bridge API or MCP wrapper.

## What it can do

- Inspect the active Chrome / Edge tab in real time.
- Read visible text, HTML, screenshots, tables, console logs, and network events.
- Navigate tabs, click, type, scroll, select, and work with forms.
- Use the universal form helper when you need to fill common fields by label/name/placeholder/id and then click the right button.
- When the bridge is connected, search and navigation should happen in the user's personal Chrome / Edge session, not the in-app browser.
- Create and maintain a Codex tab workspace group for related tabs.
- Use guarded file upload flows for files the user already owns.
- Work with ATutor, Moodle, GitHub, forms, dashboards, and similar browser apps.

## What it cannot do by design

- It does not bypass logins, permissions, or site policy.
- It does not solve quizzes or tests.
- It does not generate or edit a user's educational answers.
- It does not auto-submit in Safe Mode.
- It does not search the whole disk for files.
- It does not access browser passwords or hidden personal data.

## How an AI agent should use it

1. Start the local bridge server:
   - `npm run bridge:autostart`
   - or connect the native messaging host `com.codex.bridge` so the browser launches it automatically
2. Load this unpacked extension in Chrome or Edge:
   - `plugins/chrome-bridge/assets/companion-extension`
3. Confirm the popup shows `Connected`.
4. Ask the agent to use the bridge tools for the current browser tab.

## Useful patterns

- Read the page first with `extractText`, `extractHtml`, `pageOverview`, or `getElements`.
- Use `pageDomSnapshot` when you need a deep DOM inventory with forms, controls, frames, and shadow hosts.
- Use `pageDomOutline` when you want a compact DOM map instead of the full snapshot.
- Use `pageSummary` when you want a short overview of the page without dumping the whole DOM.
- Use `pageSectionReader` when you want the page split into logical sections.
- Use `findDomControl` when you need a specific control by text, label, placeholder, name, id, or role.
- Use `describeDomElement` when you need a detailed breakdown of one element, including its form context and geometry.
- Use `modalDetector` when you want to know whether a dialog, popover, or toast is blocking the page.
- Use `repeatedElementMatcher` when a page has many similar cards, rows, or buttons and you need the repeated groups.
- Use `nextVisibleControl` when you want the next accessible control instead of a brittle selector.
- Use `semanticClick` when you know the intent but not the exact selector.
- Use `pageDiffMemory` when you want to compare what changed after an action.
- Use `resolveDomRoute` when you need the ancestry, frame path, or shadow route for an element.
- Use `pageIntentMap` when you want a quick semantic map of visible controls.
- Use `ocrFromScreenshot` when text is baked into images, canvas, or non-DOM UI.
- Use `visualPageCompare` when you want to see whether the page visually changed between screenshots.
- Use `screenshot` or `elementScreenshot` when layout matters.
- Use `waitForText` / `waitForSelector` before clicking dynamic UI.
- Use `smartFocus` to find the right field when the form is cluttered.
- Use `universalFormAssist` when you want to fill several common fields quickly across different sites.
- Use `watchDownloads` / `waitForDownload` when a file should appear in the browser download list.
- Use form profiles when you want to save and replay the same browser form values repeatedly.
- Use `siteMemorySnapshot` / `getSiteMemory` when you want to remember what the current site looked like and what you already learned there.
- Use tab groups when you need several related pages open together.
- Use the upload assistant only for user-owned completed files.
- Use preflight before attach/submit when file integrity matters.

## File upload rules

- Files come only from allowed folders or user-selected files.
- File matching uses `fileQuery` and approved folders.
- The assistant may preview, preflight, attach, and optionally submit only when policy allows.
- The system should treat uploads as assistive actions, not autonomous submissions.

## Tab groups

- Use `openInCodexWorkspace` when you want new tabs to land in the same workspace group.
- Use `createCodexTabGroup` when you want the first tab to establish the group.
- Use `addActiveTabToWorkspace` if you already have a tab open and want to fold it into the group.

## Notes for other desktop AIs

Any AI that can call the local bridge API or MCP adapter can use the same extension.
The browser extension itself is not the desktop AI, but it exposes the browser context that the AI can control.
If another AI surface can reach `http://127.0.0.1:17373` or the MCP bridge wrapper, it can work with the same tab and the same extension.

## AI startup checklist for automatic bridge launch

If an AI agent is asked to make the bridge start automatically, it should do these steps:

1. Create a native messaging host manifest named `com.codex.bridge`.
2. Point the manifest `path` to the local launcher script:
   - Windows: `scripts/start-bridge.bat`
   - macOS/Linux: `scripts/start-bridge.sh`
3. Set `type` to `stdio`.
4. Add the extension origin to `allowed_origins`:
   - `chrome-extension://<extension-id>/`
5. Register the manifest in the OS native-messaging location or registry.
6. Add `nativeMessaging` to the extension permissions.
7. In `background.js`, call `chrome.runtime.connectNative('com.codex.bridge')` on:
   - `runtime.onStartup`
   - `runtime.onInstalled`
8. Keep a reconnect loop so the bridge restarts if the native host disconnects.
9. Reload the unpacked extension after any manifest or background script change.
10. Verify that the popup or state page shows `Connected`.

## What the AI should remember

- The bridge can auto-start only if the browser is launched.
- The bridge is meant to control the real browser session; do not route user-facing search or navigation into the in-app browser when the companion extension is connected.
- The extension can start the native host, but it cannot bypass OS registration.
- The extension ID is required in `allowed_origins`.
- Client ID and bridge token are not the same thing as extension ID.
