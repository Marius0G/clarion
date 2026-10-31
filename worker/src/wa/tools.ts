import { route, zoneDensities } from '../../../backend/src/routing.js';
import { terminalGraph, zoneAreas } from '../../../backend/src/terminal.js';
// The WhatsApp agent's tools (SPEC-v2 D15). Read-only views of the Tower: flights, queues and the arrival plan (D5).
import { clockLabel, clockText, closeAt, etd, findFlight, gateName, type Clock, type Flight } from './flights.js';
import { ISSUE_LABELS, classifyIssue, isIssueKind, matchNode, type Report, type IssueKind } from './reports.js';

export interface ZoneRow {
  density?: number | null; stale?: boolean; waiting: number; waitMin: number | null; peak?: number; staff?: number | null; capacity?: number | null;
  forecast?: { inMin: number; waitMin: number }[] | null;
}
/** What the agent may read from the Tower. Implemented in index.ts over the sim store; plain data in tests. */
export interface AirportView {
  clock(): Clock;
  flow(): Record<string, ZoneRow>;
  flights(): readonly Flight[];
  provisional(): boolean;
  blocked?(): readonly string[];
}
export interface Profile {
  phone: string; role: 'passenger' | 'staff';
  flight?: string; airline?: string; pageToken?: string; token?: string; verified?: boolean;
  hasCheckedBag?: boolean; lastInboundAt?: number; name?: string;
}
export type Tools = Record<string, (input: any) => Promise<unknown>>;

// Legacy fallback in minutes, used only when no security-to-gate route is available.
export const GATE_WALK_MIN: Record<string, number> = { gate_1: 3, gate_2: 4, gate_3: 5, gate_4: 6, G1: 3, G2: 4, G3: 5, G4: 6 };
const DEFAULT_WALK_MIN = 5;
export const MARGIN_MIN = 10;
// Used only when neither a forecast nor a live wait exists for a zone (no Unity, no history yet).
export const DEFAULT_WAIT_MIN: Record<string, number> = { bag_drop: 12, check_in: 15, security: 15 };

const ZONE_NAMES: Record<string, string> = {
  check_in: 'Check-in', bag_drop: 'Predare bagaje', security: 'Control de securitate',
  arrivals_hall: 'Sala de sosiri', taxi_rank: 'Stația de taxi', kerb: 'Zona de oprire',
};
/** "check_in:2" -> "Check-in, grupul 2" (desk group, D8); "check_in:W6" -> "Check-in W6" (legacy per airline). */
export function zoneName(zone: string) {
  const [base, suffix] = zone.split(':');
  const name = ZONE_NAMES[base!] ?? base;
  if (!suffix) return name!;
  return /^\d+$/.test(suffix) ? `${name}, grupul ${suffix}` : `${name} ${suffix}`;
}
/** Readable node: "gate_2" -> "Poarta 2", "exit_1" -> "Ieșirea 1", "check_in:2" -> "Check-in, grupul 2". */
export function nodeName(id: string) {
  const n = /^(gate|exit)_(\d+)$/.exec(id);
  if (n) return `${n[1] === 'gate' ? 'Poarta' : 'Ieșirea'} ${n[2]}`;
  return ({ entrance: 'Intrarea', airside: 'Zona de plecări', team_post: 'Postul echipei' } as Record<string, string>)[id] ?? zoneName(id);
}

/** The flight's own queues: its desk group (D8: check_in:2 / bag_drop:2), else the airline's (legacy check_in:W6). */
export function ownZones(flight: Pick<Flight, 'airline' | 'checkIn'> | undefined) {
  if (!flight) return [];
  const group = flight.checkIn?.split(':')[1];
  return [...(group ? [`check_in:${group}`, `bag_drop:${group}`] : []), `check_in:${flight.airline}`, `bag_drop:${flight.airline}`];
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

/** The flight's desk group queue first (D8: bag_drop:2), then the airline's (legacy), then the shared one. */
function zoneFor(flow: Record<string, ZoneRow>, bases: string[], flight: Flight) {
  const group = flight.checkIn?.split(':')[1];
  const suffixes = [...(group ? [group] : []), flight.airline];
  for (const suffix of suffixes) for (const base of bases) if (flow[`${base}:${suffix}`]) return { key: `${base}:${suffix}`, base, row: flow[`${base}:${suffix}`] };
  for (const base of bases) if (flow[base]) return { key: base, base, row: flow[base] };
  return { key: `${bases[0]}:${suffixes[0]}`, base: bases[0]!, row: undefined };
}

/**
 * D5: be at the terminal entrance at gateCloseAt − (bag drop if checked bag + security + walk to gate + margin),
 * each wait taken for the time he gets there. Two passes: the first estimate picks which forecast point applies.
 */
export function arrivalPlan(flight: Flight, flow: Record<string, ZoneRow>, clock: Clock, hasCheckedBag: boolean | undefined, blocked: readonly string[] = []) {
  const bag = hasCheckedBag !== false;
  const bagZone = zoneFor(flow, ['bag_drop', 'check_in'], flight);
  const secZone = { key: 'security', row: flow.security };
  const close = closeAt(flight);
  const walk = route(terminalGraph, 'security', flight.gate, zoneDensities(flow, zoneAreas), blocked);
  const steps = (inMin: number) => {
    const out: { zone: string; step: string; min: number; source: string }[] = [];
    if (bag) { const w = waitAt(bagZone.row, bagZone.base, inMin); out.push({ zone: bagZone.key, step: zoneName(bagZone.key), min: Math.ceil(w.min), source: w.source }); }
    const s = waitAt(secZone.row, 'security', inMin);
    out.push({ zone: secZone.key, step: zoneName(secZone.key), min: Math.ceil(s.min), source: s.source });
    out.push({ zone: 'walk', step: `Drum până la poarta ${gateName(flight.gate)}`, min: walk ? Math.ceil(walk.totalSec / 60) : GATE_WALK_MIN[flight.gate] ?? DEFAULT_WALK_MIN, source: walk ? 'traseu live' : 'constantă' });
    out.push({ zone: 'margin', step: 'Marjă', min: MARGIN_MIN, source: 'constantă' });
    return out;
  };
  let plan = steps(0);
  for (let pass = 0; pass < 2; pass++) {
    const total = plan.reduce((s, x) => s + x.min, 0);
    plan = steps(Math.max(0, (close - total * 60 - clock.now) / 60));
  }
  const totalMin = plan.reduce((s, x) => s + x.min, 0);
  // Rounded down to 5 minutes: "14:20" reads better than "14:23" and errs on the early side.
  const at = Math.floor((close - totalMin * 60) / 300) * 300;
  return {
    flight: flight.flight, gate: gateName(flight.gate), gateCloseAt: clockText(close),
    beAtEntranceAt: clockText(at), minutesFromNow: Math.round((at - clock.now) / 60), late: at < clock.now,
    totalMin, steps: plan, assumedCheckedBag: hasCheckedBag === undefined, clock: clockLabel(clock),
  };
}

function flightView(f: Flight, clock: Clock, provisional: boolean) {
  return {
    flight: f.flight, airline: f.airline, destination: f.destination, gate: gateName(f.gate),
    departure: clockText(etd(f)), gateCloseAt: clockText(closeAt(f)), status: f.status, delayMin: f.delayMin,
    ...(f.delayMin > 0 && { scheduledDeparture: clockText(f.std) }),
    checkIn: f.checkIn ? [zoneName(f.checkIn)] : f.checkInDesks.map(zoneName), now: clockText(clock.now), clock: clockLabel(clock),
    ...(provisional && { note: 'Orar provizoriu de test, nu orarul real al aeroportului.' }),
  };
}

export interface ToolDeps {
  view: AirportView;
  profile: () => Profile;
  save: (patch: Partial<Profile>) => Promise<void>;
  /** Stores a staff report (D11); absent in read-only contexts. */
  report?: (input: { kind: IssueKind; node: string | null; text: string; etaMin: number | null }) => Promise<Report>;
  pageLink?: () => Promise<string>;
}

/** The five D15 tools for one person, using the shared provisional terminal graph. */
export function toolsFor({ view, profile, save, report, pageLink }: ToolDeps): Tools {
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
      return { ...arrivalPlan(f, view.flow(), view.clock(), profile().hasCheckedBag, view.blocked?.()), status: f.status, delayMin: f.delayMin };
    },
    async queues() {
      const flow = view.flow(), clock = view.clock(), p = profile();
      const mine = new Set(ownZones(p.flight ? findFlight(view.flights(), p.flight) : p.airline ? { airline: p.airline } : undefined));
      const zones = Object.entries(flow).map(([zone, z]) => ({
        zone: zoneName(zone), waiting: z.waiting, waitMin: z.waitMin, peak30min: z.peak, staff: z.staff,
        ...(z.forecast?.length && { forecast: z.forecast.map(p => ({ inMin: p.inMin, waitMin: p.waitMin })) }),
        ...(mine.has(zone) && { yours: true }),
      }));
      if (!zones.length) return { available: false, note: 'Nu am date live despre cozi acum.', now: clockText(clock.now), clock: clockLabel(clock) };
      return { available: true, zones, now: clockText(clock.now), clock: clockLabel(clock) };
    },
    async routeTo(input: { to?: string; flight?: string }) {
      const to = input?.to ?? 'gate';
      if (!['gate', 'check_in', 'exit'].includes(to)) return { error: 'invalid_destination' };
      const density = zoneDensities(view.flow(), zoneAreas), blocked = view.blocked?.() ?? [];
      // No passenger position is available on WhatsApp: explicitly start at the entrance.
      let targets: string[];
      if (to === 'exit') targets = terminalGraph.nodes.filter(n => n.kind === 'exit').map(n => n.id);
      else {
        const r = await resolve(input?.flight);
        if ('error' in r) return r;
        targets = to === 'gate' ? [r.flight.gate] : r.flight.checkIn ? [r.flight.checkIn] : r.flight.checkInDesks;
      }
      const best = targets.map(id => route(terminalGraph, 'entrance', id, density, blocked))
        .filter(r => r !== null).sort((a, b) => a.totalSec - b.totalSec)[0];
      if (!best) return { status: 'unavailable', note: 'Nu există un traseu liber cunoscut. Cere ajutorul personalului.' };
      const minutes = Math.ceil(best.totalSec / 60);
      return { status: 'ready', ...best, minutes, from: 'entrance', to: best.nodes.at(-1),
        steps: best.nodes.map(nodeName), note: `De la intrare: ${best.nodes.map(nodeName).join(' → ')}. ~${minutes} min.`,
        ...(pageLink && { link: await pageLink() }), provisional: terminalGraph.provisional };
    },
    async reportIssue(input: { text?: string; kind?: string; location?: string }) {
      if (profile().role !== 'staff') return { error: 'staff_only', note: 'Doar angajații aeroportului pot raporta incidente aici.' };
      const text = String(input?.text ?? '').trim();
      if (!text) return { error: 'empty', hint: 'Cere-i angajatului ce s-a întâmplat și unde.' };
      if (!report) return { error: 'unavailable', note: 'Nu pot trimite raportul acum. Sună la dispecerat.' };
      const kind = isIssueKind(input?.kind) ? input.kind : classifyIssue(text);
      const node = matchNode(`${input?.location ?? ''} ${text}`, view.flights());
      const path = node ? route(terminalGraph, 'team_post', node, zoneDensities(view.flow(), zoneAreas), view.blocked?.()) : null;
      const etaMin = path ? Math.ceil(path.totalSec / 60) : null;
      const r = await report({ kind, node, etaMin, text: input?.location ? `${text} (loc: ${input.location})` : text });
      return { status: 'sent', id: r.id, etaMin, kind: ISSUE_LABELS[kind], place: node ? nodeName(node) : 'loc neprecizat',
        note: `Raportul e pe harta din dashboard. Echipa de intervenție a fost anunțată. ${etaMin === null ? 'ETA indisponibil: loc necunoscut sau traseu blocat.' : `Echipa ajunge în ~${etaMin} min`}` };
    },
  };
}
