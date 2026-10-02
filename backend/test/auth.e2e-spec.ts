import { createTestApp, loginBuyer, resetDb, type TestApp } from './support/app.js';

describe('вход и серверные часы', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });
  beforeEach(() => resetDb(t.prisma));
  afterAll(() => t.close());

  it('покупатель входит по email; повторный вход — тот же пользователь', async () => {
    const first = await loginBuyer(t, 'Alice@Example.com');
    const second = await loginBuyer(t, 'alice@example.com');
    expect(second.userId).toBe(first.userId);

    const me = await t.http().get('/api/me').set('Authorization', `Bearer ${first.token}`).expect(200);
    expect(me.body).toMatchObject({ email: 'alice@example.com', role: 'BUYER' });
  });

  it('без токена /api/me → 401', async () => {
    const res = await t.http().get('/api/me').expect(401);
    expect(res.body.error).toBe('unauthorized');
  });

  it('некорректный email → 400', async () => {
    await t.http().post('/api/auth/login').send({ email: 'not-an-email' }).expect(400);
  });

  it('вход магазина только по паролю', async () => {
    await t.http().post('/api/auth/shop-login').send({ password: 'wrong' }).expect(401);
    const res = await t.http().post('/api/auth/shop-login').send({ password: 'shop' }).expect(200);
    expect(res.body.user.role).toBe('SHOP');

    const asBuyer = await t.http().post('/api/auth/login').send({ email: 'shop@flash-sale.local' }).expect(403);
    expect(asBuyer.body.error).toBe('use_shop_login');
  });

  it('GET /api/time отдаёт время БД', async () => {
    const res = await t.http().get('/api/time').expect(200);
    const [{ now }] = await t.prisma.$queryRaw<{ now: Date }[]>`SELECT now() AS now`;
    const serverTime = new Date(res.body.serverTime).getTime();
    expect(Math.abs(now.getTime() - serverTime)).toBeLessThan(2000);
  });
});
