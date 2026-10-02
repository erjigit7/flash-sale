import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

export interface ReservedRow {
  id: string;
  saleId: string;
  userId: string;
  quantity: number;
  unitPriceCents: number;
  expiresAt: Date;
  /** Остаток распродажи сразу после списания и его версия — для realtime-события */
  available: number;
  version: number;
}

export interface StockChange {
  saleId: string;
  available: number;
  version: number;
}

export interface ReleasedRow {
  id: string;
  saleId: string;
  userId: string;
  quantity: number;
}

export interface ReleaseResult {
  reservations: ReleasedRow[];
  stock: StockChange[];
}

export interface SaleAvailability {
  available: number;
  maxPerOrder: number;
  started: boolean;
  ended: boolean;
  startsAt: Date;
}

/**
 * Все изменения остатка при резерве и возврате — здесь, и только условными UPDATE
 * (никакого «прочитал → проверил → записал»). Время — только now() БД.
 */
@Injectable()
export class ReservationsRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Резерв одним SQL-оператором: списание остатка и создание позиции корзины атомарны.
   * - UPDATE пройдёт, только если остатка хватает и распродажа идёт по часам БД.
   *   Два покупателя за последнюю единицу: строку sales блокирует первый, второй после
   *   разблокировки перепроверяет available >= qty и получает 0 строк.
   * - Если у покупателя уже есть живая позиция, частичный уникальный индекс роняет INSERT,
   *   и весь оператор (включая списание) откатывается.
   * Возвращает null, если списать не удалось (причину выясняет diagnose()).
   */
  async reserve(userId: string, saleId: string, qty: number, ttlSeconds: number): Promise<ReservedRow | null> {
    const rows = await this.prisma.$queryRaw<ReservedRow[]>`
      WITH s AS (
        UPDATE sales
           SET available = available - ${qty}, version = version + 1
         WHERE id = ${saleId}::uuid
           AND available >= ${qty}
           AND ${qty} <= max_per_order
           AND starts_at <= now()
           AND ends_at > now()
        RETURNING id, price_cents, available, version
      ), r AS (
        INSERT INTO reservations (sale_id, user_id, quantity, unit_price_cents, status, expires_at)
        SELECT s.id, ${userId}::uuid, ${qty}, s.price_cents, 'ACTIVE', now() + make_interval(secs => ${ttlSeconds})
          FROM s
        RETURNING id, sale_id, user_id, quantity, unit_price_cents, expires_at
      )
      SELECT r.id, r.sale_id AS "saleId", r.user_id AS "userId", r.quantity,
             r.unit_price_cents AS "unitPriceCents", r.expires_at AS "expiresAt",
             s.available, s.version
        FROM r CROSS JOIN s`;
    return rows[0] ?? null;
  }

  /** Только для понятного ответа клиенту после неудачного резерва; на корректность не влияет. */
  async diagnose(saleId: string): Promise<SaleAvailability | null> {
    const rows = await this.prisma.$queryRaw<SaleAvailability[]>`
      SELECT available, max_per_order AS "maxPerOrder", starts_at AS "startsAt",
             starts_at <= now() AS started, ends_at <= now() AS ended
        FROM sales WHERE id = ${saleId}::uuid`;
    return rows[0] ?? null;
  }

  async findLiveForUser(userId: string, saleId: string): Promise<{ id: string } | null> {
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM reservations
       WHERE user_id = ${userId}::uuid AND sale_id = ${saleId}::uuid AND status IN ('ACTIVE', 'CHECKOUT')`;
    return rows[0] ?? null;
  }

  /** Покупатель сам убирает позицию из корзины (только ACTIVE — в оплате уже нельзя). */
  releaseByUser(userId: string, reservationId: string): Promise<ReleaseResult> {
    return this.releaseLocked(
      'RELEASED',
      Prisma.sql`
        SELECT id FROM reservations
         WHERE id = ${reservationId}::uuid AND user_id = ${userId}::uuid AND status = 'ACTIVE'
         FOR UPDATE`,
    );
  }

  /**
   * Истечение удержания: ACTIVE с expires_at <= now() → EXPIRED, остаток возвращается на витрину.
   * - Позиции в CHECKOUT (оплата начата) не трогаем — они держат товар до ответа платёжки.
   * - Позиции завершившихся распродаж не трогаем — их отменяет уборка после окончания (с уведомлением).
   * - SKIP LOCKED: строку, которую прямо сейчас переводит в оплату checkout, пропускаем;
   *   после его commit она уже не ACTIVE. Кто первым заблокировал строку, тот и решает её судьбу.
   */
  expireDue(limit = 500): Promise<ReleaseResult> {
    return this.releaseLocked(
      'EXPIRED',
      Prisma.sql`
        SELECT r.id FROM reservations r
          JOIN sales s ON s.id = r.sale_id
         WHERE r.status = 'ACTIVE' AND r.expires_at <= now() AND s.ends_at > now()
         ORDER BY r.expires_at
         LIMIT ${limit}
         FOR UPDATE OF r SKIP LOCKED`,
    );
  }

  /**
   * Общая часть «отпустить позиции и вернуть остаток» одним оператором.
   * Остаток идёт на витрину, если распродажа ещё идёт, иначе — в снятое с продажи (withdrawn_qty).
   * Остаток каждой распродажи меняется одним UPDATE (позиции сгруппированы по sale_id).
   */
  private async releaseLocked(newStatus: 'RELEASED' | 'EXPIRED', lockedIds: Prisma.Sql): Promise<ReleaseResult> {
    const rows = await this.prisma.$queryRaw<{ reservations: ReleasedRow[] | null; stock: StockChange[] | null }[]>`
      WITH r AS (
        UPDATE reservations
           SET status = ${newStatus}::"ReservationStatus", updated_at = now()
         WHERE status = 'ACTIVE' AND id IN (${lockedIds})
        RETURNING id, sale_id, user_id, quantity
      ), agg AS (
        SELECT sale_id, sum(quantity)::int AS qty FROM r GROUP BY sale_id
      ), s AS (
        UPDATE sales
           SET available     = available     + CASE WHEN ends_at > now() THEN agg.qty ELSE 0 END,
               withdrawn_qty = withdrawn_qty + CASE WHEN ends_at > now() THEN 0 ELSE agg.qty END,
               version = version + 1
          FROM agg
         WHERE sales.id = agg.sale_id
        RETURNING sales.id, sales.available, sales.version
      )
      SELECT
        (SELECT json_agg(json_build_object('id', id, 'saleId', sale_id, 'userId', user_id, 'quantity', quantity)) FROM r)
          AS reservations,
        (SELECT json_agg(json_build_object('saleId', id, 'available', available, 'version', version)) FROM s)
          AS stock`;
    return { reservations: rows[0].reservations ?? [], stock: rows[0].stock ?? [] };
  }
}
