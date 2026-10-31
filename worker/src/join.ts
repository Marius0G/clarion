import type { WaStore } from './wa/index.js';
import { flightKey } from './wa/flights.js';

export const JOIN_TTL_MS = 24 * 60 * 60 * 1000;
export interface PendingJoin { flight: string; name?: string; expiresAt: number }
export const joinKey = (token: string) => `join:${token}`;
export const waLink = (flight: string, token: string, number = '15556318672') =>
  `https://wa.me/${number.replace(/\D/g, '')}?text=${encodeURIComponent(`START ${flight} ${token}`)}`;

export async function pendingJoin(store: WaStore, token: unknown, now = Date.now()) {
  if (typeof token !== 'string' || !/^[a-f0-9]{48}$/.test(token)) return;
  const pending = await store.get<PendingJoin>(joinKey(token));
  if (!pending) return;
  if (pending.expiresAt <= now) { await store.delete(joinKey(token)); return; }
  return pending;
}

/** Delete is the single-use claim: only one concurrent phone can succeed. */
export async function consumeJoin(store: WaStore, token: unknown, flight: string) {
  const pending = await pendingJoin(store, token);
  if (!pending || flightKey(pending.flight) !== flightKey(flight)) return;
  return await store.delete(joinKey(token as string)) ? pending : undefined;
}
