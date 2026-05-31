# Codex Chrome Platform

## UA

Цей репозиторій є GitHub-платформою плагінів для Codex. Основний плагін тут зараз це `chrome-bridge` — локальний міст між Codex і реальним браузером `Chrome` або `Microsoft Edge` через companion extension і localhost hub.

### Що вміє `chrome-bridge`

- читати активну вкладку
- показувати список вкладок
- перемикати, відкривати і закривати вкладки
- переходити на URL, робити `back`, `forward`, `reload`
- діставати текст сторінки, HTML, видимий DOM і базову структуру сторінки
- шукати елементи за текстом
- натискати по селектору
- натискати по тексту
- натискати по найближчому текстовому збігу
- підсвічувати елементи
- наводити курсор, перевіряти dropdown/menu/modal після hover
- робити більш “людські” дії: `moveCursor`, `humanClick`, `doubleClick`, `rightClick`
- скролити сторінку грубо і плавно
- робити `infinite scroll`
- чекати появи селектора або тексту
- вводити текст у поля
- вставляти текст як через paste
- працювати з `contenteditable`, `Monaco`, `CodeMirror`
- знаходити і заповнювати форми
- працювати з `select`
- читати `iframe` / `frame`
- працювати з таблицями
- виділяти текст
- виділяти текст drag-подібною дією
- копіювати виділений текст
- копіювати весь текст або HTML сторінки в буфер
- читати `cookies`
- читати `localStorage` і `sessionStorage`
- запускати власний JavaScript у сторінці
- робити screenshot видимої області
- робити full-page screenshot
- запускати завантаження файлів
- відкривати системний file picker для `input[type=file]`
- виконувати `drag-and-drop`
- пам’ятати коротку історію дій по вкладці через session memory
- показувати network log через popup розширення

### Локальний запуск

1. Запусти localhost hub:

```powershell
node .\plugins\chrome-bridge\scripts\bridge_hub.js
```

2. Відкрий у `Chrome` або `Edge` сторінку розширень:
   - `chrome://extensions`
   - або `edge://extensions`
3. Увімкни `Developer mode`
4. Натисни `Load unpacked`
5. Вибери папку:

```text
plugins/chrome-bridge/assets/companion-extension
```

6. Відкрий popup розширення і перевір, що статус `Connected`
7. Після зміни файлів розширення натискай `Reload` на картці розширення

### Додавання в Codex

Додай цей репозиторій у Codex як plugin platform.

- Source: `yourname/codex-chrome-platform`
- Branch: `main`
- Optional paths: порожньо

## EN

This repository is a GitHub plugin platform for Codex. The main plugin at the moment is `chrome-bridge` — a local bridge between Codex and a real `Chrome` or `Microsoft Edge` browser through a companion extension and a localhost hub.

### What `chrome-bridge` can do

- read the active tab
- list tabs
- switch, open, and close tabs
- navigate to URLs, go `back`, `forward`, and `reload`
- extract page text, HTML, visible DOM summaries, and page structure
- find elements by visible text
- click by selector
- click by text
- click the nearest text match
- highlight elements
- hover elements and inspect menus, dropdowns, and modals after hover
- perform more human-like actions: `moveCursor`, `humanClick`, `doubleClick`, `rightClick`
- scroll in large steps or smooth steps
- run `infinite scroll`
- wait for a selector or visible text
- type into fields
- paste text like a user paste action
- work with `contenteditable`, `Monaco`, and `CodeMirror`
- inspect and fill forms
- work with native `select` controls
- inspect `iframe` / `frame`
- extract table data
- select text
- select text with a drag-like action
- copy the current selection
- copy all page text or HTML to the system clipboard
- read `cookies`
- read `localStorage` and `sessionStorage`
- run custom JavaScript in the page
- capture visible screenshots
- capture full-page screenshots
- trigger browser downloads
- open the system file picker for `input[type=file]`
- perform `drag-and-drop`
- keep short-lived per-tab session memory of recent actions
- show a network log in the extension popup

### Local setup

1. Start the localhost hub:

```powershell
node .\plugins\chrome-bridge\scripts\bridge_hub.js
```

2. Open extensions in `Chrome` or `Edge`:
   - `chrome://extensions`
   - or `edge://extensions`
3. Enable `Developer mode`
4. Click `Load unpacked`
5. Select:

```text
plugins/chrome-bridge/assets/companion-extension
```

6. Open the extension popup and confirm the status is `Connected`
7. After editing extension files, click `Reload` on the extension card

### Add to Codex

Add this repository to Codex as a plugin platform.

- Source: `yourname/codex-chrome-platform`
- Branch: `main`
- Optional paths: leave empty
