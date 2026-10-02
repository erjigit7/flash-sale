import { defineConfig } from 'vitest/config';

// E2E-тесты идут на реальном Postgres (+ заглушка оплаты и Mailpit из compose).
// Файлы запускаются последовательно: у них общая тестовая БД, и каждый тест сам её чистит.
// Дефолты рассчитаны на локальный запуск при поднятом docker compose; в контейнере tests их переопределяет compose.
process.env.DATABASE_URL ??= 'postgresql://flashsale:flashsale@localhost:5432/flashsale_test';
process.env.WORKERS_ENABLED = 'false';
// Тестовое приложение слушает фиксированный порт: на него заглушка оплаты (в docker) шлёт webhook.
// Локально заглушка достаёт до хоста через host.docker.internal; в контейнере tests compose задаёт свои адреса.
process.env.TEST_HTTP_PORT ??= '3100';
process.env.PAYMENT_STUB_URL ??= 'http://localhost:4000';
process.env.PAYMENT_WEBHOOK_URL ??= `http://host.docker.internal:${process.env.TEST_HTTP_PORT}/api/payments/webhook`;
process.env.SMTP_HOST ??= 'localhost';
process.env.MAILPIT_API_URL ??= 'http://localhost:8025';

export default defineConfig({
  test: {
    globals: true,
    root: './',
    include: ['test/**/*.e2e-spec.ts'],
    globalSetup: ['test/support/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
