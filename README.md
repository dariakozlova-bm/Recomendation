# Система збору рекомендацій — міні-сайт

## Поточна архітектура (легка версія, без Cloudflare)
- `frontend/index.html` — односторінкова форма (статичний файл, можна на GitHub Pages)
- `google-apps-script/Code.gs` — весь бекенд в одному Apps Script Web App: віддає список вакансій, створює кандидата в Breezy, пише рядок у Sheet, шле листи референту, приймає вебхук про зміну статусу
- `backend/` — Cloudflare Worker-версія того ж бекенду, відкладена на потім (див. нижче "Якщо знадобиться Cloudflare")

## Потік
1. Людина заповнює форму → `POST {exec}?route=submit`
2. Apps Script створює кандидата в Breezy: `source` = "Внутрішня рекомендація"/"Зовнішня рекомендація" (залежно від перемикача "Я співробітник"), `headline` = ім'я кандидата, а хто саме рекомендує — в `cover_letter`
3. Той самий виклик пише рядок у Sheet і шле лист-подяку референту
4. Коли статус кандидата змінюється в Breezy → вебхук `POST {exec}?route=webhook&token=...` → Apps Script оновлює Sheet і шле відповідний лист референту (в процесі / відмова / прийнято)

## Налаштування

### У Breezy
- [x] `company_id` (BetterMe) = `28387eb8ead6`
- [x] Тестова вакансія-sandbox: https://betterme.breezy.hr/p/163887b99a33
- [ ] Надіслати точні назви стадій вашого пайплайну — зараз у `STAGE_EMAIL_MAP` (`Code.gs`) стоять орієнтовні: Screening/Interview/Offer/Hired/Rejected

### У Google Apps Script
1. Відкрити таблицю → Розширення → Apps Script, вставити вміст `google-apps-script/Code.gs`
2. Project Settings → Script Properties — додати (НЕ в код, тільки тут):
   - `BREEZY_API_TOKEN` — Personal Access Token з Breezy (My Settings → API Keys)
   - `BREEZY_COMPANY_ID` — `28387eb8ead6`
   - `WEBHOOK_TOKEN` — будь-який випадковий рядок (замінює перевірку підпису — Apps Script не вміє читати заголовки запитів)
3. Deploy → New deployment (або Manage deployments → редагувати наявний) → Web app, execute as "Me", access "Anyone with the link"
4. У функції `registerBreezyWebhook_` в коду вставити свій `/exec` URL і один раз запустити її вручну з редактора Apps Script — це зареєструє вебхук у Breezy на подію `candidateStatusUpdated`

### У формі (`frontend/index.html`)
`BACKEND_URL` вже вказує на задеплоєний Apps Script URL — при передеплої з новою версією код URL не змінюється.

### Ще не реалізовано
- Прикріплення CV кандидата (форма його збирає, але бекенд поки нічого з ним не робить) — Breezy-ендпоінт для вкладень треба звірити з developer.breezy.hr під конкретний акаунт
- Точне поле назви стадії (`stage_name`) у вебхук-payload — потрібно підтвердити на реальній доставці вебхука

### Тексти листів
У `Code.gs` (`EMAIL_TEMPLATES`) — за потреби відредагуйте формулювання, тон, підпис компанії.

## Якщо знадобиться Cloudflare
`backend/` містить готовий Cloudflare Worker з тією самою логікою (ті самі виправлення `source`/`headline`/`cover_letter`) — на випадок, якщо навантаження чи потреба у справжній перевірці підпису вебхука (`X-Hook-Signature`, яку Apps Script прочитати не може) виправдають перехід. Дивись історію комітів цього файлу для повного опису налаштування Worker'а.
