# План: Флэш-распродажа (тестовое MadDevs, задание 4)

## Контекст

Тестовое на Agentic Developer, дедлайн 7 октября 2026 (2.10 заказчик перенёс срок на **5 октября**, актуальные контрольные точки — в CLAUDE.md). Папка `C:\Users\Admin20\Projects\flash-sale` пустая, git ещё нет.
Окружение проверено: Node 24.19, npm 11.17, Docker 29.6 + Compose v5.3, git 2.55. Планирование начато 2026-10-02 09:55:57 +0600 (взято из `date`).

Стек задан: NestJS + Prisma + PostgreSQL, React + Vite + TS, Socket.IO, Mailpit, своя заглушка оплаты, всё поднимается одной командой `docker compose up`.

Главное, на чём не экономим:
1. последнюю единицу не продать двоим: атомарный условный UPDATE;
2. всё время считает сервер, а точнее `now()` в БД;
3. идемпотентная оплата: ключ + уникальные индексы;
4. зависшая оплата держит товар;
5. каждое письмо уходит один раз.

Всё это доказываем автотестами на настоящем Postgres.

### Решения, согласованные с тобой
- **Вход**: email без пароля. Сервер делает upsert пользователя и выдаёт JWT. Токен лежит в **sessionStorage**, поэтому каждая вкладка может быть отдельным покупателем. Экран магазина закрыт паролем `SHOP_PASSWORD` из `.env`. В README помечено как демо-вход.
- **Количество**: у распродажи есть `max_per_order` (по умолчанию 1), у покупателя одна активная позиция на распродажу. **Если просят больше, чем осталось, отказываем целиком**, частичной продажи нет: списание идёт через `WHERE available >= qty`. В ответе 409 `insufficient_stock` приходит `{available}`, и UI пишет «осталось N». На витрине всегда виден живой остаток, а выбор количества ограничен `min(max_per_order, available)`.
- **Язык**: README, JOURNAL, CLAUDE.md и UI на русском, коммиты на английском (Conventional Commits).
- **Playwright** с двумя вкладками делаем отдельным этапом после фронта.

### Поправки при утверждении плана
1. **Контрольные точки**:
   - к концу 4.10: ядро бэкенда с тестами (этапы 0–11);
   - 5.10: фронт (этап 12);
   - 6.10: Playwright и README (13–14);
   - 7.10: запас.
   
   Если отстаём, режем в таком порядке: хаос-тест → Playwright → HMAC на webhook. **Фронт не режем никогда.**
2. **Prisma 7**: если начнёт конфликтовать с Nest (ESM/CJS и т.п.), не боремся, ставим Prisma 6 и пишем в журнал почему.
3. **`docker compose up` работает без копирования `.env`**: все дефолты прописаны в compose через `${VAR:-default}`. `.env.example` только документирует переменные для переопределения. **Seed идемпотентный**: магазин делаем через upsert по email, демо-распродажу создаём, только если её ещё нет (фиксированный `slug`). Перезапуск не плодит распродажи. Для свежего демо на экране магазина есть пресет «старт через 1 мин».
4. **Оплата, зависшая навсегда, держит товар бесконечно.** Так требует ТЗ. В README это описано как осознанное решение с альтернативами: жёсткий таймаут, запрос статуса у провайдера, ручная отмена.
5. **Экспорт сессии в репо не кладём.** Решение остаётся за тобой.

Репозиторий: https://github.com/erjigit7/flash-sale. На этапе 0 добавляю `origin`, дальше пушу после каждого этапа.

---

## 1. Архитектура

```
 Browser tab A ─┐                       ┌─────────── docker compose ───────────────────────────┐
 Browser tab B ─┼─ http://localhost:8080 │ frontend (nginx: SPA + proxy /api, /socket.io)        │
                │                        │      │                                                │
                │                        │ backend (NestJS) ── REST /api + Socket.IO             │
                │                        │   ├─ воркеры: expirer, sale-lifecycle,                │
                │                        │   │   payment-dispatcher, reconciler, mail-sender     │
                │                        │   ├──► postgres:5432 (единственный источник правды)   │
                │                        │   ├──► payment-stub:4000 (HTTP)  ◄── webhook (HMAC)   │
                │                        │   └──► mailpit:1025 (SMTP)                            │
 http://localhost:4000 (панель заглушки) │ payment-stub (Fastify, отдельный сервис)              │
 http://localhost:8025 (Mailpit UI)      │ mailpit                                               │
                                         └──────────────────────────────────────────────────────┘
```

Решения и почему:
- **Заглушка оплаты живёт отдельным контейнером**, а не модулем бэкенда. Так она ведёт себя как внешний провайдер: есть сетевая граница, ответ приходит асинхронно через webhook, можно «зависнуть». У неё своя панель, там висящий платёж подтверждают или отклоняют руками.
- **Решения о времени принимает только БД** (`now()` внутри условных UPDATE). Часы Node и браузера ни на что не влияют. Браузер только рисует таймер: смещение часов считаем по ping серверного времени, примерно как в NTP.
- **Outbox в БД** для писем и запросов к оплате. Запись создаётся в той же транзакции, что и смена статуса, а отправляет её воркер. Если процесс упадёт, событие не потеряется и не задвоится.
- **Prisma для CRUD, `$queryRaw` для критичных переходов** (резерв, истечение, checkout, результат оплаты). Prisma не умеет выразить `WHERE ... AND now() BETWEEN ...` с часами БД в одном атомарном запросе. Все такие SQL собраны в `*.repository.ts`.
- **Один инстанс бэкенда**. Воркеры всё равно пишем безопасными для нескольких инстансов (`FOR UPDATE SKIP LOCKED`). Для масштабирования Socket.IO нужен Redis-адаптер, это уходит в «что дальше».
- Фронт в compose собирается и отдаётся через nginx, nginx проксирует `/api` и `/socket.io`. Получается один origin, CORS не нужен. В dev-режиме тот же прокси настроен в Vite.
- `.gitattributes` с `eol=lf` нужен, потому что на Windows CRLF ломает скрипты в контейнерах.

## 2. Структура репозитория

```
flash-sale/
  docker-compose.yml   .env.example   package.json (npm workspaces + корневые скрипты)
  backend/   NestJS: prisma/ (schema, migrations, seed), src/{auth,clock,sales,reservations,
             orders,payments,mail,realtime,shop,workers,prisma}, test/ (e2e на реальном PG)
  frontend/  React+Vite+TS: src/{api,socket,clock,pages,components}, Dockerfile (build → nginx)
  payment-stub/  Fastify+TS: API платежей + HTML-панель
  docs/PLAN.md (этот план)   JOURNAL.md   CLAUDE.md   README.md
```

## 3. Схема БД (Prisma; CHECK и частичные индексы добавляем сырым SQL в миграции)

| Таблица | Поля | Ограничения |
|---|---|---|
| `users` | id uuid, email, name, role (BUYER/SHOP), created_at | unique(email) |
| `sales` | id, title, description, image_url, price_cents, total_qty, **available**, withdrawn_qty, max_per_order, starts_at, ends_at (timestamptz), finalized_at, **version** bigint | CHECK `0 <= available <= total_qty`, CHECK `ends_at > starts_at` |
| `reservations` (позиции корзины) | id, sale_id, user_id, quantity, unit_price_cents, status, expires_at, created_at, updated_at | **частичный unique(user_id, sale_id) WHERE status IN ('ACTIVE','CHECKOUT')**; index(status, expires_at) |
| `orders` | id, reservation_id, user_id, sale_id, quantity, amount_cents, status, scenario, idempotency_key, provider_payment_id, paid_at, failed_reason, payment_attempts, timestamps | **unique(reservation_id)**, **unique(user_id, idempotency_key)** |
| `email_outbox` | id, dedup_key, to, subject, body, status (PENDING/SENT/FAILED), attempts, sent_at | **unique(dedup_key)** |
| `notifications` | id, user_id, type, payload jsonb, created_at, read_at | для уведомлений в кабинете |

Статусы:
- **reservation**: `ACTIVE` (в корзине) → `CHECKOUT` (оплата начата, товар держится) → `PURCHASED`. Другие исходы из `ACTIVE`: `EXPIRED`, `RELEASED` (удалил сам) и `CANCELLED` (распродажа закончилась). Из `CHECKOUT` при отказе оплаты идёт в `RELEASED`.
- **order**: `PENDING` → `PAID` или `FAILED`.
- **sale**: статус не храним, вычисляем по `now()` БД: UPCOMING, LIVE или ENDED. Флаг `finalized_at` ставится, когда уборка после окончания выполнена.

Инвариант, который проверяется в тестах: `total_qty = available + ACTIVE + CHECKOUT + PURCHASED + withdrawn_qty`.

## 4. Ключевые операции (атомарно, без read-check-write)

**Резерв (в корзину)** — один SQL-оператор:
```sql
WITH s AS (
  UPDATE sales SET available = available - $qty, version = version + 1
  WHERE id = $sale AND available >= $qty AND $qty <= max_per_order
    AND starts_at <= now() AND ends_at > now()
  RETURNING id, price_cents, available, version)
INSERT INTO reservations (sale_id, user_id, quantity, unit_price_cents, status, expires_at)
SELECT id, $user, $qty, price_cents, 'ACTIVE', now() + make_interval(secs => $ttl) FROM s
RETURNING ...;
```
Если строк нет, отдельным read-only запросом определяем причину для ответа: `not_started`, `ended`, `sold_out` (остаток 0), `insufficient_stock` (остаток меньше qty, вместе с `available`) или `qty_over_limit`. На корректность этот запрос не влияет. Если сработал частичный unique (у покупателя уже есть активная позиция), оператор откатывается целиком вместе со списанием, и мы отвечаем 409 `already_in_cart`.

**Checkout (оплатить)** — одна транзакция:
1. `UPDATE reservations SET status='CHECKOUT' WHERE id=$r AND user_id=$u AND status='ACTIVE' AND expires_at > now() RETURNING *`.
2. Если строка вернулась, делаем `INSERT orders` с идемпотентным ключом.
3. Если 0 строк, ищем заказ по `(user_id, idempotency_key)` или по `reservation_id`. Нашли — возвращаем тот же заказ (повтор запроса). Не нашли — 410 `hold_expired`.

Второй параллельный запрос ждёт блокировку строки. После неё условие `status='ACTIVE'` уже не выполняется, и он возвращает существующий заказ.

**Результат оплаты** приходит через webhook или reconciler и обрабатывается одной идемпотентной функцией `applyPaymentResult`:
- `UPDATE orders SET status=... WHERE id=$o AND status='PENDING'`. Если 0 строк, это дубль, ничего не делаем.
- **PAID**: reservation → `PURCHASED`; `INSERT email_outbox (dedup_key='order:'||id) ON CONFLICT DO NOTHING`.
- **FAILED**: reservation → `RELEASED`. Остаток возвращается на витрину, если распродажа ещё идёт, иначе в `withdrawn_qty`. Письмо об отказе тоже ровно одно, ключ тот же: **одно письмо на заказ**.

## 5. «Ожидаемое поведение» → как закрываем

| # | Требование | Решение | Доказательство |
|---|---|---|---|
| 1 | До старта купить нельзя, даже если страница открыта заранее. В момент старта покупка открывается у всех одновременно | Проверка `starts_at <= now()` встроена в атомарный UPDATE резерва, поэтому запрос, подделанный клиентом, не пройдёт. Клиент синхронизирует часы (смещение от серверного времени, пересчёт раз в 30 с). Кнопка открывается, когда синхронизированный таймер доходит до 0, либо по событию `sale:started`: lifecycle-воркер шлёт его по точному `setTimeout`, а секундный sweep подстраховывает. | e2e: резерв до старта → 409 `not_started`, после старта → 201. Тест realtime: два сокета получают `sale:started`. |
| 2 | Остатки на витрине меняются у всех без обновления страницы | После commit каждой операции с остатком сервер шлёт `sale:stock {saleId, available, version}` в комнату `sale:{id}`. Клиент игнорирует события со старой `version`, так что порядок доставки не важен. После переподключения клиент заново берёт снапшот через REST. | e2e: два socket.io-клиента получают обновление. Playwright: две вкладки. |
| 3 | Последнюю единицу двоим не продать | Один условный UPDATE `available >= qty` плюс CHECK `available >= 0` как последний рубеж. | e2e: распродажа на 1 шт., 50 параллельных покупателей → ровно один 201 и 49 ответов `sold_out`. Вариант 10 шт. на 100 покупателей → ровно 10. Запрос 3 шт. при остатке 2 → 409 `insufficient_stock {available:2}`, остаток не изменился. Проверяется инвариант. |
| 4 | Удержание 10 минут; не оплатил — товар вернулся, остальные видят сразу | `expires_at = now()+600s`, TTL задаётся в env. Expirer раз в 1 с в одной транзакции переводит `ACTIVE → EXPIRED` и делает `available += qty` через `SKIP LOCKED`, после commit шлёт `sale:stock` и `reservation:expired` владельцу. Таймер корзины на клиенте считает от серверного `expires_at`. | e2e: в тесте сдвигаем `expires_at` в прошлое и вызываем expirer напрямую, без sleep → остаток вернулся, событие пришло, checkout отвечает 410. |
| 5 | Оплата, начатая до истечения, завершается, даже если заглушка ответила после | После checkout позиция в статусе `CHECKOUT`, а expirer трогает только `ACTIVE`. Гонку «оплатить» против «истечь» решает блокировка строки: побеждает кто-то один. | e2e: оплата в режиме hang → `expires_at` в прошлом → expirer → товар не вернулся → заглушка ответила success → `PAID`. Отдельный тест на гонку checkout и expirer. |
| 6 | Заглушка «зависла» — заказ ждёт, товар не возвращается и не продаётся дважды; когда ответила — досчитывается | Заказ `PENDING`, позиция `CHECKOUT`, остаток остаётся списанным. Результат приходит через webhook (HMAC) или через reconciler, который опрашивает `GET /payments/:id` у заглушки для PENDING-заказов: страховка на случай потерянного webhook. Обе ветки сходятся в `applyPaymentResult`. Dispatcher повторяет запросы к заглушке, если та недоступна или не ответила за таймаут, ключ при этом тот же. | e2e: hang → остаток не изменился, другой покупатель получает `sold_out` → resolve в заглушке → `PAID`. Вариант с decline → остаток вернулся. |
| 7 | Двойное «оплатить» не создаёт двух заказов и не списывает дважды | Клиент генерирует `Idempotency-Key` один раз на позицию корзины, хранит его и блокирует кнопку. На сервере стоят `unique(user_id, idempotency_key)` и `unique(reservation_id)`, а переход `ACTIVE→CHECKOUT` выполняется один раз. Заглушка дедуплицирует платежи по ключу = `order.id`, поэтому повторы dispatcher не приводят ко второму списанию. | e2e: 20 параллельных POST с одним ключом → один заказ, все ответы с одним id. Разные ключи на одну позицию → тоже один заказ. У заглушки ровно один платёж. |
| 8 | Письмо о заказе. Одно | Outbox: запись создаётся в той же транзакции, что и единственный переход `PENDING→PAID/FAILED`, а `unique(dedup_key)` страхует ещё раз. Отправитель захватывает запись (`FOR UPDATE SKIP LOCKED`), шлёт в SMTP и помечает `SENT` в той же транзакции. Message-ID детерминированный (`<order:{id}@flash-sale.local>`). | e2e: 10 параллельных одинаковых webhook → одна запись в outbox, в **Mailpit через его API ровно одно письмо**. |
| 9 | По окончании непроданное снимается, корзины очищаются, владельцы получают уведомление | Lifecycle-воркер при `ends_at <= now()` в одной транзакции: `withdrawn_qty += available, available = 0`; `ACTIVE → CANCELLED`; для каждой позиции создаёт notification и запись в outbox (`sale-ended:{reservationId}`); ставит `finalized_at`. Позиции в `CHECKOUT` не трогаем: оплата досчитается, при отказе товар уйдёт в withdrawn. Потом сокет-события в `sale:{id}` и `user:{id}`. | e2e: распродажа закончилась → остаток 0, корзины отменены, по одному письму на владельца, повторный запуск воркера ничего не делает, PENDING-заказ потом корректно становится PAID. |

Честное ограничение, которое опишем в README. «Ровно один раз» гарантируется на уровне БД: одна запись на событие, один отправитель, статус SENT. Сама доставка в SMTP идёт по схеме at-least-once с узким окном: если процесс упал между ответом SMTP `250 OK` и commit, письмо уйдёт повторно. Это окно смягчает детерминированный Message-ID. Exactly-once поверх SMTP теоретически невозможен.

## 6. API и события

REST `/api`:
- `POST /auth/login`, `GET /me`, `GET /time`
- `GET /sales`, `GET /sales/:id`
- `POST /reservations {saleId, qty}`, `GET /reservations` (корзина), `DELETE /reservations/:id`
- `POST /orders {reservationId, scenario}` + заголовок `Idempotency-Key`, `GET /orders`
- `POST /payments/webhook`
- `GET /notifications`
- shop: `POST /shop/sales`, `GET /shop/stats`

Socket.IO:
- комнаты: `sale:{id}`, `user:{id}`, `shop`
- события: `time:pong`, `sale:started`, `sale:ended`, `sale:stock`, `reservation:updated`, `order:updated`, `notification`, `shop:stats` (throttle 250 мс)

Заглушка `:4000`:
- `POST /payments {idempotencyKey, amountCents, scenario, callbackUrl}` → 202 `{paymentId, status:'processing'}`
- `GET /payments/:id`
- `POST /payments/:id/resolve {result}` (для панели и тестов)
- HTML-панель со списком платежей и кнопками «подтвердить» / «отклонить»
- сценарии: `success` и `decline` отвечают через 1–2 с, `hang` ждёт, пока платёж не разрешат вручную

## 7. Фронтенд (React + Vite + TS, react-router, TanStack Query, socket.io-client, простой CSS)

- **Витрина**: карточки с ценой и остатком (прогресс-бар), таймер до старта или до конца, кнопка «В корзину» в состояниях «скоро / купить / закончилось».
- **Корзина**: таймер удержания по серверному `expires_at`, выбор тестового сценария оплаты, «Оплатить». После клика кнопка заблокирована, ключ переиспользуется.
- **Кабинет**: заказы со статусами, которые обновляются вживую (PENDING → PAID/FAILED), история позиций (истекла, отменена), уведомления.
- **Экран магазина**: форма создания распродажи с пресетом «старт через 1 мин». Таблица по распродажам: остаток, в корзинах, ждут оплаты, продано, снято, выручка. Обновляется вживую.
- Тосты из `user:{id}`: «удержание истекло», «распродажа закончилась, корзина очищена».

## 8. Тесты (доказуемость)

Jest + supertest + socket.io-client. Бэкенд поднимается in-process (Nest TestingModule) на **реальном Postgres** (отдельная БД `flashsale_test`), заглушка и Mailpit настоящие из compose. Тесты идут последовательно (`--runInBand`), перед каждым TRUNCATE. Воркеры в тестах вызываются напрямую, время двигаем изменением `expires_at`/`ends_at` в БД, без sleep, поэтому тесты детерминированы.

Файлы `backend/test/`:
- `race-last-unit.e2e-spec.ts`
- `sale-window.e2e-spec.ts` (до старта / после конца)
- `hold-expiry.e2e-spec.ts`
- `double-pay.e2e-spec.ts`
- `hung-payment.e2e-spec.ts`
- `payment-after-expiry.e2e-spec.ts`
- `email-once.e2e-spec.ts`
- `sale-end.e2e-spec.ts`
- `realtime.e2e-spec.ts`
- `invariant.e2e-spec.ts` (хаос-тест: случайные параллельные операции, в конце проверяется инвариант)

Плюс по возможности **Playwright**: два browser context, витрина в обоих, покупка последней единицы, остаток обновился у второго без reload.

Запуск одной командой: `docker compose --profile test run --rm tests`. Локально: `npm run test:e2e` при поднятом compose.

## 9. Этапы (после каждого: запись в JOURNAL.md с временем из `date`, маленький коммит)

0. **Bootstrap**: `git init`, `.gitignore`, `.gitattributes`, `CLAUDE.md`, `JOURNAL.md`, `docs/PLAN.md`.
1. **Каркас**: docker-compose (postgres, mailpit, healthchecks), скелеты Nest, Vite и заглушки, Dockerfile'ы, `docker compose up` поднимает пустые сервисы.
2. **Схема БД**: Prisma-схема, миграция с CHECK и частичными индексами, seed (магазин, демо-распродажа со стартом через 2 мин после запуска).
3. **Auth + часы**: логин, JWT, guard'ы, `/time`, ping по сокету.
4. **Распродажи**: создание и список, lifecycle-воркер (start/end).
5. **Корзина**: атомарный резерв, удаление, expirer. Тесты: гонка, окно продаж, истечение.
6. **Realtime**: gateway, комнаты, версии. Тест на двух сокетах.
7. **Payment-stub**: сценарии, идемпотентность, webhook с HMAC, панель.
8. **Checkout и оплата**: идемпотентный checkout, dispatcher, webhook, reconciler. Тесты: двойная оплата, зависшая оплата, оплата после истечения, дубли webhook.
9. **Почта**: outbox, sender, Mailpit. Тест «одно письмо».
10. **Окончание распродажи**: снятие остатка, отмена корзин, уведомления. Тесты.
11. **Статистика магазина** + realtime.
12. **Фронтенд** несколькими коммитами: login → витрина → корзина/оплата → кабинет → магазин.
13. **Playwright** (две вкладки), если хватает времени.
14. **README** (запуск, что работает и что нет, решения с отдельным пунктом про бесконечно зависшую оплату, что дальше, чем делали) и финальная запись в журнале. Экспорт сессии в репо не кладём.

Ядро бэкенда с тестами (этапы 1–11) идёт первым: это главное. Фронт после.

GitHub: https://github.com/erjigit7/flash-sale, пушу после каждого этапа. Версии пакетов (Prisma, Nest, Vite) проверяю на этапе 1 и фиксирую в lock-файлах. Если с Prisma 7 возникнут проблемы, откатываемся на Prisma 6 (см. поправку 2).

## 10. CLAUDE.md (содержание)

- стек и структура
- команды: up, test, migrate, seed, lint
- правила:
  - остаток и переходы статусов меняются только условным UPDATE в `*.repository.ts`, никакого read-then-write;
  - время берём из `now()` БД, никогда из `Date.now()` для решений;
  - любое внешнее действие (письмо, платёж) идёт через outbox или с ключом идемпотентности;
  - сокет-событие отправляется только после commit;
  - каждое изменение поведения сопровождается тестом;
  - коммиты маленькие, Conventional Commits;
  - JOURNAL.md обновляется на каждом шаге, время берём только из `date`;
  - без секретов в репо (только `.env.example`);
  - переводы строк LF

## 11. Проверка end-to-end

1. `docker compose up --build`. Открыть http://localhost:8080 в двух вкладках, во второй войти другим покупателем.
2. Демо-распродажа на 1 шт. стартует через ~2 мин: таймеры идут синхронно, кнопка недоступна, в момент старта открывается в обеих вкладках.
3. Обе вкладки жмут «купить»: одна получает товар, другая «закончилось».
4. Подождать удержание (для демо можно `HOLD_TTL_SECONDS=60`): товар сразу появляется во второй вкладке.
5. Оплата со сценарием hang: заказ PENDING, товар не возвращается. Подтвердить в панели :4000 → PAID, в Mailpit :8025 ровно одно письмо.
6. Экран магазина показывает остаток, в корзинах, продано, выручку вживую.
7. `docker compose --profile test run --rm tests` → все тесты зелёные.
