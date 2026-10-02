const rub = new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 0 });

export function money(cents: number): string {
  return rub.format(cents / 100);
}

/** 3725 c → «1:02:05», 125 c → «02:05» */
export function duration(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  if (h > 0) return `${h}:${mm}:${ss}`;
  return `${mm}:${ss}`;
}

export function dateTime(iso: string): string {
  return new Date(iso).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}

/** Текст ошибки по машинному коду сервера */
export function errorText(code: string, details: Record<string, unknown> = {}, fallback = 'Что-то пошло не так'): string {
  switch (code) {
    case 'sold_out':
      return 'Закончилось';
    case 'insufficient_stock':
      return `Осталось только ${details.available} шт. — уменьшите количество`;
    case 'qty_over_limit':
      return `Не больше ${details.maxPerOrder} шт. в одни руки`;
    case 'not_started':
      return 'Распродажа ещё не началась';
    case 'sale_ended':
      return 'Распродажа закончилась';
    case 'already_in_cart':
      return 'Этот товар уже в вашей корзине';
    case 'hold_expired':
      return 'Время удержания истекло — товар вернулся на витрину';
    case 'not_releasable':
      return 'Позицию уже нельзя убрать — оплата начата';
    case 'bad_password':
      return 'Неверный пароль магазина';
    case 'unauthorized':
      return 'Нужно войти';
    default:
      return fallback;
  }
}
