import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router';
import { api, ApiError } from '../lib/api.ts';
import { useServerNow, useWakeAt } from '../lib/clock.ts';
import { duration, errorText, money } from '../lib/format.ts';
import { useSession } from '../lib/session.ts';
import { toast } from '../lib/toast.ts';
import type { Sale, SaleStatus } from '../lib/types.ts';

const PALETTE = ['#d6402c', '#2c6bd6', '#1f8a5b', '#8a3fd1', '#c97a12', '#0f8a9e'];

function artColor(id: string) {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

/** Фаза по серверным часам вкладки: кнопка у всех вкладок открывается в один и тот же момент. */
function phaseAt(sale: Sale, now: number): SaleStatus {
  if (now < Date.parse(sale.startsAt)) return 'UPCOMING';
  if (now < Date.parse(sale.endsAt)) return 'LIVE';
  return 'ENDED';
}

export function SaleCard({ sale, inCart }: { sale: Sale; inCart: boolean }) {
  const now = useServerNow(250);
  useWakeAt(sale.startsAt);
  useWakeAt(sale.endsAt);
  const phase = phaseAt(sale, now);
  const session = useSession();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [qty, setQty] = useState(1);
  const [error, setError] = useState<string | null>(null);

  // подсветка остатка при изменении (видно, что обновилось «само», без перезагрузки)
  const [flash, setFlash] = useState(false);
  const prevAvailable = useRef(sale.available);
  useEffect(() => {
    if (prevAvailable.current !== sale.available) {
      prevAvailable.current = sale.available;
      setFlash(true);
      const id = setTimeout(() => setFlash(false), 900);
      return () => clearTimeout(id);
    }
  }, [sale.available]);

  const maxQty = Math.max(1, Math.min(sale.maxPerOrder, sale.available));
  useEffect(() => {
    if (qty > maxQty) setQty(maxQty);
  }, [qty, maxQty]);
  useEffect(() => setError(null), [sale.available, phase]);

  const reserve = useMutation({
    mutationFn: () => api.reserve(sale.id, qty),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['cart'] });
      toast(`«${sale.title}» в корзине — товар удерживается за вами 10 минут`, 'success');
    },
    onError: (err) => {
      if (err instanceof ApiError) {
        setError(errorText(err.code, err.details, err.message));
        if (err.code === 'already_in_cart') void qc.invalidateQueries({ queryKey: ['cart'] });
      } else setError('Сервер недоступен');
    },
  });

  function onBuy() {
    if (!session) return navigate('/login');
    if (session.user.role !== 'BUYER') return setError('Магазин не может покупать — войдите как покупатель');
    setError(null);
    reserve.mutate();
  }

  const soldPct = sale.totalQty ? Math.round(((sale.totalQty - sale.available) / sale.totalQty) * 100) : 0;
  const off = sale.oldPriceCents ? Math.round((1 - sale.priceCents / sale.oldPriceCents) * 100) : 0;

  let button;
  if (inCart) {
    button = (
      <Link to="/cart" className="btn" style={{ flex: 1, justifyContent: 'center' }}>
        В корзине → оплатить
      </Link>
    );
  } else if (phase === 'UPCOMING') {
    button = <button disabled>Старт через {duration(Date.parse(sale.startsAt) - now)}</button>;
  } else if (phase === 'ENDED') {
    button = <button disabled>Распродажа завершена</button>;
  } else if (sale.available === 0) {
    button = <button disabled>Закончилось</button>;
  } else {
    button = (
      <button className="primary" onClick={onBuy} disabled={reserve.isPending}>
        {reserve.isPending ? <span className="spinner" /> : null} В корзину
      </button>
    );
  }

  return (
    <article className="card sale" data-testid={`sale-${sale.id}`}>
      <div className="sale-art" style={{ background: `linear-gradient(135deg, ${artColor(sale.id)}, #1c1b19)` }}>
        {off > 0 ? `−${off}%` : '⚡'}
      </div>
      <div className="sale-body">
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'start' }}>
          <h3 className="sale-title">{sale.title}</h3>
          <span className={`badge ${phase.toLowerCase()}`}>
            {phase === 'LIVE' ? 'идёт' : phase === 'UPCOMING' ? 'скоро' : 'завершена'}
          </span>
        </div>
        {sale.description && <p className="muted small" style={{ margin: 0 }}>{sale.description}</p>}
        <div className="price">
          <span className="price-now">{money(sale.priceCents)}</span>
          {sale.oldPriceCents && <span className="price-old">{money(sale.oldPriceCents)}</span>}
        </div>
        <div className="stock">
          <div className="stock-row">
            <span className={flash ? 'flash' : ''} data-testid="available">
              Осталось <strong className="num">{sale.available}</strong> из {sale.totalQty}
            </span>
            <span>до {sale.maxPerOrder} шт. в руки</span>
          </div>
          <div className="stock-bar" aria-hidden>
            <div className="stock-fill" style={{ width: `${soldPct}%` }} />
          </div>
        </div>
        <div className="timer">
          {phase === 'UPCOMING' && (
            <>
              Старт через <strong>{duration(Date.parse(sale.startsAt) - now)}</strong>
            </>
          )}
          {phase === 'LIVE' && (
            <>
              До конца <strong>{duration(Date.parse(sale.endsAt) - now)}</strong>
            </>
          )}
          {phase === 'ENDED' && 'Непроданное снято с продажи'}
        </div>
        <div className="buy-row">
          {phase === 'LIVE' && sale.available > 0 && !inCart && sale.maxPerOrder > 1 && (
            <select value={qty} onChange={(e) => setQty(Number(e.target.value))} aria-label="Количество">
              {Array.from({ length: maxQty }, (_, i) => i + 1).map((n) => (
                <option key={n} value={n}>
                  {n} шт.
                </option>
              ))}
            </select>
          )}
          {button}
        </div>
        {error && <div className="form-error">{error}</div>}
      </div>
    </article>
  );
}
