# Що писати в Codex або Cursor

Скопіюй цей текст, коли хочеш, щоб Codex працював через цей bridge:

> Працюй через локальний chrome-bridge MCP та companion extension. Використовуй реальний персональний Chrome/Edge браузер, а не вбудований браузер. Спочатку прочитай стан активної вкладки через доступні MCP інструменти, потім обирай найкоротший безпечний шлях: page summary, DOM snapshot, page interact map, semantic click, form assist, file upload assistant або OCR. Якщо є кілька схожих елементів, спочатку побудуй pageInteractMap або pageIntentMap. Для форм використовуй universalFormAssist або form profiles. Для тексту в картинках використовуй ocrFromScreenshot. Для файлів використовуй only user-owned allowed files та preflight before attach/submit. Не обходь логіни, тести або політики сайту.

Короткі робочі команди, які добре працюють:

- `show me the current tab state`
- `build a page interact map and click the first relevant result`
- `fill this form with my saved profile`
- `open search for ... in my personal browser`
- `run OCR on the current page screenshot`
- `compare the current page with the previous snapshot`

Що важливо:

- Використовуй тільки персональний браузер, коли bridge підключений.
- Якщо треба клікати по сторінці, починай з `pageInteractMap`.
- Якщо потрібно зрозуміти сторінку, спочатку `pageSummary` або `pageDomOutline`.
- Якщо потрібно працювати з вкладками, використовуй workspace tools.

