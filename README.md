# Codex Chrome Platform

This repository is a Codex plugin platform that can be added from GitHub.

## Included plugin

- `chrome-bridge`: local bridge for controlling the active Chrome tab through a companion extension and a localhost hub.

## Local setup

1. Start the localhost hub:
   - `node ./plugins/chrome-bridge/scripts/bridge_hub.js`
2. In Chrome open `chrome://extensions`
3. Enable `Developer mode`
4. Click `Load unpacked`
5. Select `plugins/chrome-bridge/assets/companion-extension`
6. Open the extension popup and confirm it says `Connected`

## Add to Codex

In Codex add this repository as a plugin platform.

- Source: your GitHub repo, for example `yourname/codex-chrome-platform`
- Branch: `main`
- Optional paths: leave empty