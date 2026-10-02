import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { configureApp } from '../../src/app.setup.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';

export interface TestApp {
  app: INestApplication;
  prisma: PrismaService;
  /** Базовый URL поднятого приложения (на нём же webhook для заглушки оплаты) */
  baseUrl: string;
  http: () => ReturnType<typeof request>;
  close: () => Promise<void>;
}

/**
 * Поднимает настоящее приложение (все модули, реальный Postgres) внутри процесса теста
 * и слушает настоящий порт: TEST_HTTP_PORT — чтобы заглушка оплаты могла прислать webhook.
 * Фоновые воркеры выключены (WORKERS_ENABLED=false в vitest.config.e2e.ts): тест вызывает их сам —
 * так «время» двигается детерминированно, без sleep.
 */
export async function createTestApp(): Promise<TestApp> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication({ rawBody: true, logger: ['error', 'warn'] });
  configureApp(app);
  await app.listen(Number(process.env.TEST_HTTP_PORT ?? 0), '0.0.0.0');
  const { port } = app.getHttpServer().address() as { port: number };
  const baseUrl = `http://127.0.0.1:${port}`;
  const prisma = app.get(PrismaService);
  return {
    app,
    prisma,
    baseUrl,
    http: () => request(baseUrl),
    close: () => app.close(),
  };
}

/** Чистит все таблицы тестовой БД (globalSetup гарантирует, что это БД *_test). */
export async function resetDb(prisma: PrismaService) {
  await prisma.$executeRawUnsafe(
    'TRUNCATE notifications, email_outbox, orders, reservations, sales, users RESTART IDENTITY CASCADE',
  );
}

export async function loginBuyer(t: TestApp, email: string): Promise<{ token: string; userId: string }> {
  const res = await t.http().post('/api/auth/login').send({ email }).expect(200);
  return { token: res.body.token, userId: res.body.user.id };
}

export async function loginShop(t: TestApp): Promise<string> {
  const res = await t
    .http()
    .post('/api/auth/shop-login')
    .send({ password: process.env.SHOP_PASSWORD ?? 'shop' })
    .expect(200);
  return res.body.token;
}
