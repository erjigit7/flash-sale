import { ReservationsService } from '../src/reservations/reservations.service.js';
import { DomainEvents, type DomainEventMap } from '../src/events/domain-events.js';
import { createTestApp, loginBuyer, resetDb, type TestApp } from './support/app.js';
import { createSale, saleRow } from './support/fixtures.js';
import { expectStockInvariant } from './support/invariant.js';

/**
 * «Товар в корзине удерживается 10 минут. Не оплатил — вернулся на витрину, и остальные видят это сразу».
 * Время не ждём: сдвигаем expires_at в прошлое по часам БД и запускаем шаг воркера напрямую.
 */
describe('удержание товара в корзине', () => {
  let t: TestApp;
  let reservations: ReservationsService;
  let events: DomainEvents;

  beforeAll(async () => {
    t = await createTestApp();
    reservations = t.app.get(ReservationsService);
    events = t.app.get(DomainEvents);
  });
  beforeEach(() => resetDb(t.prisma));
  afterAll(() => t.close());

  const reserve = (token: string, saleId: string) =>
    t.http().post('/api/reservations').set('Authorization', `Bearer ${token}`).send({ saleId, quantity: 1 });

  const expireNow = (reservationId: string) =>
    t.prisma.$executeRaw`UPDATE reservations SET expires_at = now() - interval '1 second' WHERE id = ${reservationId}::uuid`;

  it('удержание ставится на HOLD_TTL_SECONDS (по умолчанию 10 минут) по часам БД', async () => {
    const saleId = await createSale(t.prisma);
    const { token } = await loginBuyer(t, 'a@example.com');
    const res = await reserve(token, saleId).expect(201);

    const [{ ttl }] = await t.prisma.$queryRaw<{ ttl: number }[]>`
      SELECT EXTRACT(EPOCH FROM (expires_at - created_at))::float AS ttl FROM reservations WHERE id = ${res.body.reservation.id}::uuid`;
    expect(ttl).toBeCloseTo(600, 0);
  });

  it('до истечения — товар держится; после — возвращается на витрину и достаётся другому', async () => {
    const saleId = await createSale(t.prisma, { totalQty: 1 });
    const alice = await loginBuyer(t, 'alice@example.com');
    const bob = await loginBuyer(t, 'bob@example.com');

    const held = await reserve(alice.token, saleId).expect(201);
    expect((await reserve(bob.token, saleId).expect(409)).body.error).toBe('sold_out');

    // ещё не истекло — воркер ничего не трогает
    await reservations.expireDue();
    expect((await saleRow(t.prisma, saleId)).available).toBe(0);

    const stockEvents: DomainEventMap['stock.changed'][] = [];
    const off = events.on('stock.changed', (e) => stockEvents.push(e));
    await expireNow(held.body.reservation.id);
    const result = await reservations.expireDue();
    off();

    expect(result.reservations).toHaveLength(1);
    expect((await saleRow(t.prisma, saleId)).available).toBe(1);
    // событие для витрины опубликовано сразу после commit, с новой версией остатка
    expect(stockEvents).toEqual([{ saleId, available: 1, version: held.body.sale.version + 1 }]);

    const status = await t.prisma.reservation.findUniqueOrThrow({ where: { id: held.body.reservation.id } });
    expect(status.status).toBe('EXPIRED');

    await reserve(bob.token, saleId).expect(201);
    await expectStockInvariant(t.prisma, saleId);
  });

  it('повторный запуск воркера не возвращает товар дважды', async () => {
    const saleId = await createSale(t.prisma, { totalQty: 2 });
    const { token } = await loginBuyer(t, 'a@example.com');
    const held = await reserve(token, saleId).expect(201);
    await expireNow(held.body.reservation.id);

    const results = await Promise.all([reservations.expireDue(), reservations.expireDue(), reservations.expireDue()]);
    expect(results.reduce((n, r) => n + r.reservations.length, 0)).toBe(1);
    expect((await saleRow(t.prisma, saleId)).available).toBe(2);
    await expectStockInvariant(t.prisma, saleId);
  });

  it('покупатель сам убирает позицию → товар сразу на витрине; повторно убрать нельзя', async () => {
    const saleId = await createSale(t.prisma, { totalQty: 1 });
    const { token } = await loginBuyer(t, 'a@example.com');
    const held = await reserve(token, saleId).expect(201);
    const auth = { Authorization: `Bearer ${token}` };

    await t.http().delete(`/api/reservations/${held.body.reservation.id}`).set(auth).expect(204);
    expect((await saleRow(t.prisma, saleId)).available).toBe(1);
    const again = await t.http().delete(`/api/reservations/${held.body.reservation.id}`).set(auth).expect(409);
    expect(again.body.error).toBe('not_releasable');
    await expectStockInvariant(t.prisma, saleId);
  });

  it('чужую позицию убрать нельзя', async () => {
    const saleId = await createSale(t.prisma, { totalQty: 1 });
    const alice = await loginBuyer(t, 'alice@example.com');
    const bob = await loginBuyer(t, 'bob@example.com');
    const held = await reserve(alice.token, saleId).expect(201);

    await t
      .http()
      .delete(`/api/reservations/${held.body.reservation.id}`)
      .set('Authorization', `Bearer ${bob.token}`)
      .expect(409);
    expect((await saleRow(t.prisma, saleId)).available).toBe(0);
  });

  it('корзина показывает позицию с серверным временем истечения', async () => {
    const saleId = await createSale(t.prisma);
    const { token } = await loginBuyer(t, 'a@example.com');
    await reserve(token, saleId).expect(201);

    const cart = await t.http().get('/api/reservations').set('Authorization', `Bearer ${token}`).expect(200);
    expect(cart.body.serverTime).toBeDefined();
    expect(cart.body.items).toHaveLength(1);
    expect(cart.body.items[0]).toMatchObject({ saleId, status: 'ACTIVE', quantity: 1 });
  });
});
