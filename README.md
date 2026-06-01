# Codex Chrome Platform

Local browser automation platform for Chrome/Edge with:
- Chrome Bridge extension
- local HTTP bridge API
- MCP tools
- desktop launcher

## What It Can Do

- Control real browser tabs (navigate, click, type, scroll, extract).
- Capture screenshots (full page and element).
- Read console/network signals for debugging flows.
- Run reusable recipes/macros.
- Use guarded file upload automation for user-owned completed files.

## Universal File Upload Assistant

The upload assistant supports universal file lookup via `fileQuery`:
- exact: `report.docx`
- partial/fuzzy: `звіт`
- glob: `*.pdf`
- newest by extension: `newest:.pdf`
- newest allowed file: `newest`
- multiple file mode: `multiple=true`

Search scope is restricted to:
- `upload.allowedFolders` (or legacy `allowedUploadFolders`)
- `manualSelectedFiles`

No "any file anywhere" mode is allowed.

### Universal Actions

- `universalFileUploadPreflight`
- `universalFileUploadPreview`
- `universalFileUploadAttach`
- `universalFileUploadAttachAndSubmit`
- `universalFileUploadPreflightAttachAndSubmit`

Backward-compatible aliases:
- `fileUploadAssistantPreview`
- `fileUploadAssistantAttach`
- `fileUploadAssistantAttachAndSubmit`

### Preflight Actions

- `fileUploadAssistantPreflight`
- `fileUploadAssistantPreflightAttachAndSubmit`

Preflight creates a temp copy in:
- `~/.chrome-bridge/preflight/`

And checks technical readiness only:
- file exists / is file / non-empty
- extension and size policy
- copy integrity checksum match
- container integrity for `.docx`, `.xlsx`, `.zip`
- basic header/page checks for `.pdf`

The system does **not** edit or evaluate educational content.

## Policy Model

Global safety defaults:
- `actions.allowAutoSubmit = false`
- submit only through guarded upload actions with explicit confirmations
- blocked on quiz/test/exam contexts
- blocked on unknown/blocked domains when policy requires it

Target model:
- any allowed file -> any allowed domain

## MCP Tools (Upload)

- `chrome_bridge_universal_file_upload_preflight`
- `chrome_bridge_universal_file_upload_preview`
- `chrome_bridge_universal_file_upload_attach`
- `chrome_bridge_universal_file_upload_attach_and_submit`
- `chrome_bridge_universal_file_upload_preflight_attach_and_submit`
- `chrome_bridge_file_upload_assistant_preflight`
- `chrome_bridge_file_upload_assistant_preflight_attach_and_submit`

## Quick Start

```powershell
npm install
npm run start-bridge
```

Load extension in browser:
1. Open `edge://extensions` or `chrome://extensions`
2. Enable Developer Mode
3. Load unpacked:
4. `plugins/chrome-bridge/assets/companion-extension`

## Paths

- Runtime: `%USERPROFILE%\\.chrome-bridge\\runtime.json`
- Logs: `%USERPROFILE%\\.chrome-bridge\\logs\\`
- Output: `%USERPROFILE%\\.chrome-bridge\\output\\`
- Preflight copies: `%USERPROFILE%\\.chrome-bridge\\preflight\\`

## Security Note

This platform is designed as an assistive automation tool.
It must not be used to bypass authentication, break platform rules, or automate quiz/test answering.
