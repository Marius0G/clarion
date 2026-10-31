import type { Flight } from "../types.js";
export const fixtureSource =
  "FIXTURE: Wizz winter 2026/27; 21 departures/week per team plan. Routes, flight numbers and times illustrative, not a verified airline timetable. craiova-airport.ro unavailable on 2026-10-31.";
// Seven days × three departures: deliberately a fixture, never presented as a live FIDS.
export function schedule(now = new Date()): Flight[] {
  const routes = [
    ["Bergamo", "BGY"],
    ["London Luton", "LTN"],
    ["Birmingham", "BHX"],
    ["Brussels Charleroi", "CRL"],
    ["Dortmund", "DTM"],
    ["Rome", "FCO"],
    ["Bologna", "BLQ"],
  ];
  return Array.from({ length: 21 }, (_, i) => {
    const date = new Date(now);
    date.setUTCHours(6 + (i % 3) * 6, 0, 0, 0);
    date.setUTCDate(date.getUTCDate() + Math.floor(i / 3));
    const [city, iata] = routes[i % routes.length]!;
    return {
      flight: `W6 ${3400 + i * 2}`,
      dir: "dep" as const,
      city: city!,
      iata: iata!,
      sched: date.toISOString(),
      est: date.toISOString(),
      status: "scheduled" as const,
    };
  }).flatMap((f) => [
    f,
    {
      ...f,
      flight:
        f.iata === "BGY" ? "W6 3412" : `W6 ${Number(f.flight.slice(3)) + 1}`,
      dir: "arr" as const,
      sched: new Date(Date.parse(f.sched) - 3600000).toISOString(),
      est: new Date(Date.parse(f.sched) - 3600000).toISOString(),
    },
  ]);
}
export async function aircraftNearLrcv(): Promise<unknown[]> {
  try {
    const res = await fetch(
      "https://opensky-network.org/api/states/all?lamin=44.1&lomin=23.6&lamax=44.6&lomax=24.2",
      { signal: AbortSignal.timeout(3000) },
    );
    if (!res.ok) return [];
    const body = (await res.json()) as { states?: unknown[] };
    return Array.isArray(body.states) ? body.states : [];
  } catch {
    return [];
  }
}
