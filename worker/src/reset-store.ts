import type { WaStore } from './wa/index.js';

/** Page through DO KV so reset also removes orphaned tokens and unbound profiles. */
export async function clearPrefix(store: WaStore, prefix: string): Promise<number> {
  if (!store.list) throw new Error('Reset requires enumerable storage');
  let count = 0, startAfter: string | undefined;
  while (true) {
    const rows = await store.list({ prefix, startAfter, limit: 500 });
    if (!rows.size) return count;
    for (const key of rows.keys()) { if (await store.delete(key)) count++; startAfter = key; }
  }
}
