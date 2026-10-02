import { useEffect, useState } from 'react'

// Временная заглушка каркаса: проверяет, что фронт видит бэкенд через прокси.
export default function App() {
  const [status, setStatus] = useState('проверяем…')

  useEffect(() => {
    fetch('/api/health')
      .then((r) => r.json())
      .then((b: { status: string }) => setStatus(b.status))
      .catch(() => setStatus('бэкенд недоступен'))
  }, [])

  return (
    <main>
      <h1>Флэш-распродажа</h1>
      <p>Backend: {status}</p>
    </main>
  )
}
