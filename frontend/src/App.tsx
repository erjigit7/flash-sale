import { Navigate, Route, Routes } from 'react-router';
import { Header } from './components/Header.tsx';
import { Toasts } from './components/Toasts.tsx';
import { useRealtime } from './lib/realtime.ts';
import { useSession } from './lib/session.ts';
import { AccountPage } from './pages/AccountPage.tsx';
import { CartPage } from './pages/CartPage.tsx';
import { LoginPage } from './pages/LoginPage.tsx';
import { ShopPage } from './pages/ShopPage.tsx';
import { ShowcasePage } from './pages/ShowcasePage.tsx';

export function App() {
  useRealtime();
  const session = useSession();
  const buyer = session?.user.role === 'BUYER';

  return (
    <>
      <Header />
      <Routes>
        <Route path="/" element={<ShowcasePage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/cart" element={buyer ? <CartPage /> : <Navigate to="/login?next=/cart" replace />} />
        <Route path="/account" element={buyer ? <AccountPage /> : <Navigate to="/login?next=/account" replace />} />
        <Route path="/shop" element={<ShopPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <Toasts />
    </>
  );
}
