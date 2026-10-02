import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { configureApp } from '../../src/app.setup.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';

export interface TestApp {
  app: INestApplication;
  prisma: PrismaService;
  http: () => ReturnType<typeof request>;
  close: () => Promise<void>;
}

/**
 * Поднимает настоящее приложение (все модули, реальный Postgres) внутри процесса теста.
 * Фоновые воркеры выключены (WORKERS_ENABLED=false в vitest.config.e2e.ts): тест вызывает их сам —
 * так «время» двигается детерминированно, без sleep.
 */
export async function createTestApp(): Promise<TestApp> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication({ logger: ['error', 'warn'] });
  configureApp(app);
  await app.init();
  const prisma = app.get(PrismaService);
  return {
    app,
    prisma,
    http: () => request(app.getHttpServer()),
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
