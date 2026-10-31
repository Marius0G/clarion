import { mkdtempSync,rmSync,writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach,describe,expect,it,vi } from "vitest";
import { schedule } from "../src/data/flights.js";
import "../src/node-runtime.js";
import { loadBackendEnv } from "../src/server.js";
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
describe("QA gaps", () => {
  it.each([
    "2026-10-31T22:30:00Z",
    "2026-10-31T23:30:00Z",
    "2026-07-01T09:00:00Z",
  ])("uses Bucharest operating day and plausible rotations %s", (now) => {
    const flights = schedule(new Date(now));
    expect(flights).toHaveLength(6);
    const local = (iso: string) =>
      new Intl.DateTimeFormat("en-CA", {
        timeZone: "Europe/Bucharest",
        dateStyle: "short",
        timeStyle: "short",
        hourCycle: "h23",
      }).format(new Date(iso));
    expect(local(flights.find((f) => f.flight === "W6 3412")!.sched)).toContain(
      "23:55",
    );
    for (const arr of flights.filter((f) => f.dir === "arr"))
      expect(
        Date.parse(arr.sched) -
          Date.parse(
            flights.find((f) => f.dir === "dep" && f.iata === arr.iata)!.sched,
          ),
      ).toBeGreaterThan(4 * 3600000);
    if (now.includes("23:30:00Z"))
      expect(flights.every((f) => f.sched.startsWith("2026-10-31"))).toBe(true);
  });
  it("loads .env without overriding exported variables", () => {
    const dir = mkdtempSync(join(tmpdir(), "tower-env-"));
    vi.stubEnv("TOWER_ENV_TEST", "exported");
    vi.stubEnv("TOWER_ENV_NEW", "");
    delete process.env.TOWER_ENV_NEW;
    try {
      const file = join(dir, ".env");
      writeFileSync(file, "TOWER_ENV_TEST=file\nTOWER_ENV_NEW=loaded\n");
      loadBackendEnv(file);
      expect(process.env.TOWER_ENV_TEST).toBe("exported");
      expect(process.env.TOWER_ENV_NEW).toBe("loaded");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
