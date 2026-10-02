# CLAUDE.md — правила проекта «Флэш-распродажа»

Тестовое задание MadDevs (Agentic Developer, задание 4). Подробный план и обоснования: [docs/PLAN.md](docs/PLAN.md). Журнал работы: [JOURNAL.md](JOURNAL.md).

## Стек

- **backend/** — NestJS + Prisma + PostgreSQL, REST под `/api`, realtime через Socket.IO, фоновые воркеры в том же процессе.
- **frontend/** — React + Vite + TypeScript, react-router, TanStack Query, socket.io-client. В compose собирается и отдаётся через nginx; nginx проксирует `/api` и `/socket.io` на бэкенд, поэтому всё работает с одного origin.
- **payment-stub/** — отдельный сервис-заглушка платёжки (Fastify + TS). Сценарии: `success`, `decline`, `hang`. Есть HTML-панель, где зависшие платежи разрешают руками.
- **Mailpit** — SMTP-заглушка, письма видны в веб-интерфейсе.
- Всё поднимается командой `docker compose up --build` без `.env`: дефолты прописаны в compose (`${VAR:-default}`).

## Порты (локально)

| Сервис | URL |
|---|---|
| Фронтенд | http://localhost:8080 |
| Backend API | http://localhost:3000/api |
| Панель заглушки оплаты | http://localhost:4000 |
| Mailpit UI | http://localhost:8025 |
| PostgreSQL | localhost:5432 |

## Команды

```bash
docker compose up --build                                            # весь стек (или: npm run up)
docker compose --profile test run --rm --build --use-aliases tests   # все e2e-тесты бэкенда в контейнере (или: npm test)

# локально, при поднятом compose (тесты сами возьмут БД flashsale_test, заглушку :4000, Mailpit :8025)
cd backend && npm run test:e2e
cd backend && npx vitest run --config ./vitest.config.e2e.ts test/race-last-unit.e2e-spec.ts   # один файл

cd backend && npx prisma migrate dev --name <имя>   # новая миграция (CHECK/частичные индексы — дописывать SQL руками)
cd backend && npx tsc --noEmit -p tsconfig.json     # проверка типов
cd payment-stub && npx tsc --noEmit                 # проверка типов заглушки
```

`--use-aliases` обязателен: заглушка оплаты шлёт webhook на `http://tests:3100`, а контейнер `docker compose run` без этого флага не получает DNS-имя сервиса.

## Где что лежит (backend/src)

- `reservations/reservations.repository.ts`: атомарный резерв, возврат остатка, истечение удержания.
- `orders/orders.repository.ts`: идемпотентный checkout, outbox отправки в платёжку, `applyPaymentResult`.
- `sales/sale-finalizer.service.ts`: уборка после окончания распродажи. `sales/sale-scheduler.service.ts`: таймеры старта и конца.
- `mail/mail.service.ts`: отправка писем из outbox.
- `realtime/realtime.gateway.ts`: Socket.IO, пересылает доменные события (`events/domain-events.ts`) в комнаты.
- `workers/workers.service.ts`: все фоновые циклы и их периоды.

## Жёсткие правила (не нарушать)

1. **Остаток и статусы меняются только условным UPDATE.** Это одна атомарная операция `UPDATE ... WHERE <условие> RETURNING`, и живёт она в `*.repository.ts` через `$queryRaw`. Никакого «прочитал → проверил в коде → записал». Последний рубеж — CHECK `available >= 0` в БД.
2. **Время для решений берём только из БД** (`now()` внутри SQL). `Date.now()` в Node и время браузера для решений не используем. Клиент только рисует таймер со смещением, синхронизированным по серверу.
3. **Внешние действия идемпотентны.**
   - Письма уходят через `email_outbox`, у каждой записи уникальный `dedup_key`, и запись создаётся в той же транзакции, что и смена статуса.
   - Платёж отправляется с ключом идемпотентности, это `order.id`.
   - Checkout требует заголовок `Idempotency-Key` и защищён уникальными индексами.
4. **Сокет-события отправляем только после commit транзакции.** У событий об остатке есть поле `version`, клиент игнорирует события со старой версией.
5. **Воркеры безопасны для нескольких инстансов**: захват строк через `FOR UPDATE SKIP LOCKED`, повторный запуск ничего не ломает.
6. **Изменение поведения сопровождается тестом.** E2E-тесты идут на реальном Postgres, без sleep: время двигаем через `expires_at`/`ends_at` в БД, воркеры вызываем напрямую.
7. **Секретов в репо нет.** Есть только `.env.example` и дефолты в compose для локального запуска.
8. **Переводы строк — LF** (см. `.gitattributes`).

## Договорённости по процессу

- **Язык**: документация и UI на русском, сообщения коммитов на английском в стиле Conventional Commits (`feat(reservations): ...`, `test: ...`, `chore: ...`, `docs: ...`).
- **Коммит сразу, как шаг готов.** Нельзя писать всё целиком, а потом резать на коммиты. Каждый коммит — в момент готовности своего шага. Пуш в `origin` (https://github.com/erjigit7/flash-sale) после каждого этапа.
- **JOURNAL.md** обновляется на каждом шаге: время (только из команды `date`, не придумывать), что сделано, какое решение принято и почему, и **кто его принял**: `[решение: заказчик]` или `[решение: агент]`. Баги, найденные заказчиком, и смены подхода от него помечаются явно.
- **Текущий режим**: заказчик проверяет руками и присылает баги. README не финализировать и не писать, что всё готово, пока он не скажет.
- **Контрольные точки**:
  - к концу 4.10: ядро бэкенда с тестами;
  - 5.10: фронт;
  - 6.10: Playwright и README;
  - 7.10: запас.
  
  Если отстаём, режем в таком порядке: хаос-тест → Playwright → HMAC на webhook. **Фронт не режем никогда.**
- Если Prisma 7 конфликтует с Nest (ESM/CJS и т.п.), не боремся: ставим Prisma 6 и пишем в журнал почему.
- Seed идемпотентный: перезапуск не плодит данные.
- Экспорт сессии агента в репозиторий не кладём.
