import { Injectable } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { AppConfig } from '../config/app-config.js';
import type { PaymentScenario } from '../generated/prisma/enums.js';

export type ProviderStatus = 'processing' | 'succeeded' | 'declined';

export interface CreatePaymentRequest {
  /** Ключ идемпотентности у провайдера = id заказа: повторная отправка не спишет второй раз */
  idempotencyKey: string;
  amountCents: number;
  scenario: PaymentScenario;
  description: string;
}

/** HTTP-клиент к платёжному провайдеру (заглушке). Таймаут на каждый запрос: «зависшая» сеть не вешает воркер. */
@Injectable()
export class PaymentGateway {
  constructor(private readonly config: AppConfig) {}

  async createPayment(req: CreatePaymentRequest): Promise<{ paymentId: string; status: ProviderStatus }> {
    const res = await fetch(`${this.config.paymentStubUrl}/payments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...req, callbackUrl: this.config.paymentWebhookUrl }),
      signal: AbortSignal.timeout(this.config.paymentRequestTimeoutMs),
    });
    if (!res.ok) throw new Error(`payment provider responded ${res.status}: ${await res.text()}`);
    return (await res.json()) as { paymentId: string; status: ProviderStatus };
  }

  /** null — провайдер платёж не знает (404) */
  async getPayment(paymentId: string): Promise<{ id: string; status: ProviderStatus } | null> {
    const res = await fetch(`${this.config.paymentStubUrl}/payments/${encodeURIComponent(paymentId)}`, {
      signal: AbortSignal.timeout(this.config.paymentRequestTimeoutMs),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`payment provider responded ${res.status}`);
    return (await res.json()) as { id: string; status: ProviderStatus };
  }

  /** Подпись webhook: HMAC-SHA256 от сырого тела запроса, общий секрет с провайдером. */
  verifySignature(rawBody: Buffer, header: string | undefined): boolean {
    if (!header) return false;
    const expected = `sha256=${createHmac('sha256', this.config.paymentWebhookSecret).update(rawBody).digest('hex')}`;
    const a = Buffer.from(header);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  }
}
