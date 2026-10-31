import { expect, it } from 'vitest';
import { consumeJoin, JOIN_TTL_MS, joinKey, pendingJoin, waLink } from '../src/join.js';
import type { WaStore } from '../src/wa/index.js';

const memory = () => {
  const data = new Map<string, unknown>();
  const store: WaStore = {
    get: async <T>(key: string) => data.get(key) as T | undefined,
    put: async (key, value) => { data.set(key, value); },
    delete: async key => data.delete(key),
  };
  return store;
};
it('expires at exactly 24 hours and removes the expired record', async () => {
  const store = memory(), token = 'c'.repeat(48), now = Date.now();
  await store.put(joinKey(token), { flight: 'W6 3751', expiresAt: now + JOIN_TTL_MS });
  expect(await pendingJoin(store, token, now + JOIN_TTL_MS - 1)).toBeDefined();
  expect(await pendingJoin(store, token, now + JOIN_TTL_MS)).toBeUndefined();
  expect(await store.get(joinKey(token))).toBeUndefined();
});
it('allows only one claim when two phones race for the same token', async () => {
  const store = memory(), token = 'd'.repeat(48);
  await store.put(joinKey(token), { flight: 'W6 3751', expiresAt: Date.now() + JOIN_TTL_MS });
  const results = await Promise.all([consumeJoin(store, token, 'W6 3751'), consumeJoin(store, token, 'W6 3751')]);
  expect(results.filter(Boolean)).toHaveLength(1);
});
it('uses the default WhatsApp number and URL-encodes START', () => {
  expect(waLink('W6 3751', 'abcd')).toBe('https://wa.me/15556318672?text=START%20W6%203751%20abcd');
});
