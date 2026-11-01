import { airportInfo } from './airport-info.js';
import { factPatch } from './context.js';
import { flowRow, mapNodeId } from '../../../backend/src/mapIds.js';
import { copy, say, nodeName, zoneName, EN_ISSUES, RO_ISSUES, type Lang } from './texts.js';
import { route, zoneDensities } from '../../../backend/src/routing.js';
import { terminalGraph, zoneAreas } from '../../../backend/src/terminal.js';
// The WhatsApp agent's tools (SPEC-v2 D15). Read-only views of the Tower: flights, queues and the arrival plan (D5).
import { clockLabel, clockText, closeAt, etd, findFlight, gateName, type Clock, type Flight } from './flights.js';
import { classifyIssue, isIssueKind, matchNode, type Report, type IssueKind } from './reports.js';
import type { EvacRoute } from './messaging.js';

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
  /** D5b: mean wait per zone for the simulated hour of `simSec`, from past camera reports; used only without a fresh row. */
  history?(simSec: number): Record<string, ZoneRow>;
}
export interface Profile {
  lang?: Lang; phone: string; role: 'passenger' | 'staff';
  flight?: string; airline?: string; pageToken?: string; token?: string; verified?: boolean;
  groupSize?: number; needs?: { kids?: boolean; reducedMobility?: boolean; other?: string };
  gate?: string; lastWaitEstimate?: { at: string; totalMin: number };
  hasCheckedBag?: boolean; lastInboundAt?: number; name?: string;
}
export type Tools = Record<string, (input: any) => Promise<unknown>>;

// Legacy fallback in minutes, used only when no security-to-gate route is available.
export const GATE_WALK_MIN: Record<string, number> = { gate_1: 3, gate_2: 4, gate_3: 5, gate_4: 6, G1: 3, G2: 4, G3: 5, G4: 6 };
const DEFAULT_WALK_MIN = 5;
export const MARGIN_MIN = 10;
/** Airport police posts placed by Unity (terminal.json nodes). */
export const POLICE_POSTS = ['door_departures', 'door_exit_west'];
// Used only when neither a forecast nor a live wait exists for a zone (no Unity, no history yet).
export const DEFAULT_WAIT_MIN: Record<string, number> = { bag_drop: 12, check_in: 15, security: 15 };

export { zoneName, nodeName } from './texts.js';

/** The flight's own queues: its desk group (D8: check_in:2 / bag_drop:2), else the airline's (legacy check_in:W6). */
export function ownZones(flight: Pick<Flight, 'airline' | 'checkIn'> | undefined) {
  if (!flight) return [];
  const group = flight.checkIn?.split(':')[1];
  return [...(group ? [`check_in:${group}`, `bag_drop:${group}`] : []), `check_in:${flight.airline}`, `bag_drop:${flight.airline}`];
}

type Source = 'prognoză' | 'acum' | 'istoric' | 'estimare standard';
/** Wait at a zone for someone arriving inMin minutes from now: forecast (interpolated), else live, else the same-hour history mean (D5b), else default. */
export function waitAt(row: ZoneRow | undefined, base: string, inMin: number, past?: ZoneRow): { min: number; source: Source } {
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
  if (past && past.waitMin !== null && Number.isFinite(past.waitMin)) return { min: past.waitMin, source: 'istoric' };
  return { min: DEFAULT_WAIT_MIN[base] ?? 10, source: 'estimare standard' };
}

/** The flight's desk group queue first (D8: bag_drop:2), then the airline's (legacy), then the shared one. */
function zoneFor(flow: Record<string, ZoneRow>, bases: string[], flight: Flight) {
  const group = flight.checkIn?.split(':')[1];
  const suffixes = [...(group ? [group] : []), flight.airline];
  for (const suffix of suffixes) for (const base of bases) { const key = `${base}:${suffix}`, row = flowRow(flow, key); if (row) return { key, base, row }; }
  for (const base of bases) { const row = flowRow(flow, base); if (row) return { key: base, base, row }; }
  return { key: `${bases[0]}:${suffixes[0]}`, base: bases[0]!, row: undefined };
}

/**
 * D5: be at the terminal entrance at gateCloseAt − (bag drop if checked bag + security + walk to gate + margin),
 * each wait taken for the time he gets there. Two passes: the first estimate picks which forecast point applies.
 */
export function arrivalPlan(flight: Flight, flow: Record<string, ZoneRow>, clock: Clock, hasCheckedBag: boolean | undefined, blocked: readonly string[] = [], history?: AirportView['history']) {
  const bag = hasCheckedBag !== false;
  const bagZone = zoneFor(flow, ['bag_drop', 'check_in'], flight);
  const secZone = { key: 'security', row: flowRow(flow, 'security') };
  const close = closeAt(flight);
  const walk = route(terminalGraph, 'security', flight.gate, zoneDensities(flow, zoneAreas), blocked);
  const steps = (inMin: number) => {
    const out: { zone: string; step: string; min: number; source: string }[] = [];
    const past = history?.(clock.now + inMin * 60) ?? {};
    if (bag) { const w = waitAt(bagZone.row, bagZone.base, inMin, bagZone.row ? undefined : zoneFor(past, ['bag_drop', 'check_in'], flight).row); out.push({ zone: bagZone.key, step: zoneName(bagZone.key), min: Math.ceil(w.min), source: w.source }); }
    const s = waitAt(secZone.row, 'security', inMin, secZone.row ? undefined : flowRow(past, 'security'));
    out.push({ zone: secZone.key, step: zoneName(secZone.key), min: Math.ceil(s.min), source: s.source });
    out.push({ zone: 'walk', step: copy.gateWalk(undefined, flight), min: walk ? Math.ceil(walk.totalSec / 60) : GATE_WALK_MIN[flight.gate] ?? DEFAULT_WALK_MIN, source: walk ? 'traseu live' : 'constantă' });
    out.push({ zone: 'margin', step: say('ro', 'margin'), min: MARGIN_MIN, source: 'constantă' });
    return out;
  };
  let plan = steps(0);
  for (let pass = 0; pass < 2; pass++) {
    const total = plan.reduce((s, x) => s + x.min, 0);
    plan = steps(Math.max(0, (close - total * 60 - clock.now) / 60));
  }
  const totalMin = plan.reduce((s, x) => s + x.min, 0);
  const likelyAt = Math.max(clock.now, close - totalMin * 60);
  const queues = plan.filter(s => !['walk', 'margin'].includes(s.zone)).map(s => ({
    zone: s.zone, label: s.step, nowMin: flowRow(flow, s.zone)?.waitMin ?? null,
    forecastMin: s.min, forecastAt: clockText(likelyAt), source: s.source,
  }));
  // Rounded down to 5 minutes: "14:20" reads better than "14:23" and errs on the early side.
  const at = Math.floor((close - totalMin * 60) / 300) * 300;
  return {
    flight: flight.flight, gate: gateName(flight.gate), gateCloseAt: clockText(close),
    beAtEntranceAt: clockText(at), minutesFromNow: Math.round((at - clock.now) / 60), late: at < clock.now,
    totalMin, queues, steps: plan, assumedCheckedBag: hasCheckedBag === undefined, clock: clockLabel(clock),
  };
}

/** D22: one situation description shared by tools, WhatsApp and simulated passengers. */
export function situationText(plan: ReturnType<typeof arrivalPlan>, lang?: Lang) {
  return copy.situation(lang, plan);
}

function flightView(f: Flight, clock: Clock, provisional: boolean, lang?: Lang) {
  return {
    flight: f.flight, airline: f.airline, destination: f.destination, gate: gateName(f.gate),
    departure: clockText(etd(f)), gateCloseAt: clockText(closeAt(f)), status: f.status, delayMin: f.delayMin,
    ...(f.delayMin > 0 && { scheduledDeparture: clockText(f.std) }),
    checkIn: f.checkIn ? [zoneName(f.checkIn, lang)] : f.checkInDesks.map(n => zoneName(n, lang)), now: clockText(clock.now), clock: say(lang, clock.sim ? 'simClock' : 'realClock'),
    ...(provisional && { note: say(lang, 'provisional') }),
  };
}

export interface ToolDeps {
  view: AirportView;
  profile: () => Profile;
  save: (patch: Partial<Profile>) => Promise<void>;
  /** Stores a staff report (D11); absent in read-only contexts. */
  report?: (input: { kind: IssueKind; node: string | null; text: string; etaMin: number | null; policeEtaMin?: number | null }) => Promise<Report>;
  pageLink?: () => Promise<string>;
  /** During an evacuation: the latest evac.plan route for this passenger's estimated place (A10, D9); null otherwise. */
  evacRoute?: (flight: Flight | undefined) => Promise<EvacRoute | null>;
}

/** The five D15 tools for one person, using the shared provisional terminal graph. */
export function toolsFor({ view, profile, save, report, pageLink, evacRoute }: ToolDeps): Tools {
  const resolve = async (code?: string) => {
    const p = profile();
    const wanted = code || p.flight;
    if (!wanted) return { error: 'no_flight', hint: say(p.lang, 'flightHint') } as const;
    const f = findFlight(view.flights(), wanted);
    if (!f) return { error: 'unknown_flight', flight: wanted, hint: say(p.lang, 'unknownFlightHint') } as const;
    // A flight number given in chat binds the person too, unverified (no Wallet token).
    if (p.flight !== f.flight) await save({ flight: f.flight, airline: f.airline, verified: false });
    await save({ gate: gateName(f.gate) });
    return { flight: f };
  };
  return {
    async airportInfo(input: { topic?: string; query?: string }) { return airportInfo(input, profile().lang); },
    async rememberFact(input: { key?: unknown; value?: unknown }) {
      if (input?.key === 'flight' && typeof input.value === 'string') {
        const r = await resolve(input.value);
        return 'error' in r ? r : { remembered: true, key: 'flight', value: r.flight.flight };
      }
      const patch = factPatch(input?.key, input?.value);
      if (!patch) return { error: 'invalid_fact' };
      if (patch.needs) patch.needs = { ...profile().needs, ...patch.needs };
      await save(patch);
      return { remembered: true, key: input.key, value: input.value };
    },
    async myFlight(input: { flight?: string }) {
      const r = await resolve(input?.flight);
      return 'error' in r ? r : flightView(r.flight, view.clock(), view.provisional(), profile().lang);
    },
    async whenToArrive(input: { flight?: string; hasCheckedBag?: boolean }) {
      const r = await resolve(input?.flight);
      if ('error' in r) return r;
      if (typeof input?.hasCheckedBag === 'boolean') await save({ hasCheckedBag: input.hasCheckedBag });
      const f = r.flight;
      if (f.status === 'cancelled') return { flight: f.flight, status: 'cancelled', note: say(profile().lang, 'cancelledNote') };
      if (f.status === 'departed') return { flight: f.flight, status: 'departed', note: say(profile().lang, 'departedNote') };
      const plan = arrivalPlan(f, view.flow(), view.clock(), profile().hasCheckedBag, view.blocked?.(), view.history);
      return { ...plan, situation: situationText(plan, profile().lang), status: f.status, delayMin: f.delayMin };
    },
    async queues() {
      const flow = view.flow(), clock = view.clock(), p = profile();
      const mine = new Set(ownZones(p.flight ? findFlight(view.flights(), p.flight) : p.airline ? { airline: p.airline } : undefined).slice(0, 2).map(mapNodeId));
      const zones = Object.entries(flow).map(([zone, z]) => ({
        zone: zoneName(zone, p.lang), waiting: z.waiting, waitMin: z.waitMin, peak30min: z.peak, staff: z.staff,
        ...(z.forecast?.length && { forecast: z.forecast.map(p => ({ inMin: p.inMin, waitMin: p.waitMin })) }),
        ...(mine.has(mapNodeId(zone)) && { yours: true }),
      }));
      if (!zones.length) return { available: false, note: say(profile().lang, 'noQueues'), now: clockText(clock.now), clock: say(profile().lang, clock.sim ? 'simClock' : 'realClock') };
      return { available: true, zones, now: clockText(clock.now), clock: say(profile().lang, clock.sim ? 'simClock' : 'realClock') };
    },
    async routeTo(input: { to?: string; flight?: string }) {
      const to = input?.to ?? 'gate';
      if (!['gate', 'check_in', 'exit'].includes(to)) return { error: 'invalid_destination' };
      // Evacuation: the exit vision assigned to his estimated place (evac.plan), not the nearest one on the plain graph.
      const evac = to === 'exit' && evacRoute ? await evacRoute(profile().flight ? findFlight(view.flights(), profile().flight!) : undefined) : null;
      if (evac) return { status: 'evacuation', from: evac.from, to: evac.exit, exit: nodeName(evac.exit, profile().lang), nodes: evac.nodes,
        steps: evac.nodes.map(n => nodeName(n, profile().lang)), note: copy.evacuationRoute(profile().lang, '', evac), ...(pageLink && { link: await pageLink() }) };
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
      if (!best) return { status: 'unavailable', note: say(profile().lang, 'noRoute') };
      const minutes = Math.ceil(best.totalSec / 60);
      // Pitch: the gate and the walk to it from security, said explicitly.
      const fromSec = to === 'gate' ? route(terminalGraph, 'security', best.nodes.at(-1)!, density, blocked) : null;
      const fromSecurityMin = fromSec ? Math.ceil(fromSec.totalSec / 60) : null;
      const securityNote = fromSecurityMin === null ? '' : ` ${say(profile().lang, 'fromSecurity', gateName(best.nodes.at(-1)!), fromSecurityMin)}`;
      return { status: 'ready', ...best, minutes, from: 'entrance', to: best.nodes.at(-1), ...(fromSecurityMin !== null && { fromSecurityMin }),
        steps: best.nodes.map(n => nodeName(n, profile().lang)), note: say(profile().lang, 'route', best.nodes.map(n => nodeName(n, profile().lang)).join(' → '), minutes) + securityNote,
        ...(pageLink && { link: await pageLink() }), provisional: terminalGraph.provisional };
    },
    async reportIssue(input: { text?: string; kind?: string; location?: string }) {
      if (profile().role !== 'staff') return { error: 'staff_only', note: say(profile().lang, 'staffOnly') };
      const text = String(input?.text ?? '').trim();
      if (!text) return { error: 'empty', hint: say(profile().lang, 'whereIssue') };
      if (!report) return { error: 'unavailable', note: say(profile().lang, 'reportUnavailable') };
      const kind = isIssueKind(input?.kind) ? input.kind : classifyIssue(text);
      const node = matchNode(`${input?.location ?? ''} ${text}`, view.flights());
      const density = zoneDensities(view.flow(), zoneAreas);
      const path = node ? route(terminalGraph, 'team_post', node, density, view.blocked?.()) : null;
      const etaMin = path ? Math.ceil(path.totalSec / 60) : null;
      // The airport police posts Unity places (POLICE_POSTS), crowd-penalised like the team's route (A8); the nearest one.
      const police = node ? POLICE_POSTS.map(post => route(terminalGraph, post, node, density, view.blocked?.())).filter(r => r !== null).sort((a, b) => a.totalSec - b.totalSec)[0] : undefined;
      const policeEtaMin = police ? Math.ceil(police.totalSec / 60) : null;
      const r = await report({ kind, node, etaMin, policeEtaMin, text: input?.location ? `${text} (loc: ${input.location})` : text });
      const lang = profile().lang;
      const eta = etaMin === null && policeEtaMin === null ? say(lang, 'noEta')
        : [etaMin === null ? '' : say(lang, 'eta', etaMin), policeEtaMin === null ? '' : say(lang, 'policeEta', policeEtaMin)].filter(Boolean).join('. ') + '.';
      return { status: 'sent', id: r.id, etaMin, policeEtaMin, kind: lang === 'en' ? EN_ISSUES[kind] : RO_ISSUES[kind], place: node ? nodeName(node, lang) : say(lang, 'unknownPlace'),
        note: say(lang, 'reportSent', eta) };
    },
  };
}
