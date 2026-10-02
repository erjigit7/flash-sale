import type { Socket } from 'socket.io-client';
import { ReservationsService } from '../src/reservations/reservations.service.js';
import { SaleScheduler } from '../src/sales/sale-scheduler.service.js';
import { createTestApp, loginBuyer, resetDb, type TestApp } from './support/app.js';
import { createSale } from './support/fixtures.js';
import { collect, connectSocket, waitForEvent } from './support/sockets.js';

type StockEvent = { saleId: string; available: number; version: number };

/**
 * «Остатки на витрине меняются у всех, кто её смотрит, без обновления страницы»
 * и «в момент старта покупка открывается у всех одновременно».
 * Два socket.io-клиента = две открытые вкладки.
 */
describe('realtime: две вкладки', () => {
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

  async function tab(token?: string) {
    const s = await connectSocket(t.baseUrl, token);
    sockets.push(s);
    return s;
  }

  it('покупка в одной вкладке → обе видят новый остаток; истечение удержания → обе видят возврат', async () => {
    const saleId = await createSale(t.prisma, { totalQty: 1 });
    const alice = await loginBuyer(t, 'alice@example.com');
    const bob = await loginBuyer(t, 'bob@example.com');
    const tabA = await tab(alice.token);
    const tabB = await tab(bob.token);
    const anonymous = await tab();

    const seenByA = waitForEvent<StockEvent>(tabA, 'sale:stock', (e) => e.saleId === saleId);
    const seenByB = waitForEvent<StockEvent>(tabB, 'sale:stock', (e) => e.saleId === saleId);
    const seenByAnon = waitForEvent<StockEvent>(anonymous, 'sale:stock', (e) => e.saleId === saleId);
    const res = await t
      .http()
      .post('/api/reservations')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ saleId, quantity: 1 })
      .expect(201);

    for (const e of await Promise.all([seenByA, seenByB, seenByAnon])) {
      expect(e).toEqual({ saleId, available: 0, version: res.body.sale.version });
    }

    // личное событие корзины — только владельцу
    const bobReservations = collect(tabB, 'reservation:updated');
    const aliceExpired = waitForEvent<{ status: string }>(tabA, 'reservation:updated', (e) => e.status === 'EXPIRED');
    const back = waitForEvent<StockEvent>(tabB, 'sale:stock', (e) => e.saleId === saleId && e.available === 1);
    await t.prisma.$executeRaw`UPDATE reservations SET expires_at = now() - interval '1 second'`;
    await t.app.get(ReservationsService).expireDue();

    await Promise.all([aliceExpired, back]);
    expect(bobReservations).toEqual([]);
  });

  it('магазин создал распродажу → открытые витрины и экран магазина получают sale:created', async () => {
    const viewer = await tab(); // покупатель на витрине, даже без входа
    const shopToken = (await t.http().post('/api/auth/shop-login').send({ password: 'shop' })).body.token as string;
    const shopTab = await tab(shopToken);

    const seenByViewer = waitForEvent<{ saleId: string }>(viewer, 'sale:created');
    const seenByShop = waitForEvent<{ saleId: string }>(shopTab, 'sale:created');
    const res = await t
      .http()
      .post('/api/shop/sales')
      .set('Authorization', `Bearer ${shopToken}`)
      .send({ title: 'Новинка', priceCents: 500_00, totalQty: 3, startsInSeconds: 60, durationSeconds: 600 })
      .expect(201);

    const [a, b] = await Promise.all([seenByViewer, seenByShop]);
    expect(a).toEqual({ saleId: res.body.id });
    expect(b).toEqual({ saleId: res.body.id });
    // к моменту события распродажа уже в БД: перезапрос витрины её вернёт
    const list = await t.http().get('/api/sales').expect(200);
    expect(list.body.sales.map((s: { id: string }) => s.id)).toContain(res.body.id);
  });

  it('версии остатка монотонны: клиент может отбросить устаревшее событие', async () => {
    const saleId = await createSale(t.prisma, { totalQty: 20 });
    const viewer = await tab();
    const events = collect<StockEvent>(viewer, 'sale:stock');
    const users = await Promise.all(Array.from({ length: 10 }, (_, i) => loginBuyer(t, `u${i}@example.com`)));

    await Promise.all(
      users.map((u) =>
        t.http().post('/api/reservations').set('Authorization', `Bearer ${u.token}`).send({ saleId, quantity: 1 }),
      ),
    );
    await waitForEvent<StockEvent>(viewer, 'sale:stock', (e) => e.available === 10).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 100));

    expect(events).toHaveLength(10);
    // событие с максимальной версией несёт итоговый остаток, как бы ни перемешалась доставка
    const latest = events.reduce((a, b) => (b.version > a.version ? b : a));
    expect(latest.available).toBe(10);
    expect(new Set(events.map((e) => e.version)).size).toBe(10);
  });

  it('старт распродажи: обе вкладки получают sale:started в момент starts_at по часам БД', async () => {
    const saleId = await createSale(t.prisma, { totalQty: 1, startsIn: 1, endsIn: 600 });
    const tabA = await tab();
    const tabB = await tab();

    const startedA = waitForEvent<{ saleId: string }>(tabA, 'sale:started', (e) => e.saleId === saleId, 4000);
    const startedB = waitForEvent<{ saleId: string }>(tabB, 'sale:started', (e) => e.saleId === saleId, 4000);
    await t.app.get(SaleScheduler).planUpcoming();
    await Promise.all([startedA, startedB]);

    // сигнал пришёл не раньше старта: к этому моменту БД уже пускает в покупку
    const [{ started }] = await t.prisma.$queryRaw<{ started: boolean }[]>`
      SELECT starts_at <= now() AS started FROM sales WHERE id = ${saleId}::uuid`;
    expect(started).toBe(true);
  });

  it('time:ping возвращает время БД (для синхронизации таймеров)', async () => {
    const s = await tab();
    const t0 = Date.now();
    const { serverTime } = await s.emitWithAck('time:ping');
    const t1 = Date.now();
    const [{ now }] = await t.prisma.$queryRaw<{ now: Date }[]>`SELECT now() AS now`;
    expect(Math.abs(new Date(serverTime).getTime() - now.getTime())).toBeLessThan(t1 - t0 + 1000);
  });
});
