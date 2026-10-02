import { randomUUID } from 'node:crypto';

export type Scenario = 'SUCCESS' | 'DECLINE' | 'HANG';
export type PaymentStatus = 'processing' | 'succeeded' | 'declined';

export interface Payment {
  id: string;
  idempotencyKey: string;
  amountCents: number;
  description: string;
  scenario: Scenario;
  status: PaymentStatus;
  callbackUrl: string;
  createdAt: string;
  resolvedAt: string | null;
  webhook: {
    deliveries: number;
    lastStatus: number | 'network_error' | null;
    lastAttemptAt: string | null;
    delivered: boolean;
  };
}

/**
 * Хранилище платежей в памяти. Для заглушки этого достаточно; при перезапуске контейнера
 * висящие платежи теряются — бэкенд это переживает (см. reconciler: 404 → повторная отправка с тем же ключом).
 */
export class PaymentStore {
  private readonly byId = new Map<string, Payment>();
  private readonly byKey = new Map<string, string>();

  /**
   * Идемпотентность: тот же ключ → тот же платёж, второго списания нет.
   * Возвращает [платёж, создан_ли_сейчас].
   */
  create(input: Omit<Payment, 'id' | 'status' | 'createdAt' | 'resolvedAt' | 'webhook'>): [Payment, boolean] {
    const existingId = this.byKey.get(input.idempotencyKey);
    if (existingId) return [this.byId.get(existingId)!, false];

    const payment: Payment = {
      ...input,
      id: `pay_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
      status: 'processing',
      createdAt: new Date().toISOString(),
      resolvedAt: null,
      webhook: { deliveries: 0, lastStatus: null, lastAttemptAt: null, delivered: false },
    };
    this.byId.set(payment.id, payment);
    this.byKey.set(payment.idempotencyKey, payment.id);
    return [payment, true];
  }

  get(id: string): Payment | undefined {
    return this.byId.get(id);
  }

  findByKey(key: string): Payment | undefined {
    const id = this.byKey.get(key);
    return id ? this.byId.get(id) : undefined;
  }

  list(): Payment[] {
    return [...this.byId.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Разрешить платёж один раз; повторное разрешение — false (результат уже зафиксирован). */
  resolve(id: string, status: 'succeeded' | 'declined'): boolean {
    const p = this.byId.get(id);
    if (!p || p.status !== 'processing') return false;
    p.status = status;
    p.resolvedAt = new Date().toISOString();
    return true;
  }
}
