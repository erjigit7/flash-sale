import { useSyncExternalStore } from 'react';
import type { User } from './types.ts';

/**
 * Сессия хранится в sessionStorage — она своя у каждой вкладки.
 * Поэтому две вкладки могут быть двумя разными покупателями (требование «два одновременных клиента»).
 */
const KEY = 'flash-sale:session';

export interface Session {
  token: string;
  user: User;
}

const listeners = new Set<() => void>();
let current: Session | null = read();

function read(): Session | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

export function getSession(): Session | null {
  return current;
}

export function setSession(session: Session | null) {
  current = session;
  try {
    if (session) sessionStorage.setItem(KEY, JSON.stringify(session));
    else sessionStorage.removeItem(KEY);
  } catch {
    // приватный режим и т.п. — сессия живёт только в памяти вкладки
  }
  for (const l of listeners) l();
}

export function useSession(): Session | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => current,
  );
}
