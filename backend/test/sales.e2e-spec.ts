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
