import { flowRow, logicalKind, mapNodeId } from './mapIds.js';
import type { FlowRow, TerminalFlight } from './sim.js';

export type AlertState = 'unacked' | 'acked' | 'cleared-unacked' | 'shelved';
export type AlertKind = 'zone-target' | 'forecast-target' | 'density' | 'staff-security' | 'staff-report' | 'flight-risk' | 'camera-loss';
export interface Alert {
  id: string; priority: 'P1' | 'P2' | 'P3'; kind: AlertKind; zoneId: string | null; flight: string | null;
  text: string; numbers: Record<string, number>; createdAt: number; updatedAt: number;
  state: AlertState; active: boolean; adviceId: string | null; shelvedUntil: number | null; shelveReason: string | null;
}
export interface StaffReport { id: string; kind: string; node: string | null; text: string; status: 'open' | 'closed'; type?: string; source?: 'passenger' | 'staff'; priority?: 'P1' | 'P2' | 'P3' }
export interface AlertInput {
  simTime: number;
  flow: Readonly<Record<string, Pick<FlowRow, 'source' | 'stale' | 'coverage' | 'waiting' | 'waitMin' | 'forecast' | 'density'> & { adviceId?: string | null }>>;
  flights: readonly TerminalFlight[]; reports: readonly StaffReport[];
}
export type AlertCommand = { type: 'ack'; id: string } | { type: 'shelve'; id: string; durationSec: number; reason: string };
export function alertCommand(d: any): AlertCommand {
  if (!d || typeof d !== 'object' || typeof d.id !== 'string' || !d.id || d.id.length > 200) throw new Error('Invalid alert command');
  if (d.type === 'ack') return { type: 'ack', id: d.id };
  if (d.type !== 'shelve' || !Number.isFinite(d.durationSec) || d.durationSec <= 0 || d.durationSec > 86400 || typeof d.reason !== 'string' || !d.reason.trim() || d.reason.length > 200) throw new Error('Invalid alert command');
  return { type: 'shelve', id: d.id, durationSec: d.durationSec, reason: d.reason.trim() };
}
export function waitTarget(zone: string): number | null {
  const kind = logicalKind(zone);
  return kind === 'security' ? 10 : kind === 'check_in' || kind === 'bag_drop' ? 15 : null;
}
export function densityThreshold(zone: string): number {
  return ['security', 'check_in', 'bag_drop', 'gate', 'waiting', 'reclaim'].includes(logicalKind(zone)) ? 5 : 3;
}
const seconds = (v: number | string | null): number => {
  if (typeof v === 'number') return v;
  if (typeof v !== 'string' || !/^\d{1,2}:\d{2}(:\d{2})?$/.test(v)) return NaN;
  const parts = v.split(':').map(Number);
  return parts[0]! < 24 && parts[1]! < 60 && (parts[2] ?? 0) < 60 ? parts[0]! * 3600 + parts[1]! * 60 + (parts[2] ?? 0) : NaN;
};
// bag drop and check-in are separate queues even though their physical anchors overlap.
const zoneKey = (id: string) => id.startsWith('bag_drop:') ? `bag_drop:${mapNodeId(id).split(':')[1]}` : mapNodeId(id);
type Condition = Pick<Alert, 'priority' | 'kind' | 'zoneId' | 'flight' | 'text' | 'numbers' | 'adviceId'>;

/** Pure ISA-18.2 lifecycle. Inputs deliberately exclude truth and individual Unity agent stages. */
export class Alerts {
  private rows = new Map<string, Alert>();
  reset() { this.rows.clear(); this.reportIds.clear(); }
  update(input: AlertInput): Alert[] {
    const { simTime: now, flow, flights, reports } = input;
    const conditions = new Map<string, Condition>();
    const add = (c: Condition, subject = c.zoneId ?? c.flight ?? 'unknown') => conditions.set(`${c.kind}:${subject}`, c);
    for (const [zoneId, row] of Object.entries(flow)) {
      if (row.source !== 'vision') continue;
      const common = { zoneId, flight: null, adviceId: row.adviceId ?? null };
      if (row.stale || row.coverage === 0) {
        add({ ...common, kind: 'camera-loss', priority: 'P3', text: 'Cameră pierdută', numbers: {} }, zoneKey(zoneId));
        continue;
      }
      const target = waitTarget(zoneId);
      if (target !== null) {
        if (row.waitMin !== null && row.waitMin > target)
          add({ ...common, kind: 'zone-target', priority: 'P2', text: 'Țintă depășită', numbers: { waitMin: row.waitMin, targetMin: target } }, zoneKey(zoneId));
        const peak = row.forecast?.filter(f => f.inMin > 0 && f.inMin <= 60 && f.waitMin > target).sort((a, b) => a.inMin - b.inMin)[0];
        if (peak) add({ ...common, kind: 'forecast-target', priority: 'P3', text: 'Depășire prognozată', numbers: { waitMin: peak.waitMin, targetMin: target, inMin: peak.inMin, at: now + peak.inMin * 60 } }, zoneKey(zoneId));
      }
      const threshold = densityThreshold(zoneId);
      if (row.density !== null && row.density > threshold)
        add({ ...common, kind: 'density', priority: 'P1', text: 'Densitate periculoasă', numbers: { density: row.density, threshold } }, zoneKey(zoneId));
    }
    // Same-zone reports form one alarm, but a newly arriving report must require acknowledgement again.
    const reportGroups = new Map<string, StaffReport[]>();
    for (const r of reports.filter(r => r.status === 'open')) {
      const kind = (['securitate', 'bagaj_abandonat', 'medical'].includes(r.kind) || r.type === 'security' || r.type === 'medical') ? 'staff-security' : 'staff-report';
      const key = `${kind}:${r.node ? zoneKey(r.node) : 'unknown'}`;
      reportGroups.set(key, [...reportGroups.get(key) ?? [], r]);
    }
    for (const [key, group] of reportGroups) {
      const r = group[group.length - 1]!;
      const kind = key.startsWith('staff-security:') ? 'staff-security' : 'staff-report';
      add({ kind, priority: group.some(r => r.priority === 'P1') || kind === 'staff-security' ? 'P1' : group.some(r => r.priority === 'P2') ? 'P2' : r.priority ?? 'P2', zoneId: r.node, flight: null,
        text: kind === 'staff-security' ? (group.every(r => r.kind === 'medical' || r.type === 'medical') ? 'Raport medical' : 'Raport securitate') : (group.some(r => r.source === 'passenger') ? 'Raport pasager' : 'Raport personal'), numbers: { reports: group.length }, adviceId: null }, r.node ? zoneKey(r.node) : 'unknown');
      const previous = this.reportIds.get(key);
      if (previous && group.some(r => !previous.has(r.id))) {
        const alert = this.rows.get(key);
        if (alert && alert.state !== 'shelved') { alert.state = 'unacked'; alert.updatedAt = now; }
      }
      this.reportIds.set(key, new Set(group.map(r => r.id)));
    }
    const usable = (id: string) => {
      const r = flowRow(flow, id);
      return r?.source === 'vision' && !r.stale && r.coverage !== 0 ? r : undefined;
    };
    for (const f of flights) {
      if (f.status === 'cancelled' || f.status === 'departed') continue;
      const close = (f.gateCloseAt === null ? seconds(f.std) - 1800 : seconds(f.gateCloseAt)) + f.delayMin * 60;
      const security = usable('security');
      const checkIn = f.checkIn ? usable(f.checkIn) : undefined;
      const bagDrop = f.checkIn ? usable(f.checkIn.replace('check_in:', 'bag_drop:')) : undefined;
      const beforeSecurity = Math.min(f.pax ?? Infinity, (security?.waiting ?? 0) + (checkIn?.waiting ?? 0) + (bagDrop?.waiting ?? 0));
      const waitMin = (security?.waitMin ?? 0) + Math.max(checkIn?.waitMin ?? 0, bagDrop?.waitMin ?? 0);
      const left = (close - now) / 60;
      if (beforeSecurity > 0 && left >= 0 && left <= Math.max(15, waitMin + 5))
        add({ kind: 'flight-risk', priority: 'P2', zoneId: f.gate, flight: f.flight, text: 'Zbor în pericol',
          numbers: { estimatedBeforeSecurity: beforeSecurity, minutesToClose: left, waitMin, estimated: 1 }, adviceId: null }, f.flight.replace(/\s/g, '').toUpperCase());
    }
    for (const [key, c] of conditions) {
      let row = this.rows.get(key);
      if (!row) {
        row = { ...c, id: key, createdAt: now, updatedAt: now, state: 'unacked', active: true, shelvedUntil: null, shelveReason: null };
        this.rows.set(key, row);
      } else {
        const changed = JSON.stringify([row.priority, row.numbers, row.adviceId, row.zoneId]) !== JSON.stringify([c.priority, c.numbers, c.adviceId, c.zoneId]);
        if ((!row.active || row.priority !== c.priority) && row.state !== 'shelved') row.state = 'unacked';
        if (!row.active || changed) row.updatedAt = now;
        Object.assign(row, c, { active: true });
      }
    }
    for (const [key, row] of this.rows) {
      if (!conditions.has(key) && row.active) {
        row.active = false; row.updatedAt = now;
        if (row.state === 'unacked') row.state = 'cleared-unacked';
      }
      if (row.state === 'shelved' && row.shelvedUntil! <= now) {
        row.state = row.active ? 'unacked' : 'cleared-unacked';
        row.shelvedUntil = null; row.shelveReason = null; row.updatedAt = now;
      }
    }
    return this.snapshot();
  }
  private reportIds = new Map<string, Set<string>>();
  command(command: AlertCommand, now: number): Alert {
    const row = this.rows.get(command.id);
    if (!row) throw new Error('Unknown alert');
    if (command.type === 'ack') {
      row.state = 'acked'; row.shelvedUntil = null; row.shelveReason = null;
    } else {
      row.state = 'shelved'; row.shelvedUntil = now + command.durationSec; row.shelveReason = command.reason;
    }
    row.updatedAt = now;
    return structuredClone(row);
  }
  snapshot(): Alert[] { return structuredClone([...this.rows.values()]); }
}
