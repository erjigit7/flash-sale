import { createTestApp, loginBuyer, resetDb, type TestApp } from './support/app.js';
import { createSale, saleRow, setSaleWindow } from './support/fixtures.js';

/**
 * «До старта купить нельзя, даже если страница открыта заранее».
 * Проверка — в атомарном SQL по часам БД, поэтому запрос «в обход» кнопки тоже отклоняется.
 */
describe('окно распродажи по часам сервера', () => {
  let t: TestApp;
  let token: string;

  beforeAll(async () => {
    t = await createTestApp();
  });
  beforeEach(async () => {
    await resetDb(t.prisma);
    token = (await loginBuyer(t, 'early@example.com')).token;
  });
  afterAll(() => t.close());

  const reserve = (saleId: string) =>
    t.http().post('/api/reservations').set('Authorization', `Bearer ${token}`).send({ saleId, quantity: 1 });

  it('до старта → 409 not_started, остаток не тронут; в момент старта — покупка открывается', async () => {
    const saleId = await createSale(t.prisma, { totalQty: 3, startsIn: 30, endsIn: 600 });

    const early = await reserve(saleId).expect(409);
    expect(early.body.error).toBe('not_started');
    expect(early.body.startsAt).toBeDefined();
    expect((await saleRow(t.prisma, saleId)).available).toBe(3);

    // «наступил старт»: двигаем окно так, что now() БД уже внутри него
    await setSaleWindow(t.prisma, saleId, 0, 600);
    await reserve(saleId).expect(201);
    expect((await saleRow(t.prisma, saleId)).available).toBe(2);
  });

  it('после окончания → 409 sale_ended', async () => {
    const saleId = await createSale(t.prisma, { totalQty: 3, startsIn: -600, endsIn: -1 });
    const res = await reserve(saleId).expect(409);
    expect(res.body.error).toBe('sale_ended');
    expect((await saleRow(t.prisma, saleId)).available).toBe(3);
  });

  it('несуществующая распродажа → 404', async () => {
    const res = await reserve('00000000-0000-0000-0000-000000000000').expect(404);
    expect(res.body.error).toBe('sale_not_found');
  });

  it('магазин не может покупать (роль BUYER)', async () => {
    const saleId = await createSale(t.prisma);
    const shop = await t.http().post('/api/auth/shop-login').send({ password: 'shop' });
    await t
      .http()
      .post('/api/reservations')
      .set('Authorization', `Bearer ${shop.body.token}`)
      .send({ saleId, quantity: 1 })
      .expect(403);
  });
});
