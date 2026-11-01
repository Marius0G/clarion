import { flowRow, mapNodeId } from '../../../backend/src/mapIds.js';
import type { OpsCommand } from '../../../backend/src/sim.js';
import type { WaStore } from './index.js';
import type { AirportView, Profile } from './tools.js';
import { clockText } from './flights.js';
import { nodeName } from './texts.js';
import type { WhatsAppClient } from './transport.js';

export interface StaffNotice {
  id: string; at: string; zone: string; type: OpsCommand['type']; text: string;
}
export async function staffNotices(store: WaStore, phone: string): Promise<StaffNotice[]> {
  return (await store.get<StaffNotice[]>(`msg:staffNotices:${phone}`) ?? []).slice(-20);
}

/** Only the camera forecast for this exact zone; no interpolation, truth or invented values. */
export function staffForecast(view: AirportView, zone: string) {
  const row = flowRow(view.flow(), zone);
  if (!row || row.source !== 'vision' || row.stale || row.coverage === 0) return [];
  return [30, 60].flatMap(inMin => {
    const point = row.forecast?.find(p => p.inMin === inMin && Number.isFinite(p.waitMin) && p.waitMin >= 0);
    return point ? [{ inMin, waitMin: point.waitMin }] : [];
  });
}

export function commandZones(command: OpsCommand): string[] {
  return command.type === 'evacuate' ? command.zones : command.type === 'redirect' ? [command.from, command.to] : [command.zone];
}
const placeName = (zone: string, lang?: Profile['lang']) => mapNodeId(zone) === 'U_SECURITY_QUEUE'
  ? lang === 'en' ? 'security' : 'securitate' : nodeName(zone, lang);

export function staffNoticeText(command: OpsCommand, zone: string, lang?: Profile['lang']): string {
  const name = placeName(zone, lang);
  if (lang === 'en') {
    if (command.type === 'staff') return `Dispatch has ${command.delta > 0 ? 'opened' : 'closed'} ${Math.abs(command.delta)} ${Math.abs(command.delta) === 1 ? 'lane' : 'lanes'} at ${name}.`;
    if (command.type === 'redirect') return `Dispatch has redirected passengers from ${placeName(command.from, lang)} to ${placeName(command.to, lang)}.`;
    return `Dispatch has ${command.type === 'evacuate' ? 'started evacuation at' : command.type === 'close' ? 'temporarily closed' : 'reopened'} ${name}.`;
  }
  if (command.type === 'staff') {
    const count = Math.abs(command.delta);
    const amount = count === 1 ? 'o linie' : `${count} linii`;
    return `Dispeceratul a ${command.delta > 0 ? 'deschis' : 'închis'} ${amount}${command.delta > 0 ? ' în plus' : ''} la ${name}.`;
  }
  if (command.type === 'redirect') return `Dispeceratul a redirecționat pasagerii de la ${placeName(command.from)} către ${placeName(command.to)}.`;
  return `Dispeceratul a ${command.type === 'evacuate' ? 'început evacuarea la' : command.type === 'close' ? 'închis temporar' : 'redeschis'} ${name}.`;
}

// Shared routing anchors do not make bag-drop and check-in profiles the same zone.
const noticeZone = (zone: string) => zone.startsWith('bag_drop:') ? mapNodeId(zone).replace(/^check_in:/, 'bag_drop:') : mapNodeId(zone);

const locks = new WeakMap<WaStore, Promise<unknown>>();
/** One informational message per matching staff phone and command, independent of passenger throttling. */
export function dispatchStaffNotices(store: WaStore, wa: WhatsAppClient, view: AirportView, command: OpsCommand & { id?: string }) {
  const next = (locks.get(store) ?? Promise.resolve()).then(async () => {
    const id = command.id ?? crypto.randomUUID();
    const phones = new Set(await store.get<string[]>('wa:subs') ?? []);
    if (store.list) {
      let startAfter: string | undefined;
      for (;;) {
        const rows = await store.list<Profile>({ prefix: 'wa:profile:', limit: 500, ...(startAfter && { startAfter }) });
        for (const key of rows.keys()) phones.add(key.slice('wa:profile:'.length));
        const lastKey = [...rows.keys()].sort().at(-1);
        // Node stores return the whole prefix and may ignore pagination options.
        if (rows.size !== 500 || !lastKey || (startAfter && lastKey <= startAfter)) break;
        startAfter = lastKey;
      }
    }
    const zones = new Set(commandZones(command).map(noticeZone));
    for (const phone of phones) {
      const profile = await store.get<Profile>(`wa:profile:${phone}`);
      if (profile?.role !== 'staff' || !profile.zone || !zones.has(noticeZone(profile.zone))) continue;
      const marker = `msg:staffNoticeSent:${phone}:${id}`;
      if (await store.get(marker)) continue;
      const notice: StaffNotice = { id, at: clockText(view.clock().now), zone: profile.zone, type: command.type,
        text: staffNoticeText(command, profile.zone, profile.lang) };
      await store.put(`msg:staffNotices:${phone}`, [...await staffNotices(store, phone), notice].slice(-20));
      await store.put(marker, true);
      // TODO(staff-notices): pushToPhone(phone, event) is unavailable; page updates use GET /api/staff.
      const last = await store.get<number>(`wa:last:${phone}`);
      if (typeof last !== 'number' || Date.now() - last >= 86_400_000) continue;
      try { await wa.sendText(phone, notice.text); } catch { /* The persisted notice remains available in the API. */ }
    }
  });
  locks.set(store, next.catch(() => {}));
  return next;
}
