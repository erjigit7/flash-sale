import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { AppError } from '../common/app-error.js';
import { DomainEvents } from '../events/domain-events.js';
import type { PaymentScenario } from '../generated/prisma/enums.js';
import { PaymentGateway } from '../payments/payment-gateway.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { orderEmail } from './order-emails.js';
import { OrdersRepository, type OrderRow } from './orders.repository.js';

@Injectable()
export class OrdersService {
  private readonly log = new Logger(OrdersService.name);

  constructor(
    private readonly repo: OrdersRepository,
    private readonly gateway: PaymentGateway,
    private readonly events: DomainEvents,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * «Оплатить». Двойное нажатие / повтор запроса / вторая вкладка не создают второго заказа:
   * условный переход позиции в CHECKOUT + уникальные индексы (см. OrdersRepository.checkout).
   * Ответ — сразу после commit; запрос в платёжку уходит асинхронно (и повторяется воркером при сбое).
   */
  async checkout(
    userId: string,
    reservationId: string,
    idempotencyKey: string,
    scenario: PaymentScenario,
  ): Promise<{ order: OrderRow; replay: boolean }> {
    const outcome = await this.repo.checkout(userId, reservationId, idempotencyKey, scenario);
    switch (outcome.kind) {
      case 'created':
        this.events.emit('reservation.changed', {
          userId,
          reservationId,
          saleId: outcome.order.saleId,
          status: 'CHECKOUT',
        });
        this.events.emit('order.changed', {
          userId,
          orderId: outcome.order.id,
          saleId: outcome.order.saleId,
          status: 'PENDING',
        });
        void this.dispatch(outcome.order.id);
        return { order: outcome.order, replay: false };
      case 'replay':
        return { order: outcome.order, replay: true };
      case 'key_reused':
        throw new AppError(
          HttpStatus.UNPROCESSABLE_ENTITY,
          'idempotency_key_reused',
          'Этот ключ идемпотентности уже использован для другой покупки',
        );
      case 'not_found':
        throw new AppError(HttpStatus.NOT_FOUND, 'reservation_not_found', 'Позиция корзины не найдена');
      case 'hold_expired':
        throw new AppError(HttpStatus.GONE, 'hold_expired', 'Время удержания истекло — товар вернулся на витрину', {
          reservationStatus: outcome.status,
        });
    }
  }

  /**
   * Отправить заказ(ы) в платёжку. onlyOrderId — сразу после checkout; null — шаг воркера (повторы).
   * Сбой сети или таймаут — не беда: заказ остаётся PENDING и захватится снова после паузы.
   */
  async dispatch(onlyOrderId: string | null = null): Promise<number> {
    const claimed = await this.repo.claimForDispatch(onlyOrderId);
    for (const order of claimed) {
      try {
        const sale = await this.prisma.sale.findUnique({ where: { id: order.saleId }, select: { title: true } });
        const res = await this.gateway.createPayment({
          idempotencyKey: order.id,
          amountCents: order.amountCents,
          scenario: order.scenario,
          description: `${sale?.title ?? 'Товар'} × ${order.quantity}`,
        });
        await this.repo.setProviderPaymentId(order.id, res.paymentId);
      } catch (error) {
        this.log.warn(`payment dispatch for order ${order.id} failed, will retry: ${(error as Error).message}`);
      }
    }
    return claimed.length;
  }

  /** Результат от платёжки (webhook или reconciler) — идемпотентно. */
  async applyPaymentResult(
    orderId: string,
    result: 'succeeded' | 'declined',
    providerPaymentId: string | null,
  ): Promise<boolean> {
    const applied = await this.repo.applyPaymentResult(orderId, result, providerPaymentId, orderEmail);
    if (!applied) return false;
    const { order } = applied;
    this.events.emit('order.changed', { userId: order.userId, orderId: order.id, saleId: order.saleId, status: order.status });
    this.events.emit('reservation.changed', {
      userId: order.userId,
      reservationId: order.reservationId,
      saleId: order.saleId,
      status: applied.reservationStatus,
    });
    if (applied.stock) this.events.emit('stock.changed', applied.stock);
    return true;
  }

  /**
   * Страховка от потерянного webhook: опросить платёжку по PENDING-заказам.
   * «Заглушка ответила» — досчитываем заказ; «не знает платёж» — переотправим с тем же ключом.
   */
  async reconcile(): Promise<number> {
    const claimed = await this.repo.claimForReconcile();
    let resolved = 0;
    for (const order of claimed) {
      try {
        const payment = await this.gateway.getPayment(order.providerPaymentId!);
        if (!payment) {
          await this.repo.clearProviderPaymentId(order.id, order.providerPaymentId!);
          continue;
        }
        if (payment.status !== 'processing') {
          if (await this.applyPaymentResult(order.id, payment.status, payment.id)) resolved++;
        }
      } catch (error) {
        this.log.warn(`reconcile for order ${order.id} failed: ${(error as Error).message}`);
      }
    }
    return resolved;
  }

  listForUser(userId: string) {
    return this.prisma.order.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: {
        id: true,
        saleId: true,
        reservationId: true,
        quantity: true,
        amountCents: true,
        status: true,
        scenario: true,
        createdAt: true,
        resolvedAt: true,
        sale: { select: { title: true } },
      },
    });
  }
}
