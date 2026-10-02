import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

/**
 * Каждый «таб» — отдельный browser context. Закрываем их после каждого теста: иначе к концу прогона
 * открыты десятки вкладок с сокетами и таймерами, и это тормозит следующие тесты.
 */
const openContexts = new Set<BrowserContext>();
export async function newTabContext(browser: Browser): Promise<BrowserContext> {
  const context = await browser.newContext();
  openContexts.add(context);
  return context;
}
test.afterEach(async () => {
  await Promise.all([...openContexts].map((c) => c.close()));
  openContexts.clear();
});

export const STUB_URL = process.env.PAYMENT_STUB_URL ?? 'http://localhost:4000';
export const MAILPIT_URL = process.env.MAILPIT_API_URL ?? 'http://localhost:8025';
const API = () => `${process.env.BASE_URL ?? 'http://localhost:8080'}/api`;

export function uniqueEmail(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}@example.com`;
}

/** Время удержания, с которым запущен бэкенд (scripts/run-e2e.mjs ставит 15 с). */
export const HOLD_TTL_SECONDS = Number(process.env.HOLD_TTL_SECONDS ?? 600);

export async function createSale(opts: { title: string; totalQty: number; startsInSeconds: number; durationSeconds?: number }) {
  return (await createSaleFull(opts)).id;
}

/** Магазин создаёт распродажу через API (старт — смещение от часов сервера). */
export async function createSaleFull(opts: { title: string; totalQty: number; startsInSeconds: number; durationSeconds?: number }) {
  const login = await fetch(`${API()}/auth/shop-login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: process.env.SHOP_PASSWORD ?? 'shop' }),
  });
  const { token } = (await login.json()) as { token: string };
  const res = await fetch(`${API()}/shop/sales`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({
      title: opts.title,
      priceCents: 4990_00,
      oldPriceCents: 12990_00,
      totalQty: opts.totalQty,
      maxPerOrder: 1,
      startsInSeconds: opts.startsInSeconds,
      durationSeconds: opts.durationSeconds ?? 600,
    }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string; startsAt: string; endsAt: string };
}

/** Отдельный browser context = отдельная «вкладка» со своей sessionStorage и своим покупателем. */
export async function buyerTab(browser: Browser, email: string): Promise<Page> {
  const context = await newTabContext(browser);
  const page = await context.newPage();
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page.getByText(email)).toBeVisible();
  return page;
}

export async function shopTab(browser: Browser): Promise<Page> {
  const context = await newTabContext(browser);
  const page = await context.newPage();
  await page.goto('/shop');
  await page.getByLabel('Пароль').fill(process.env.SHOP_PASSWORD ?? 'shop');
  await page.getByRole('button', { name: 'Войти как магазин' }).click();
  await expect(page.getByRole('heading', { name: 'Новая распродажа' })).toBeVisible();
  return page;
}

export function card(page: Page, saleId: string) {
  return page.getByTestId(`sale-${saleId}`);
}

/** Токен покупателя этой вкладки (лежит в sessionStorage) — для проверок через API. */
export async function tokenOf(page: Page): Promise<string> {
  return page.evaluate(() => JSON.parse(sessionStorage.getItem('flash-sale:session')!).token as string);
}

export async function ordersOf(page: Page) {
  const res = await fetch(`${API()}/orders`, { headers: { authorization: `Bearer ${await tokenOf(page)}` } });
  return ((await res.json()) as { orders: { id: string; status: string; saleId: string }[] }).orders;
}

export async function stubPayments(orderId: string) {
  const res = await fetch(`${STUB_URL}/payments?idempotencyKey=${orderId}`);
  return ((await res.json()) as { payments: { id: string; status: string }[] }).payments;
}

export async function mailsTo(address: string) {
  const res = await fetch(`${MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`to:${address}`)}`);
  return ((await res.json()) as { messages: { Subject: string }[] }).messages;
}
