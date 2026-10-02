import { defineConfig, devices } from '@playwright/test';

// Тесты идут против уже поднятого стека (docker compose up). Адреса — изнутри сети compose
// (сервис e2e) или с хоста (локальный запуск: npm test в папке e2e).
export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: process.env.BASE_URL ?? 'http://localhost:8080',
    trace: 'retain-on-failure',
    locale: 'ru-RU',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
