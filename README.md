# Codex Chrome Platform

Локальна платформа для автоматизації браузера (Chrome/Edge), яка дає змогу керувати реальною вкладкою через `chrome-bridge`.

## Що це вміє


- Я можу відкрити потрібний курс/сторінку, знайти потрібний блок тексту, перейти по ньому і перевірити, що відкрилась саме потрібна тема.
- Я можу натиснути кнопку там, де треба, навіть якщо на сторінці є схожі кнопки.
- Я можу робити "безпечний клік" (`safeClick`) з повторними спробами, центруванням елемента і перевіркою перекриття.
- Я можу вводити текст, вставляти через буфер, працювати з формами, submit-ити форму, і автозаповнювати логін/пароль.
- Я можу знімати скрін усієї сторінки або тільки потрібної області (`elementScreenshot`).
- Я можу читати JS помилки та мережеві події без відкриття DevTools (`getConsoleLog`, `networkGetLog`, `readResponseBody`).
- Я можу чекати появу тексту (`waitForText` / `wait_until_text`) і не клікати "в сліпу".
- Я можу працювати зі складними UI: `contenteditable`, Monaco/CodeMirror, Shadow DOM, dropdown/menu після hover.
- Я можу прокручувати сторінку керовано (вниз/вгору), щоб не залипати внизу.
- Я можу записувати і відтворювати сценарії (макроси) для повторюваних перевірок.

## Архітектура

- `plugins/chrome-bridge/scripts/bridge_hub.js`  
  Локальний HTTP hub (`/health`, `/status`, `/api/action`), токен-автентифікація, маршрутизація команд.
- `plugins/chrome-bridge/scripts/bridge_runtime.js`  
  Режими безпеки, токен, normalizer назв команд (`snake_case` -> `camelCase`).
- `plugins/chrome-bridge/assets/companion-extension/`  
  Розширення-компаньйон (service worker + popup UI), виконує дії у вкладці.
- `desktop-app/`  
  Electron-лаунчер для запуску/зупинки моста і швидких дій.

## Режими безпеки

- `safe` (за замовчуванням): блокує ризикові дії (`cookies`, `runScript`, debugger-команди).
- `developer`: відкриває розширені дії для тестування/налагодження.
- `local_network`: опціонально для LAN, тільки з токеном.

Токен зберігається у: `%USERPROFILE%\\.chrome-bridge\\runtime.json`

## Швидкий старт

### 1) Встановлення

```powershell
npm install
```

### 2) Запуск моста

```powershell
npm run start-bridge
```

### 3) Підключення розширення

1. Відкрити `edge://extensions` або `chrome://extensions`
2. Увімкнути `Developer mode`
3. `Load unpacked`
4. Вибрати папку `plugins/chrome-bridge/assets/companion-extension`

### 4) Перевірка, що все працює

```powershell
curl http://127.0.0.1:17373/health
```

## Приклади API дій

```bash
curl -X POST http://127.0.0.1:17373/api/action \
  -H "Content-Type: application/json" \
  -H "X-Bridge-Token: YOUR_TOKEN" \
  -d "{\"action\":\"navigate\",\"params\":{\"url\":\"https://example.com\"},\"token\":\"YOUR_TOKEN\"}"
```

```bash
curl -X POST http://127.0.0.1:17373/api/action \
  -H "Content-Type: application/json" \
  -H "X-Bridge-Token: YOUR_TOKEN" \
  -d "{\"action\":\"safe_click\",\"params\":{\"selector\":\"button[type='submit']\",\"maxAttempts\":3},\"token\":\"YOUR_TOKEN\"}"
```

```bash
curl -X POST http://127.0.0.1:17373/api/action \
  -H "Content-Type: application/json" \
  -H "X-Bridge-Token: YOUR_TOKEN" \
  -d "{\"action\":\"element_screenshot\",\"params\":{\"selector\":\".result-card\"},\"token\":\"YOUR_TOKEN\"}"
```

## Для розробника тестів

Це підходить для:

- smoke/regression перевірок у реальному браузері;
- повторюваних E2E сценаріїв через макроси;
- швидкого дебагу UI через console/network логи;
- перевірок React SPA, де важливо чекати стан, а не просто "sleep".

## Privacy

- За замовчуванням дані залишаються локально.
- Команди захищені токеном.
- Без явного вмикання `local_network` нічого не слухає LAN.
