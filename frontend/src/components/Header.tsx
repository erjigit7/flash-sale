import { useQuery, useQueryClient } from '@tanstack/react-query';
import { NavLink, useNavigate } from 'react-router';
import { api } from '../lib/api.ts';
import { serverClock, useServerNow } from '../lib/clock.ts';
import { useConnected } from '../lib/realtime.ts';
import { setSession, useSession } from '../lib/session.ts';

export function Header() {
  const session = useSession();
  const connected = useConnected();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const buyer = session?.user.role === 'BUYER';
  useServerNow(5000); // перерисовать индикатор синхронизации часов

  const cart = useQuery({ queryKey: ['cart'], queryFn: api.cart, enabled: buyer });
  const cartCount = cart.data?.items.filter((i) => i.status === 'ACTIVE').length ?? 0;

  function logout() {
    setSession(null);
    qc.clear();
    navigate('/');
  }

  const offset = Math.round(serverClock.offset);
  return (
    <header className="header">
      <div className="header-inner">
        <NavLink to="/" className="brand">
          <span className="brand-mark">⚡</span> Флэш-распродажа
        </NavLink>
        <nav className="nav">
          <NavLink to="/" end>
            Витрина
          </NavLink>
          {buyer && (
            <NavLink to="/cart">
              Корзина{cartCount > 0 && <span className="badge-count">{cartCount}</span>}
            </NavLink>
          )}
          {buyer && <NavLink to="/account">Кабинет</NavLink>}
          <NavLink to="/shop">Магазин</NavLink>
        </nav>
        <div className="header-right">
          <span title="Соединение для обновлений в реальном времени">
            <span className={`dot ${connected ? 'on' : 'off'}`} />
            {connected ? 'онлайн' : 'нет связи'}
          </span>
          <span
            className="num"
            title={`Таймеры идут по часам сервера. Смещение часов этой вкладки относительно сервера: ${offset} мс (RTT ${Math.round(serverClock.rtt)} мс)`}
          >
            ⏱ {serverClock.synced ? `${offset >= 0 ? '+' : ''}${offset} мс` : '…'}
          </span>
          {session ? (
            <>
              <span className="who">{session.user.role === 'SHOP' ? 'Магазин' : session.user.email}</span>
              <button className="ghost" onClick={logout}>
                Выйти
              </button>
            </>
          ) : (
            <NavLink to="/login" className="btn">
              Войти
            </NavLink>
          )}
        </div>
      </div>
    </header>
  );
}
