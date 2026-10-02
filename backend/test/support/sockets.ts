import { io, type Socket } from 'socket.io-client';

/** Клиент Socket.IO к тестовому приложению — как вкладка браузера. */
export async function connectSocket(baseUrl: string, token?: string): Promise<Socket> {
  const socket = io(baseUrl, {
    path: '/socket.io',
    transports: ['websocket'],
    auth: token ? { token } : {},
    reconnection: false,
    forceNew: true,
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('connect_error', reject);
  });
  // handleConnection на сервере асинхронный (join комнат после проверки JWT) — даём ему завершиться
  await new Promise((r) => setTimeout(r, 50));
  return socket;
}

/** Ждёт событие, удовлетворяющее условию; падает по таймауту. */
export function waitForEvent<T = unknown>(
  socket: Socket,
  event: string,
  predicate: (payload: T) => boolean = () => true,
  timeoutMs = 3000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`timeout waiting for "${event}"`));
    }, timeoutMs);
    const handler = (payload: T) => {
      if (!predicate(payload)) return;
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(payload);
    };
    socket.on(event, handler);
  });
}

/** Собирает все события за время жизни сокета. */
export function collect<T = unknown>(socket: Socket, event: string): T[] {
  const items: T[] = [];
  socket.on(event, (p: T) => items.push(p));
  return items;
}
