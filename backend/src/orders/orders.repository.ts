import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import type { OrderStatus, PaymentScenario } from '../generated/prisma/enums.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { StockChange } from '../reservations/reservations.repository.js';

export interface OrderRow {
  id: string;
  reservationId: string;
  userId: string;
  saleId: string;
  quantity: number;
  amountCents: number;
  status: OrderStatus;
  scenario: PaymentScenario;
  idempotencyKey: string;
  providerPaymentId: string | null;
  createdAt: Date;
}

const ORDER_COLUMNS = Prisma.raw(`
  id, reservation_id AS "reservationId", user_id AS "userId", sale_id AS "saleId", quantity,
  amount_cents AS "amountCents", status, scenario, idempotency_key AS "idempotencyKey",
  provider_payment_id AS "providerPaymentId", created_at AS "createdAt"`);

export type CheckoutOutcome =
  | { kind: 'created'; order: OrderRow }
  | { kind: 'replay'; order: OrderRow }
  | { kind: 'key_reused' }
  | { kind: 'not_found' }
  | { kind: 'hold_expired'; status: string };

export interface PaymentResultApplied {
  order: OrderRow & { userEmail: string; saleTitle: string };
  reservationStatus: 'PURCHASED' | 'RELEASED';
  stock: StockChange | null;
}

/** Переходы заказа — только условными UPDATE; время — now() БД. */
@Injectable()
export class OrdersRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * «Оплатить»: позиция ACTIVE → CHECKOUT и создание заказа — в одной транзакции.
   * Переход условный (status = 'ACTIVE' AND expires_at > now()), поэтому из двух одновременных
   * запросов (двойной клик, две вкладки) проходит ровно один: второй ждёт блокировку строки,
   * перепроверяет условие и получает 0 строк → возвращаем уже созданный заказ.
   * Уникальные индексы orders(reservation_id) и orders(user_id, idempotency_key) — второй рубеж.
   */
  async checkout(
    userId: string,
    reservationId: string,
    idempotencyKey: string,
    scenario: PaymentScenario,
  ): Promise<CheckoutOutcome> {
    const created = await this.prisma.$transaction(async (tx) => {
      const held = await tx.$queryRaw<{ saleId: string; quantity: number; unitPriceCents: number }[]>`
        UPDATE reservations SET status = 'CHECKOUT', updated_at = now()
         WHERE id = ${reservationId}::uuid AND user_id = ${userId}::uuid
           AND status = 'ACTIVE' AND expires_at > now()
        RETURNING sale_id AS "saleId", quantity, unit_price_cents AS "unitPriceCents"`;
      if (held.length === 0) return null;
      const { saleId, quantity, unitPriceCents } = held[0];
      // ON CONFLICT: ключ уже использован для другой позиции → откат перехода в CHECKOUT
      const orders = await tx.$queryRaw<OrderRow[]>`
        INSERT INTO orders (reservation_id, user_id, sale_id, quantity, amount_cents, scenario, idempotency_key)
        VALUES (${reservationId}::uuid, ${userId}::uuid, ${saleId}::uuid, ${quantity}, ${quantity * unitPriceCents},
                ${scenario}::"PaymentScenario", ${idempotencyKey})
        ON CONFLICT (user_id, idempotency_key) DO NOTHING
        RETURNING ${ORDER_COLUMNS}`;
      if (orders.length === 0) throw new KeyReusedError();
      return orders[0];
    }).catch((error: unknown) => {
      if (error instanceof KeyReusedError) return 'key_reused' as const;
      throw error;
    });

    if (created === 'key_reused') return { kind: 'key_reused' };
    if (created) return { kind: 'created', order: created };

    // Перехода не было: это повтор (заказ уже есть) или удержание истекло / позиция не наша
    const existing = await this.prisma.$queryRaw<OrderRow[]>`
      SELECT ${ORDER_COLUMNS} FROM orders WHERE reservation_id = ${reservationId}::uuid AND user_id = ${userId}::uuid`;
    if (existing[0]) return { kind: 'replay', order: existing[0] };

    const byKey = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM orders WHERE user_id = ${userId}::uuid AND idempotency_key = ${idempotencyKey}`;
    if (byKey[0]) return { kind: 'key_reused' };

    const reservation = await this.prisma.$queryRaw<{ status: string }[]>`
      SELECT status FROM reservations WHERE id = ${reservationId}::uuid AND user_id = ${userId}::uuid`;
    if (!reservation[0]) return { kind: 'not_found' };
    return { kind: 'hold_expired', status: reservation[0].status };
  }

  /**
   * Захват заказов для отправки в платёжку (outbox: заказ PENDING без provider_payment_id).
   * Захват сдвигает next_attempt_at вперёд — это «аренда»: параллельный dispatcher тот же заказ не возьмёт.
   * Даже если возьмёт — платёжка дедуплицирует по ключу (= id заказа), второго списания не будет.
   */
  claimForDispatch(onlyOrderId: string | null, limit = 20): Promise<OrderRow[]> {
    return this.prisma.$queryRaw<OrderRow[]>`
      UPDATE orders
         SET payment_attempts = payment_attempts + 1,
             next_attempt_at = now() + make_interval(secs => LEAST(60, 2 ^ LEAST(payment_attempts, 6))),
             updated_at = now()
       WHERE id IN (
         SELECT id FROM orders
          WHERE status = 'PENDING' AND provider_payment_id IS NULL AND next_attempt_at <= now()
            AND (${onlyOrderId}::uuid IS NULL OR id = ${onlyOrderId}::uuid)
          ORDER BY next_attempt_at
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED)
       RETURNING ${ORDER_COLUMNS}`;
  }

  async setProviderPaymentId(orderId: string, providerPaymentId: string): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE orders SET provider_payment_id = ${providerPaymentId}, updated_at = now(),
                        next_attempt_at = now() + interval '10 seconds'
       WHERE id = ${orderId}::uuid AND provider_payment_id IS NULL`;
  }

  /** Платёжка «забыла» платёж (заглушка перезапустилась) — отправим заново с тем же ключом. */
  async clearProviderPaymentId(orderId: string, providerPaymentId: string): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE orders SET provider_payment_id = NULL, next_attempt_at = now(), updated_at = now()
       WHERE id = ${orderId}::uuid AND status = 'PENDING' AND provider_payment_id = ${providerPaymentId}`;
  }

  /** Reconciler: PENDING-заказы, уже принятые платёжкой, — опросить статус (страховка от потерянного webhook). */
  claimForReconcile(limit = 20): Promise<OrderRow[]> {
    return this.prisma.$queryRaw<OrderRow[]>`
      UPDATE orders SET next_attempt_at = now() + interval '10 seconds'
       WHERE id IN (
         SELECT id FROM orders
          WHERE status = 'PENDING' AND provider_payment_id IS NOT NULL AND next_attempt_at <= now()
          ORDER BY next_attempt_at
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED)
       RETURNING ${ORDER_COLUMNS}`;
  }

  /**
   * Применить результат оплаты. Идемпотентно: переход PENDING → PAID/FAILED условный,
   * повторный webhook / ответ reconciler получает 0 строк и ничего не меняет.
   * В той же транзакции:
   *  - PAID: позиция CHECKOUT → PURCHASED (остаток уже списан при резерве — продаём то, что держали);
   *  - FAILED: позиция CHECKOUT → RELEASED, остаток возвращается на витрину (или в «снято», если распродажа кончилась);
   *  - письмо покупателю в outbox с dedup_key = 'order:<id>' — одно письмо на заказ.
   * Оплата, начатая до истечения удержания, завершается и после него: позиция в CHECKOUT, expirer её не трогал.
   */
  async applyPaymentResult(
    orderId: string,
    result: 'succeeded' | 'declined',
    providerPaymentId: string | null,
    email: (o: OrderRow & { userEmail: string; saleTitle: string }, paid: boolean) => { subject: string; body: string },
  ): Promise<PaymentResultApplied | null> {
    const paid = result === 'succeeded';
    return this.prisma.$transaction(async (tx) => {
      const status = paid ? 'PAID' : 'FAILED';
      const rows = await tx.$queryRaw<(OrderRow & { userEmail: string; saleTitle: string })[]>`
        WITH o AS (
           UPDATE orders
              SET status = ${status}::"OrderStatus", resolved_at = now(), updated_at = now(),
                  provider_payment_id = COALESCE(provider_payment_id, ${providerPaymentId}),
                  failed_reason = CASE WHEN ${status}::text = 'FAILED' THEN 'declined_by_provider' END
            WHERE id = ${orderId}::uuid AND status = 'PENDING'
           RETURNING *)
         SELECT o.id, o.reservation_id AS "reservationId", o.user_id AS "userId", o.sale_id AS "saleId",
                o.quantity, o.amount_cents AS "amountCents", o.status, o.scenario,
                o.idempotency_key AS "idempotencyKey", o.provider_payment_id AS "providerPaymentId",
                o.created_at AS "createdAt", u.email AS "userEmail", s.title AS "saleTitle"
           FROM o JOIN users u ON u.id = o.user_id JOIN sales s ON s.id = o.sale_id`;
      if (rows.length === 0) return null; // уже применено — дубль webhook или ответ reconciler
      const order = rows[0];

      let stock: StockChange | null = null;
      if (paid) {
        await tx.$executeRaw`
          UPDATE reservations SET status = 'PURCHASED', updated_at = now()
           WHERE id = ${order.reservationId}::uuid AND status = 'CHECKOUT'`;
      } else {
        const returned = await tx.$queryRaw<StockChange[]>`
          WITH r AS (
            UPDATE reservations SET status = 'RELEASED', updated_at = now()
             WHERE id = ${order.reservationId}::uuid AND status = 'CHECKOUT'
            RETURNING sale_id, quantity)
          UPDATE sales
             SET available     = available     + CASE WHEN ends_at > now() THEN r.quantity ELSE 0 END,
                 withdrawn_qty = withdrawn_qty + CASE WHEN ends_at > now() THEN 0 ELSE r.quantity END,
                 version = version + 1
            FROM r WHERE sales.id = r.sale_id
          RETURNING sales.id AS "saleId", sales.available, sales.version`;
        stock = returned[0] ?? null;
      }

      const mail = email(order, paid);
      await tx.$executeRaw`
        INSERT INTO email_outbox (dedup_key, to_email, subject, body)
        VALUES (${`order:${order.id}`}, ${order.userEmail}, ${mail.subject}, ${mail.body})
        ON CONFLICT (dedup_key) DO NOTHING`;

      return { order, reservationStatus: paid ? 'PURCHASED' : 'RELEASED', stock } satisfies PaymentResultApplied;
    });
  }
}

class KeyReusedError extends Error {}
