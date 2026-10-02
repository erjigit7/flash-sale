import { Injectable } from '@nestjs/common';

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value)) throw new Error(`${name} must be an integer, got "${raw}"`);
  return value;
}

function str(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw === undefined || raw === '' ? fallback : raw;
}

/**
 * Конфигурация из переменных окружения. У всего есть дефолты для локального запуска
 * (тот же набор, что в docker-compose.yml), поэтому .env не обязателен.
 */
@Injectable()
export class AppConfig {
  readonly port = int('PORT', 3000);
  readonly databaseUrl = str(
    'DATABASE_URL',
    'postgresql://flashsale:flashsale@localhost:5432/flashsale',
  );
  readonly dbPoolMax = int('DB_POOL_MAX', 20);

  readonly jwtSecret = str('JWT_SECRET', 'dev-only-jwt-secret-change-me');
  readonly shopPassword = str('SHOP_PASSWORD', 'shop');

  /** Сколько держим товар в корзине. По ТЗ — 10 минут. */
  readonly holdTtlSeconds = int('HOLD_TTL_SECONDS', 600);

  readonly paymentStubUrl = str('PAYMENT_STUB_URL', 'http://localhost:4000');
  readonly paymentWebhookUrl = str(
    'PAYMENT_WEBHOOK_URL',
    'http://localhost:3000/api/payments/webhook',
  );
  readonly paymentWebhookSecret = str('PAYMENT_WEBHOOK_SECRET', 'dev-only-webhook-secret');
  readonly paymentRequestTimeoutMs = int('PAYMENT_REQUEST_TIMEOUT_MS', 5000);

  readonly smtpHost = str('SMTP_HOST', 'localhost');
  readonly smtpPort = int('SMTP_PORT', 1025);
  readonly mailFrom = str('MAIL_FROM', 'Флэш-распродажа <noreply@flash-sale.local>');

  /** Фоновые воркеры. В e2e-тестах выключены: тесты вызывают их напрямую, без sleep. */
  readonly workersEnabled = str('WORKERS_ENABLED', 'true') === 'true';
}
