# Codex Chrome Platform

Локальна платформа для автоматизації браузера (Chrome/Edge), яка дає змогу керувати реальною вкладкою через `chrome-bridge`.

## Що це вміє (практично)

- Я можу відкрити потрібний сайт або курс, знайти конкретну тему і перевірити, що відкрилась саме вона (по URL/заголовку).
- Я можу натискати кнопки стабільніше, навіть коли елемент перекритий або сторінка "стрибає" (`safeClick` з retries).
- Я можу клікати по найближчому збігу тексту, коли на сторінці кілька схожих елементів (`clickNearestMatch`).
- Я можу вводити текст, вставляти через clipboard, заповнювати форми, робити submit і автозаповнення логіну/пароля.
- Я можу робити скрін усієї сторінки або тільки потрібної області (`screenshot`, `elementScreenshot`).
- Я можу читати JS помилки і мережеві події без DevTools (`getConsoleLog`, `networkGetLog`, `readResponseBody`).
- Я можу чекати появу тексту або стану сторінки, щоб не клікати "в сліпу" (`waitForText`).
- Я можу працювати зі складним UI: `contenteditable`, Monaco/CodeMirror, Shadow DOM, dropdown/menu після hover.
- Я можу робити контрольовану прокрутку вниз/вгору і не залипати в кінці сторінки.
- Я можу записувати і відтворювати сценарії (макроси) для повторюваних перевірок.
- Я можу збирати коротку "пам'ять сесії": що було натиснуто, що змінювалось, які дії вже виконані.

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
- `developer`: відкриває розширені дії для тестування і налагодження.
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

### 4) Перевірка

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

Підходить для:

- smoke/regression перевірок у реальному браузері;
- повторюваних E2E сценаріїв через макроси;
- швидкого дебагу UI через console/network логи;
- перевірок React SPA, де важливо чекати стан, а не просто ставити `sleep`.

## Privacy

- За замовчуванням дані залишаються локально.
- Команди захищені токеном.
- Без явного вмикання `local_network` нічого не слухає LAN.
