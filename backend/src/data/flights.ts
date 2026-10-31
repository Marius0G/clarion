import type { Flight } from "../types.js";
export const fixtureSource =
  "FIXTURE: Wizz winter 2026/27; 21 departures/week per team plan. Routes, flight numbers and times illustrative, not a verified airline timetable. craiova-airport.ro unavailable on 2026-10-31.";
// One Bucharest operating day, including the following night before 02:00.
// These are illustrative out-and-back rotations, not verified airline slots.
export function schedule(now = new Date()): Flight[] {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Bucharest",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const part = (name: string) =>
    Number(parts.find((p) => p.type === name)!.value);
  const day = new Date(Date.UTC(part("year"), part("month") - 1, part("day")));
  if (part("hour") < 2) day.setUTCDate(day.getUTCDate() - 1);
  const localTime = (hour: number, minute: number) => {
    const wall = Date.UTC(
      day.getUTCFullYear(),
      day.getUTCMonth(),
      day.getUTCDate(),
      hour,
      minute,
    );
    // Resolve offset for this date (EET/EEST), independently of host timezone.
    let utc = wall;
    for (let i = 0; i < 3; i++) {
      const offset = new Intl.DateTimeFormat("en", {
        timeZone: "Europe/Bucharest",
        timeZoneName: "longOffset",
      })
        .formatToParts(new Date(utc))
        .find((p) => p.type === "timeZoneName")!.value;
      const match = /GMT([+-])(\d{2}):(\d{2})/.exec(offset)!;
      utc =
        wall -
        (match[1] === "+" ? 1 : -1) *
          (Number(match[2]) * 60 + Number(match[3])) *
          60000;
    }
    return new Date(utc).toISOString();
  };
  const rotations = [
    {
      city: "London Luton",
      iata: "LTN",
      dep: "W6 3751",
      arr: "W6 3752",
      out: [6, 0],
      back: [12, 40],
    },
    {
      city: "Dortmund",
      iata: "DTM",
      dep: "W6 3761",
      arr: "W6 3762",
      out: [14, 0],
      back: [20, 0],
    },
    {
      city: "Bergamo",
      iata: "BGY",
      dep: "W6 3411",
      arr: "W6 3412",
      out: [19, 0],
      back: [23, 55],
    },
  ];
  return rotations
    .flatMap((r) =>
      (["dep", "arr"] as const).map((dir) => {
        const time = dir === "dep" ? r.out : r.back;
        const sched = localTime(time[0]!, time[1]!);
        return {
          flight: dir === "dep" ? r.dep : r.arr,
          dir,
          city: r.city,
          iata: r.iata,
          sched,
          est: sched,
          status: "scheduled" as const,
        };
      }),
    )
    .sort((a, b) => a.sched.localeCompare(b.sched));
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
