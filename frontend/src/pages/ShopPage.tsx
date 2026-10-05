import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api.ts';
import { useServerNow } from '../lib/clock.ts';
import { duration, errorText, money } from '../lib/format.ts';
import { setSession, useSession } from '../lib/session.ts';
import { toast } from '../lib/toast.ts';
import type { SaleStats } from '../lib/types.ts';

export function ShopPage() {
  const session = useSession();
  if (session?.user.role !== 'SHOP') return <ShopLogin />;
  return <ShopDashboard />;
}

function ShopLogin() {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const qc = useQueryClient();

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const session = await api.shopLogin(password);
      qc.clear();
      setSession(session);
    } catch (err) {
      setError(err instanceof ApiError ? errorText(err.code, err.details, err.message) : 'Сервер недоступен');
    }
  }

  return (
    <main className="page">
      <div className="auth card card-pad">
        <h1>Экран магазина</h1>
        <p className="muted">Вход по паролю магазина (по умолчанию — <code>shop</code>, переменная SHOP_PASSWORD).</p>
        <form onSubmit={submit}>
          <label>
            Пароль
            <input type="password" required value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
          </label>
          {error && <div className="form-error">{error}</div>}
          <button className="primary">Войти как магазин</button>
          <div className="hint">Вход магазина заменит покупателя в этой вкладке. Для покупок откройте другую вкладку.</div>
        </form>
      </div>
    </main>
  );
}

function ShopDashboard() {
  const stats = useQuery({ queryKey: ['shopStats'], queryFn: api.shopStats });
  const sales = stats.data?.sales ?? [];
  const total = sales.reduce(
    (acc, s) => ({
      available: acc.available + s.available,
      inCarts: acc.inCarts + s.inCarts,
      awaiting: acc.awaiting + s.awaitingPayment,
      sold: acc.sold + s.sold,
      revenue: acc.revenue + s.revenueCents,
    }),
    { available: 0, inCarts: 0, awaiting: 0, sold: 0, revenue: 0 },
  );

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <h1>Экран магазина</h1>
          <p className="muted" style={{ margin: 0 }}>
            Цифры обновляются в реальном времени.
          </p>
        </div>
      </div>

      <div className="kpis">
        <Kpi label="На витрине" value={total.available} />
        <Kpi label="В корзинах" value={total.inCarts} />
        <Kpi label="Ждут оплаты" value={total.awaiting} />
        <Kpi label="Продано" value={total.sold} />
        <Kpi label="Выручка" value={money(total.revenue)} />
      </div>

      <section className="card" style={{ marginBottom: 20 }}>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Распродажа</th>
                <th>Статус</th>
                <th className="r">Партия</th>
                <th className="r">Остаток</th>
                <th className="r">В корзинах</th>
                <th className="r">Ждут оплаты</th>
                <th className="r">Продано</th>
                <th className="r">Снято</th>
                <th className="r">Выручка</th>
                <th className="r">Заказы ✓/⏳/✗</th>
              </tr>
            </thead>
            <tbody>
              {sales.map((s) => (
                <StatsRow key={s.id} s={s} />
              ))}
              {sales.length === 0 && (
                <tr>
                  <td colSpan={10} className="muted">
                    Распродаж нет
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <CreateSaleForm />
    </main>
  );
}

function Kpi({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="card kpi">
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
    </div>
  );
}

function StatsRow({ s }: { s: SaleStats }) {
  const now = useServerNow(1000);
  const phase = now < Date.parse(s.startsAt) ? 'UPCOMING' : now < Date.parse(s.endsAt) ? 'LIVE' : 'ENDED';
  return (
    <tr data-testid={`stats-${s.id}`}>
      <td>
        <strong>{s.title}</strong>
        <div className="muted small">{money(s.priceCents)}</div>
      </td>
      <td>
        <span className={`badge ${phase.toLowerCase()}`}>
          {phase === 'LIVE' ? `идёт · ${duration(Date.parse(s.endsAt) - now)}` : phase === 'UPCOMING' ? `старт через ${duration(Date.parse(s.startsAt) - now)}` : 'завершена'}
        </span>
      </td>
      <td className="r num">{s.totalQty}</td>
      <td className="r num">{s.available}</td>
      <td className="r num">{s.inCarts}</td>
      <td className="r num">{s.awaitingPayment}</td>
      <td className="r num">{s.sold}</td>
      <td className="r num">{s.withdrawn}</td>
      <td className="r num">{money(s.revenueCents)}</td>
      <td className="r num">
        {s.ordersPaid}/{s.ordersPending}/{s.ordersFailed}
      </td>
    </tr>
  );
}

const START_PRESETS = [
  { label: 'через 1 минуту', seconds: 60 },
  { label: 'через 2 минуты', seconds: 120 },
  { label: 'через 5 минут', seconds: 300 },
  { label: 'прямо сейчас', seconds: 0 },
];

function CreateSaleForm() {
  const [form, setForm] = useState({
    title: 'Наушники Pulse Pro',
    description: '',
    price: '4990',
    oldPrice: '12990',
    totalQty: '1',
    maxPerOrder: '1',
    startIn: '60',
    durationMin: '15',
  });
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const create = useMutation({
    mutationFn: () =>
      api.createSale({
        title: form.title,
        description: form.description || undefined,
        priceCents: Math.round(Number(form.price) * 100),
        oldPriceCents: form.oldPrice ? Math.round(Number(form.oldPrice) * 100) : undefined,
        totalQty: Number(form.totalQty),
        maxPerOrder: Number(form.maxPerOrder),
        startsInSeconds: Number(form.startIn),
        durationSeconds: Math.round(Number(form.durationMin) * 60),
      }),
    onSuccess: (sale) => {
      toast(`Распродажа «${sale.title}» создана`, 'success');
      setError(null);
      // витрину и статистику обновят события sale:created и shop:stats
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Сервер недоступен'),
  });

  return (
    <section className="card card-pad">
      <h2>Новая распродажа</h2>
      <form
        style={{ display: 'grid', gap: 12 }}
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <div className="field-row">
          <label style={{ gridColumn: 'span 2' }}>
            Товар
            <input required value={form.title} onChange={set('title')} />
          </label>
          <label>
            Цена, ₽
            <input required type="number" min="1" step="1" value={form.price} onChange={set('price')} />
          </label>
          <label>
            Старая цена, ₽
            <input type="number" min="1" step="1" value={form.oldPrice} onChange={set('oldPrice')} />
          </label>
        </div>
        <label>
          Описание
          <input value={form.description} onChange={set('description')} placeholder="необязательно" />
        </label>
        <div className="field-row">
          <label>
            Количество
            <input required type="number" min="1" value={form.totalQty} onChange={set('totalQty')} />
          </label>
          <label>
            В одни руки, до
            <input required type="number" min="1" value={form.maxPerOrder} onChange={set('maxPerOrder')} />
          </label>
          <label>
            Старт (по часам сервера)
            <select value={form.startIn} onChange={set('startIn')}>
              {START_PRESETS.map((p) => (
                <option key={p.seconds} value={p.seconds}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Длительность, мин
            <input required type="number" min="1" value={form.durationMin} onChange={set('durationMin')} />
          </label>
        </div>
        {error && <div className="form-error">{error}</div>}
        <div>
          <button className="primary" disabled={create.isPending}>
            Выставить на распродажу
          </button>
        </div>
      </form>
    </section>
  );
}
