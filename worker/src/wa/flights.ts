import { desksForGroup } from '../../../backend/src/mapIds.js';
// Flights and the clock the WhatsApp agent reads (SPEC-v2 D13, D14).
// Times are seconds on the displayed clock: seconds since midnight of the simulated day when Unity sends
// simTime (D13; assumption until Marius confirms the origin), simulation midnight until the first tick.

export type FlightStatus = 'scheduled' | 'boarding' | 'delayed' | 'cancelled' | 'departed';
const STATUSES: readonly FlightStatus[] = ['scheduled', 'boarding', 'delayed', 'cancelled', 'departed'];
/**
 * std and gateCloseAt are the SCHEDULED times; delayMin moves both (see etd/closeAt).
 * gate is a terminal.json node id (`gate_2`); checkIn is the desk group zone (`check_in:2`, D8).
 */
export interface Flight {
  flight: string; airline: string; destination: string;
  std: number; gateCloseAt: number; gate: string; checkIn?: string; checkInDesks: string[];
  status: FlightStatus; delayMin: number; pax?: number;
}
export interface Clock { now: number; sim: boolean }

const hm = (h: number, m: number) => h * 3600 + m * 60;
/** Minutes before departure the gate closes when Unity sends no gateCloseAt. */
export const GATE_CLOSE_BEFORE_MIN = 30;

/**
 * PROVISIONAL schedule. Unity's flight.update (D14) replaces it as soon as one arrives (currentFlights).
 * Flight numbers and gates are placeholders, not the real CRA timetable. Desk groups as in D8.
 */
export const PROVISIONAL_FLIGHTS: readonly Flight[] = [
  { flight: 'W6 3751', airline: 'W6', destination: 'Londra Luton', std: hm(9, 40), gateCloseAt: hm(9, 10), gate: 'gate_2', checkIn: 'check_in:1', checkInDesks: [...desksForGroup('check_in:1')], status: 'scheduled', delayMin: 0, pax: 180 },
  { flight: 'W6 3401', airline: 'W6', destination: 'Milano Bergamo', std: hm(13, 5), gateCloseAt: hm(12, 35), gate: 'gate_4', checkIn: 'check_in:1', checkInDesks: [...desksForGroup('check_in:1')], status: 'scheduled', delayMin: 0, pax: 186 },
  { flight: 'RO 7653', airline: 'RO', destination: 'București Otopeni', std: hm(15, 20), gateCloseAt: hm(14, 55), gate: 'gate_5', checkIn: 'check_in:2', checkInDesks: [...desksForGroup('check_in:2')], status: 'scheduled', delayMin: 0, pax: 68 },
  { flight: 'FR 2214', airline: 'FR', destination: 'Londra Stansted', std: hm(17, 45), gateCloseAt: hm(17, 15), gate: 'gate_3', checkIn: 'check_in:3', checkInDesks: [...desksForGroup('check_in:3')], status: 'scheduled', delayMin: 0, pax: 189 },
  { flight: 'W6 4307', airline: 'W6', destination: 'Dortmund', std: hm(20, 30), gateCloseAt: hm(20, 0), gate: 'gate_6', checkIn: 'check_in:1', checkInDesks: [...desksForGroup('check_in:1')], status: 'scheduled', delayMin: 0, pax: 180 },
];

/** "W6 3751", "w63751", "W6-3751" -> "W63751", for comparing flight numbers. */
export const flightKey = (s: string) => String(s).toUpperCase().replace(/[^A-Z0-9]/g, '');

/** A sim time as Unity sends it (D13): seconds, or "HH:MM" / "HH:MM:SS". NaN when it is neither. */
export function simSeconds(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? v : NaN;
  const m = typeof v === 'string' ? /^\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\s*$/.exec(v) : null;
  if (!m || Number(m[2]) > 59 || Number(m[3] ?? 0) > 59) return NaN;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3] ?? 0);
}

/** A flight.update row as the sim store keeps it (backend/src/sim.ts TerminalFlight). */
export interface SimFlightRow {
  flight: string; airline: string; destination: string; std: number | string; gate: string | null;
  checkIn?: string; checkInDesks: string[]; gateCloseAt: number | string | null; status: string; delayMin: number; pax: number | null;
}
/** Unity's rows -> the agent's flights. A row whose departure time cannot be read is skipped. */
export function fromSim(rows: readonly SimFlightRow[] | null | undefined): Flight[] {
  const out: Flight[] = [];
  for (const r of rows ?? []) {
    const std = simSeconds(r.std);
    if (!Number.isFinite(std)) continue;
    const close = r.gateCloseAt === null ? NaN : simSeconds(r.gateCloseAt);
    out.push({
      flight: r.flight, airline: r.airline, destination: r.destination, std,
      gateCloseAt: Number.isFinite(close) ? close : std - GATE_CLOSE_BEFORE_MIN * 60,
      gate: r.gate ?? '', ...(r.checkIn && { checkIn: r.checkIn }), checkInDesks: r.checkInDesks ?? [],
      status: (STATUSES as readonly string[]).includes(r.status) ? r.status as FlightStatus : 'scheduled',
      delayMin: r.delayMin ?? 0, ...(r.pax !== null && r.pax !== undefined && { pax: r.pax }),
    });
  }
  return out;
}

/** Unity's schedule when it has sent one, else the provisional fixture. */
export function currentFlights(unity?: readonly Flight[] | null): readonly Flight[] {
  return unity?.length ? unity : PROVISIONAL_FLIGHTS;
}
export const isProvisional = (unity?: readonly Flight[] | null) => !unity?.length;

export function findFlight(flights: readonly Flight[], code: string) {
  const key = flightKey(code);
  return key ? flights.find(f => flightKey(f.flight) === key) : undefined;
}

/** Expected departure and gate close, after the delay. */
export const etd = (f: Flight) => f.std + f.delayMin * 60;
export const closeAt = (f: Flight) => f.gateCloseAt + f.delayMin * 60;
/** "gate_2" -> "2", "G2" -> "G2", "" -> "necunoscută încă". */
export const gateName = (gate: string) => (gate ? gate.replace(/^(?:gate_|U_GATE_|G)/, '') : 'necunoscută încă');

/** Keep the latest simulation clock through disconnects. Before its first tick, use simulation midnight. */
export function clockFrom(simTime: number | null | undefined, _connected: boolean, _nowMs?: number): Clock {
  return { now: typeof simTime === 'number' && Number.isFinite(simTime) && simTime >= 0 ? simTime : 0, sim: true };
}

/** Seconds on the clock -> "14:20". */
export function clockText(sec: number) {
  const day = ((Math.floor(sec / 60) % 1440) + 1440) % 1440;
  return `${String(Math.floor(day / 60)).padStart(2, '0')}:${String(day % 60).padStart(2, '0')}`;
}
export const clockLabel = (c: Clock) => (c.sim ? 'ora simulării' : 'ora României');
