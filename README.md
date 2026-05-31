# Codex Chrome Platform

This repository is a Codex plugin platform that can be added from GitHub.

## Included plugin

- `chrome-bridge`: local bridge for controlling the active Chrome tab through a companion extension and a localhost hub.

## Current capabilities

`chrome-bridge` can now:

- inspect the active tab and list/switch/open/close tabs
- navigate, go back/forward, and reload
- extract page text, HTML, visible DOM summaries, and common interactive elements
- scroll by pixels or scroll to a selector
- click, type, press keys, wait for selectors, select native `<select>` options, and highlight elements
- capture visible-tab screenshots
- copy page text or HTML to the system clipboard through the extension, which is useful on sites that interfere with normal copy handlers

## Local setup

1. Start the localhost hub:
   - `node ./plugins/chrome-bridge/scripts/bridge_hub.js`
2. In Chrome open `chrome://extensions`
3. Enable `Developer mode`
4. Click `Load unpacked`
5. Select `plugins/chrome-bridge/assets/companion-extension`
6. Open the extension popup and confirm it says `Connected`
7. After changing extension files, click `Reload` on the extension card in `chrome://extensions`

## Add to Codex

In Codex add this repository as a plugin platform.

- Source: your GitHub repo, for example `yourname/codex-chrome-platform`
- Branch: `main`
- Optional paths: leave empty
