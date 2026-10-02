import { createHmac } from 'node:crypto';
import type { Payment } from './store.ts';

export interface WebhookOptions {
  secret: string;
  maxAttempts: number;
  baseDelayMs: number;
  log: (msg: string) => void;
}

export function sign(body: string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

/**
 * Доставка webhook как у настоящих провайдеров — at-least-once:
 * повторяем, пока получатель не ответит 2xx (экспоненциальная пауза). Значит, получатель
 * обязан быть идемпотентным: один и тот же результат может прийти несколько раз.
 */
export async function deliverWebhook(payment: Payment, opts: WebhookOptions): Promise<void> {
  const body = JSON.stringify({
    paymentId: payment.id,
    idempotencyKey: payment.idempotencyKey,
    status: payment.status,
    amountCents: payment.amountCents,
    resolvedAt: payment.resolvedAt,
  });
  const signature = sign(body, opts.secret);

  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    payment.webhook.deliveries++;
    payment.webhook.lastAttemptAt = new Date().toISOString();
    try {
      const res = await fetch(payment.callbackUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-signature': signature },
        body,
        signal: AbortSignal.timeout(5000),
      });
      payment.webhook.lastStatus = res.status;
      if (res.ok) {
        payment.webhook.delivered = true;
        return;
      }
      opts.log(`webhook ${payment.id} attempt ${attempt}: HTTP ${res.status}`);
    } catch (error) {
      payment.webhook.lastStatus = 'network_error';
      opts.log(`webhook ${payment.id} attempt ${attempt}: ${(error as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, opts.baseDelayMs * 2 ** (attempt - 1)));
  }
  opts.log(`webhook ${payment.id}: giving up after ${opts.maxAttempts} attempts`);
}
