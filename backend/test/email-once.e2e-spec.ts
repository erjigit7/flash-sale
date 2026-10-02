import { MailService } from '../src/mail/mail.service.js';
import { createTestApp, loginBuyer, resetDb, type TestApp } from './support/app.js';
import { createSale } from './support/fixtures.js';
import { mailsTo, uniqueEmail } from './support/mailpit.js';
import { checkout, signedWebhook, waitForOrder, waitUntil } from './support/payments.js';

/**
 * «Покупатель получает письмо о заказе. Одно.»
 * Проверяем не только outbox, но и то, что реально дошло до почтового сервера (Mailpit API).
 */
describe('письмо о заказе — ровно одно', () => {
  let t: TestApp;
  let mail: MailService;

  beforeAll(async () => {
    t = await createTestApp();
    mail = t.app.get(MailService);
  });
  beforeEach(() => resetDb(t.prisma));
  afterAll(() => t.close());

  async function pendingOrderFor(email: string, scenario: 'SUCCESS' | 'HANG' = 'HANG') {
    const saleId = await createSale(t.prisma, { totalQty: 3 });
    const { token } = await loginBuyer(t, email);
    const held = await t
      .http()
      .post('/api/reservations')
      .set('Authorization', `Bearer ${token}`)
      .send({ saleId, quantity: 1 })
      .expect(201);
    const res = await checkout(t, token, held.body.reservation.id, scenario).expect(201);
    return waitForOrder(t, res.body.order.id, (o) => o.providerPaymentId !== null);
  }

  it('оплата прошла → одно письмо; повторные webhook и параллельные отправители не дублируют', async () => {
    const email = uniqueEmail('paid');
    const order = await pendingOrderFor(email);
    const body = { paymentId: order.providerPaymentId, idempotencyKey: order.id, status: 'succeeded' };

    // провайдер доставляет результат несколько раз, в том числе одновременно
    await Promise.all(Array.from({ length: 10 }, () => signedWebhook(t, body)));
    expect(await t.prisma.emailOutbox.count({ where: { toEmail: email } })).toBe(1);

    // пять «инстансов» отправителя одновременно, потом ещё раз
    await Promise.all(Array.from({ length: 5 }, () => mail.sendDue()));
    await mail.sendDue();

    const outbox = await t.prisma.emailOutbox.findFirstOrThrow({ where: { toEmail: email } });
    expect(outbox).toMatchObject({ status: 'SENT', attempts: 1, dedupKey: `order:${order.id}` });

    const delivered = await waitUntil(() => mailsTo(email), (m) => m.length >= 1);
    // небольшая пауза: если бы ушёл дубль, он бы успел дойти
    await new Promise((r) => setTimeout(r, 300));
    const final = await mailsTo(email);
    expect(final).toHaveLength(1);
    expect(delivered[0].Subject).toContain('оплачен');
    expect(final[0].MessageID).toBe(`order.${order.id}@flash-sale.local`);
  });

  it('оплата отклонена → тоже ровно одно письмо (об отказе)', async () => {
    const email = uniqueEmail('declined');
    const order = await pendingOrderFor(email);
    await signedWebhook(t, { paymentId: order.providerPaymentId, idempotencyKey: order.id, status: 'declined' }).expect(200);
    await signedWebhook(t, { paymentId: order.providerPaymentId, idempotencyKey: order.id, status: 'declined' }).expect(200);
    await mail.sendDue();
    await mail.sendDue();

    const delivered = await waitUntil(() => mailsTo(email), (m) => m.length >= 1);
    await new Promise((r) => setTimeout(r, 300));
    expect(await mailsTo(email)).toHaveLength(1);
    expect(delivered[0].Subject).toContain('не прошла');
  });

  it('полный путь через заглушку (SUCCESS, webhook от провайдера) → одно письмо', async () => {
    const email = uniqueEmail('e2e');
    const order = await pendingOrderFor(email, 'SUCCESS');
    await waitForOrder(t, order.id, (o) => o.status === 'PAID');
    await mail.sendDue();

    await waitUntil(() => mailsTo(email), (m) => m.length >= 1);
    await new Promise((r) => setTimeout(r, 300));
    expect(await mailsTo(email)).toHaveLength(1);
  });

  it('заказ ещё в ожидании (платёжка «висит») → писем нет', async () => {
    const email = uniqueEmail('pending');
    await pendingOrderFor(email);
    await mail.sendDue();
    expect(await t.prisma.emailOutbox.count({ where: { toEmail: email } })).toBe(0);
    expect(await mailsTo(email)).toHaveLength(0);
  });
});
