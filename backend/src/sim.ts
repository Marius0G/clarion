import { isRole, type Role } from './types.js';
export const locations = ['home', 'road', 'terminal', 'kerb'] as const;
export type LegacyLocation = typeof locations[number];
const phones = ['unknown', 'notified', 'read', 'acting'] as const;
const stages = ['public', 'airside', 'gate'] as const;
export interface SimAgent {
  agentId: string; role: Role; persona: string;
  /** Legacy place (home/road/terminal/kerb) or a node id from terminal.json. */
  location: string; phone: typeof phones[number]; action: string;
  trigger?: string; lat?: number; lon?: number; thought?: string; stage?: typeof stages[number];
}
const object = (v: any) => v && typeof v === 'object' && !Array.isArray(v);
const text = (v: any, max: number) => typeof v === 'string' && v.length <= max;
const finite = (v: any, min: number, max = Infinity) => Number.isFinite(v) && v >= min && v <= max;
const withoutNulls = (r: any) => object(r) ? Object.fromEntries(Object.entries(r).filter(([, v]) => v !== null)) : r;
export const flowZones = ['check_in', 'bag_drop', 'security', 'arrivals_hall', 'taxi_rank', 'kerb'] as const;
export type FlowZone = typeof flowZones[number];
export interface Forecast { inMin: number; waitMin: number }
export interface FlowRow {
  waiting: number; capacity: number | null; waitMin: number | null; staff: number | null;
  forecast: Forecast[] | null; peak: number; updatedAt: string;
}
/** Node / zone id from terminal.json, e.g. `security`, `gate_1`, `check_in:W6`. */
const nodeId = (v: any) => typeof v === 'string' && /^[a-z][a-z0-9_]{0,39}(:[A-Za-z0-9_-]{1,16})?$/.test(v);
/** Per-airline ids carry the IATA code in upper case (D8). */
const upperSuffix = (v: any) => typeof v === 'string' ? v.replace(/:([A-Za-z0-9]{2})$/, (_, c: string) => `:${c.toUpperCase()}`) : v;
/** The six T2 queues plus `check_in:<IATA>` / `bag_drop:<IATA>` (D8). */
export const isFlowZone = (v: any) => (flowZones as readonly string[]).includes(v) || (typeof v === 'string' && /^(check_in|bag_drop):[A-Z0-9]{2}$/.test(v));
const FLOW_ZONES_MAX = 64, FORECAST_MAX = 12, FLIGHTS_MAX = 300, PEOPLE_MAX = 2000, OPS_KEPT = 50, POSITIONS_MIN_MS = 900;
/** Peak window: 30 minutes, in sim seconds when sim.status has given a simTime, else wall-clock seconds. */
const PEAK_WINDOW_S = 1800, HISTORY_MAX = 4000;
const flightStatuses = ['scheduled', 'boarding', 'delayed', 'cancelled', 'departed'] as const;
/** D14 schedule row. Times are sim time (seconds or a clock string, as Unity sends them). */
export interface TerminalFlight {
  flight: string; airline: string; destination: string; std: number | string; gate: string | null; checkInDesks: string[];
  /** D8: the desk group zone serving the flight, e.g. `check_in:2`. Absent when Unity does not send it. */
  checkIn?: string;
  gateCloseAt: number | string | null; status: typeof flightStatuses[number]; delayMin: number; pax: number | null;
}
export interface Person { x: number; y: number; kind: 'pax' | 'staff' }
export const opsTypes = ['staff', 'redirect', 'evacuate', 'close', 'open'] as const;
export type OpsCommand =
  | { type: 'staff'; zone: string; delta: number }
  | { type: 'redirect'; from: string; to: string }
  | { type: 'evacuate'; zones: string[] }
  | { type: 'close' | 'open'; zone: string };
export type OpsRecord = OpsCommand & { id: string; status: 'sent' | 'acked'; sentAt: string; ackedAt: string | null };
/** The ops.command payload Unity receives: the command and its id, no tracking fields. */
export const opsWire = ({ status: _s, sentAt: _t, ackedAt: _a, ...wire }: OpsRecord) => wire;
const simTimeValue = (v: any) => finite(v, 0) || (text(v, 40) && v.length > 0);
/** D12: validate an admin decision before it is forwarded to Unity as ops.command. */
export function opsCommand(d: any): OpsCommand {
  if (!object(d) || !opsTypes.includes(d.type)) throw new Error('Invalid ops command');
  if (d.type === 'staff') {
    if (!nodeId(d.zone) || !Number.isSafeInteger(d.delta) || d.delta === 0 || Math.abs(d.delta) > 20) throw new Error('Invalid ops command');
    return { type: 'staff', zone: upperSuffix(d.zone), delta: d.delta };
  }
  if (d.type === 'redirect') {
    if (!nodeId(d.from) || !nodeId(d.to) || upperSuffix(d.from) === upperSuffix(d.to)) throw new Error('Invalid ops command');
    return { type: 'redirect', from: upperSuffix(d.from), to: upperSuffix(d.to) };
  }
  if (d.type === 'evacuate') {
    if (!Array.isArray(d.zones) || d.zones.length < 1 || d.zones.length > 50 || !d.zones.every(nodeId) || new Set(d.zones.map(upperSuffix)).size !== d.zones.length) throw new Error('Invalid ops command');
    return { type: 'evacuate', zones: d.zones.map(upperSuffix) };
  }
  if (!nodeId(d.zone)) throw new Error('Invalid ops command');
  return { type: d.type, zone: upperSuffix(d.zone) };
}
export const routeReasons = ['gate', 'check_in', 'evacuate', 'redirect'] as const;
/** Contract `agent.route`: the phone agent walks this node path in Unity. */
export function agentRoute(d: any) {
  if (!object(d) || !text(d.agentId, 100) || !d.agentId || !Array.isArray(d.nodes) || d.nodes.length < 1 || d.nodes.length > 200 || !d.nodes.every(nodeId) || !routeReasons.includes(d.reason)) throw new Error('Invalid agent route');
  return { agentId: d.agentId as string, nodes: (d.nodes as string[]).map(upperSuffix), reason: d.reason as typeof routeReasons[number] };
}
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
  private flowRows = new Map<string, FlowRow>();
  private flowHistory = new Map<string, { t: number; waiting: number }[]>();
  private flightRows: TerminalFlight[] = [];
  private flightsAt: string | null = null;
  private people: { people: Person[]; at: string } | null = null;
  private peopleMs = -Infinity;
  private ops: OpsRecord[] = [];
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
      r = withoutNulls(r);
      if (!object(r) || !text(r.agentId, 100) || !r.agentId || !isRole(r.role) || !text(r.persona, 100) || !(locations.includes(r.location) || nodeId(r.location)) || (r.stage !== undefined && !stages.includes(r.stage)) || !phones.includes(r.phone) || !text(r.action, 40) || (r.trigger !== undefined && !text(r.trigger, 40)) || (r.thought !== undefined && !text(r.thought, 200)) || ((r.lat !== undefined || r.lon !== undefined) && (!finite(r.lat, -90, 90) || !finite(r.lon, -180, 180)))) throw new Error('Invalid sim agent');
      const row: SimAgent = { agentId: r.agentId, role: r.role, persona: r.persona, location: upperSuffix(r.location), phone: r.phone, action: r.action };
      for (const k of ['trigger', 'thought', 'lat', 'lon', 'stage'] as const) if (r[k] !== undefined) (row as any)[k] = r[k];
      return row;
    });
    const ids = new Set([...this.rows.keys(), ...updates.map(r => r.agentId)]);
    if (ids.size > 5000) throw new Error('Sim store exceeds 5000 agents');
    for (const row of updates) this.rows.set(row.agentId, row);
    this.lastSeen = new Date().toISOString();
    return updates;
  }
  flow(d: any) {
    if (!object(d) || !Array.isArray(d.zones) || d.zones.length < 1 || d.zones.length > FLOW_ZONES_MAX) throw new Error(`zones[] required (1-${FLOW_ZONES_MAX})`);
    const seen = new Set<string>();
    // Validate the complete report before applying any zone.
    const zones = d.zones.map((z: any) => object(z) ? { ...z, zone: upperSuffix(z.zone), capacity: z.capacity ?? null, waitMin: z.waitMin ?? null, staff: z.staff ?? null, forecast: z.forecast ?? null } : z);
    for (const z of zones) {
      if (!object(z) || !isFlowZone(z.zone) || seen.has(z.zone) || !Number.isSafeInteger(z.waiting) || z.waiting < 0 ||
        (z.capacity !== null && (!Number.isSafeInteger(z.capacity) || z.capacity <= 0)) ||
        (z.waitMin !== null && !finite(z.waitMin, 0)) ||
        (z.staff !== null && (!Number.isSafeInteger(z.staff) || z.staff < 0)) ||
        (z.forecast !== null && (!Array.isArray(z.forecast) || z.forecast.length > FORECAST_MAX ||
          !z.forecast.every((f: any) => object(f) && finite(f.inMin, 0, 1440) && finite(f.waitMin, 0))))) throw new Error('Invalid flow zone');
      seen.add(z.zone);
    }
    const t = this.simTime ?? Date.now() / 1000, updatedAt = new Date().toISOString();
    for (const z of zones as { zone: string; waiting: number; capacity: number | null; waitMin: number | null; staff: number | null; forecast: Forecast[] | null }[]) {
      // Entries newer than t mean the sim clock restarted; drop them with the expired ones.
      const history = (this.flowHistory.get(z.zone) ?? []).filter(h => h.t <= t && h.t > t - PEAK_WINDOW_S).slice(-HISTORY_MAX + 1);
      history.push({ t, waiting: z.waiting });
      this.flowHistory.set(z.zone, history);
      const forecast = z.forecast && z.forecast.map(f => ({ inMin: f.inMin, waitMin: f.waitMin }));
      this.flowRows.set(z.zone, { waiting: z.waiting, capacity: z.capacity, waitMin: z.waitMin, staff: z.staff, forecast, peak: Math.max(...history.map(h => h.waiting)), updatedAt });
    }
    this.lastSeen = updatedAt;
  }
  /** D14: the full schedule, replaced on every message. */
  flights(d: any) {
    if (!object(d) || !Array.isArray(d.flights) || d.flights.length > FLIGHTS_MAX) throw new Error(`flights[] required (max ${FLIGHTS_MAX})`);
    const ids = new Set<string>();
    const rows: TerminalFlight[] = d.flights.map((raw: any) => {
      const f = withoutNulls(raw);
      if (!object(f) || !text(f.flight, 20) || !f.flight.trim() || ids.has(f.flight) || typeof f.airline !== 'string' || !/^[A-Za-z0-9]{2}$/.test(f.airline) ||
        !text(f.destination, 100) || !simTimeValue(f.std) || (f.gate !== undefined && !nodeId(f.gate)) ||
        (f.checkInDesks !== undefined && (!Array.isArray(f.checkInDesks) || f.checkInDesks.length > 50 || !f.checkInDesks.every(nodeId))) ||
        (f.checkIn !== undefined && (!nodeId(f.checkIn) || !/^check_in:/.test(f.checkIn))) ||
        (f.gateCloseAt !== undefined && !simTimeValue(f.gateCloseAt)) || !flightStatuses.includes(f.status) ||
        (f.delayMin !== undefined && !finite(f.delayMin, 0)) || (f.pax !== undefined && (!Number.isSafeInteger(f.pax) || f.pax < 0))) throw new Error('Invalid flight');
      ids.add(f.flight);
      return { flight: f.flight, airline: f.airline.toUpperCase(), destination: f.destination, std: f.std, gate: f.gate ?? null,
        checkInDesks: (f.checkInDesks ?? []).map(upperSuffix), ...(f.checkIn !== undefined && { checkIn: upperSuffix(f.checkIn) }), gateCloseAt: f.gateCloseAt ?? null, status: f.status, delayMin: f.delayMin ?? 0, pax: f.pax ?? null };
    });
    this.flightRows = rows; this.flightsAt = this.lastSeen = new Date().toISOString();
  }
  /** Crowd dots in terminal metres. One snapshot per ~second is kept; faster ones are dropped (false). */
  positions(d: any, now = Date.now()): boolean {
    if (!object(d) || !Array.isArray(d.people) || d.people.length > PEOPLE_MAX) throw new Error(`people[] required (max ${PEOPLE_MAX})`);
    const people: Person[] = d.people.map((p: any) => {
      if (!object(p) || !finite(p.x, -1e5, 1e5) || !finite(p.y, -1e5, 1e5) || !['pax', 'staff'].includes(p.kind)) throw new Error('Invalid person');
      return { x: p.x, y: p.y, kind: p.kind };
    });
    if (now - this.peopleMs < POSITIONS_MIN_MS) return false;
    this.peopleMs = now;
    this.people = { people, at: this.lastSeen = new Date(now).toISOString() };
    return true;
  }
  /** Records a command forwarded to Unity and gives it its id. */
  sent(command: OpsCommand): OpsRecord {
    const record: OpsRecord = { ...command, id: crypto.randomUUID(), status: 'sent', sentAt: new Date().toISOString(), ackedAt: null };
    this.ops = [...this.ops, record].slice(-OPS_KEPT);
    return record;
  }
  ack(d: any) {
    if (!object(d) || !text(d.id, 100) || !d.id) throw new Error('Invalid ops ack');
    const record = this.ops.find(o => o.id === d.id);
    if (!record) throw new Error('Unknown ops command');
    if (record.status !== 'acked') { record.status = 'acked'; record.ackedAt = new Date().toISOString(); }
    this.lastSeen = record.ackedAt;
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
    return {
      connected, lastSeen: this.lastSeen, run: this.run ?? { scenario: null, arm: null, coverage: null, seed: null }, simTime: this.simTime, speed: this.speed,
      counts, actions, phones: phoneCounts, metrics, flow: Object.fromEntries(this.flowRows),
      flights: this.flightRows, flightsAt: this.flightsAt, positions: this.people, ops: [...this.ops].reverse(),
    };
  }
}
