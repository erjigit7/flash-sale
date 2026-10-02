import { randomUUID, createHmac } from 'node:crypto';
import type { TestApp } from './app.js';

const stubUrl = () => process.env.PAYMENT_STUB_URL ?? 'http://localhost:4000';

export interface StubPayment {
  id: string;
  idempotencyKey: string;
  amountCents: number;
  scenario: string;
  status: 'processing' | 'succeeded' | 'declined';
  webhook: { deliveries: number; delivered: boolean };
}

/** Сколько платежей завёл провайдер по ключу (= id заказа). «Не списывает дважды» ⇔ не больше одного. */
export async function stubPaymentsFor(orderId: string): Promise<StubPayment[]> {
  const res = await fetch(`${stubUrl()}/payments?idempotencyKey=${encodeURIComponent(orderId)}`);
  return ((await res.json()) as { payments: StubPayment[] }).payments;
}

/** Ручное решение по «зависшему» платежу — как кнопка в панели заглушки. Провайдер сам пришлёт webhook. */
export async function resolveStub(paymentId: string, result: 'succeeded' | 'declined') {
  const res = await fetch(`${stubUrl()}/payments/${paymentId}/resolve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ result }),
  });
  if (!res.ok) throw new Error(`resolve failed: ${res.status} ${await res.text()}`);
}

export async function redeliverStub(paymentId: string) {
  const res = await fetch(`${stubUrl()}/payments/${paymentId}/redeliver`, { method: 'POST' });
  if (!res.ok) throw new Error(`redeliver failed: ${res.status}`);
}

/** Подписанный webhook «как от провайдера» — для проверки дублей и подписи без участия заглушки. */
export function signedWebhook(t: TestApp, body: object, secret = process.env.PAYMENT_WEBHOOK_SECRET ?? 'dev-only-webhook-secret') {
  const raw = JSON.stringify(body);
  const signature = `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
  return t.http().post('/api/payments/webhook').set('content-type', 'application/json').set('x-signature', signature).send(raw);
}

export function checkout(
  t: TestApp,
  token: string,
  reservationId: string,
  scenario: 'SUCCESS' | 'DECLINE' | 'HANG',
  key: string = randomUUID(),
) {
  return t
    .http()
    .post('/api/orders')
    .set('Authorization', `Bearer ${token}`)
    .set('Idempotency-Key', key)
    .send({ reservationId, scenario });
}

/** Ждёт выполнения условия (опрос раз в 50 мс). Для асинхронных шагов: ответ платёжки, webhook. */
export async function waitUntil<T>(probe: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 8000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = await probe();
    if (ok(value)) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`waitUntil timed out; last value: ${JSON.stringify(value)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

export function orderRow(t: TestApp, orderId: string) {
  return t.prisma.order.findUniqueOrThrow({ where: { id: orderId } });
}

export function waitForOrder(t: TestApp, orderId: string, ok: (o: Awaited<ReturnType<typeof orderRow>>) => boolean) {
  return waitUntil(() => orderRow(t, orderId), ok);
}
