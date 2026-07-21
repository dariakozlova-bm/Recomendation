# Система збору рекомендацій — каркас проєкту

## Структура
- `frontend/index.html` — односторінкова форма (статичний файл, можна на GitHub Pages)
- `backend/src/worker.js` — Cloudflare Worker: створює кандидата в Breezy, приймає webhook про зміну статусу
- `google-apps-script/Code.gs` — місток до Google Sheets + Gmail (уникає складної OAuth-криптографії у Worker'і)

## Потік
1. Людина заповнює форму → `POST /submit`
2. Worker створює кандидата в Breezy (`origin: referral`, тег типу рекомендації в `headline`)
3. Worker шле дані в Apps Script → рядок у Sheet + лист-подяка референту
4. Коли статус кандидата змінюється в Breezy → вебхук `POST /webhook` → Worker оновлює Sheet і шле відповідний лист референту (в процесі / відмова / прийнято)

## Що потрібно зробити перед першим тестом

### У Breezy
- [ ] Отримати `company_id` і API-токен (Admin → API keys)
- [ ] Створити тестову вакансію-sandbox
- [ ] Написати в підтримку Breezy з проханням активувати вебхуки (Pro-план це дозволяє) на подію `candidateStatusUpdated`, отримати webhook secret
- [ ] Надіслати мені точні назви стадій вашого пайплайну — зараз у `STAGE_EMAIL_MAP` (worker.js) стоять орієнтовні: Screening/Interview/Offer/Hired/Rejected

### У Google
- [ ] Створити Google Sheet, скопіювати його ID з URL, вставити в `SHEET_ID` в `Code.gs`
- [ ] Задеплоїти `Code.gs` як Web App (Deploy → New deployment → Web app, execute as "Me", access "Anyone with the link")
- [ ] Скопіювати URL деплою — це `SHEETS_BRIDGE_URL`
- [ ] Придумати випадковий рядок-секрет і вставити його і в `Code.gs` (`SHARED_SECRET`), і в секрети Worker'а (`SHEETS_BRIDGE_SECRET`) — вони мають збігатись

### У Cloudflare
- [ ] `npm install` в папці `backend`
- [ ] `wrangler login`
- [ ] Встановити секрети:
  ```
  wrangler secret put BREEZY_API_TOKEN
  wrangler secret put BREEZY_COMPANY_ID
  wrangler secret put SHEETS_BRIDGE_URL
  wrangler secret put SHEETS_BRIDGE_SECRET
  wrangler secret put BREEZY_WEBHOOK_SECRET
  ```
- [ ] `wrangler deploy`
- [ ] Вставити отриманий Worker URL у `frontend/index.html` (`BACKEND_URL`)

### Ще не реалізовано — потребує уточнення перед доробкою
- Прикріплення CV до кандидата (`attachResume` в worker.js) — потрібно перевірити точний ендпоінт для вашого акаунту в developer.breezy.hr
- Пошук референта за `breezyCandidateId` при зміні статусу (`lookupReferrer` в worker.js) — потрібно додати дзеркальну дію `get_referral` в Apps Script
- `referred_by` для внутрішніх референтів технічно очікує ID користувача Breezy, а не будь-яке ім'я — варто перевірити на тестовому кандидаті, чи спрацює простий email/name

### Тексти листів
Чернетки вже в `Code.gs` (`EMAIL_TEMPLATES`) — за потреби відредагуйте формулювання, тон, підпис компанії.

## Наступний крок
Як тільки з'явиться `company_id`, тестова вакансія і реальні назви стадій — можемо протестувати весь ланцюжок end-to-end на одному тестовому кандидаті.
