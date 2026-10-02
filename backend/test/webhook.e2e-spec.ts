import { createTestApp, loginBuyer, resetDb, type TestApp } from './support/app.js';
import { createSale, saleRow } from './support/fixtures.js';
import { expectStockInvariant } from './support/invariant.js';
import { checkout, redeliverStub, signedWebhook, waitForOrder, waitUntil, stubPaymentsFor } from './support/payments.js';

/** Webhook провайдера: подпись и идемпотентность при повторной (at-least-once) доставке. */
describe('webhook оплаты', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });
  beforeEach(() => resetDb(t.prisma));
  afterAll(() => t.close());

  async function pendingOrder() {
    const saleId = await createSale(t.prisma, { totalQty: 2 });
    const { token } = await loginBuyer(t, 'hook@example.com');
    const held = await t
      .http()
      .post('/api/reservations')
      .set('Authorization', `Bearer ${token}`)
      .send({ saleId, quantity: 1 })
      .expect(201);
    const res = await checkout(t, token, held.body.reservation.id, 'HANG').expect(201);
    const order = await waitForOrder(t, res.body.order.id, (o) => o.providerPaymentId !== null);
    return { saleId, order };
  }

  it('без подписи или с чужой подписью → 401, заказ не меняется', async () => {
    const { order } = await pendingOrder();
    const body = { paymentId: order.providerPaymentId, idempotencyKey: order.id, status: 'succeeded' };

    await t.http().post('/api/payments/webhook').send(body).expect(401);
    await signedWebhook(t, body, 'wrong-secret').expect(401);
    expect((await waitForOrder(t, order.id, () => true)).status).toBe('PENDING');
  });

  it('10 одинаковых webhook одновременно → результат применён ровно один раз', async () => {
    const { saleId, order } = await pendingOrder();
    const body = { paymentId: order.providerPaymentId, idempotencyKey: order.id, status: 'declined' };

    const responses = await Promise.all(Array.from({ length: 10 }, () => signedWebhook(t, body)));

    expect(responses.every((r) => r.status === 200)).toBe(true);
    expect(responses.filter((r) => r.body.applied === true)).toHaveLength(1);
    expect((await waitForOrder(t, order.id, () => true)).status).toBe('FAILED');
    // товар вернулся один раз, а не десять
    expect((await saleRow(t.prisma, saleId)).available).toBe(2);
    await expectStockInvariant(t.prisma, saleId);
  });

  it('противоречивый повтор (сначала succeeded, потом declined) не переписывает итог', async () => {
    const { saleId, order } = await pendingOrder();
    await signedWebhook(t, { paymentId: order.providerPaymentId, idempotencyKey: order.id, status: 'succeeded' }).expect(200);
    const late = await signedWebhook(t, { paymentId: order.providerPaymentId, idempotencyKey: order.id, status: 'declined' }).expect(200);
    expect(late.body.applied).toBe(false);
    expect((await waitForOrder(t, order.id, () => true)).status).toBe('PAID');
    expect((await saleRow(t.prisma, saleId)).available).toBe(1);
  });

  it('настоящая повторная доставка от заглушки (redeliver) — без последствий', async () => {
    const saleId = await createSale(t.prisma, { totalQty: 2 });
    const { token } = await loginBuyer(t, 'hook@example.com');
    const held = await t
      .http()
      .post('/api/reservations')
      .set('Authorization', `Bearer ${token}`)
      .send({ saleId, quantity: 1 })
      .expect(201);
    const res = await checkout(t, token, held.body.reservation.id, 'SUCCESS').expect(201);
    const paid = await waitForOrder(t, res.body.order.id, (o) => o.status === 'PAID');

    await redeliverStub(paid.providerPaymentId!);
    await waitUntil(
      () => stubPaymentsFor(paid.id),
      (p) => p[0]?.webhook.deliveries >= 2 && p[0]?.webhook.delivered,
    );
    expect((await waitForOrder(t, paid.id, () => true)).status).toBe('PAID');
    const b = await expectStockInvariant(t.prisma, saleId);
    expect(b.purchased).toBe(1);
  });
});
