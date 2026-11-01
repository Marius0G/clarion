import { Alerts, alertCommand, type StaffReport } from './alerts.js';
import { isNodeId } from './mapIds.js';
import { isRole, type Role } from './types.js';
import { initialLanes } from './terminal.js';
import { laneKey } from './mapIds.js';
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
/** Who sent a flow row: the camera service (contract v2) or a legacy Unity build. */
export type FlowSource = 'vision' | 'twin';
/**
 * A7 lane advice from vision. Contract shape `{ lanes, by, waitMinIfNot }`; a plain sentence is also accepted.
 * `by` is sim time (seconds or a clock string, as sent).
 */
export type Advice = string | { lanes: number | null; by: number | string | null; waitMinIfNot: number | null };
export interface FlowRow {
  waiting: number; waitMin: number | null;
  /** Vision (A3, A4): standard deviation of `waiting`, people per m², p90 wait. Null when not sent. */
  waitingSd: number | null; density: number | null; waitMinP90: number | null;
  /** Share of the queue the cameras see (0-1); null when vision did not say. */
  coverage: number | null;
  advice: Advice | null;
  forecast: Forecast[] | null; peak: number; updatedAt: string;
  /** No report for this zone in the last FLOW_STALE_MS: treat it as unknown, not as the old number. */
  stale: boolean; source: FlowSource;
  /** Legacy Unity fields; vision does not send them (lanes live in `lanes`). */
  capacity: number | null; staff: number | null;
}
/** Truth from Unity (D0): only for the accuracy panel and A/B, never for decisions. */
export interface TruthRow { waiting: number; waitMin: number | null }
/** Node / zone id from terminal.json, e.g. `security`, `gate_1`, `check_in:2`. */
const nodeId = isNodeId;
/** Per-airline ids carry the IATA code in upper case (D8). */
const upperSuffix = (v: any) => typeof v === 'string' ? v.replace(/:([A-Za-z0-9]{2})$/, (_, c: string) => `:${c.toUpperCase()}`) : v;
/** Any zone id from terminal.json (D7, D8): `security`, `gate_3`, `check_in:2`, `bag_drop:2`. Not a fixed list. */
export const isFlowZone = nodeId;
const FLOW_ZONES_MAX = 64, FORECAST_MAX = 12, FLIGHTS_MAX = 300, PEOPLE_MAX = 2000, OPS_KEPT = 50, POSITIONS_MIN_MS = 900, TRUTH_MIN_MS = 900;
/** Vision reports at most 1/s; a zone missing for this long is unknown again. */
export const FLOW_STALE_MS = 5000;
const LANES_MAX = 50, DENSITY_MAX = 20;
/** A7 advice: a sentence (≤200 chars) or `{ lanes?, by?, waitMinIfNot? }`; `waitMin` is read as `waitMinIfNot`. */
function advice(a: any): Advice {
  if (typeof a === 'string') { if (!a.trim() || a.length > 200) throw new Error('Invalid flow zone'); return a.trim(); }
  const v = withoutNulls(a), wait = v?.waitMinIfNot ?? v?.waitMin;
  if (!object(v) || (v.lanes !== undefined && (!Number.isSafeInteger(v.lanes) || v.lanes < 0 || v.lanes > LANES_MAX)) ||
    (v.by !== undefined && !simTimeValue(v.by)) || (wait !== undefined && !finite(wait, 0))) throw new Error('Invalid flow zone');
  return { lanes: v.lanes ?? null, by: v.by ?? null, waitMinIfNot: wait ?? null };
}
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
/** Feet point of a detected person, terminal metres. Vision sends only x, y; legacy Unity also sent kind. */
export interface Person { x: number; y: number; z?: number; level?: 'G' | 'U' | 'X'; kind?: 'pax' | 'staff'; /** Vision's track id, stable while it tracks the person; lets the map glide a dot. */ id?: string }
export const opsTypes = ['staff', 'redirect', 'evacuate', 'close', 'open'] as const;
export type OpsCommand =
  | { type: 'staff'; zone: string; delta: number }
  | { type: 'redirect'; from: string; to: string }
  | { type: 'evacuate'; zones: string[] }
  | { type: 'close' | 'open'; zone: string };
export type OpsRecord = OpsCommand & { id: string; staffState?: 'confirmed' | 'done'; staffConfirmedAt?: string; staffDoneAt?: string; status: 'sent' | 'acked'; sentAt: string; ackedAt: string | null };
/** The ops.command payload Unity receives: the command and its id, no tracking fields. */
export const opsWire = ({ status: _s, sentAt: _t, ackedAt: _a, staffState: _ss, staffConfirmedAt: _sc, staffDoneAt: _sd, ...wire }: OpsRecord) => wire;
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
  private alerts = new Alerts();
  private staffReports: StaffReport[] = [];
  reports(rows: readonly StaffReport[]) {
    if (!Array.isArray(rows) || rows.length > 200 || rows.some(r => !r || typeof r.id !== 'string' || !r.id || r.id.length > 100 || typeof r.kind !== 'string' || !['open', 'closed'].includes(r.status) || (r.node !== null && !isNodeId(r.node)) || typeof r.text !== 'string' || r.text.length > 500)) throw new Error('Invalid staff reports');
    this.staffReports = structuredClone([...rows]);
    this.alertSnapshot();
  }
  reportSnapshot() { return structuredClone(this.staffReports); }
  alertSnapshot(now = Date.now()) {
    if (this.simTime === null) return this.alerts.snapshot();
    return this.alerts.update({ simTime: this.simTime, flow: this.flowSnapshot(now, true), flights: this.flightRows, reports: this.staffReports });
  }
  alertCommand(data: unknown) {
    const command = alertCommand(data);
    if (this.simTime === null) throw new Error('Simulation clock required');
    this.alertSnapshot();
    return this.alerts.command(command, this.simTime);
  }
  private flowSnapshot(now: number, camerasOnly = false): Record<string, FlowRow> {
    return Object.fromEntries([...(camerasOnly ? this.cameraRows : this.flowRows)].map(([zone, { at, ...row }]) => [zone, { ...row, stale: now - at > FLOW_STALE_MS }]));
  }
  private rows = new Map<string, SimAgent>();
  private run: { scenario: string; arm: 'A' | 'B'; coverage: number; seed: number } | null = null;
  private simTime: number | null = null;
  private speed: number | null = null;
  private lastSeen: string | null = null;
  private flowRows = new Map<string, Omit<FlowRow, 'stale'> & { at: number }>();
  // Retain the last camera observation independently: legacy fallbacks cannot clear camera alarms.
  private cameraRows = new Map<string, Omit<FlowRow, 'stale'> & { at: number }>();
  private visionFlowMs = -Infinity;
  private laneRows = new Map<string, number>(Object.entries(initialLanes));
  private truthRows: { zones: Record<string, TruthRow>; at: string } | null = null;
  private truthMs = -Infinity;
  private flowHistory = new Map<string, { t: number; waiting: number }[]>();
  private flightRows: TerminalFlight[] = [];
  private flightsAt: string | null = null;
  private people: { people: Person[]; at: string } | null = null;
  private peopleMs = -Infinity;
  private visionPeopleMs = -Infinity;
  private ops: OpsRecord[] = [];
  private blockedZones = new Set<string>();
  reset() {
    const cleared = { simAgents: this.rows.size, flowZones: this.flowRows.size,
      truthZones: Object.keys(this.truthRows?.zones ?? {}).length, positions: this.people?.people.length ?? 0,
      flights: this.flightRows.length, commands: this.ops.length, blockedZones: this.blockedZones.size };
    this.alerts.reset(); this.staffReports = [];
    this.rows.clear(); this.run = null; this.simTime = this.speed = null; this.lastSeen = null;
    this.flowRows.clear(); this.cameraRows.clear(); this.flowHistory.clear(); this.visionFlowMs = -Infinity;
    this.laneRows = new Map(Object.entries(initialLanes));
    this.truthRows = null; this.truthMs = -Infinity;
    this.flightRows = []; this.flightsAt = null;
    this.people = null; this.peopleMs = this.visionPeopleMs = -Infinity;
    this.ops = []; this.blockedZones.clear();
    return cleared;
  }
  status(d: any) {
    if (!object(d)) throw new Error('Invalid sim status');
    runFields(d, true);
    if (typeof d.running !== 'boolean' || !finite(d.simTime, 0) || !Number.isSafeInteger(d.agents) || d.agents < 0) throw new Error('Invalid sim status');
    this.run = { scenario: d.scenario, arm: d.arm, coverage: d.coverage, seed: d.seed };
    this.simTime = d.simTime; this.speed = d.speed; this.lastSeen = new Date().toISOString();
    this.alertSnapshot();
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
  /**
   * flow.report. v2 from vision: { zone, waiting, waitingSd?, density?, waitMin?, waitMinP90?, coverage?, forecast?, advice? };
   * legacy Unity rows may add staff/capacity. A zone not in the report is not touched (it goes stale).
   * While vision is reporting, legacy twin reports are ignored (D0). Returns false when the report was ignored.
   */
  flow(d: any, source: FlowSource = 'twin', now = Date.now()): boolean {
    if (!object(d) || !Array.isArray(d.zones) || d.zones.length < 1 || d.zones.length > FLOW_ZONES_MAX) throw new Error(`zones[] required (1-${FLOW_ZONES_MAX})`);
    const seen = new Set<string>();
    // Validate the complete report before applying any zone.
    const rows = d.zones.map((raw: any) => {
      const z = withoutNulls(raw), zone = upperSuffix(z?.zone);
      if (!object(z) || !isFlowZone(zone) || seen.has(zone) || !Number.isSafeInteger(z.waiting) || z.waiting < 0 ||
        (z.capacity !== undefined && (!Number.isSafeInteger(z.capacity) || z.capacity <= 0)) ||
        (z.staff !== undefined && (!Number.isSafeInteger(z.staff) || z.staff < 0)) ||
        (z.coverage !== undefined && !finite(z.coverage, 0, 1)) ||
        (z.density !== undefined && !finite(z.density, 0, DENSITY_MAX)) ||
        !['waitMin', 'waitMinP90', 'waitingSd'].every(k => z[k] === undefined || finite(z[k], 0)) ||
        (z.forecast !== undefined && (!Array.isArray(z.forecast) || z.forecast.length > FORECAST_MAX ||
          !z.forecast.every((f: any) => object(f) && finite(f.inMin, 0, 1440) && finite(f.waitMin, 0))))) throw new Error('Invalid flow zone');
      seen.add(zone);
      const forecast: Forecast[] | null = z.forecast ? z.forecast.map((f: Forecast) => ({ inMin: f.inMin, waitMin: f.waitMin })) : null;
      return { zone, waiting: z.waiting as number, waitingSd: z.waitingSd ?? null, density: z.density ?? null, waitMin: z.waitMin ?? null,
        waitMinP90: z.waitMinP90 ?? null, coverage: z.coverage ?? null, forecast, advice: z.advice === undefined ? null : advice(z.advice),
        capacity: z.capacity ?? null, staff: z.staff ?? null };
    });
    if (source === 'vision') this.visionFlowMs = now;
    else if (now - this.visionFlowMs < FLOW_STALE_MS) return false;
    const t = this.simTime ?? now / 1000, updatedAt = new Date(now).toISOString();
    for (const { zone, ...row } of rows as ({ zone: string } & Omit<FlowRow, 'peak' | 'updatedAt' | 'stale' | 'source'>)[]) {
      // Entries newer than t mean the sim clock restarted; drop them with the expired ones.
      const history = (this.flowHistory.get(zone) ?? []).filter(h => h.t <= t && h.t > t - PEAK_WINDOW_S).slice(-HISTORY_MAX + 1);
      history.push({ t, waiting: row.waiting });
      this.flowHistory.set(zone, history);
      const observation = { ...row, peak: Math.max(...history.map(h => h.waiting)), updatedAt, source, at: now };
      this.flowRows.set(zone, observation);
      if (source === 'vision') this.cameraRows.set(zone, observation);
    }
    this.lastSeen = updatedAt;
    this.alertSnapshot(now);
    return true;
  }
  /** truth.report from Unity (D0), at most ~1/s; faster ones are dropped (false). Kept apart from flow. */
  truth(d: any, now = Date.now()): boolean {
    if (!object(d) || !Array.isArray(d.zones) || d.zones.length < 1 || d.zones.length > FLOW_ZONES_MAX) throw new Error(`zones[] required (1-${FLOW_ZONES_MAX})`);
    const zones: Record<string, TruthRow> = {};
    for (const raw of d.zones) {
      const z = withoutNulls(raw);
      if (!object(z) || !isFlowZone(z.zone) || Object.hasOwn(zones, upperSuffix(z.zone)) || !Number.isSafeInteger(z.waiting) || z.waiting < 0 ||
        (z.waitMin !== undefined && !finite(z.waitMin, 0))) throw new Error('Invalid truth zone');
      zones[upperSuffix(z.zone)] = { waiting: z.waiting, waitMin: z.waitMin ?? null };
    }
    if (now - this.truthMs < TRUTH_MIN_MS) return false;
    this.truthMs = now;
    this.truthRows = { zones, at: this.lastSeen = new Date(now).toISOString() };
    return true;
  }
  /** Counters under their canonical keys, plus the zone id for shared ones (`U_SECURITY_QUEUE`) so any reader finds them. */
  private laneSnapshot(): Record<string, number> {
    const out = Object.fromEntries(this.laneRows);
    if (this.laneRows.has('security')) out.U_SECURITY_QUEUE = this.laneRows.get('security')!;
    return out;
  }
  /** Open lanes / desks for a zone (D12); null when the backend has never had a number for it. */
  lanes(zone: string): number | null { return this.laneRows.get(laneKey(zone)) ?? null; }
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
    this.alertSnapshot();
  }
  /** Crowd dots in terminal metres. One snapshot per ~second is kept; faster ones are dropped (false). */
  positions(d: any, source: FlowSource = 'twin', now = Date.now()): boolean {
    if (!object(d) || !Array.isArray(d.people) || d.people.length > PEOPLE_MAX) throw new Error(`people[] required (max ${PEOPLE_MAX})`);
    const people: Person[] = d.people.map((raw: any) => {
      const p = withoutNulls(raw);
      const world = p?.z !== undefined;
      if (!object(p) || !finite(p.x, -1e5, 1e5) || !(world ? finite(p.z, -1e5, 1e5) && ['G', 'U', 'X'].includes(p.level) : finite(p.y, -1e5, 1e5)) || (p.kind !== undefined && !['pax', 'staff'].includes(p.kind))) throw new Error('Invalid person');
      return { x: p.x, y: world ? p.z : p.y, ...(world && { z: p.z, level: p.level }), ...(p.kind !== undefined && { kind: p.kind }), ...(typeof p.id === 'string' && /^[\w:.-]{1,64}$/.test(p.id) && { id: p.id }) };
    });
    // Same rule as flow: the cameras win over a legacy Unity build.
    if (source === 'vision') this.visionPeopleMs = now;
    else if (now - this.visionPeopleMs < FLOW_STALE_MS) return false;
    if (now - this.peopleMs < POSITIONS_MIN_MS) return false;
    this.peopleMs = now;
    this.people = { people, at: this.lastSeen = new Date(now).toISOString() };
    return true;
  }
  /**
   * Records a command forwarded to Unity and gives it its id. `staff` changes the backend's open lanes at once
   * (D12: the backend holds them, vision reads them); never below 0, at most LANES_MAX.
   */
  sent(command: OpsCommand): OpsRecord {
    if (command.type === 'evacuate') for (const zone of command.zones) this.blockedZones.add(zone);
    if (command.type === 'close') this.blockedZones.add(command.zone);
    if (command.type === 'open') this.blockedZones.delete(command.zone);
    if (command.type === 'staff')
      // Same counter whatever id the dashboard used (U_SECURITY_QUEUE, security, check_in:W6, check_in:1).
      this.laneRows.set(laneKey(command.zone), Math.min(LANES_MAX, Math.max(0, (this.laneRows.get(laneKey(command.zone)) ?? 0) + command.delta)));
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
  staffTask(id: string, state: 'confirmed' | 'done') {
    const record = this.ops.find(o => o.id === id);
    if (!record) throw new Error('Unknown task');
    if (record.staffState === state || record.staffState === 'done') return structuredClone(record);
    if (state === 'done' && record.staffState !== 'confirmed') throw new Error('Confirm task first');
    record.staffState = state;
    if (state === 'confirmed') record.staffConfirmedAt = new Date().toISOString();
    else record.staffDoneAt = new Date().toISOString();
    return structuredClone(record);
  }
  agents(filters: URLSearchParams) {
    return [...this.rows.values()].filter(r => ['role', 'location', 'action'].every(k => !filters.get(k) || filters.get(k) === (r as any)[k]));
  }
  /** `connected` = Unity (twin) online, `vision` = camera service online. */
  snapshot(connected: boolean, metrics: unknown, vision = false, now = Date.now()) {
    const counts: Record<string, Record<string, number>> = {}, actions: Record<string, number> = Object.create(null);
    const phoneCounts = { unknown: 0, notified: 0, read: 0, acting: 0 };
    for (const row of this.rows.values()) {
      const role = counts[row.role] ??= { home: 0, road: 0, terminal: 0, kerb: 0 };
      role[row.location] = (role[row.location] ?? 0) + 1; actions[row.action] = (actions[row.action] ?? 0) + 1; phoneCounts[row.phone]++;
    }
    return {
      connected, vision, lastSeen: this.lastSeen, run: this.run ?? { scenario: null, arm: null, coverage: null, seed: null }, simTime: this.simTime, speed: this.speed,
      counts, actions, phones: phoneCounts, metrics,
      flow: this.flowSnapshot(now), alerts: this.alertSnapshot(now),
      blocked: [...this.blockedZones], lanes: this.laneSnapshot(), truth: this.truthRows,
      flights: this.flightRows, flightsAt: this.flightsAt, positions: this.people, ops: [...this.ops].reverse(),
    };
  }
}
