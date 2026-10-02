import { useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { api, ApiError } from '../lib/api.ts';
import { errorText } from '../lib/format.ts';
import { setSession } from '../lib/session.ts';

export function LoginPage() {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const qc = useQueryClient();

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const session = await api.login(email, name);
      qc.clear();
      setSession(session);
      navigate(params.get('next') ?? '/');
    } catch (err) {
      setError(err instanceof ApiError ? (err.code === 'use_shop_login' ? err.message : errorText(err.code, err.details, err.message)) : 'Сервер недоступен');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="page">
      <div className="auth card card-pad">
        <h1>Вход покупателя</h1>
        <p className="muted">Пароль не нужен — email нужен, чтобы прислать письмо о заказе.</p>
        <form onSubmit={submit}>
          <label>
            Email
            <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="alice@example.com" autoFocus />
          </label>
          <label>
            Имя (необязательно)
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Алиса" />
          </label>
          {error && <div className="form-error">{error}</div>}
          <button className="primary" disabled={busy}>
            {busy ? 'Входим…' : 'Войти'}
          </button>
          <div className="hint">
            Каждая вкладка — отдельный покупатель (сессия хранится в sessionStorage вкладки). Откройте вторую вкладку и войдите
            другим email, чтобы сразиться за последнюю единицу. Письма смотрите в{' '}
            <a href={`${location.protocol}//${location.hostname}:8025`} target="_blank" rel="noreferrer">
              Mailpit
            </a>
            .
          </div>
          <p className="small muted">
            Вы магазин? <Link to="/shop">Вход для магазина</Link>
          </p>
        </form>
      </div>
    </main>
  );
}
