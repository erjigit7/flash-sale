import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DomainEvents } from '../events/domain-events.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { RealtimeGateway, Rooms } from '../realtime/realtime.gateway.js';

export interface SaleStats {
  id: string;
  title: string;
  status: 'UPCOMING' | 'LIVE' | 'ENDED';
  priceCents: number;
  totalQty: number;
  startsAt: Date;
  endsAt: Date;
  /** Остаток на витрине */
  available: number;
  /** В корзинах (удержание, оплата не начата) */
  inCarts: number;
  /** Оплата начата, ждём платёжку (в том числе «зависшие») */
  awaitingPayment: number;
  sold: number;
  /** Снято с продажи по окончании */
  withdrawn: number;
  revenueCents: number;
  ordersPaid: number;
  ordersPending: number;
  ordersFailed: number;
}

/**
 * Статистика для экрана магазина — одним запросом, по часам БД.
 * Живое обновление: на любое изменение остатка/корзины/заказа пересчитываем и шлём в комнату shop,
 * но не чаще раза в 250 мс (во время ажиотажа событий сотни в секунду).
 */
@Injectable()
export class ShopStatsService implements OnModuleInit, OnModuleDestroy {
  static readonly THROTTLE_MS = 250;
  private readonly log = new Logger(ShopStatsService.name);
  private timer: NodeJS.Timeout | null = null;
  private readonly unsubscribe: (() => void)[] = [];

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: DomainEvents,
    private readonly gateway: RealtimeGateway,
  ) {}

  onModuleInit() {
    const schedule = () => this.schedulePush();
    this.unsubscribe.push(
      this.events.on('stock.changed', schedule),
      this.events.on('reservation.changed', schedule),
      this.events.on('order.changed', schedule),
    );
  }

  onModuleDestroy() {
    for (const off of this.unsubscribe) off();
    if (this.timer) clearTimeout(this.timer);
  }

  stats(): Promise<SaleStats[]> {
    return this.prisma.$queryRaw<SaleStats[]>`
      SELECT s.id, s.title, s.price_cents AS "priceCents", s.total_qty AS "totalQty",
             s.starts_at AS "startsAt", s.ends_at AS "endsAt",
             CASE WHEN now() < s.starts_at THEN 'UPCOMING' WHEN now() < s.ends_at THEN 'LIVE' ELSE 'ENDED' END AS status,
             s.available,
             COALESCE(r.in_carts, 0)::int          AS "inCarts",
             COALESCE(r.awaiting, 0)::int          AS "awaitingPayment",
             COALESCE(r.sold, 0)::int              AS sold,
             s.withdrawn_qty                       AS withdrawn,
             COALESCE(o.revenue, 0)::int           AS "revenueCents",
             COALESCE(o.paid, 0)::int              AS "ordersPaid",
             COALESCE(o.pending, 0)::int           AS "ordersPending",
             COALESCE(o.failed, 0)::int            AS "ordersFailed"
        FROM sales s
        LEFT JOIN (
          SELECT sale_id,
                 sum(quantity) FILTER (WHERE status = 'ACTIVE')    AS in_carts,
                 sum(quantity) FILTER (WHERE status = 'CHECKOUT')  AS awaiting,
                 sum(quantity) FILTER (WHERE status = 'PURCHASED') AS sold
            FROM reservations GROUP BY sale_id
        ) r ON r.sale_id = s.id
        LEFT JOIN (
          SELECT sale_id,
                 sum(amount_cents) FILTER (WHERE status = 'PAID') AS revenue,
                 count(*) FILTER (WHERE status = 'PAID')          AS paid,
                 count(*) FILTER (WHERE status = 'PENDING')       AS pending,
                 count(*) FILTER (WHERE status = 'FAILED')        AS failed
            FROM orders GROUP BY sale_id
        ) o ON o.sale_id = s.id
       ORDER BY CASE WHEN now() < s.starts_at THEN 1 WHEN now() < s.ends_at THEN 0 ELSE 2 END, s.starts_at DESC`;
  }

  /** Троттлинг с «хвостом»: последнее изменение в окне обязательно попадёт в следующую рассылку. */
  private schedulePush() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      // ошибка рассылки статистики не должна ронять процесс (unhandled rejection в Node — фатальна)
      this.push().catch((e: unknown) => this.log.warn(`shop stats push failed: ${(e as Error).message}`));
    }, ShopStatsService.THROTTLE_MS);
    this.timer.unref();
  }

  private async push() {
    const server = this.gateway.server;
    if (!server) return;
    const watchers = await server.in(Rooms.shop).fetchSockets();
    if (watchers.length === 0) return;
    server.to(Rooms.shop).emit('shop:stats', { sales: await this.stats() });
  }
}
