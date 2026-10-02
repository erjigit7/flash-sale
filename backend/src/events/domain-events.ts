import { Injectable } from '@nestjs/common';
import { EventEmitter } from 'node:events';

/**
 * Внутренняя шина событий. Сервисы публикуют события ТОЛЬКО после commit транзакции;
 * realtime-шлюз подписывается и рассылает их по Socket.IO-комнатам.
 * Так бизнес-логика не знает про сокеты, а тесты могут слушать те же события.
 */
export interface DomainEventMap {
  /** Остаток на витрине изменился (version растёт монотонно — клиент отбрасывает старые события) */
  'stock.changed': { saleId: string; available: number; version: number };
  /** Позиция корзины сменила статус */
  'reservation.changed': { userId: string; reservationId: string; saleId: string; status: string };
  /** Заказ сменил статус */
  'order.changed': { userId: string; orderId: string; saleId: string; status: string };
  /** Магазин выставил новую распродажу — витрины должны показать карточку без перезагрузки */
  'sale.created': { saleId: string };
  /** Распродажа стартовала / закончилась (момент по часам БД) */
  'sale.started': { saleId: string };
  'sale.ended': { saleId: string };
  /** Новое уведомление покупателю */
  'notification.created': { userId: string; notificationId: string; type: string; title: string; body: string };
}

export type DomainEventName = keyof DomainEventMap;

@Injectable()
export class DomainEvents {
  private readonly emitter = new EventEmitter({ captureRejections: true });

  constructor() {
    this.emitter.setMaxListeners(100);
  }

  emit<K extends DomainEventName>(name: K, payload: DomainEventMap[K]): void {
    this.emitter.emit(name, payload);
  }

  on<K extends DomainEventName>(name: K, listener: (payload: DomainEventMap[K]) => void): () => void {
    this.emitter.on(name, listener);
    return () => this.emitter.off(name, listener);
  }
}
