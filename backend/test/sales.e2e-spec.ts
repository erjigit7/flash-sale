import { AppConfig } from '../src/config/app-config.js';
import { SaleScheduler } from '../src/sales/sale-scheduler.service.js';
import { createTestApp, loginBuyer, loginShop, resetDb, type TestApp } from './support/app.js';
import { createSale } from './support/fixtures.js';

describe('распродажи: создание и витрина', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });
  beforeEach(() => resetDb(t.prisma));
  afterAll(() => t.close());

  it('магазин создаёт распродажу со стартом «через N секунд» по часам БД', async () => {
    const shop = await loginShop(t);
    const res = await t
      .http()
      .post('/api/shop/sales')
      .set('Authorization', `Bearer ${shop}`)
      .send({ title: 'Чайник', priceCents: 99900, totalQty: 3, maxPerOrder: 2, startsInSeconds: 60, durationSeconds: 600 })
      .expect(201);

    expect(res.body).toMatchObject({ title: 'Чайник', totalQty: 3, available: 3, maxPerOrder: 2, status: 'UPCOMING' });
    const [{ diff }] = await t.prisma.$queryRaw<{ diff: number }[]>`
      SELECT EXTRACT(EPOCH FROM (starts_at - now()))::float AS diff FROM sales WHERE id = ${res.body.id}::uuid`;
    expect(diff).toBeGreaterThan(55);
    expect(diff).toBeLessThanOrEqual(60);
  });

  it('покупатель не может создать распродажу', async () => {
    const { token } = await loginBuyer(t, 'buyer@example.com');
    await t
      .http()
      .post('/api/shop/sales')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'x', priceCents: 1, totalQty: 1, startsInSeconds: 0, durationSeconds: 60 })
      .expect(403);
  });

  it('валидация: лимит на заказ больше партии, нет старта', async () => {
    const shop = await loginShop(t);
    const auth = { Authorization: `Bearer ${shop}` };
    const bad1 = await t.http().post('/api/shop/sales').set(auth)
      .send({ title: 'x', priceCents: 100, totalQty: 2, maxPerOrder: 3, startsInSeconds: 0, durationSeconds: 60 })
      .expect(400);
    expect(bad1.body.error).toBe('invalid_max_per_order');
    const bad2 = await t.http().post('/api/shop/sales').set(auth)
      .send({ title: 'x', priceCents: 100, totalQty: 2, durationSeconds: 60 })
      .expect(400);
    expect(bad2.body.error).toBe('invalid_start');
  });

  describe('правила формы магазина проверяет сервер (не только фронт)', () => {
    const base = { title: 'Товар', priceCents: 1000_00, totalQty: 5, maxPerOrder: 1, startsInSeconds: 60, durationSeconds: 600 };
    const create = async (body: object) =>
      t.http().post('/api/shop/sales').set('Authorization', `Bearer ${await loginShop(t)}`).send({ ...base, ...body });

    it('старая цена ниже или равна новой → 400 invalid_old_price, распродажа не создаётся', async () => {
      for (const oldPriceCents of [999_00, 1000_00]) {
        const res = await create({ oldPriceCents });
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('invalid_old_price');
      }
      expect(await t.prisma.sale.count()).toBe(0);
      await create({ oldPriceCents: 1000_01 }).then((r) => expect(r.status).toBe(201));
      await create({}).then((r) => expect(r.status).toBe(201)); // старая цена необязательна
    });

    it('лимит «в одни руки» больше партии → 400 invalid_max_per_order; равный партии — можно', async () => {
      const res = await create({ totalQty: 3, maxPerOrder: 4 });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_max_per_order');
      expect(await t.prisma.sale.count()).toBe(0);
      await create({ totalQty: 3, maxPerOrder: 3 }).then((r) => expect(r.status).toBe(201));
    });

    it('в обход сервиса БД сама не даст записать такие значения (CHECK-ограничения)', async () => {
      const insert = (oldPrice: number | null, maxPerOrder: number) => t.prisma.$executeRaw`
        INSERT INTO sales (title, price_cents, old_price_cents, total_qty, available, max_per_order, starts_at, ends_at)
        VALUES ('x', 1000, ${oldPrice}, 3, 3, ${maxPerOrder}, now(), now() + interval '1 hour')`;
      await expect(insert(500, 1)).rejects.toThrow(/sales_old_price_above_price/);
      await expect(insert(null, 4)).rejects.toThrow(/sales_max_per_order_within_total/);
      expect(await t.prisma.sale.count()).toBe(0);
    });
  });

  it('сбой планирования таймера после создания не превращается в 500: распродажа уже создана и показана', async () => {
    const config = t.app.get(AppConfig) as { workersEnabled: boolean };
    const scheduler = t.app.get(SaleScheduler);
    const original = scheduler.planUpcoming.bind(scheduler);
    config.workersEnabled = true;
    scheduler.planUpcoming = async () => {
      throw new Error('boom');
    };
    try {
      const shop = await loginShop(t);
      const res = await t
        .http()
        .post('/api/shop/sales')
        .set('Authorization', `Bearer ${shop}`)
        .send({ title: 'Таймер упал', priceCents: 100_00, totalQty: 2, startsInSeconds: 60, durationSeconds: 600 });
      expect(res.status).toBe(201);
      expect(await t.prisma.sale.count()).toBe(1);
    } finally {
      config.workersEnabled = false;
      scheduler.planUpcoming = original;
    }
  });

  it('витрина: статус считается по часам БД, идущие — первыми', async () => {
    const upcoming = await createSale(t.prisma, { startsIn: 120, endsIn: 600 });
    const live = await createSale(t.prisma, { startsIn: -10, endsIn: 600 });
    const ended = await createSale(t.prisma, { startsIn: -600, endsIn: -1 });

    const res = await t.http().get('/api/sales').expect(200);
    expect(res.body.serverTime).toBeDefined();
    expect(res.body.sales.map((s: { id: string; status: string }) => [s.id, s.status])).toEqual([
      [live, 'LIVE'],
      [upcoming, 'UPCOMING'],
      [ended, 'ENDED'],
    ]);
  });

  it('несуществующая распродажа → 404', async () => {
    const res = await t.http().get('/api/sales/00000000-0000-0000-0000-000000000000').expect(404);
    expect(res.body.error).toBe('sale_not_found');
  });
});
