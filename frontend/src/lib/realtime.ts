import { useEffect, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { io, type Socket } from 'socket.io-client';
import { serverClock } from './clock.ts';
import { useSession } from './session.ts';
import { toast } from './toast.ts';
import { applyStock, type StockEvent } from './sales-cache.ts';
import type { SaleStats } from './types.ts';

let connected = false;
const statusListeners = new Set<() => void>();
const setConnected = (v: boolean) => {
  connected = v;
  statusListeners.forEach((l) => l());
};

export function useConnected(): boolean {
  return useSyncExternalStore(
    (cb) => {
      statusListeners.add(cb);
      return () => statusListeners.delete(cb);
    },
    () => connected,
  );
}

/** Несколько ping с ack — берём замер с минимальным RTT (см. serverClock). */
async function syncClock(s: Socket) {
  serverClock.resetQuality();
  for (let i = 0; i < 5; i++) {
    const t0 = Date.now();
    try {
      const { serverTime } = (await s.timeout(3000).emitWithAck('time:ping')) as { serverTime: string };
      serverClock.sample(t0, Date.now(), serverTime);
    } catch {
      return;
    }
  }
}

/**
 * Одно Socket.IO-соединение на вкладку. Переподключается при смене пользователя (токен в handshake).
 * Все события только обновляют кэш TanStack Query — компоненты перерисовываются сами, без перезагрузки страницы.
 */
export function useRealtime() {
  const session = useSession();
  const qc = useQueryClient();
  const token = session?.token;

  useEffect(() => {
    const s = io({ path: '/socket.io', auth: token ? { token } : {}, transports: ['websocket', 'polling'] });

    s.on('connect', () => {
      setConnected(true);
      void syncClock(s);
      // после разрыва могли пропустить события — берём свежие снимки
      void qc.invalidateQueries();
    });
    s.on('disconnect', () => setConnected(false));

    s.on('sale:stock', (e: StockEvent) => applyStock(qc, e));
    // новая распродажа: карточка должна появиться на открытой витрине без перезагрузки
    // статистику магазина не перезапрашиваем: сервер сам присылает shop:stats (GET без версии мог бы откатить push)
    s.on('sale:created', () => void qc.invalidateQueries({ queryKey: ['sales'] }));
    s.on('sale:started', () => void qc.invalidateQueries({ queryKey: ['sales'] }));
    s.on('sale:ended', () => {
      void qc.invalidateQueries({ queryKey: ['sales'] });
      void qc.invalidateQueries({ queryKey: ['cart'] });
    });

    s.on('reservation:updated', (e: { status: string }) => {
      void qc.invalidateQueries({ queryKey: ['cart'] });
      void qc.invalidateQueries({ queryKey: ['history'] });
      if (e.status === 'EXPIRED') toast('Время удержания истекло — товар вернулся на витрину', 'error', 7000);
    });
    s.on('order:updated', (e: { status: string }) => {
      void qc.invalidateQueries({ queryKey: ['orders'] });
      void qc.invalidateQueries({ queryKey: ['cart'] });
      if (e.status === 'PAID') toast('Оплата прошла — заказ оформлен. Письмо отправлено на почту.', 'success', 7000);
      if (e.status === 'FAILED') toast('Оплата отклонена — товар вернулся на витрину', 'error', 7000);
    });
    s.on('notification', (e: { title: string; body: string }) => {
      void qc.invalidateQueries({ queryKey: ['notifications'] });
      toast(`${e.title}: ${e.body}`, 'info', 9000);
    });
    s.on('shop:stats', (e: { sales: SaleStats[] }) => {
      qc.setQueryData(['shopStats'], (prev: { serverTime: string } | undefined) => ({
        serverTime: prev?.serverTime ?? new Date(serverClock.now()).toISOString(),
        sales: e.sales,
      }));
    });

    const resync = setInterval(() => void syncClock(s), 30_000);
    return () => {
      clearInterval(resync);
      s.disconnect();
      setConnected(false);
    };
  }, [token, qc]);
}
