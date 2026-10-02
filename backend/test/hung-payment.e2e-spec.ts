import { OrdersService } from '../src/orders/orders.service.js';
import { ReservationsService } from '../src/reservations/reservations.service.js';
import { createTestApp, loginBuyer, resetDb, type TestApp } from './support/app.js';
import { createSale, saleRow } from './support/fixtures.js';
import { expectStockInvariant } from './support/invariant.js';
import { checkout, resolveStub, signedWebhook, waitForOrder } from './support/payments.js';

/**
 * «Заглушка „зависла“ — заказ в состоянии ожидания, товар не возвращается на витрину и не продаётся дважды.
 *  Когда заглушка ответила, заказ досчитывается.»
 * «Оплата, начатая до истечения удержания, завершается, даже если заглушка ответила после.»
 */
describe('зависшая оплата и оплата после истечения удержания', () => {
  let t: TestApp;
  let reservations: ReservationsService;
  let orders: OrdersService;

  beforeAll(async () => {
    t = await createTestApp();
    reservations = t.app.get(ReservationsService);
    orders = t.app.get(OrdersService);
  });
  beforeEach(() => resetDb(t.prisma));
  afterAll(() => t.close());

  async function setup() {
    const saleId = await createSale(t.prisma, { totalQty: 1 });
    const alice = await loginBuyer(t, 'alice@example.com');
    const bob = await loginBuyer(t, 'bob@example.com');
    const held = await t
      .http()
      .post('/api/reservations')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ saleId, quantity: 1 })
      .expect(201);
    return { saleId, alice, bob, reservationId: held.body.reservation.id as string };
  }

  const expireAllHolds = () =>
    t.prisma.$executeRaw`UPDATE reservations SET expires_at = now() - interval '1 minute'`;

  it('HANG → заказ ждёт, товар держится даже после истечения удержания, второму не продаётся; ответ «успех» → досчитан', async () => {
    const { saleId, alice, bob, reservationId } = await setup();
    const res = await checkout(t, alice.token, reservationId, 'HANG').expect(201);
    const orderId = res.body.order.id as string;
    const pending = await waitForOrder(t, orderId, (o) => o.providerPaymentId !== null);
    expect(pending.status).toBe('PENDING');

    // 10 минут прошли, платёжка молчит: expirer НЕ возвращает товар — оплата уже начата
    await expireAllHolds();
    const expired = await reservations.expireDue();
    expect(expired.reservations).toHaveLength(0);
    expect((await saleRow(t.prisma, saleId)).available).toBe(0);
    expect((await t.prisma.reservation.findUniqueOrThrow({ where: { id: reservationId } })).status).toBe('CHECKOUT');

    // второй покупатель не может купить ту же единицу
    const second = await t
      .http()
      .post('/api/reservations')
      .set('Authorization', `Bearer ${bob.token}`)
      .send({ saleId, quantity: 1 })
      .expect(409);
    expect(second.body.error).toBe('sold_out');

    // заглушка «отвисла» и ответила — уже после истечения удержания
    await resolveStub(pending.providerPaymentId!, 'succeeded');
    const paid = await waitForOrder(t, orderId, (o) => o.status !== 'PENDING');
    expect(paid.status).toBe('PAID');
    expect((await t.prisma.reservation.findUniqueOrThrow({ where: { id: reservationId } })).status).toBe('PURCHASED');
    expect((await saleRow(t.prisma, saleId)).available).toBe(0);
    const b = await expectStockInvariant(t.prisma, saleId);
    expect(b.purchased).toBe(1);
  });

  it('HANG → ответ «отклонено» после истечения → товар возвращается на витрину и достаётся другому', async () => {
    const { saleId, alice, bob, reservationId } = await setup();
    const res = await checkout(t, alice.token, reservationId, 'HANG').expect(201);
    const pending = await waitForOrder(t, res.body.order.id, (o) => o.providerPaymentId !== null);
    await expireAllHolds();
    await reservations.expireDue();

    await resolveStub(pending.providerPaymentId!, 'declined');
    const failed = await waitForOrder(t, pending.id, (o) => o.status !== 'PENDING');
    expect(failed.status).toBe('FAILED');
    expect((await saleRow(t.prisma, saleId)).available).toBe(1);

    await t
      .http()
      .post('/api/reservations')
      .set('Authorization', `Bearer ${bob.token}`)
      .send({ saleId, quantity: 1 })
      .expect(201);
    await expectStockInvariant(t.prisma, saleId);
  });

  it('webhook так и не дошёл → reconciler сам опрашивает платёжку и досчитывает заказ', async () => {
    const { saleId, alice, reservationId } = await setup();
    const res = await checkout(t, alice.token, reservationId, 'HANG').expect(201);
    const orderId = res.body.order.id as string;
    await waitForOrder(t, orderId, (o) => o.providerPaymentId !== null);

    // Платёж у провайдера, webhook которого доставить невозможно (callback в никуда) —
    // так выглядит «потерянный webhook». Привязываем его к заказу.
    const lost = await createStubPayment(`lost-${orderId}`, res.body.order.amountCents, 'http://127.0.0.1:9/nowhere');
    await resolveStub(lost, 'succeeded');
    await t.prisma.$executeRaw`
      UPDATE orders SET provider_payment_id = ${lost}, next_attempt_at = now() WHERE id = ${orderId}::uuid`;
    expect((await waitForOrder(t, orderId, () => true)).status).toBe('PENDING');

    const resolved = await orders.reconcile();
    expect(resolved).toBe(1);
    expect((await waitForOrder(t, orderId, () => true)).status).toBe('PAID');
    expect((await saleRow(t.prisma, saleId)).available).toBe(0);

    // повторный проход reconciler и запоздалый webhook ничего не меняют
    await t.prisma.$executeRaw`UPDATE orders SET next_attempt_at = now() WHERE id = ${orderId}::uuid`;
    expect(await orders.reconcile()).toBe(0);
    const late = await signedWebhook(t, { paymentId: lost, idempotencyKey: orderId, status: 'declined' }).expect(200);
    expect(late.body.applied).toBe(false);
    expect((await waitForOrder(t, orderId, () => true)).status).toBe('PAID');
    await expectStockInvariant(t.prisma, saleId);
  });

  it('«оплатить» после истечения удержания → 410, заказ не создаётся, товар возвращается', async () => {
    const { saleId, alice, reservationId } = await setup();
    await expireAllHolds();
    const res = await checkout(t, alice.token, reservationId, 'SUCCESS').expect(410);
    expect(res.body.error).toBe('hold_expired');
    expect(await t.prisma.order.count()).toBe(0);
    await reservations.expireDue();
    expect((await saleRow(t.prisma, saleId)).available).toBe(1);
  });

  it('гонка «оплатить» против истечения на самой границе: побеждает ровно один, товар не теряется и не задваивается', async () => {
    const outcomes = { paid: 0, expired: 0 };
    for (let round = 0; round < 20; round++) {
      await resetDb(t.prisma);
      const { saleId, alice, reservationId } = await setup();
      // граница удержания через ~30 мс; запросы летят около неё
      await t.prisma.$executeRaw`UPDATE reservations SET expires_at = now() + interval '30 milliseconds'`;
      await sleep(20 + Math.random() * 20);
      const [pay] = await Promise.all([
        checkout(t, alice.token, reservationId, 'HANG'),
        sleep(Math.random() * 10).then(() => reservations.expireDue()),
      ]);
      await sleep(40);
      await reservations.expireDue();

      const r = await t.prisma.reservation.findUniqueOrThrow({ where: { id: reservationId } });
      const b = await expectStockInvariant(t.prisma, saleId);
      if (pay.status === 201) {
        outcomes.paid++;
        expect(r.status).toBe('CHECKOUT');
        expect(b.available).toBe(0);
        expect(await t.prisma.order.count()).toBe(1);
      } else {
        outcomes.expired++;
        expect(pay.status).toBe(410);
        expect(r.status).toBe('EXPIRED');
        expect(b.available).toBe(1);
        expect(await t.prisma.order.count()).toBe(0);
      }
    }
    // для журнала: сколько раз выиграла каждая сторона
    console.log(`race outcomes over 20 rounds: ${JSON.stringify(outcomes)}`);
  });
});

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function createStubPayment(idempotencyKey: string, amountCents: number, callbackUrl: string): Promise<string> {
  const res = await fetch(`${process.env.PAYMENT_STUB_URL}/payments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ idempotencyKey, amountCents, scenario: 'HANG', callbackUrl }),
  });
  return ((await res.json()) as { paymentId: string }).paymentId;
}
