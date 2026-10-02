import { execSync } from 'node:child_process';

/**
 * Перед всеми e2e-тестами накатываем миграции на тестовую БД.
 * Защита от случайностей: тесты чистят таблицы, поэтому работаем только с БД, чьё имя оканчивается на _test.
 */
export default function setup() {
  const url = process.env.DATABASE_URL!;
  const dbName = new URL(url).pathname.slice(1);
  if (!dbName.endsWith('_test')) {
    throw new Error(`e2e tests refuse to run against "${dbName}": database name must end with _test`);
  }
  execSync('npx prisma migrate deploy', { stdio: 'inherit', env: process.env });
}
