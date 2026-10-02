import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api.ts';
import { dateTime, money } from '../lib/format.ts';
import { useSession } from '../lib/session.ts';
import type { OrderStatus, ReservationStatus } from '../lib/types.ts';

const ORDER_STATUS: Record<OrderStatus, { text: string; cls: string }> = {
  PENDING: { text: 'Ожидает оплаты', cls: 'wait' },
  PAID: { text: 'Оплачен', cls: 'ok' },
  FAILED: { text: 'Оплата отклонена', cls: 'err' },
};

const HOLD_STATUS: Record<ReservationStatus, string> = {
  ACTIVE: 'В корзине',
  CHECKOUT: 'В оплате',
  PURCHASED: 'Куплено',
  EXPIRED: 'Удержание истекло',
  RELEASED: 'Возвращено на витрину',
  CANCELLED: 'Распродажа закончилась до оплаты',
};

const SCENARIO: Record<string, string> = { SUCCESS: 'успех', DECLINE: 'отказ', HANG: 'зависание' };

export function AccountPage() {
  const session = useSession();
  const qc = useQueryClient();
  const orders = useQuery({ queryKey: ['orders'], queryFn: api.orders });
  const notifications = useQuery({ queryKey: ['notifications'], queryFn: api.notifications });
  const history = useQuery({ queryKey: ['history'], queryFn: api.history });

  const unread = notifications.data?.notifications.filter((n) => !n.readAt).length ?? 0;
  useEffect(() => {
    if (unread === 0) return;
    const id = setTimeout(() => {
      void api.readNotifications().then(() => qc.invalidateQueries({ queryKey: ['notifications'] }));
    }, 4000);
    return () => clearTimeout(id);
  }, [unread, qc]);

  const past = (history.data?.items ?? []).filter((i) => !['ACTIVE', 'CHECKOUT', 'PURCHASED'].includes(i.status));

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <h1>Кабинет покупателя</h1>
          <p className="muted" style={{ margin: 0 }}>
            {session?.user.email} · статусы заказов обновляются сами
          </p>
        </div>
      </div>

      <section className="card" style={{ marginBottom: 20 }}>
        <div className="card-pad" style={{ paddingBottom: 0 }}>
          <h2>Заказы</h2>
        </div>
        {orders.data && orders.data.orders.length === 0 && <div className="empty">Заказов пока нет</div>}
        {orders.data && orders.data.orders.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Когда</th>
                  <th>Товар</th>
                  <th className="r">Кол-во</th>
                  <th className="r">Сумма</th>
                  <th>Статус</th>
                  <th>Сценарий оплаты</th>
                  <th>Заказ</th>
                </tr>
              </thead>
              <tbody>
                {orders.data.orders.map((o) => (
                  <tr key={o.id} data-testid={`order-${o.id}`}>
                    <td>{dateTime(o.createdAt)}</td>
                    <td>{o.sale.title}</td>
                    <td className="r num">{o.quantity}</td>
                    <td className="r num">{money(o.amountCents)}</td>
                    <td>
                      <span className={`badge ${ORDER_STATUS[o.status].cls}`}>
                        {o.status === 'PENDING' && <span className="spinner" />}
                        {ORDER_STATUS[o.status].text}
                      </span>
                    </td>
                    <td className="muted">{SCENARIO[o.scenario]}</td>
                    <td className="muted num small">{o.id.slice(0, 8)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))' }}>
        <section className="card card-pad">
          <h2>Уведомления</h2>
          {notifications.data?.notifications.length === 0 && <p className="muted">Пока ничего</p>}
          <div className="list">
            {notifications.data?.notifications.map((n) => (
              <div key={n.id} style={{ display: 'grid', gap: 2 }}>
                <strong>
                  {!n.readAt && <span className="dot off" />}
                  {n.title}
                </strong>
                <span className="small">{n.body}</span>
                <span className="small muted">{dateTime(n.createdAt)}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="card card-pad">
          <h2>История корзины</h2>
          {past.length === 0 && <p className="muted">Истёкших и отменённых позиций нет</p>}
          <div className="list">
            {past.map((i) => (
              <div key={i.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                <span>
                  {i.sale.title} <span className="muted">× {i.quantity}</span>
                </span>
                <span className="badge neutral">{HOLD_STATUS[i.status]}</span>
              </div>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}
