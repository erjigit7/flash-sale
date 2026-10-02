import { defineConfig } from 'vitest/config';

// E2E-тесты идут на реальном Postgres (+ заглушка оплаты и Mailpit из compose).
// Файлы запускаются последовательно: у них общая тестовая БД, и каждый тест сам её чистит.
export default defineConfig({
  test: {
    globals: true,
    root: './',
    include: ['test/**/*.e2e-spec.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
