// The WhatsApp agent's tools (SPEC-v2 D15). Read-only views of the Tower: flights, queues and the arrival plan (D5).
import { clockLabel, clockText, findFlight, type Clock, type Flight } from './flights.js';

export interface ZoneRow {
  waiting: number; waitMin: number | null; peak?: number; staff?: number; capacity?: number | null;
  forecast?: { inMin: number; waitMin: number }[];
}
/** What the agent may read from the Tower. Implemented in index.ts over the sim store; plain data in tests. */
export interface AirportView {
  clock(): Clock;
  flow(): Record<string, ZoneRow>;
  flights(): readonly Flight[];
  provisional(): boolean;
}
export interface Profile {
  phone: string; role: 'passenger' | 'staff';
  flight?: string; airline?: string; token?: string; verified?: boolean;
  hasCheckedBag?: boolean; lastInboundAt?: number; name?: string;
}
export type Tools = Record<string, (input: any) => Promise<unknown>>;

// Walk from security to the gate, minutes. Constant per gate until terminal.json (D7) gives the real edges.
export const GATE_WALK_MIN: Record<string, number> = { G1: 3, G2: 4, G3: 5, G4: 6 };
const DEFAULT_WALK_MIN = 5;
export const MARGIN_MIN = 10;
// Used only when neither a forecast nor a live wait exists for a zone (no Unity, no history yet).
export const DEFAULT_WAIT_MIN: Record<string, number> = { bag_drop: 12, check_in: 15, security: 15 };

const ZONE_NAMES: Record<string, string> = {
  check_in: 'Check-in', bag_drop: 'Predare bagaje', security: 'Control de securitate',
  arrivals_hall: 'Sala de sosiri', taxi_rank: 'Stația de taxi', kerb: 'Zona de oprire',
};
export function zoneName(zone: string) {
  const [base, airline] = zone.split(':');
  return `${ZONE_NAMES[base!] ?? base}${airline ? ` ${airline}` : ''}`;
}

type Source = 'prognoză' | 'acum' | 'estimare standard';
/** Wait at a zone for someone arriving inMin minutes from now: forecast (interpolated), else live, else default. */
export function waitAt(row: ZoneRow | undefined, base: string, inMin: number): { min: number; source: Source } {
  const forecast = (row?.forecast ?? []).filter(p => Number.isFinite(p.inMin) && Number.isFinite(p.waitMin)).sort((a, b) => a.inMin - b.inMin);
  if (forecast.length) {
    const points = [{ inMin: 0, waitMin: row?.waitMin ?? forecast[0]!.waitMin }, ...forecast.filter(p => p.inMin > 0)];
    if (inMin <= 0) return { min: points[0]!.waitMin, source: 'prognoză' };
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1]!, b = points[i]!;
      if (inMin <= b.inMin) return { min: a.waitMin + (b.waitMin - a.waitMin) * (inMin - a.inMin) / (b.inMin - a.inMin), source: 'prognoză' };
    }
    return { min: points.at(-1)!.waitMin, source: 'prognoză' };
  }
  if (row && row.waitMin !== null && Number.isFinite(row.waitMin)) return { min: row.waitMin, source: 'acum' };
  return { min: DEFAULT_WAIT_MIN[base] ?? 10, source: 'estimare standard' };
}

/** The airline's own queue first (D8: check_in:W6), then the shared one. */
function zoneFor(flow: Record<string, ZoneRow>, bases: string[], airline: string) {
  for (const base of bases) if (flow[`${base}:${airline}`]) return { key: `${base}:${airline}`, base, row: flow[`${base}:${airline}`] };
  for (const base of bases) if (flow[base]) return { key: base, base, row: flow[base] };
  return { key: `${bases[0]}:${airline}`, base: bases[0]!, row: undefined };
}

/**
 * D5: be at the terminal entrance at gateCloseAt − (bag drop if checked bag + security + walk to gate + margin),
 * each wait taken for the time he gets there. Two passes: the first estimate picks which forecast point applies.
 */
export function arrivalPlan(flight: Flight, flow: Record<string, ZoneRow>, clock: Clock, hasCheckedBag: boolean | undefined) {
  const bag = hasCheckedBag !== false;
  const bagZone = zoneFor(flow, ['bag_drop', 'check_in'], flight.airline);
  const secZone = zoneFor(flow, ['security'], flight.airline);
  const steps = (inMin: number) => {
    const out: { step: string; min: number; source: string }[] = [];
    if (bag) { const w = waitAt(bagZone.row, bagZone.base, inMin); out.push({ step: zoneName(bagZone.key), min: Math.ceil(w.min), source: w.source }); }
    const s = waitAt(secZone.row, 'security', inMin);
    out.push({ step: zoneName(secZone.key), min: Math.ceil(s.min), source: s.source });
    out.push({ step: `Drum până la poarta ${flight.gate}`, min: GATE_WALK_MIN[flight.gate] ?? DEFAULT_WALK_MIN, source: 'constantă' });
    out.push({ step: 'Marjă', min: MARGIN_MIN, source: 'constantă' });
    return out;
  };
  let plan = steps(0);
  for (let pass = 0; pass < 2; pass++) {
    const total = plan.reduce((s, x) => s + x.min, 0);
    plan = steps(Math.max(0, (flight.gateCloseAt - total * 60 - clock.now) / 60));
  }
  const totalMin = plan.reduce((s, x) => s + x.min, 0);
  // Rounded down to 5 minutes: "14:20" reads better than "14:23" and errs on the early side.
  const at = Math.floor((flight.gateCloseAt - totalMin * 60) / 300) * 300;
  return {
    flight: flight.flight, gate: flight.gate, gateCloseAt: clockText(flight.gateCloseAt),
    beAtEntranceAt: clockText(at), minutesFromNow: Math.round((at - clock.now) / 60), late: at < clock.now,
    totalMin, steps: plan, assumedCheckedBag: hasCheckedBag === undefined, clock: clockLabel(clock),
  };
}

function flightView(f: Flight, clock: Clock, provisional: boolean) {
  return {
    flight: f.flight, airline: f.airline, destination: f.destination, gate: f.gate,
    departure: clockText(f.std), gateCloseAt: clockText(f.gateCloseAt), status: f.status, delayMin: f.delayMin,
    checkIn: f.checkInDesks.map(zoneName), now: clockText(clock.now), clock: clockLabel(clock),
    ...(provisional && { note: 'Orar provizoriu de test, nu orarul real al aeroportului.' }),
  };
}

export interface ToolDeps {
  view: AirportView;
  profile: () => Profile;
  save: (patch: Partial<Profile>) => Promise<void>;
}

/** The five D15 tools for one person. routeTo and reportIssue are stubs until terminal.json (D7) and D11 land. */
export function toolsFor({ view, profile, save }: ToolDeps): Tools {
  const resolve = async (code?: string) => {
    const p = profile();
    const wanted = code || p.flight;
    if (!wanted) return { error: 'no_flight', hint: 'Cere-i numărul zborului (ex: W6 3751).' } as const;
    const f = findFlight(view.flights(), wanted);
    if (!f) return { error: 'unknown_flight', flight: wanted, hint: 'Zborul nu e în orarul de azi. Roagă-l să verifice numărul.' } as const;
    // A flight number given in chat binds the person too, unverified (no Wallet token).
    if (!p.flight) await save({ flight: f.flight, airline: f.airline, verified: false });
    return { flight: f };
  };
  return {
    async myFlight(input: { flight?: string }) {
      const r = await resolve(input?.flight);
      return 'error' in r ? r : flightView(r.flight, view.clock(), view.provisional());
    },
    async whenToArrive(input: { flight?: string; hasCheckedBag?: boolean }) {
      const r = await resolve(input?.flight);
      if ('error' in r) return r;
      if (typeof input?.hasCheckedBag === 'boolean') await save({ hasCheckedBag: input.hasCheckedBag });
      const f = r.flight;
      if (f.status === 'cancelled') return { flight: f.flight, status: 'cancelled', note: 'Zborul e anulat. Pasagerul ia legătura cu compania aeriană.' };
      if (f.status === 'departed') return { flight: f.flight, status: 'departed', note: 'Zborul a plecat deja.' };
      return { ...arrivalPlan(f, view.flow(), view.clock(), profile().hasCheckedBag), status: f.status, delayMin: f.delayMin };
    },
    async queues() {
      const flow = view.flow(), clock = view.clock(), airline = profile().airline;
      const zones = Object.entries(flow).map(([zone, z]) => ({
        zone: zoneName(zone), waiting: z.waiting, waitMin: z.waitMin, peak30min: z.peak, staff: z.staff,
        ...(z.forecast?.length && { forecast: z.forecast.map(p => ({ inMin: p.inMin, waitMin: p.waitMin })) }),
        ...(airline && zone.endsWith(`:${airline}`) && { yours: true }),
      }));
      if (!zones.length) return { available: false, note: 'Nu am date live despre cozi acum.', now: clockText(clock.now), clock: clockLabel(clock) };
      return { available: true, zones, now: clockText(clock.now), clock: clockLabel(clock) };
    },
    async routeTo(input: { to?: string }) {
      return { status: 'coming_soon', to: input?.to ?? null, note: 'Hărțile cu traseul până la poartă vin în curând. Până atunci, urmează indicatoarele din terminal.' };
    },
    async reportIssue(input: { text?: string }) {
      if (profile().role !== 'staff') return { error: 'staff_only', note: 'Doar angajații aeroportului pot raporta incidente aici.' };
      return { status: 'coming_soon', received: Boolean(input?.text), note: 'Raportarea către dashboard vine în curând. Sună la dispecerat pentru urgențe.' };
    },
  };
}
