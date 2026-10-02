import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { DomainEvents } from '../events/domain-events.js';

type Boundary = 'start' | 'end';

/**
 * Точные таймеры на старт и конец распродаж — для realtime-сигнала «покупка открылась» / «закончилась».
 * Важно: это только сигнал для UI. Купить до старта нельзя независимо от него — проверка в атомарном SQL.
 * Задержка считается по часам БД (starts_at − now()), не по часам Node.
 * Метод planUpcoming() вызывается воркером периодически и после создания распродажи; повторный вызов
 * не создаёт дубликатов (ключ — id + граница + момент).
 */
@Injectable()
export class SaleScheduler implements OnModuleDestroy {
  private readonly log = new Logger(SaleScheduler.name);
  private readonly timers = new Map<string, NodeJS.Timeout>();
  /** Насколько вперёд ставим таймеры; дальние подхватит следующий вызов */
  static readonly LOOKAHEAD_SECONDS = 60;

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: DomainEvents,
  ) {}

  async planUpcoming(): Promise<number> {
    const rows = await this.prisma.$queryRaw<{ id: string; boundary: Boundary; at: Date; delayMs: number }[]>`
      SELECT id, 'start' AS boundary, starts_at AS at,
             GREATEST(0, EXTRACT(EPOCH FROM (starts_at - now())) * 1000)::float AS "delayMs"
        FROM sales
       WHERE starts_at > now() - interval '5 seconds'
         AND starts_at <= now() + make_interval(secs => ${SaleScheduler.LOOKAHEAD_SECONDS})
      UNION ALL
      SELECT id, 'end', ends_at,
             GREATEST(0, EXTRACT(EPOCH FROM (ends_at - now())) * 1000)::float
        FROM sales
       WHERE ends_at > now() - interval '5 seconds'
         AND ends_at <= now() + make_interval(secs => ${SaleScheduler.LOOKAHEAD_SECONDS})`;

    let planned = 0;
    for (const row of rows) {
      const key = `${row.id}:${row.boundary}:${row.at.getTime()}`;
      if (this.timers.has(key)) continue;
      const timer = setTimeout(() => {
        this.events.emit(row.boundary === 'start' ? 'sale.started' : 'sale.ended', { saleId: row.id });
        // ключ оставляем до истечения окна поиска, чтобы не запланировать повторно
        setTimeout(() => this.timers.delete(key), 10_000).unref();
      }, row.delayMs);
      timer.unref();
      this.timers.set(key, timer);
      planned++;
    }
    if (planned) this.log.debug(`planned ${planned} sale boundary timers`);
    return planned;
  }

  onModuleDestroy() {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }
}
