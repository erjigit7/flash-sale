#!/usr/bin/env node
/**
 * Браузерные e2e (Playwright) на ОТДЕЛЬНОМ, изолированном стеке:
 *   node scripts/run-e2e.mjs            (или npm run test:e2e)
 *
 * Почему отдельный стек: часть сценариев требует короткого удержания (HOLD_TTL_SECONDS=15 вместо 600),
 * а это настройка всего бэкенда. Отдельный compose-проект со своими портами и volume'ами не трогает
 * демо-стек и его данные; после прогона он сносится (KEEP_E2E_STACK=1 — оставить для разбора).
 */
import { spawnSync } from 'node:child_process';

const env = {
  ...process.env,
  COMPOSE_PROJECT_NAME: 'flash-sale-e2e',
  HOLD_TTL_SECONDS: process.env.HOLD_TTL_SECONDS ?? '15',
  // порты на хосте — свои, чтобы не конфликтовать с поднятым демо-стеком
  FRONTEND_PORT: '18080',
  BACKEND_PORT: '13000',
  PAYMENT_STUB_PORT: '14000',
  MAILPIT_UI_PORT: '18025',
  MAILPIT_SMTP_PORT: '11025',
  POSTGRES_PORT: '15432',
};

const compose = (args) => spawnSync('docker', ['compose', ...args], { stdio: 'inherit', env }).status ?? 1;

let code = 1;
try {
  // явная сборка всех образов: `run --build` не гарантирует пересборку уже существующих образов зависимостей
  code = compose(['--profile', 'e2e', 'build']);
  if (code === 0) code = compose(['--profile', 'e2e', 'run', '--rm', 'e2e']);
} finally {
  if (process.env.KEEP_E2E_STACK !== '1') compose(['--profile', 'e2e', 'down', '-v', '--remove-orphans']);
}
process.exit(code);
