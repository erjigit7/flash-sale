import { useQuery } from '@tanstack/react-query';
import { SaleCard } from '../components/SaleCard.tsx';
import { api } from '../lib/api.ts';
import { useSession } from '../lib/session.ts';

export function ShowcasePage() {
  const session = useSession();
  const buyer = session?.user.role === 'BUYER';
  const sales = useQuery({ queryKey: ['sales'], queryFn: api.sales });
  const cart = useQuery({ queryKey: ['cart'], queryFn: api.cart, enabled: buyer });
  const inCart = new Set((cart.data?.items ?? []).filter((i) => i.status === 'ACTIVE' || i.status === 'CHECKOUT').map((i) => i.saleId));

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <h1>Витрина</h1>
          <p className="muted" style={{ margin: 0 }}>
            Остатки обновляются у всех в реальном времени. Таймеры идут по часам сервера.
          </p>
        </div>
      </div>
      {sales.isLoading && <div className="card empty">Загружаем распродажи…</div>}
      {sales.isError && <div className="card empty">Не удалось загрузить витрину — сервер недоступен</div>}
      {sales.data && sales.data.sales.length === 0 && <div className="card empty">Распродаж пока нет — магазин может создать её на своём экране</div>}
      <div className="grid">
        {sales.data?.sales.map((s) => <SaleCard key={s.id} sale={s} inCart={inCart.has(s.id)} />)}
      </div>
    </main>
  );
}
