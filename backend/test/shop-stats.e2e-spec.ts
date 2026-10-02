import type { Socket } from 'socket.io-client';
import { createTestApp, loginBuyer, loginShop, resetDb, type TestApp } from './support/app.js';
import { createSale } from './support/fixtures.js';
import { checkout, waitForOrder } from './support/payments.js';
import { connectSocket, waitForEvent } from './support/sockets.js';

type Stats = {
  id: string;
  available: number;
  inCarts: number;
  awaitingPayment: number;
  sold: number;
  withdrawn: number;
  revenueCents: number;
  ordersPaid: number;
  ordersPending: number;
};

/** «Экран магазина: остатки, продано, в корзинах, выручка» — и обновляется вживую. */
describe('экран магазина', () => {
  let t: TestApp;
  const sockets: Socket[] = [];

  beforeAll(async () => {
    t = await createTestApp();
  });
  beforeEach(() => resetDb(t.prisma));
  afterEach(() => {
    for (const s of sockets.splice(0)) s.disconnect();
  });
  afterAll(() => t.close());

  it('считает остаток, корзины, ожидающие оплаты, продано и выручку', async () => {
    const saleId = await createSale(t.prisma, { totalQty: 5, priceCents: 1500_00, maxPerOrder: 2 });
    const [a, b, c] = await Promise.all(['a', 'b', 'c'].map((n) => loginBuyer(t, `${n}@example.com`)));
    const reserve = (token: string, quantity: number) =>
      t.http().post('/api/reservations').set('Authorization', `Bearer ${token}`).send({ saleId, quantity }).expect(201);

    await reserve(a.token, 1); // в корзине
    const rb = await reserve(b.token, 1); // начнёт оплату и «зависнет»
    const rc = await reserve(c.token, 2); // купит две
    await checkout(t, b.token, rb.body.reservation.id, 'HANG').expect(201);
    const oc = await checkout(t, c.token, rc.body.reservation.id, 'SUCCESS').expect(201);
    await waitForOrder(t, oc.body.order.id, (o) => o.status === 'PAID');

    const shop = await loginShop(t);
    const res = await t.http().get('/api/shop/stats').set('Authorization', `Bearer ${shop}`).expect(200);
    const stats = res.body.sales.find((s: Stats) => s.id === saleId) as Stats;
    expect(stats).toMatchObject({
      available: 1,
      inCarts: 1,
      awaitingPayment: 1,
      sold: 2,
      withdrawn: 0,
      revenueCents: 2 * 1500_00,
      ordersPaid: 1,
      ordersPending: 1,
    });
  });

  it('покупателю экран магазина недоступен', async () => {
    const { token } = await loginBuyer(t, 'nosy@example.com');
    await t.http().get('/api/shop/stats').set('Authorization', `Bearer ${token}`).expect(403);
  });

  it('обновляется вживую: изменение в корзине → shop:stats в сокет магазина', async () => {
    const saleId = await createSale(t.prisma, { totalQty: 3 });
    const shopTab = await connectSocket(t.baseUrl, await loginShop(t));
    sockets.push(shopTab);
    const { token } = await loginBuyer(t, 'live@example.com');

    const pushed = waitForEvent<{ sales: Stats[] }>(shopTab, 'shop:stats', (e) =>
      e.sales.some((s) => s.id === saleId && s.inCarts === 1),
    );
    await t.http().post('/api/reservations').set('Authorization', `Bearer ${token}`).send({ saleId, quantity: 1 }).expect(201);
    const e = await pushed;
    expect(e.sales.find((s) => s.id === saleId)).toMatchObject({ available: 2, inCarts: 1 });
  });
});
