import { defineConfig } from 'vitest/config';

// Юнит-тесты: чистая логика без БД.
export default defineConfig({
  test: {
    globals: true,
    root: './',
    include: ['src/**/*.spec.ts'],
  },
});
