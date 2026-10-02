#!/usr/bin/env node
/**
 * Проверка устойчивости к рестартам на живом стеке (docker compose up должен быть поднят).
 *   node scripts/check-restarts.mjs
 *
 * A. Оплата висит (HANG) → рестарт заглушки → у провайдера ТОТ ЖЕ платёж (не новый), бэкенд его не пересоздаёт;
 *    решение по нему → заказ оплачен.
 * B. Оплата SUCCESS → заглушку убивают (SIGKILL) до ответа «банка» → после старта платёж досчитывается сам.
 * C. Оплата висит → бэкенд остановлен, в этот момент платёжка отвечает → после старта бэкенда заказ досчитан.
 * В каждом сценарии: у провайдера ровно один платёж на заказ, у заказа ровно одно письмо.
 */
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const API = process.env.API_URL ?? 'http://localhost:8080/api';
const STUB = process.env.STUB_URL ?? 'http://localhost:4000';
const MAILPIT = process.env.MAILPIT_URL ?? 'http://localhost:8025';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const compose = (args) => execSync(`docker compose ${args}`, { stdio: 'pipe' }).toString();

async function json(method, url, body, headers = {}) {
  const res = await fetch(url, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function waitFor(what, probe, timeoutMs = 90_000) {
  const started = Date.now();
  for (;;) {
    try {
      const v = await probe();
      if (v) return v;
    } catch {
      // сервис ещё не поднялся
    }
    if (Date.now() - started > timeoutMs) throw new Error(`timeout: ${what}`);
    await sleep(250);
  }
}

function check(cond, message) {
  if (!cond) throw new Error(`FAIL: ${message}`);
  console.log(`  ✓ ${message}`);
}

async function stubHealthy() {
  return waitFor('stub health', async () => (await fetch(`${STUB}/health`)).ok);
}
async function backendHealthy() {
  return waitFor('backend health', async () => (await fetch(`${API}/health`)).ok);
}

async function newHangOrder(scenario) {
  const shop = await json('POST', `${API}/auth/shop-login`, { password: process.env.SHOP_PASSWORD ?? 'shop' });
  const sale = await json(
    'POST',
    `${API}/shop/sales`,
    { title: `Рестарт ${scenario} ${Date.now()}`, priceCents: 99_00, totalQty: 1, maxPerOrder: 1, startsInSeconds: 0, durationSeconds: 3600 },
    { authorization: `Bearer ${shop.body.token}` },
  );
  const email = `restart-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}@example.com`;
  const login = await json('POST', `${API}/auth/login`, { email });
  const auth = { authorization: `Bearer ${login.body.token}` };
  const held = await json('POST', `${API}/reservations`, { saleId: sale.body.id, quantity: 1 }, auth);
  const order = await json(
    'POST',
    `${API}/orders`,
    { reservationId: held.body.reservation.id, scenario },
    { ...auth, 'idempotency-key': randomUUID() },
  );
  const orderId = order.body.order.id;
  const payment = await waitFor('payment at provider', async () => {
    const r = await json('GET', `${STUB}/payments?idempotencyKey=${orderId}`);
    return r.body.payments[0];
  });
  return { saleId: sale.body.id, email, auth, orderId, payment };
}

const orderStatus = async (o) =>
  (await json('GET', `${API}/orders`, undefined, o.auth)).body.orders.find((x) => x.id === o.orderId).status;
const paymentsFor = async (orderId) => (await json('GET', `${STUB}/payments?idempotencyKey=${orderId}`)).body.payments;
const mailsTo = async (email) =>
  (await json('GET', `${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`)).body.messages;

async function finalChecks(o) {
  check((await paymentsFor(o.orderId)).length === 1, 'у провайдера ровно один платёж на заказ');
  await waitFor('email', async () => (await mailsTo(o.email)).length >= 1, 20_000);
  await sleep(1000);
  check((await mailsTo(o.email)).length === 1, 'письмо о заказе ровно одно');
}

async function scenarioA() {
  console.log('A. HANG → рестарт заглушки → тот же платёж');
  const o = await newHangOrder('HANG');
  compose('restart payment-stub');
  await stubHealthy();
  const after = await json('GET', `${STUB}/payments/${o.payment.id}`);
  check(after.status === 200 && after.body.status === 'processing', `после рестарта платёж ${o.payment.id} на месте и всё ещё висит`);
  // даём reconciler бэкенда (опрос раз в 5 с, аренда 10 с) время сходить к провайдеру: пересоздавать нечего
  await sleep(16_000);
  const payments = await paymentsFor(o.orderId);
  check(payments.length === 1 && payments[0].id === o.payment.id, 'бэкенд не создал новый платёж — тот же id');
  check((await orderStatus(o)) === 'PENDING', 'заказ ждёт ответа платёжки, товар держится');
  await json('POST', `${STUB}/payments/${o.payment.id}/resolve`, { result: 'succeeded' });
  await waitFor('order PAID', async () => (await orderStatus(o)) === 'PAID');
  check(true, 'после решения по тому же платежу заказ оплачен');
  await finalChecks(o);
}

async function scenarioB() {
  console.log('B. SUCCESS → заглушку убили (SIGKILL) до ответа банка → досчитается после старта');
  const o = await newHangOrder('SUCCESS');
  const statusBeforeKill = (await json('GET', `${STUB}/payments/${o.payment.id}`)).body.status;
  compose('kill -s SIGKILL payment-stub');
  console.log(`  (на момент kill платёж был: ${statusBeforeKill})`);
  compose('start payment-stub');
  await stubHealthy();
  check((await json('GET', `${STUB}/payments/${o.payment.id}`)).status === 200, 'после SIGKILL платёж на месте');
  await waitFor('order PAID', async () => (await orderStatus(o)) === 'PAID');
  check(true, 'платёж досчитан заглушкой после старта, заказ оплачен');
  await finalChecks(o);
}

async function scenarioC() {
  console.log('C. HANG → бэкенд остановлен → платёжка отвечает → бэкенд стартует → заказ досчитан');
  const o = await newHangOrder('HANG');
  compose('stop backend');
  await json('POST', `${STUB}/payments/${o.payment.id}/resolve`, { result: 'succeeded' });
  await sleep(3000); // пара попыток webhook уходит в никуда
  compose('start backend');
  await backendHealthy();
  await waitFor('order PAID', async () => (await orderStatus(o)) === 'PAID');
  check(true, 'после старта бэкенда заказ досчитан (повтор webhook или reconciler)');
  await finalChecks(o);
}

try {
  await stubHealthy();
  await backendHealthy();
  await scenarioA();
  await scenarioB();
  await scenarioC();
  console.log('\nВсе сценарии рестартов прошли.');
} catch (error) {
  console.error(`\n${error.message}`);
  process.exit(1);
}
