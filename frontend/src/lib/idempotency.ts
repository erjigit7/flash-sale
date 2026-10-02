/**
 * Ключ идемпотентности оплаты — один на позицию корзины. Генерируется при первом нажатии «Оплатить»
 * и переиспользуется при любом повторе (двойной клик, повтор после сетевой ошибки, перезагрузка вкладки).
 * Сервер по этому ключу (и по самой позиции) вернёт тот же заказ, а не создаст второй.
 */
export function idempotencyKeyFor(reservationId: string): string {
  const storageKey = `flash-sale:idem:${reservationId}`;
  try {
    const existing = sessionStorage.getItem(storageKey);
    if (existing) return existing;
    const key = crypto.randomUUID();
    sessionStorage.setItem(storageKey, key);
    return key;
  } catch {
    return `${reservationId}-pay`;
  }
}
