import Fastify from 'fastify';
import { PaymentStore, type Scenario } from './store.ts';
import { deliverWebhook, type WebhookOptions } from './webhook.ts';
import { panelHtml } from './panel.ts';

/**
 * Заглушка платёжного провайдера.
 *  POST /payments                 — создать платёж (идемпотентно по idempotencyKey), ответ 202 «в обработке»
 *  GET  /payments/:id             — статус платежа (для reconciler бэкенда)
 *  GET  /payments?idempotencyKey= — поиск по ключу (тесты: «списание одно»)
 *  POST /payments/:id/resolve     — вручную разрешить «зависший» платёж (панель, тесты)
 *  POST /payments/:id/redeliver   — повторно отправить webhook (демонстрация идемпотентности получателя)
 *  GET  /                         — HTML-панель
 * Сценарии: SUCCESS и DECLINE отвечают webhook'ом через RESPONSE_DELAY_MS, HANG — молчит до ручного решения.
 */
const port = Number(process.env.PORT ?? 4000);
const responseDelayMs = Number(process.env.RESPONSE_DELAY_MS ?? 1500);
const webhookOptions: Omit<WebhookOptions, 'log'> = {
  secret: process.env.WEBHOOK_SECRET ?? 'dev-only-webhook-secret',
  maxAttempts: Number(process.env.WEBHOOK_MAX_ATTEMPTS ?? 8),
  baseDelayMs: Number(process.env.WEBHOOK_BASE_DELAY_MS ?? 500),
};

const SCENARIOS: Scenario[] = ['SUCCESS', 'DECLINE', 'HANG'];

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });
const store = new PaymentStore();
const log = (msg: string) => app.log.info(msg);

function sendWebhook(paymentId: string) {
  const payment = store.get(paymentId);
  if (!payment) return;
  void deliverWebhook(payment, { ...webhookOptions, log });
}

app.get('/health', async () => ({ status: 'ok' }));

app.get('/', async (_req, reply) => reply.type('text/html; charset=utf-8').send(panelHtml));

app.post<{
  Body: { idempotencyKey?: string; amountCents?: number; scenario?: Scenario; callbackUrl?: string; description?: string };
}>('/payments', async (req, reply) => {
  const { idempotencyKey, amountCents, scenario, callbackUrl, description } = req.body ?? {};
  if (!idempotencyKey || !Number.isInteger(amountCents) || !callbackUrl || !scenario || !SCENARIOS.includes(scenario)) {
    return reply.code(400).send({ error: 'invalid_request' });
  }

  const [payment, created] = store.create({
    idempotencyKey,
    amountCents: amountCents!,
    scenario,
    callbackUrl,
    description: description ?? '',
  });

  if (!created) {
    // тот же ключ с другой суммой — ошибка клиента, а не повод списать ещё раз
    if (payment.amountCents !== amountCents) {
      return reply.code(422).send({ error: 'idempotency_key_reused', paymentId: payment.id });
    }
    return reply.code(200).send({ paymentId: payment.id, status: payment.status, idempotentReplay: true });
  }

  if (scenario !== 'HANG') {
    setTimeout(() => {
      if (store.resolve(payment.id, scenario === 'SUCCESS' ? 'succeeded' : 'declined')) sendWebhook(payment.id);
    }, responseDelayMs);
  }
  log(`payment ${payment.id} created: key=${idempotencyKey} amount=${amountCents} scenario=${scenario}`);
  return reply.code(202).send({ paymentId: payment.id, status: payment.status });
});

app.get<{ Querystring: { idempotencyKey?: string } }>('/payments', async (req) => {
  const key = req.query.idempotencyKey;
  if (key) {
    const p = store.findByKey(key);
    return { payments: p ? [p] : [] };
  }
  return { payments: store.list() };
});

app.get<{ Params: { id: string } }>('/payments/:id', async (req, reply) => {
  const p = store.get(req.params.id);
  return p ? p : reply.code(404).send({ error: 'not_found' });
});

app.post<{ Params: { id: string }; Body: { result?: 'succeeded' | 'declined' } }>(
  '/payments/:id/resolve',
  async (req, reply) => {
    const result = req.body?.result;
    if (result !== 'succeeded' && result !== 'declined') return reply.code(400).send({ error: 'invalid_result' });
    const p = store.get(req.params.id);
    if (!p) return reply.code(404).send({ error: 'not_found' });
    if (!store.resolve(p.id, result)) return reply.code(409).send({ error: 'already_resolved', status: p.status });
    log(`payment ${p.id} resolved manually: ${result}`);
    sendWebhook(p.id);
    return { paymentId: p.id, status: p.status };
  },
);

app.post<{ Params: { id: string } }>('/payments/:id/redeliver', async (req, reply) => {
  const p = store.get(req.params.id);
  if (!p) return reply.code(404).send({ error: 'not_found' });
  if (p.status === 'processing') return reply.code(409).send({ error: 'not_resolved' });
  sendWebhook(p.id);
  return { paymentId: p.id, redelivering: true };
});

await app.listen({ port, host: '0.0.0.0' });
