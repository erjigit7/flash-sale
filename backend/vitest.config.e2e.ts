import { defineConfig } from 'vitest/config';

// E2E-тесты идут на реальном Postgres (+ заглушка оплаты и Mailpit из compose).
// Файлы запускаются последовательно: у них общая тестовая БД, и каждый тест сам её чистит.
// Дефолты рассчитаны на локальный запуск при поднятом docker compose; в контейнере tests их переопределяет compose.
process.env.DATABASE_URL ??= 'postgresql://flashsale:flashsale@localhost:5432/flashsale_test';
process.env.WORKERS_ENABLED = 'false';

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
