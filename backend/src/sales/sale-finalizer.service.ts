import { Injectable, Logger } from '@nestjs/common';
import { DomainEvents } from '../events/domain-events.js';
import { PrismaService } from '../prisma/prisma.service.js';

interface FinalizeRow {
  saleId: string;
  available: number;
  version: number;
  cancelled: { reservationId: string; userId: string; notificationId: string | null }[] | null;
}

const NOTIFICATION_TITLE = 'Распродажа завершилась';

/**
 * Уборка после окончания распродажи («непроданное снимается, неоплаченные корзины очищаются,
 * их владельцы получают уведомление»). Одна распродажа — один SQL-оператор, т.е. атомарно:
 *  - позиции ACTIVE → CANCELLED (их количество уходит в «снято», а не на витрину);
 *  - каждому владельцу — уведомление в кабинет и письмо (outbox), оба с dedup_key — ровно один раз;
 *  - остаток витрины → withdrawn_qty, available = 0, finalized_at.
 * Позиции CHECKOUT (оплата начата до конца) не трогаем: оплата досчитается; при отказе товар уйдёт в «снято».
 * Повторный запуск ничего не меняет (условие отбора + dedup_key); «опоздавший» остаток, вернувшийся
 * после окончания, подберёт следующий проход (условие available > 0).
 */
@Injectable()
export class SaleFinalizer {
  private readonly log = new Logger(SaleFinalizer.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: DomainEvents,
  ) {}

  async finalizeEnded(maxSales = 10): Promise<number> {
    let done = 0;
    for (let i = 0; i < maxSales; i++) {
      const row = await this.finalizeOne();
      if (!row) break;
      done++;
      this.publish(row);
    }
    return done;
  }

  private async finalizeOne(): Promise<FinalizeRow | null> {
    const rows = await this.prisma.$queryRaw<FinalizeRow[]>`
      WITH target AS (
        SELECT id, title FROM sales
         WHERE ends_at <= now() AND (finalized_at IS NULL OR available > 0)
         ORDER BY ends_at
         LIMIT 1
         FOR UPDATE SKIP LOCKED
      ), r AS (
        UPDATE reservations res SET status = 'CANCELLED', updated_at = now()
          FROM target
         WHERE res.sale_id = target.id AND res.status = 'ACTIVE'
        RETURNING res.id, res.user_id, res.quantity
      ), n AS (
        INSERT INTO notifications (user_id, dedup_key, type, title, body)
        SELECT r.user_id, 'sale-ended:' || r.id, 'sale_ended', ${NOTIFICATION_TITLE},
               'Распродажа «' || target.title || '» закончилась до оплаты. Товар снят из вашей корзины.'
          FROM r CROSS JOIN target
        ON CONFLICT (dedup_key) DO NOTHING
        RETURNING id, dedup_key
      ), e AS (
        INSERT INTO email_outbox (dedup_key, to_email, subject, body)
        SELECT 'sale-ended:' || r.id, u.email,
               'Распродажа «' || target.title || '» завершилась — корзина очищена',
               'Здравствуйте!' || E'\n\n' ||
               'Распродажа «' || target.title || '» закончилась, а оплата товара из вашей корзины не была начата.' || E'\n' ||
               'Товар снят с продажи, деньги не списывались.' || E'\n\n' ||
               'Следите за новыми распродажами на витрине.'
          FROM r JOIN users u ON u.id = r.user_id CROSS JOIN target
        ON CONFLICT (dedup_key) DO NOTHING
      ), s AS (
        UPDATE sales
           SET withdrawn_qty = withdrawn_qty + available + (SELECT COALESCE(sum(quantity), 0) FROM r)::int,
               available = 0,
               finalized_at = COALESCE(finalized_at, now()),
               version = version + 1
          FROM target
         WHERE sales.id = target.id
        RETURNING sales.id, sales.available, sales.version
      )
      SELECT s.id AS "saleId", s.available, s.version,
             (SELECT json_agg(json_build_object(
                       'reservationId', r.id, 'userId', r.user_id,
                       'notificationId', (SELECT n.id FROM n WHERE n.dedup_key = 'sale-ended:' || r.id)))
                FROM r) AS cancelled
        FROM s`;
    return rows[0] ?? null;
  }

  private publish(row: FinalizeRow) {
    this.events.emit('stock.changed', { saleId: row.saleId, available: row.available, version: row.version });
    for (const c of row.cancelled ?? []) {
      this.events.emit('reservation.changed', {
        userId: c.userId,
        reservationId: c.reservationId,
        saleId: row.saleId,
        status: 'CANCELLED',
      });
      if (c.notificationId) {
        this.events.emit('notification.created', {
          userId: c.userId,
          notificationId: c.notificationId,
          type: 'sale_ended',
          title: NOTIFICATION_TITLE,
          body: 'Распродажа закончилась до оплаты. Товар снят из вашей корзины.',
        });
      }
    }
    if (row.cancelled?.length) this.log.log(`sale ${row.saleId} finalized: ${row.cancelled.length} carts cleared`);
  }
}
