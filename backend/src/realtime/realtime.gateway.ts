import { Logger, OnModuleDestroy } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  OnGatewayConnection,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import { ClockService } from '../clock/clock.service.js';
import { DomainEvents } from '../events/domain-events.js';
import type { JwtPayload } from '../auth/auth.types.js';

/** Комнаты Socket.IO */
export const Rooms = {
  /** Все подключённые: витрина (остатки, старт/конец распродаж) */
  showcase: 'showcase',
  /** Личные события покупателя: корзина, заказы, уведомления */
  user: (id: string) => `user:${id}`,
  /** Экран магазина */
  shop: 'shop',
} as const;

/**
 * Realtime-шлюз. Сам ничего не решает: пересылает доменные события (опубликованные после commit)
 * в нужные комнаты. Аутентификация — тот же JWT в handshake.auth.token; без токена сокет видит только витрину.
 */
@WebSocketGateway({ path: '/socket.io', serveClient: false })
export class RealtimeGateway implements OnGatewayInit, OnGatewayConnection, OnModuleDestroy {
  private readonly log = new Logger(RealtimeGateway.name);
  private readonly unsubscribe: (() => void)[] = [];

  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly events: DomainEvents,
    private readonly jwt: JwtService,
    private readonly clock: ClockService,
  ) {}

  afterInit() {
    const ev = this.events;
    this.unsubscribe.push(
      ev.on('stock.changed', (e) => this.server.to([Rooms.showcase, Rooms.shop]).emit('sale:stock', e)),
      ev.on('sale.started', (e) => this.server.to([Rooms.showcase, Rooms.shop]).emit('sale:started', e)),
      ev.on('sale.ended', (e) => this.server.to([Rooms.showcase, Rooms.shop]).emit('sale:ended', e)),
      ev.on('reservation.changed', (e) => this.server.to(Rooms.user(e.userId)).emit('reservation:updated', e)),
      ev.on('order.changed', (e) => this.server.to(Rooms.user(e.userId)).emit('order:updated', e)),
      ev.on('notification.created', (e) => this.server.to(Rooms.user(e.userId)).emit('notification', e)),
    );
  }

  onModuleDestroy() {
    for (const off of this.unsubscribe) off();
  }

  async handleConnection(socket: Socket) {
    await socket.join(Rooms.showcase);
    const token = (socket.handshake.auth as { token?: unknown } | undefined)?.token;
    if (typeof token !== 'string' || !token) return;
    try {
      const payload = await this.jwt.verifyAsync<JwtPayload>(token);
      await socket.join(payload.role === 'SHOP' ? Rooms.shop : Rooms.user(payload.sub));
    } catch {
      // протухший токен: остаёмся зрителем витрины, клиент перелогинится
      socket.emit('auth:invalid');
    }
  }

  /**
   * Синхронизация часов: клиент шлёт ping с ack и считает смещение как в NTP:
   * offset = serverTime − (t0 + t1) / 2. Время — из БД, как и во всех решениях сервера.
   */
  @SubscribeMessage('time:ping')
  async timePing() {
    return { serverTime: (await this.clock.now()).toISOString() };
  }
}
