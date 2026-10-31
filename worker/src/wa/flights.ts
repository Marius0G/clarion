// Flights and the clock the WhatsApp agent reads (SPEC-v2 D13, D14).
// Times are seconds on the displayed clock: seconds since midnight of the simulated day when Unity sends
// simTime (D13; assumption until Marius confirms the origin), otherwise Romanian wall-clock time.

export type FlightStatus = 'scheduled' | 'boarding' | 'delayed' | 'cancelled' | 'departed';
export interface Flight {
  flight: string; airline: string; destination: string;
  std: number; gateCloseAt: number; gate: string; checkInDesks: string[];
  status: FlightStatus; delayMin: number; pax?: number;
}
export interface Clock { now: number; sim: boolean }

const hm = (h: number, m: number) => h * 3600 + m * 60;

/**
 * PROVISIONAL schedule. Unity's flight.update (D14) replaces it: everything reads flights through
 * currentFlights(), so the swap is one call site. Flight numbers and gates are placeholders, not the real CRA timetable.
 */
export const PROVISIONAL_FLIGHTS: readonly Flight[] = [
  { flight: 'W6 3751', airline: 'W6', destination: 'Londra Luton', std: hm(9, 40), gateCloseAt: hm(9, 10), gate: 'G2', checkInDesks: ['check_in:W6'], status: 'scheduled', delayMin: 0, pax: 180 },
  { flight: 'W6 3401', airline: 'W6', destination: 'Milano Bergamo', std: hm(13, 5), gateCloseAt: hm(12, 35), gate: 'G1', checkInDesks: ['check_in:W6'], status: 'scheduled', delayMin: 0, pax: 186 },
  { flight: 'RO 7653', airline: 'RO', destination: 'București Otopeni', std: hm(15, 20), gateCloseAt: hm(14, 55), gate: 'G3', checkInDesks: ['check_in:RO'], status: 'scheduled', delayMin: 0, pax: 68 },
  { flight: 'FR 2214', airline: 'FR', destination: 'Londra Stansted', std: hm(17, 45), gateCloseAt: hm(17, 15), gate: 'G4', checkInDesks: ['check_in:FR'], status: 'scheduled', delayMin: 0, pax: 189 },
  { flight: 'W6 4307', airline: 'W6', destination: 'Dortmund', std: hm(20, 30), gateCloseAt: hm(20, 0), gate: 'G2', checkInDesks: ['check_in:W6'], status: 'scheduled', delayMin: 0, pax: 180 },
];

/** "W6 3751", "w63751", "W6-3751" -> "W63751", for comparing flight numbers. */
export const flightKey = (s: string) => String(s).toUpperCase().replace(/[^A-Z0-9]/g, '');

/** Unity's schedule when it has sent one, else the provisional fixture. */
export function currentFlights(unity?: readonly Flight[] | null): readonly Flight[] {
  return unity?.length ? unity : PROVISIONAL_FLIGHTS;
}
export const isProvisional = (unity?: readonly Flight[] | null) => !unity?.length;

export function findFlight(flights: readonly Flight[], code: string) {
  const key = flightKey(code);
  return key ? flights.find(f => flightKey(f.flight) === key) : undefined;
}

/** Simulated time when Unity reports simTime, otherwise Bucharest wall-clock seconds since midnight. */
export function clockFrom(simTime: number | null | undefined, connected: boolean, nowMs = Date.now()): Clock {
  if (connected && typeof simTime === 'number' && Number.isFinite(simTime)) return { now: simTime, sim: true };
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Bucharest', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(nowMs));
  const get = (t: string) => Number(parts.find(p => p.type === t)?.value ?? 0);
  return { now: get('hour') * 3600 + get('minute') * 60 + get('second'), sim: false };
}

/** Seconds on the clock -> "14:20". */
export function clockText(sec: number) {
  const day = ((Math.floor(sec / 60) % 1440) + 1440) % 1440;
  return `${String(Math.floor(day / 60)).padStart(2, '0')}:${String(day % 60).padStart(2, '0')}`;
}
export const clockLabel = (c: Clock) => (c.sim ? 'ora simulării' : 'ora României');
