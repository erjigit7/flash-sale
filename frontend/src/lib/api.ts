import { serverClock } from './clock.ts';
import { getSession, setSession } from './session.ts';
import type { CartItem, Notification, Order, Sale, SaleStats, Scenario, User } from './types.ts';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(status: number, code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function request<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const session = getSession();
  const t0 = Date.now();
  const res = await fetch(`/api${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(session ? { authorization: `Bearer ${session.token}` } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const t1 = Date.now();
  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  // каждый ответ с serverTime — заодно замер для синхронизации часов
  if (typeof data.serverTime === 'string') serverClock.sample(t0, t1, data.serverTime);
  if (!res.ok) {
    if (res.status === 401 && session) setSession(null);
    const { error, message, ...details } = data as { error?: string; message?: string };
    throw new ApiError(res.status, error ?? 'http_error', message ?? `Ошибка ${res.status}`, details);
  }
  return data as T;
}

export const api = {
  login: (email: string, name?: string) =>
    request<{ token: string; user: User }>('POST', '/auth/login', { email, name: name || undefined }),
  shopLogin: (password: string) => request<{ token: string; user: User }>('POST', '/auth/shop-login', { password }),

  sales: () => request<{ serverTime: string; sales: Sale[] }>('GET', '/sales'),

  reserve: (saleId: string, quantity: number) =>
    request<{
      serverTime: string;
      reservation: { id: string; expiresAt: string };
      sale: { id: string; available: number; version: number };
    }>('POST', '/reservations', { saleId, quantity }),
  cart: () => request<{ serverTime: string; items: CartItem[] }>('GET', '/reservations'),
  history: () => request<{ serverTime: string; items: CartItem[] }>('GET', '/reservations?scope=all'),
  release: (reservationId: string) => request<void>('DELETE', `/reservations/${reservationId}`),

  checkout: (reservationId: string, scenario: Scenario, idempotencyKey: string) =>
    request<{ order: Order; replay: boolean }>(
      'POST',
      '/orders',
      { reservationId, scenario },
      { 'idempotency-key': idempotencyKey },
    ),
  orders: () => request<{ orders: Order[] }>('GET', '/orders'),
  notifications: () => request<{ notifications: Notification[] }>('GET', '/notifications'),
  readNotifications: () => request<void>('POST', '/notifications/read-all'),

  shopStats: () => request<{ serverTime: string; sales: SaleStats[] }>('GET', '/shop/stats'),
  createSale: (body: {
    title: string;
    description?: string;
    priceCents: number;
    oldPriceCents?: number;
    totalQty: number;
    maxPerOrder: number;
    startsInSeconds?: number;
    startsAt?: string;
    durationSeconds: number;
  }) => request<Sale>('POST', '/shop/sales', body),
};
