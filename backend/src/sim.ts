import { isRole, type Role } from './types.js';
const locations = ['home', 'road', 'terminal', 'kerb'] as const;
const phones = ['unknown', 'notified', 'read', 'acting'] as const;
export interface SimAgent {
  agentId: string; role: Role; persona: string;
  location: typeof locations[number]; phone: typeof phones[number]; action: string;
  trigger?: string; lat?: number; lon?: number; thought?: string;
}
const object = (v: any) => v && typeof v === 'object' && !Array.isArray(v);
const text = (v: any, max: number) => typeof v === 'string' && v.length <= max;
const finite = (v: any, min: number, max = Infinity) => Number.isFinite(v) && v >= min && v <= max;
export const flowZones = ['check_in', 'bag_drop', 'security', 'arrivals_hall', 'taxi_rank', 'kerb'] as const;
export type FlowZone = typeof flowZones[number];
export interface FlowRow { waiting: number; capacity: number | null; waitMin: number | null; peak: number; updatedAt: string }
/** Peak window: 30 minutes, in sim seconds when sim.status has given a simTime, else wall-clock seconds. */
const PEAK_WINDOW_S = 1800, HISTORY_MAX = 4000;
function runFields(d: any, required: boolean) {
  for (const [key, valid] of Object.entries({
    scenario: (v: any) => text(v, 100), arm: (v: any) => ['A', 'B'].includes(v),
    coverage: (v: any) => finite(v, 0, 1), seed: (v: any) => Number.isSafeInteger(v),
    speed: (v: any) => finite(v, Number.MIN_VALUE),
  })) if ((required || d[key] !== undefined) && !valid(d[key])) throw new Error(`Invalid sim ${key}`);
}
export function simCommand(d: any) {
  if (!object(d) || !['start', 'stop', 'trigger'].includes(d.action) || (d.event !== undefined && !text(d.event, 100))) throw new Error('Invalid sim command');
  runFields(d, false);
  return Object.fromEntries(['action', 'scenario', 'arm', 'coverage', 'seed', 'speed', 'event'].filter(k => d[k] !== undefined).map(k => [k, d[k]]));
}
/** Ephemeral Unity telemetry. Never part of the persisted engine store. */
export class SimStore {
  private rows = new Map<string, SimAgent>();
  private run: { scenario: string; arm: 'A' | 'B'; coverage: number; seed: number } | null = null;
  private simTime: number | null = null;
  private speed: number | null = null;
  private lastSeen: string | null = null;
  private flowRows = new Map<FlowZone, FlowRow>();
  private flowHistory = new Map<FlowZone, { t: number; waiting: number }[]>();
  status(d: any) {
    if (!object(d)) throw new Error('Invalid sim status');
    runFields(d, true);
    if (typeof d.running !== 'boolean' || !finite(d.simTime, 0) || !Number.isSafeInteger(d.agents) || d.agents < 0) throw new Error('Invalid sim status');
    this.run = { scenario: d.scenario, arm: d.arm, coverage: d.coverage, seed: d.seed };
    this.simTime = d.simTime; this.speed = d.speed; this.lastSeen = new Date().toISOString();
  }
  batch(d: any): SimAgent[] {
    if (!object(d) || !Array.isArray(d.updates) || d.updates.length > 500) throw new Error('updates[] required (max 500)');
    // Validate the complete message before mutating either telemetry or presence.
    const updates: SimAgent[] = d.updates.map((r: any) => {
      // Unity JSON serializers commonly emit null for absent optional fields.
      if (object(r)) r = Object.fromEntries(Object.entries(r).filter(([, v]) => v !== null));
      if (!object(r) || !text(r.agentId, 100) || !r.agentId || !isRole(r.role) || !text(r.persona, 100) || !locations.includes(r.location) || !phones.includes(r.phone) || !text(r.action, 40) || (r.trigger !== undefined && !text(r.trigger, 40)) || (r.thought !== undefined && !text(r.thought, 200)) || ((r.lat !== undefined || r.lon !== undefined) && (!finite(r.lat, -90, 90) || !finite(r.lon, -180, 180)))) throw new Error('Invalid sim agent');
      const row: SimAgent = { agentId: r.agentId, role: r.role, persona: r.persona, location: r.location, phone: r.phone, action: r.action };
      for (const k of ['trigger', 'thought', 'lat', 'lon'] as const) if (r[k] !== undefined) (row as any)[k] = r[k];
      return row;
    });
    const ids = new Set([...this.rows.keys(), ...updates.map(r => r.agentId)]);
    if (ids.size > 5000) throw new Error('Sim store exceeds 5000 agents');
    for (const row of updates) this.rows.set(row.agentId, row);
    this.lastSeen = new Date().toISOString();
    return updates;
  }
  flow(d: any) {
    if (!object(d) || !Array.isArray(d.zones) || d.zones.length < 1 || d.zones.length > flowZones.length) throw new Error('zones[] required (1-6)');
    const seen = new Set<string>();
    // Validate the complete report before applying any zone.
    const zones = d.zones.map((z: any) => object(z) ? { ...z, capacity: z.capacity ?? null, waitMin: z.waitMin ?? null } : z);
    for (const z of zones) {
      if (!object(z) || !flowZones.includes(z.zone) || seen.has(z.zone) || !Number.isSafeInteger(z.waiting) || z.waiting < 0 ||
        (z.capacity !== null && (!Number.isSafeInteger(z.capacity) || z.capacity <= 0)) ||
        (z.waitMin !== null && !finite(z.waitMin, 0))) throw new Error('Invalid flow zone');
      seen.add(z.zone);
    }
    const t = this.simTime ?? Date.now() / 1000, updatedAt = new Date().toISOString();
    for (const z of zones as { zone: FlowZone; waiting: number; capacity: number | null; waitMin: number | null }[]) {
      // Entries newer than t mean the sim clock restarted; drop them with the expired ones.
      const history = (this.flowHistory.get(z.zone) ?? []).filter(h => h.t <= t && h.t > t - PEAK_WINDOW_S).slice(-HISTORY_MAX + 1);
      history.push({ t, waiting: z.waiting });
      this.flowHistory.set(z.zone, history);
      this.flowRows.set(z.zone, { waiting: z.waiting, capacity: z.capacity, waitMin: z.waitMin, peak: Math.max(...history.map(h => h.waiting)), updatedAt });
    }
    this.lastSeen = updatedAt;
  }
  agents(filters: URLSearchParams) {
    return [...this.rows.values()].filter(r => ['role', 'location', 'action'].every(k => !filters.get(k) || filters.get(k) === (r as any)[k]));
  }
  snapshot(connected: boolean, metrics: unknown) {
    const counts: Record<string, Record<string, number>> = {}, actions: Record<string, number> = Object.create(null);
    const phoneCounts = { unknown: 0, notified: 0, read: 0, acting: 0 };
    for (const row of this.rows.values()) {
      const role = counts[row.role] ??= { home: 0, road: 0, terminal: 0, kerb: 0 };
      role[row.location] = (role[row.location] ?? 0) + 1; actions[row.action] = (actions[row.action] ?? 0) + 1; phoneCounts[row.phone]++;
    }
    return { connected, lastSeen: this.lastSeen, run: this.run ?? { scenario: null, arm: null, coverage: null, seed: null }, simTime: this.simTime, speed: this.speed, counts, actions, phones: phoneCounts, metrics, flow: Object.fromEntries(this.flowRows) };
  }
}
