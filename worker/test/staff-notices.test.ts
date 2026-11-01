import { describe, expect, it, vi } from 'vitest';
import { dispatchStaffNotices, staffNotices, staffNoticeText, staffForecast } from '../src/wa/staff-notices.js';
import { Messaging } from '../src/wa/messaging.js';
import type { WaStore } from '../src/wa/index.js';
import type { AirportView } from '../src/wa/tools.js';
import type { OpsCommand } from '../../backend/src/sim.js';
import type { WhatsAppClient } from '../src/wa/transport.js';
class Store implements WaStore {
  rows = new Map<string, unknown>();
  async get<T>(key: string) { return structuredClone(this.rows.get(key)) as T | undefined; }
  async put(key: string, value: unknown) { this.rows.set(key, structuredClone(value)); }
  async delete(key: string) { return this.rows.delete(key); }
  async list<T>({ prefix, startAfter, limit = 500 }: { prefix: string; startAfter?: string; limit?: number }) {
    return new Map([...this.rows].filter(([k]) => k.startsWith(prefix) && (!startAfter || k > startAfter)).sort(([a], [b]) => a.localeCompare(b)).slice(0, limit)) as Map<string, T>;
  }
}
const view: AirportView = { clock: () => ({ now: 36000, sim: true }), flow: () => ({}), flights: () => [], provisional: () => false };
async function setup() {
  const store = new Store(), sendText = vi.fn(async () => ({ ok: true }));
  const wa = { sendText } as unknown as WhatsAppClient;
  for (const [phone, role, zone] of [['match', 'staff', 'security'], ['alias', 'staff', 'U_SECURITY_QUEUE'], ['other', 'staff', 'check_in:2'], ['bag', 'staff', 'bag_drop:2'], ['passenger', 'passenger', 'security'], ['unknown', 'staff', undefined]]) {
    await store.put(`wa:profile:${phone}`, { phone, role, zone });
    await store.put(`wa:last:${phone}`, Date.now());
  }
  return { store, wa, sendText };
}
describe('staff dispatch notices', () => {
  it('targets only staff profiles in the affected zone, including unsubscribed profiles and aliases', async () => {
    const h = await setup();
    await dispatchStaffNotices(h.store, h.wa, view, { id: 'A', type: 'staff', zone: 'security', delta: 1 });
    expect(h.sendText.mock.calls.map(c => (c as unknown[])[0]).sort()).toEqual(['alias', 'match']);
    expect(await staffNotices(h.store, 'passenger')).toEqual([]);
    expect(await staffNotices(h.store, 'other')).toEqual([]);
  });
  it('notifies both redirect zones once, preserves group isolation and deduplicates concurrent command replays', async () => {
    const h = await setup();
    const command = { id: 'A', type: 'redirect' as const, from: 'security', to: 'check_in:2' };
    await Promise.all([dispatchStaffNotices(h.store, h.wa, view, command), dispatchStaffNotices(h.store, h.wa, view, command)]);
    expect(h.sendText).toHaveBeenCalledTimes(3);
    expect(await staffNotices(h.store, 'bag')).toEqual([]);
    await dispatchStaffNotices(h.store, h.wa, view, { id: 'B', type: 'close', zone: 'check_in:1' });
    expect(h.sendText).toHaveBeenCalledTimes(3);
  });
  it('enumerates paged Worker storage and unpaged Node storage without skipping staff or looping', async () => {
    for (const unpaged of [false, true]) {
      const h = await setup();
      for (let i = 0; i < 500; i++) await h.store.put(`wa:profile:extra${i}`, { role: 'passenger', zone: 'security' });
      const list = h.store.list.bind(h.store);
      if (unpaged) h.store.list = async options => list({ prefix: options.prefix, limit: 1000 });
      await dispatchStaffNotices(h.store, h.wa, view, { id: 'P', type: 'open', zone: 'security' });
      expect(h.sendText).toHaveBeenCalledTimes(2);
    }
  });
  it('retains exactly the latest 20 notices per phone across reconstruction and failed/off-window delivery', async () => {
    const h = await setup();
    await h.store.delete('wa:last:match');
    h.sendText.mockRejectedValue(new Error('offline'));
    for (let i = 0; i < 22; i++) await dispatchStaffNotices(h.store, h.wa, view, { id: String(i), type: 'open', zone: 'security' });
    expect((await staffNotices(h.store, 'match')).map(n => n.id)).toEqual(Array.from({ length: 20 }, (_, i) => String(i + 2)));
    expect(h.sendText).toHaveBeenCalledTimes(22); // Only alias has an open WhatsApp window.
    expect(await staffNotices(h.store, 'other')).toEqual([]);
  });
  it.each<OpsCommand>([
    { type: 'staff', zone: 'security', delta: 1 }, { type: 'staff', zone: 'security', delta: -2 },
    { type: 'redirect', from: 'security', to: 'check_in:2' }, { type: 'close', zone: 'check_in:2' },
    { type: 'open', zone: 'security' }, { type: 'evacuate', zones: ['security'] },
  ])('describes $type as a short dispatch fact without orders or emoji', command => {
    const text = staffNoticeText(command, 'security');
    expect(text).toMatch(/^Dispeceratul a /);
    expect(text).not.toMatch(/\p{Extended_Pictographic}|trebuie|mergi|deschideți|închideți/iu);
    expect(text.length).toBeLessThan(160);
  });
  it('uses the requested Romanian wording and respects English profiles', () => {
    expect(staffNoticeText({ type: 'staff', zone: 'security', delta: 1 }, 'security')).toBe('Dispeceratul a deschis o linie în plus la securitate.');
    expect(staffNoticeText({ type: 'close', zone: 'check_in:2' }, 'check_in:2')).toMatch(/Dispeceratul a închis temporar .*2\./);
    expect(staffNoticeText({ type: 'open', zone: 'security' }, 'security', 'en')).toMatch(/^Dispatch has reopened/);
  });
  it('hooks both command paths and sends only one staff notice during evacuation', async () => {
    const h = await setup();
    await h.store.put('wa:subs', ['match', 'other']);
    const messaging = new Messaging({ ...h, view, toUnity: () => true, evacWaitMs: 0 });
    await messaging.adminChanged({ id: 'A', type: 'staff', zone: 'security', delta: 1 });
    await messaging.evacuate(['security', 'security'], 'E');
    await messaging.adminChanged({ id: 'E', type: 'evacuate', zones: ['security'] });
    expect(await staffNotices(h.store, 'match')).toHaveLength(2);
    expect(h.sendText).toHaveBeenCalledTimes(4);
  });
  it('reads only exact +30/+60 camera points, rejecting stale, uncovered and non-vision data', () => {
    const row = { waiting: 1, waitMin: 2, coverage: 1, source: 'vision' as const, forecast: [{ inMin: 15, waitMin: 3 }, { inMin: 60, waitMin: 6 }, { inMin: 30, waitMin: 4 }, { inMin: 90, waitMin: 8 }] };
    const forecast = (patch = {}) => staffForecast({ ...view, flow: () => ({ U_SECURITY_QUEUE: { ...row, ...patch } }) }, 'security');
    expect(forecast()).toEqual([{ inMin: 30, waitMin: 4 }, { inMin: 60, waitMin: 6 }]);
    for (const patch of [{ stale: true }, { coverage: 0 }, { source: 'twin' }, { forecast: [] }]) expect(forecast(patch)).toEqual([]);
    expect(staffForecast({ ...view, flow: () => ({ 'check_in:1': row }) }, 'check_in:2')).toEqual([]);
  });
});
