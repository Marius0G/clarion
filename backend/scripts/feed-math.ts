/** Pure fake-feed model. Times are seconds on an absolute simulation timeline. */
export const DAY = 86400;
export const SECURITY_RATE = 2.3;
export const CHECK_IN_RATE = 1.5;
export const BAG_DROP_RATE = 2.0;
// ASSUMPTION: 35% need a desk; of those, 75% bag-drop and 25% full check-in.
export const DESK_SHARE = 0.35;
export const DESK_RATE = 1 / (0.75 / BAG_DROP_RATE + 0.25 / CHECK_IN_RATE);
export type Scenario = "day" | "rush";
export interface Flight {
  flight: string; airline: string; destination: string; std: number; gate: string;
  checkIn: string; checkInDesks: string[]; gateCloseAt: number;
  status: string; delayMin: number; pax: number;
}
export const clockTime = (time: number) => ((time % DAY) + DAY) % DAY;
/** W4 demo-day destinations/pax from Marius, rounded slots; illustrative, not a live timetable.
 * Add morning/evening rotations so a kiosk can run continuously. Groups are allocated by slot (D8).
 */
export function scheduleForDay(day: number): Flight[] {
  return [
    ["106", "Dortmund", 6, 0, 198, 1, 10],
    ["3391", "Bari", 12, 25, 231, 1, 9],
    ["3625", "Birmingham", 16, 40, 193, 1, 3],
    ["8093", "Milan Bergamo", 19, 0, 230, 2, 6],
    ["3751", "Londra Luton", 23, 45, 198, 3, 1],
  ].map(([number, destination, hour, minute, pax, group, gate]) => {
    const std = day * DAY + Number(hour) * 3600 + Number(minute) * 60;
    return { flight: `W4 ${number}`, airline: "W4", destination: String(destination), std,
      gate: `gate_${gate}`, checkIn: `check_in:${group}`,
      checkInDesks: Array.from({ length: 4 }, (_, i) => `checkin_${(Number(group) - 1) * 4 + i + 1}`),
      gateCloseAt: std - 600, status: "scheduled", delayMin: 0, pax: Number(pax) };
  });
}
/** Keep yesterday, today and tomorrow for midnight-crossing curves, delays and FIDS. */
export function rollingSchedule(time: number, previous: Flight[] = []): Flight[] {
  const day = Math.floor(time / DAY);
  return [day - 1, day, day + 1].flatMap(d => scheduleForDay(d))
    .map(f => previous.find(p => p.flight === f.flight && p.std === f.std) ?? f)
    .filter(f => f.std >= 0);
}
/** Backend keys FIDS rows by flight number: never publish duplicate daily rotations. */
export function flightSnapshot(flights: Flight[], time: number): Flight[] {
  const start = Math.floor(time / DAY) * DAY;
  const today = flights.filter(f => f.std >= start && f.std < start + DAY);
  return today.map(f => flights.find(p => p.flight === f.flight && p.std < start
    && p.status !== "cancelled" && p.std + p.delayMin * 60 > time) ?? f);
}
/** ASSUMPTION: calibrated piecewise arrival CDF: 35% at STD-160..100,
 * 30% at STD-100..85, 35% at STD-85..50 minutes. Rush multiplies demand by 2.5.
 * Integrating the CDF avoids rounding away fractional passengers at speed 1/10/30.
 */
export function arrivalFraction(f: Flight, time: number): number {
  const elapsed = (time - (f.std + f.delayMin * 60)) / 60;
  const ramp = (a: number, b: number) => Math.max(0, Math.min(1, (elapsed - a) / (b - a)));
  return 0.35 * ramp(-160, -100) + 0.30 * ramp(-100, -85) + 0.35 * ramp(-85, -50);
}
export function arrivalsBetween(flights: Flight[], from: number, to: number, scenario: Scenario, load = 1) {
  const checkIn: Record<string, number> = {};
  let security = 0, total = 0;
  for (const f of flights) {
    if (f.status === "cancelled" || f.status === "departed") continue;
    const n = Math.max(0, arrivalFraction(f, to) - arrivalFraction(f, from)) * f.pax * load * (scenario === "rush" ? 2.5 : 1);
    checkIn[f.checkIn] = (checkIn[f.checkIn] ?? 0) + n * DESK_SHARE;
    security += n * (1 - DESK_SHARE); total += n;
  }
  return { checkIn, security, total };
}
export function advanceQueue(waiting: number, arrivals: number, lanes: number, rate: number, minutes: number) {
  const served = Math.min(waiting + arrivals, Math.max(0, lanes * rate * minutes));
  return { waiting: Math.max(0, waiting + arrivals - served), served };
}
export const queueWait = (waiting: number, lanes: number, rate = SECURITY_RATE) => lanes > 0 ? waiting / (lanes * rate) : null;
/** ASSUMPTION: 20 min from terminal entry to gate; boarding drains over final 30 min.
 * A stage estimate for dots, not passenger tracking or a source for backend decisions.
 */
export function gateOccupancy(f: Flight, time: number, scenario: Scenario, load = 1) {
  const dep = f.std + f.delayMin * 60;
  if (f.status === "cancelled" || time >= dep) return 0;
  return Math.round(f.pax * load * (scenario === "rush" ? 2.5 : 1) * arrivalFraction(f, time - 1200)
    * Math.min(1, Math.max(0, (dep - time) / 1800)));
}
/** State-passing PRNG: callers own the seed; no hidden random state or I/O. */
export function randomStep(seed: number): { seed: number; value: number } {
  const next = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return { seed: next, value: next / 4294967296 };
}
