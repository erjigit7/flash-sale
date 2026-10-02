import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { AppError } from '../common/app-error.js';
import { isUniqueViolation } from '../common/db-errors.js';
import { AppConfig } from '../config/app-config.js';
import { DomainEvents } from '../events/domain-events.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ReservationsRepository, type ReleaseResult, type ReservedRow } from './reservations.repository.js';

const LIVE_RESERVATION_INDEX = 'reservations_one_live_per_user_sale';

@Injectable()
export class ReservationsService {
  private readonly log = new Logger(ReservationsService.name);

  constructor(
    private readonly repo: ReservationsRepository,
    private readonly prisma: PrismaService,
    private readonly events: DomainEvents,
    private readonly config: AppConfig,
  ) {}

  /**
   * Положить в корзину. Корректность обеспечивает один атомарный SQL (repo.reserve);
   * здесь — только перевод неудачи в понятный клиенту код.
   * Если просят больше, чем осталось, — отказ целиком, без частичной продажи (договорённость с заказчиком).
   */
  async reserve(userId: string, saleId: string, qty: number): Promise<ReservedRow> {
    // Повтор нужен только для честного ответа: если между неудачным списанием и диагностикой
    // кто-то вернул товар, диагностика не найдёт причины — пробуем списать ещё раз.
    for (let attempt = 0; attempt < 3; attempt++) {
      let row: ReservedRow | null;
      try {
        row = await this.repo.reserve(userId, saleId, qty, this.config.holdTtlSeconds);
      } catch (error) {
        if (isUniqueViolation(error, LIVE_RESERVATION_INDEX)) {
          const existing = await this.repo.findLiveForUser(userId, saleId);
          throw new AppError(HttpStatus.CONFLICT, 'already_in_cart', 'Этот товар уже в вашей корзине', {
            reservationId: existing?.id,
          });
        }
        throw error;
      }

      if (row) {
        this.events.emit('stock.changed', { saleId, available: row.available, version: row.version });
        this.events.emit('reservation.changed', { userId, reservationId: row.id, saleId, status: 'ACTIVE' });
        return row;
      }

      const sale = await this.repo.diagnose(saleId);
      if (!sale) throw new AppError(HttpStatus.NOT_FOUND, 'sale_not_found', 'Распродажа не найдена');
      if (!sale.started) {
        throw new AppError(HttpStatus.CONFLICT, 'not_started', 'Распродажа ещё не началась', {
          startsAt: sale.startsAt,
        });
      }
      if (sale.ended) throw new AppError(HttpStatus.CONFLICT, 'sale_ended', 'Распродажа закончилась');
      if (qty > sale.maxPerOrder) {
        throw new AppError(HttpStatus.BAD_REQUEST, 'qty_over_limit', `Не больше ${sale.maxPerOrder} шт. в одни руки`, {
          maxPerOrder: sale.maxPerOrder,
        });
      }
      if (sale.available === 0) {
        throw new AppError(HttpStatus.CONFLICT, 'sold_out', 'Закончилось', { available: 0 });
      }
      if (sale.available < qty) {
        throw new AppError(HttpStatus.CONFLICT, 'insufficient_stock', `Осталось только ${sale.available} шт.`, {
          available: sale.available,
        });
      }
      this.log.debug(`reserve retry ${attempt + 1} for sale ${saleId}: stock changed concurrently`);
    }
    throw new AppError(HttpStatus.CONFLICT, 'sold_out', 'Закончилось', { available: 0 });
  }

  async release(userId: string, reservationId: string): Promise<void> {
    const result = await this.repo.releaseByUser(userId, reservationId);
    if (result.reservations.length === 0) {
      throw new AppError(
        HttpStatus.CONFLICT,
        'not_releasable',
        'Позицию нельзя убрать: её нет в корзине или оплата уже начата',
      );
    }
    this.publishReleased(result, 'RELEASED');
  }

  /** Вызывается воркером раз в секунду (и тестами напрямую). */
  async expireDue(): Promise<ReleaseResult> {
    const result = await this.repo.expireDue();
    this.publishReleased(result, 'EXPIRED');
    return result;
  }

  listForUser(userId: string, scope: 'cart' | 'all') {
    return this.prisma.reservation.findMany({
      where: { userId, ...(scope === 'cart' ? { status: { in: ['ACTIVE', 'CHECKOUT'] } } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: {
        id: true,
        saleId: true,
        quantity: true,
        unitPriceCents: true,
        status: true,
        expiresAt: true,
        createdAt: true,
        sale: { select: { title: true, endsAt: true } },
        order: { select: { id: true, status: true } },
      },
    });
  }

  private publishReleased(result: ReleaseResult, status: 'RELEASED' | 'EXPIRED') {
    for (const s of result.stock) this.events.emit('stock.changed', s);
    for (const r of result.reservations) {
      this.events.emit('reservation.changed', { userId: r.userId, reservationId: r.id, saleId: r.saleId, status });
    }
  }
}
