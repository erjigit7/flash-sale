import { randomUUID } from 'node:crypto';
import { MailService } from '../src/mail/mail.service.js';
import { ReservationsService } from '../src/reservations/reservations.service.js';
import { SaleFinalizer } from '../src/sales/sale-finalizer.service.js';
import { createTestApp, loginBuyer, resetDb, type TestApp } from './support/app.js';
import { createSale, saleRow, setSaleWindow } from './support/fixtures.js';
import { stockBreakdown } from './support/invariant.js';
import { checkout, resolveStub, signedWebhook, stubPaymentsFor, waitUntil } from './support/payments.js';

/**
 * Хаос-тест: 30 покупателей одновременно и вперемешку кладут в корзину, убирают, платят
 * (успех / отказ / зависание), жмут «оплатить» дважды, получают дубли webhook, а удержания истекают.
 * В конце распродажа заканчивается. После всего проверяем, что учёт сошёлся до единицы.
 */
describe('хаос: инвариант учёта под случайной параллельной нагрузкой', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });
  beforeEach(() => resetDb(t.prisma));
  afterAll(() => t.close());

  it('ни одной лишней продажи, ни одной потерянной единицы, один заказ на позицию, одно письмо на заказ', async () => {
    const TOTAL = 12;
    const saleId = await createSale(t.prisma, { totalQty: TOTAL, maxPerOrder: 2 });
    const buyers = await Promise.all(Array.from({ length: 30 }, (_, i) => loginBuyer(t, `chaos${i}@example.com`)));
    const reservations = t.app.get(ReservationsService);
    const rnd = (n: number) => Math.floor(Math.random() * n);
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

    async function actor(token: string) {
      for (let step = 0; step < 4; step++) {
        await sleep(rnd(30));
        const res = await t
          .http()
          .post('/api/reservations')
          .set(auth(token))
          .send({ saleId, quantity: 1 + rnd(2) });
        if (res.status !== 201) continue;
        const reservationId = res.body.reservation.id as string;
        const action = rnd(4);
        if (action === 0) {
          await t.http().delete(`/api/reservations/${reservationId}`).set(auth(token));
        } else if (action === 1) {
          // «забыл оплатить»: удержание истекает
          await t.prisma.$executeRaw`UPDATE reservations SET expires_at = now() - interval '1 second' WHERE id = ${reservationId}::uuid`;
          await reservations.expireDue();
        } else {
          const scenario = (['SUCCESS', 'DECLINE', 'HANG'] as const)[rnd(3)];
          const key = randomUUID();
          // двойной клик: два одинаковых запроса одновременно
          await Promise.all([checkout(t, token, reservationId, scenario, key), checkout(t, token, reservationId, scenario, key)]);
        }
      }
    }

    // фоновый «шум»: expirer и дубли webhook во время нагрузки
    let running = true;
    const noise = (async () => {
      while (running) {
        await reservations.expireDue();
        const pending = await t.prisma.order.findMany({ where: { status: 'PENDING', providerPaymentId: { not: null } } });
        for (const o of pending.filter(() => Math.random() < 0.3)) {
          const body = { paymentId: o.providerPaymentId, idempotencyKey: o.id, status: Math.random() < 0.5 ? 'succeeded' : 'declined' };
          await Promise.all([signedWebhook(t, body), signedWebhook(t, body)]);
        }
        await sleep(20);
      }
    })();

    await Promise.all(buyers.map((b) => actor(b.token)));
    running = false;
    await noise;

    // распродажа заканчивается; висящие платежи потом «отвисают»
    await setSaleWindow(t.prisma, saleId, -3600, -1);
    await t.app.get(SaleFinalizer).finalizeEnded();
    await waitUntil(
      () => t.prisma.order.findMany({ where: { status: 'PENDING' } }),
      (orders) => orders.every((o) => o.providerPaymentId !== null),
    );
    for (const o of await t.prisma.order.findMany({ where: { status: 'PENDING', scenario: 'HANG' } })) {
      await resolveStub(o.providerPaymentId!, Math.random() < 0.5 ? 'succeeded' : 'declined').catch(() => undefined);
    }
    await waitUntil(() => t.prisma.order.count({ where: { status: 'PENDING' } }), (n) => n === 0, 15_000);
    await t.app.get(SaleFinalizer).finalizeEnded();
    await t.app.get(MailService).sendDue(500);

    // ---- проверки ----
    const b = await stockBreakdown(t.prisma, saleId);
    const sale = await saleRow(t.prisma, saleId);
    // 1. каждая единица ровно в одном месте; продано не больше партии
    expect(b.available + b.active + b.checkout + b.purchased + b.withdrawn).toBe(TOTAL);
    expect(b.purchased).toBeLessThanOrEqual(TOTAL);
    // 2. распродажа закончилась: на витрине и в корзинах пусто, в оплате никого
    expect({ available: sale.available, active: b.active, checkout: b.checkout }).toEqual({ available: 0, active: 0, checkout: 0 });

    // 3. заказы и позиции согласованы
    const orders = await t.prisma.order.findMany({ include: { reservation: true } });
    for (const o of orders) {
      if (o.status === 'PAID') expect(o.reservation.status).toBe('PURCHASED');
      if (o.status === 'FAILED') expect(o.reservation.status).toBe('RELEASED');
    }
    const purchasedQty = orders.filter((o) => o.status === 'PAID').reduce((n, o) => n + o.quantity, 0);
    expect(purchasedQty).toBe(b.purchased);
    // 4. один заказ на позицию (уникальность в БД) и один платёж у провайдера на заказ
    expect(new Set(orders.map((o) => o.reservationId)).size).toBe(orders.length);
    for (const o of orders) expect(await stubPaymentsFor(o.id)).toHaveLength(1);
    // 5. ровно одно письмо на каждый завершённый заказ
    const emails = await t.prisma.emailOutbox.findMany({ where: { dedupKey: { startsWith: 'order:' } } });
    expect(emails).toHaveLength(orders.length);
    expect(emails.every((e) => e.status === 'SENT' && e.attempts === 1)).toBe(true);

    console.log(
      `chaos: ${orders.length} orders (${orders.filter((o) => o.status === 'PAID').length} paid), ` +
        `stock ${JSON.stringify(b)}`,
    );
  });
});
