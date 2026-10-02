import { useEffect, useState } from 'react';

/**
 * Часы сервера в браузере. Все решения (старт, конец, удержание) принимает сервер по часам БД;
 * браузер лишь показывает таймеры — но показывает их по серверному времени, а не по своим часам,
 * иначе у покупателя со сбитыми часами кнопка «открылась» бы раньше или позже остальных.
 *
 * Смещение считается как в NTP: offset = serverTime − (t0 + t1) / 2; берём замер с минимальным RTT.
 */
class ServerClock {
  private offsetMs = 0;
  private bestRtt = Number.POSITIVE_INFINITY;
  private listeners = new Set<() => void>();
  synced = false;

  now(): number {
    return Date.now() + this.offsetMs;
  }

  get offset(): number {
    return this.offsetMs;
  }

  get rtt(): number {
    return this.bestRtt;
  }

  /** Один замер: t0/t1 — локальное время отправки и получения, serverTime — время БД. */
  sample(t0: number, t1: number, serverTimeIso: string) {
    const rtt = t1 - t0;
    // замер заметно хуже лучшего — это шум сети (очередь, ретрансмит), смещение по нему неточное
    if (rtt > this.bestRtt * 1.5 && this.synced) return;
    this.bestRtt = Math.min(rtt, this.bestRtt);
    this.offsetMs = Date.parse(serverTimeIso) - (t0 + t1) / 2;
    this.synced = true;
    for (const l of this.listeners) l();
  }

  /** Сбросить лучший RTT, чтобы следующий цикл синхронизации пересчитал смещение с нуля. */
  resetQuality() {
    this.bestRtt = Number.POSITIVE_INFINITY;
  }

  subscribe(l: () => void) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
}

export const serverClock = new ServerClock();

/** Текущее серверное время с перерисовкой каждые tickMs. */
export function useServerNow(tickMs = 250): number {
  const [now, setNow] = useState(() => serverClock.now());
  useEffect(() => {
    const id = setInterval(() => setNow(serverClock.now()), tickMs);
    const off = serverClock.subscribe(() => setNow(serverClock.now()));
    return () => {
      clearInterval(id);
      off();
    };
  }, [tickMs]);
  return now;
}

/**
 * Перерисовать компонент ровно в момент `atIso` по серверному времени
 * (кнопка «купить» открывается в момент старта, а не на ближайшем тике).
 */
export function useWakeAt(atIso: string | null | undefined) {
  const [, force] = useState(0);
  useEffect(() => {
    if (!atIso) return;
    const delay = Date.parse(atIso) - serverClock.now();
    if (delay <= 0 || delay > 2 ** 31 - 1) return;
    const id = setTimeout(() => force((n) => n + 1), delay + 5);
    return () => clearTimeout(id);
  }, [atIso]);
}
