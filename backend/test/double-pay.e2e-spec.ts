import { randomUUID } from 'node:crypto';
import { OrdersService } from '../src/orders/orders.service.js';
import { createTestApp, loginBuyer, resetDb, type TestApp } from './support/app.js';
import { createSale } from './support/fixtures.js';
import { expectStockInvariant } from './support/invariant.js';
import { checkout, stubPaymentsFor, waitForOrder } from './support/payments.js';

/** «Двойное нажатие „оплатить“ не создаёт двух заказов и не списывает дважды». */
describe('двойная оплата', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });
  beforeEach(() => resetDb(t.prisma));
  afterAll(() => t.close());

  async function heldItem(qty = 1) {
    const saleId = await createSale(t.prisma, { totalQty: 5, maxPerOrder: 2 });
    const buyer = await loginBuyer(t, 'payer@example.com');
    const res = await t
      .http()
      .post('/api/reservations')
      .set('Authorization', `Bearer ${buyer.token}`)
      .send({ saleId, quantity: qty })
      .expect(201);
    return { saleId, token: buyer.token, reservationId: res.body.reservation.id as string };
  }

  it('20 одновременных «оплатить» с одним ключом → один заказ, все ответы с одним id, один платёж у провайдера', async () => {
    const { saleId, token, reservationId } = await heldItem(2);
    const key = randomUUID();

    const responses = await Promise.all(Array.from({ length: 20 }, () => checkout(t, token, reservationId, 'SUCCESS', key)));

    expect(responses.every((r) => r.status === 201 || r.status === 200)).toBe(true);
    expect(responses.filter((r) => r.status === 201)).toHaveLength(1);
    const ids = new Set(responses.map((r) => r.body.order.id));
    expect(ids.size).toBe(1);
    const [orderId] = [...ids];
    expect(await t.prisma.order.count()).toBe(1);

    const order = await waitForOrder(t, orderId, (o) => o.status === 'PAID');
    expect(order.amountCents).toBe(2 * 1000_00);
    const payments = await stubPaymentsFor(orderId);
    expect(payments).toHaveLength(1);
    expect(payments[0].amountCents).toBe(2 * 1000_00);
    await expectStockInvariant(t.prisma, saleId);
  });

  it('разные ключи на одну позицию (две вкладки) → всё равно один заказ', async () => {
    const { token, reservationId } = await heldItem();

    const responses = await Promise.all(
      Array.from({ length: 10 }, () => checkout(t, token, reservationId, 'HANG', randomUUID())),
    );

    expect(responses.filter((r) => r.status === 201)).toHaveLength(1);
    expect(new Set(responses.map((r) => r.body.order.id)).size).toBe(1);
    expect(await t.prisma.order.count()).toBe(1);
  });

  it('повторная отправка в платёжку (воркер после сбоя) не создаёт второго платежа', async () => {
    const { token, reservationId } = await heldItem();
    const res = await checkout(t, token, reservationId, 'HANG').expect(201);
    const orderId = res.body.order.id as string;
    await waitForOrder(t, orderId, (o) => o.providerPaymentId !== null);

    // имитируем «ответ провайдера потерялся»: id платежа не сохранился, заказ снова в очереди на отправку
    await t.prisma.$executeRaw`UPDATE orders SET provider_payment_id = NULL, next_attempt_at = now() WHERE id = ${orderId}::uuid`;
    await t.app.get(OrdersService).dispatch();

    const payments = await stubPaymentsFor(orderId);
    expect(payments).toHaveLength(1);
    expect((await waitForOrder(t, orderId, (o) => o.providerPaymentId !== null)).providerPaymentId).toBe(payments[0].id);
  });

  it('тот же ключ для другой позиции → 422, второй заказ не создаётся', async () => {
    const saleA = await createSale(t.prisma, { totalQty: 3 });
    const saleB = await createSale(t.prisma, { totalQty: 3 });
    const { token } = await loginBuyer(t, 'payer@example.com');
    const auth = { Authorization: `Bearer ${token}` };
    const a = await t.http().post('/api/reservations').set(auth).send({ saleId: saleA, quantity: 1 }).expect(201);
    const b = await t.http().post('/api/reservations').set(auth).send({ saleId: saleB, quantity: 1 }).expect(201);
    const key = randomUUID();

    await checkout(t, token, a.body.reservation.id, 'HANG', key).expect(201);
    const reused = await checkout(t, token, b.body.reservation.id, 'HANG', key).expect(422);
    expect(reused.body.error).toBe('idempotency_key_reused');
    expect(await t.prisma.order.count()).toBe(1);
    // позиция B осталась в корзине — переход в CHECKOUT откатился вместе с отказом
    const resB = await t.prisma.reservation.findUniqueOrThrow({ where: { id: b.body.reservation.id } });
    expect(resB.status).toBe('ACTIVE');
  });

  it('без Idempotency-Key → 400', async () => {
    const { token, reservationId } = await heldItem();
    const res = await t
      .http()
      .post('/api/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({ reservationId, scenario: 'SUCCESS' })
      .expect(400);
    expect(res.body.error).toBe('idempotency_key_required');
  });
});
