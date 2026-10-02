import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// В dev-режиме проксируем API и Socket.IO на бэкенд, как это делает nginx в compose:
// фронт и бэк живут на одном origin, CORS не нужен.
const backend = process.env.BACKEND_URL ?? 'http://localhost:3000'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': backend,
      '/socket.io': { target: backend, ws: true },
    },
  },
})
