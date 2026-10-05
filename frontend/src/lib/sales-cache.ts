import { queryOptions, type QueryClient } from '@tanstack/react-query';
import { api } from './api.ts';
import type { Sale } from './types.ts';

export type SalesData = Awaited<ReturnType<typeof api.sales>>;
export type StockEvent = { saleId: string; available: number; version: number };
type Stock = Pick<Sale, 'available' | 'version'>;

/**
 * Самый свежий известный остаток по каждой распродаже — по всем событиям sale:stock, которые вкладка получила,
 * в том числе для распродаж, которых ещё нет в кэше витрины (ответ на первую загрузку или на перезапрос ещё в пути).
 * Версия на сервере растёт монотонно, поэтому «побеждает большая».
 */
const latestStock = new Map<string, Stock>();

/** Правило отката: из двух остатков одной распродажи берём тот, у которого версия больше. */
export function newerStock<T extends Stock>(a: T, b: Stock): T {
  return b.version > a.version ? { ...a, available: b.available, version: b.version } : a;
}

function withLatestStock(sale: Sale): Sale {
  const known = latestStock.get(sale.id);
  return known ? newerStock(sale, known) : sale;
}

/** Событие остатка: запоминаем всегда, в кэш витрины применяем, если карточка там уже есть. */
export function applyStock(qc: QueryClient, e: StockEvent) {
  const known = latestStock.get(e.saleId);
  if (!known || e.version > known.version) latestStock.set(e.saleId, { available: e.available, version: e.version });
  qc.setQueryData<SalesData>(salesQuery.queryKey, (prev) =>
    prev ? { ...prev, sales: prev.sales.map((s) => (s.id === e.saleId ? newerStock(s, e) : s)) } : prev,
  );
}

/** Новая распродажа пришла по событию целиком: добавляем карточку без запроса к серверу. */
export function addSale(qc: QueryClient, sale: Sale) {
  const prev = qc.getQueryData<SalesData>(salesQuery.queryKey);
  if (!prev) {
    // витрина ещё не загружена, а запрос, возможно, ушёл до создания — пусть загрузится заново
    void qc.invalidateQueries({ queryKey: salesQuery.queryKey });
    return;
  }
  if (prev.sales.some((s) => s.id === sale.id)) return;
  qc.setQueryData<SalesData>(salesQuery.queryKey, { ...prev, sales: [...prev.sales, withLatestStock(sale)] });
}

/**
 * Единственный способ загрузить витрину: любой запрос, где бы он ни использовался, сливает ответ сервера
 * с уже полученными событиями остатка. Запрос мог уйти ДО изменения, а ответ прийти ПОСЛЕ sale:stock —
 * без слияния он откатил бы свежий остаток.
 */
export const salesQuery = queryOptions({
  queryKey: ['sales'],
  queryFn: async (): Promise<SalesData> => {
    const fresh = await api.sales();
    return { ...fresh, sales: fresh.sales.map(withLatestStock) };
  },
});
