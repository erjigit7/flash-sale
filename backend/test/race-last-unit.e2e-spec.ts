import { createTestApp, loginBuyer, resetDb, type TestApp } from './support/app.js';
import { createSale, saleRow } from './support/fixtures.js';
import { expectStockInvariant } from './support/invariant.js';

/**
 * «Последнюю единицу двум покупателям одновременно не продать: одному товар, второму „закончилось“».
 * Запросы летят параллельно через настоящий HTTP-стек в реальный Postgres.
 */
describe('гонка за остаток', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });
  beforeEach(() => resetDb(t.prisma));
  afterAll(() => t.close());

  async function buyers(n: number) {
    return Promise.all(Array.from({ length: n }, (_, i) => loginBuyer(t, `buyer${i}@example.com`)));
  }

  function reserve(token: string, saleId: string, quantity = 1) {
    return t.http().post('/api/reservations').set('Authorization', `Bearer ${token}`).send({ saleId, quantity });
  }

  it('1 единица, 50 покупателей одновременно → ровно один получает товар, 49 — «закончилось»', async () => {
    const saleId = await createSale(t.prisma, { totalQty: 1 });
    const users = await buyers(50);

    const responses = await Promise.all(users.map((u) => reserve(u.token, saleId)));

    const won = responses.filter((r) => r.status === 201);
    const lost = responses.filter((r) => r.status === 409);
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(49);
    expect(lost.every((r) => r.body.error === 'sold_out')).toBe(true);

    expect((await saleRow(t.prisma, saleId)).available).toBe(0);
    expect(await t.prisma.reservation.count({ where: { saleId } })).toBe(1);
    await expectStockInvariant(t.prisma, saleId);
  });

  it('10 единиц, 100 покупателей одновременно → ровно 10 позиций, остаток 0', async () => {
    const saleId = await createSale(t.prisma, { totalQty: 10 });
    const users = await buyers(100);

    const responses = await Promise.all(users.map((u) => reserve(u.token, saleId)));

    expect(responses.filter((r) => r.status === 201)).toHaveLength(10);
    expect(responses.filter((r) => r.status === 409 && r.body.error === 'sold_out')).toHaveLength(90);
    expect((await saleRow(t.prisma, saleId)).available).toBe(0);
    await expectStockInvariant(t.prisma, saleId);
  });

  it('просят 3, осталось 2 → отказ целиком, без частичной продажи; клиенту сообщают остаток', async () => {
    const saleId = await createSale(t.prisma, { totalQty: 2, maxPerOrder: 3 });
    const [u] = await buyers(1);

    const res = await reserve(u.token, saleId, 3).expect(409);
    expect(res.body).toMatchObject({ error: 'insufficient_stock', available: 2 });
    expect((await saleRow(t.prisma, saleId)).available).toBe(2);

    await reserve(u.token, saleId, 2).expect(201);
    expect((await saleRow(t.prisma, saleId)).available).toBe(0);
  });

  it('больше лимита «в одни руки» → 400 qty_over_limit, остаток не тронут', async () => {
    const saleId = await createSale(t.prisma, { totalQty: 10, maxPerOrder: 2 });
    const [u] = await buyers(1);
    const res = await reserve(u.token, saleId, 3).expect(400);
    expect(res.body).toMatchObject({ error: 'qty_over_limit', maxPerOrder: 2 });
    expect((await saleRow(t.prisma, saleId)).available).toBe(10);
  });

  it('один покупатель жмёт «в корзину» 10 раз параллельно → одна позиция, списано один раз', async () => {
    const saleId = await createSale(t.prisma, { totalQty: 5 });
    const [u] = await buyers(1);

    const responses = await Promise.all(Array.from({ length: 10 }, () => reserve(u.token, saleId)));

    expect(responses.filter((r) => r.status === 201)).toHaveLength(1);
    const dup = responses.filter((r) => r.status === 409);
    expect(dup).toHaveLength(9);
    expect(dup.every((r) => r.body.error === 'already_in_cart')).toBe(true);
    expect((await saleRow(t.prisma, saleId)).available).toBe(4);
    await expectStockInvariant(t.prisma, saleId);
  });
});
