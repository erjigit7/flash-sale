import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { api, ApiError } from '../lib/api.ts';
import { useServerNow } from '../lib/clock.ts';
import { duration, errorText, money } from '../lib/format.ts';
import { idempotencyKeyFor } from '../lib/idempotency.ts';
import { toast } from '../lib/toast.ts';
import type { CartItem, Scenario } from '../lib/types.ts';

const SCENARIOS: { value: Scenario; label: string; hint: string }[] = [
  { value: 'SUCCESS', label: '✓ Оплата пройдёт', hint: 'заглушка подтвердит через ~1,5 с' },
  { value: 'DECLINE', label: '✗ Отклонить', hint: 'заглушка откажет — товар вернётся на витрину' },
  { value: 'HANG', label: '⏳ Зависнуть', hint: 'заглушка не ответит, пока вы не решите в её панели' },
];

const stubPanel = () => `${location.protocol}//${location.hostname}:4000`;

export function CartPage() {
  const cart = useQuery({ queryKey: ['cart'], queryFn: api.cart });
  const items = cart.data?.items ?? [];

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <h1>Корзина</h1>
          <p className="muted" style={{ margin: 0 }}>
            Товар удерживается за вами 10 минут. Не успели оплатить — он вернётся на витрину.
          </p>
        </div>
      </div>
      {cart.isLoading && <div className="card empty">Загружаем…</div>}
      {cart.data && items.length === 0 && (
        <div className="card empty">
          Корзина пуста. <Link to="/">На витрину →</Link>
        </div>
      )}
      <div className="list">
        {items.map((item) => (
          <CartLine key={item.id} item={item} />
        ))}
      </div>
    </main>
  );
}

function CartLine({ item }: { item: CartItem }) {
  const now = useServerNow(250);
  const qc = useQueryClient();
  const [scenario, setScenario] = useState<Scenario>('SUCCESS');
  const [error, setError] = useState<string | null>(null);
  const left = Date.parse(item.expiresAt) - now;
  const expired = item.status === 'ACTIVE' && left <= 0;

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['cart'] });
    void qc.invalidateQueries({ queryKey: ['orders'] });
  };

  // Защита от двойного клика на клиенте — только для UX (второй запрос даже не уходит).
  // Гарантию «один заказ» даёт сервер: ключ идемпотентности один на позицию + уникальные индексы.
  const paying = useRef(false);
  const pay = useMutation({
    mutationFn: () => api.checkout(item.id, scenario, idempotencyKeyFor(item.id)),
    onSuccess: (res) => {
      if (!res.replay) toast('Оплата начата — ждём ответ платёжной системы', 'info');
      refresh();
    },
    onSettled: () => {
      paying.current = false;
    },
    onError: (err) => {
      setError(err instanceof ApiError ? errorText(err.code, err.details, err.message) : 'Сервер недоступен — нажмите ещё раз');
      if (err instanceof ApiError) refresh();
    },
  });

  const release = useMutation({
    mutationFn: () => api.release(item.id),
    onSuccess: refresh,
    onError: (err) => setError(err instanceof ApiError ? errorText(err.code, err.details, err.message) : 'Сервер недоступен'),
  });

  return (
    <div className="card line" data-testid={`cart-${item.id}`}>
      <div style={{ display: 'grid', gap: 6 }}>
        <div className="line-title">{item.sale.title}</div>
        <div className="muted small">
          {item.quantity} шт. × {money(item.unitPriceCents)} = <strong>{money(item.quantity * item.unitPriceCents)}</strong>
        </div>
        {item.status === 'ACTIVE' && !expired && (
          <div className={`hold ${left < 60_000 ? 'urgent' : ''}`}>
            <span className="muted small">Удерживается ещё</span> <strong>{duration(left)}</strong>
          </div>
        )}
        {expired && <span className="badge err">Удержание истекло — товар возвращается на витрину</span>}
        {item.status === 'CHECKOUT' && (
          <div style={{ display: 'grid', gap: 4 }}>
            <span className="badge wait">
              <span className="spinner" /> Ожидаем ответ платёжной системы
            </span>
            <span className="muted small">
              Товар закреплён за вами, пока платёжка не ответит — даже если 10 минут уже прошли. Если выбран сценарий
              «зависнуть», решите судьбу платежа в{' '}
              <a href={stubPanel()} target="_blank" rel="noreferrer">
                панели заглушки
              </a>
              .
            </span>
          </div>
        )}
      </div>

      {item.status === 'ACTIVE' && !expired && (
        <div className="pay">
          <div className="scenarios" role="radiogroup" aria-label="Тестовый сценарий оплаты">
            {SCENARIOS.map((s) => (
              <button
                key={s.value}
                type="button"
                role="radio"
                aria-checked={scenario === s.value}
                title={s.hint}
                className={`scenario ${scenario === s.value ? 'selected' : ''}`}
                onClick={() => setScenario(s.value)}
              >
                {s.label}
              </button>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="ghost" onClick={() => release.mutate()} disabled={release.isPending || pay.isPending}>
              Убрать
            </button>
            <button
              className="primary"
              onClick={() => {
                if (paying.current) return;
                paying.current = true;
                pay.mutate();
              }}
              disabled={pay.isPending}
            >
              {pay.isPending && <span className="spinner" />} Оплатить {money(item.quantity * item.unitPriceCents)}
            </button>
          </div>
          {error && <div className="form-error">{error}</div>}
        </div>
      )}
    </div>
  );
}
