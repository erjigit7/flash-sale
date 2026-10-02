import type { Socket } from 'socket.io-client';
import { MailService } from '../src/mail/mail.service.js';
import { ReservationsService } from '../src/reservations/reservations.service.js';
import { SaleFinalizer } from '../src/sales/sale-finalizer.service.js';
import { createTestApp, loginBuyer, resetDb, type TestApp } from './support/app.js';
import { createSale, saleRow, setSaleWindow } from './support/fixtures.js';
import { expectStockInvariant } from './support/invariant.js';
import { mailsTo, uniqueEmail } from './support/mailpit.js';
import { checkout, resolveStub, waitForOrder, waitUntil } from './support/payments.js';
import { connectSocket, waitForEvent } from './support/sockets.js';

/**
 * «По окончании распродажи непроданное снимается, неоплаченные корзины очищаются, их владельцы получают уведомление».
 */
describe('окончание распродажи', () => {
  let t: TestApp;
  let finalizer: SaleFinalizer;
  const sockets: Socket[] = [];

  beforeAll(async () => {
    t = await createTestApp();
    finalizer = t.app.get(SaleFinalizer);
  });
  beforeEach(() => resetDb(t.prisma));
  afterEach(() => {
    for (const s of sockets.splice(0)) s.disconnect();
  });
  afterAll(() => t.close());

  /**
   * 5 единиц: A держит в корзине, B начал оплату (платёжка висит), C купил, 2 — на витрине.
   */
  async function scenario() {
    const saleId = await createSale(t.prisma, { totalQty: 5 });
    const emails = { a: uniqueEmail('cart-a'), b: uniqueEmail('paying-b'), c: uniqueEmail('paid-c') };
    const a = await loginBuyer(t, emails.a);
    const b = await loginBuyer(t, emails.b);
    const c = await loginBuyer(t, emails.c);
    const reserve = (token: string) =>
      t.http().post('/api/reservations').set('Authorization', `Bearer ${token}`).send({ saleId, quantity: 1 }).expect(201);

    const ra = await reserve(a.token);
    const rb = await reserve(b.token);
    const rc = await reserve(c.token);
    const ob = await checkout(t, b.token, rb.body.reservation.id, 'HANG').expect(201);
    const oc = await checkout(t, c.token, rc.body.reservation.id, 'SUCCESS').expect(201);
    await waitForOrder(t, oc.body.order.id, (o) => o.status === 'PAID');
    const orderB = await waitForOrder(t, ob.body.order.id, (o) => o.providerPaymentId !== null);

    return { saleId, emails, a, b, c, resA: ra.body.reservation.id as string, resB: rb.body.reservation.id as string, orderB };
  }

  it('непроданное снято, корзина A очищена, A уведомлён один раз; оплата B и покупка C не тронуты', async () => {
    const s = await scenario();
    const tabA = await connectSocket(t.baseUrl, s.a.token);
    sockets.push(tabA);
    const notified = waitForEvent<{ type: string }>(tabA, 'notification', (e) => e.type === 'sale_ended');
    const cleared = waitForEvent<{ status: string }>(tabA, 'reservation:updated', (e) => e.status === 'CANCELLED');

    await setSaleWindow(t.prisma, s.saleId, -3600, -1); // распродажа закончилась по часам БД
    expect(await finalizer.finalizeEnded()).toBe(1);
    await Promise.all([notified, cleared]);

    const sale = await saleRow(t.prisma, s.saleId);
    expect(sale.available).toBe(0);
    expect(sale.withdrawnQty).toBe(3); // 2 с витрины + 1 из корзины A
    expect(sale.finalizedAt).not.toBeNull();
    const b = await expectStockInvariant(t.prisma, s.saleId);
    expect(b).toMatchObject({ active: 0, checkout: 1, purchased: 1 });

    expect((await t.prisma.reservation.findUniqueOrThrow({ where: { id: s.resA } })).status).toBe('CANCELLED');
    expect((await t.prisma.reservation.findUniqueOrThrow({ where: { id: s.resB } })).status).toBe('CHECKOUT');

    // уведомление в кабинете A
    const list = await t.http().get('/api/notifications').set('Authorization', `Bearer ${s.a.token}`).expect(200);
    expect(list.body.notifications).toHaveLength(1);
    expect(list.body.notifications[0].type).toBe('sale_ended');

    // повторный запуск уборки ничего не меняет и не шлёт второе уведомление
    expect(await finalizer.finalizeEnded()).toBe(0);
    expect(await t.prisma.notification.count()).toBe(1);

    // письмо A — ровно одно; у B и C писем об окончании нет
    const mail = t.app.get(MailService);
    await mail.sendDue();
    await mail.sendDue();
    await waitUntil(() => mailsTo(s.emails.a), (m) => m.length >= 1);
    await new Promise((r) => setTimeout(r, 300));
    const toA = await mailsTo(s.emails.a);
    expect(toA).toHaveLength(1);
    expect(toA[0].Subject).toContain('завершилась');
    expect(await t.prisma.emailOutbox.count({ where: { dedupKey: { startsWith: 'sale-ended:' } } })).toBe(1);
  });

  it('оплата, начатая до окончания, досчитывается после него: успех → продано', async () => {
    const s = await scenario();
    await setSaleWindow(t.prisma, s.saleId, -3600, -1);
    await finalizer.finalizeEnded();

    await resolveStub(s.orderB.providerPaymentId!, 'succeeded');
    expect((await waitForOrder(t, s.orderB.id, (o) => o.status !== 'PENDING')).status).toBe('PAID');
    const b = await expectStockInvariant(t.prisma, s.saleId);
    expect(b).toMatchObject({ available: 0, checkout: 0, purchased: 2, withdrawn: 3 });
  });

  it('…а отказ после окончания отправляет товар в «снято», а не на витрину', async () => {
    const s = await scenario();
    await setSaleWindow(t.prisma, s.saleId, -3600, -1);
    await finalizer.finalizeEnded();

    await resolveStub(s.orderB.providerPaymentId!, 'declined');
    expect((await waitForOrder(t, s.orderB.id, (o) => o.status !== 'PENDING')).status).toBe('FAILED');
    const b = await expectStockInvariant(t.prisma, s.saleId);
    expect(b).toMatchObject({ available: 0, checkout: 0, purchased: 1, withdrawn: 4 });
  });

  it('удержание, истёкшее уже после окончания, не «воскрешает» товар на витрине', async () => {
    const s = await scenario();
    await setSaleWindow(t.prisma, s.saleId, -3600, -1);
    await t.prisma.$executeRaw`UPDATE reservations SET expires_at = now() - interval '1 second' WHERE status = 'ACTIVE'`;
    // expirer не трогает позиции завершившихся распродаж — их отменяет уборка (с уведомлением)
    expect((await t.app.get(ReservationsService).expireDue()).reservations).toHaveLength(0);
    await finalizer.finalizeEnded();
    expect((await t.prisma.reservation.findUniqueOrThrow({ where: { id: s.resA } })).status).toBe('CANCELLED');
    expect((await saleRow(t.prisma, s.saleId)).available).toBe(0);
  });

  it('распродажа без корзин: просто снимает остаток, писем нет', async () => {
    const saleId = await createSale(t.prisma, { totalQty: 7, startsIn: -3600, endsIn: -1 });
    expect(await finalizer.finalizeEnded()).toBe(1);
    const sale = await saleRow(t.prisma, saleId);
    expect(sale).toMatchObject({ available: 0, withdrawnQty: 7 });
    expect(await t.prisma.emailOutbox.count()).toBe(0);
  });
});
