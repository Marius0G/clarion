import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine, WAZE_DRIVERS_PER_MINUTE } from "../src/engine.js";
import { schedule } from "../src/data/flights.js";
import { simAbMetric, simAbResultsFile } from "../src/data/sim-ab.js";
import { loadBackendEnv, createControlTower } from "../src/server.js";
import { Telegram } from "../src/channels/telegram.js";
import type { AddressInfo } from "node:net";
const event = (type: string, data = {}) => ({
  type,
  ts: new Date().toISOString(),
  data,
});
const drone = (extra = {}) =>
  event("drone.detected", {
    distanceM: 2000,
    bearingDeg: 270,
    nearRunway: "27",
    source: "radar",
    ...extra,
  });
const sub = (extra = {}) => ({
  role: "taxi",
  lang: "ro",
  channel: "telegram",
  consent: true,
  ...extra,
});
async function suspend(e: Engine) {
  await e.handle(drone(), "twin");
  await e.handle(event("console.confirm_suspension"));
}
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
describe("QA gaps", () => {
  it("persists explicit drone position/timestamp and clears on reset", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tower-qa-"));
    try {
      const file = join(dir, "state.json"),
        e = new Engine({ file });
      const detection = drone({ lat: 44.3, lon: 23.9 });
      await e.handle(detection, "twin");
      expect(new Engine({ file }).snapshot().drone).toEqual({
        ...detection.data,
        at: detection.ts,
      });
      await e.handle(event("console.reset"));
      expect(e.snapshot().drone).toBeNull();
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
  it("derives metres/bearing from ARP and clears on normal", async () => {
    const e = new Engine({ wavesEnabled: false });
    await suspend(e);
    expect(e.snapshot().drone!.lat).toBeCloseTo(44.3181, 4);
    expect(e.snapshot().drone!.lon).toBeCloseTo(23.8635, 3);
    await e.handle(event("console.reopen"));
    await e.handle(event("console.reopen"));
    expect(e.snapshot().drone).toBeNull();
  });
  it.each([
    { lat: 100, lon: 0 },
    { lat: 44 },
    { distanceM: -1 },
    { bearingDeg: 360 },
  ])("rejects invalid detection %j", async (extra) => {
    const e = new Engine();
    await expect(e.handle(drone(extra), "twin")).rejects.toThrow();
    expect(e.state.phase).toBe("normal");
  });
  it("records acquisition source from API and Telegram and computes six steps", async () => {
    const e = new Engine();
    const jury = e.subscribe(sub({ source: "jury", flight: "W6 3412" }));
    await e.telegramStart(
      "1",
      new URL(e.telegramLink(jury, "demo")).searchParams.get("start")!,
    );
    await e.telegramStart("2", "relative_arrivals__W63412");
    await e.telegramStart("3", "taxi____qr");
    expect(e.subscriptions.map((s) => s.source)).toEqual([
      "jury",
      "relative",
      "qr",
    ]);
    expect(() => e.subscribe(sub({ source: "invented" }))).toThrow();
    expect(e.snapshot().reach.map((r) => r.reached)).toEqual([
      1, 2, 3, 0, 0, 0,
    ]);
    expect(e.snapshot().reach[2]!.status).toBe("idle");
    await suspend(e);
    expect(e.snapshot().reach[2]!.status).toBe("active");
    await e.handle(event("console.reset"));
    expect(e.snapshot().reach.map((r) => r.reached)).toEqual([
      1, 2, 3, 0, 0, 0,
    ]);
  });
  it("counts contact broadcasts, Waze estimates and RO-Alert draft", async () => {
    const e = new Engine({
      taxiGroup: "group",
      adapters: {
        telegram: async () => ({ delivered: true, simulated: false }),
      },
    });
    e.subscribe(sub({ role: "rent_a_car_ubt" }));
    await suspend(e);
    expect(e.snapshot().reach[4]!.status).toBe("active");
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 120000);
    expect(e.snapshot().reach[4]!.reached).toBe(2 * WAZE_DRIVERS_PER_MINUTE);
    await e.handle(
      event("console.approve_messages", { roles: ["taxi", "rent_a_car_ubt"] }),
    );
    expect(e.snapshot().reach[3]!.reached).toBe(2);
    expect(e.snapshot().counters.rent_a_car_ubt.delivered).toBe(1);
    await e.handle(
      event("payload.suspicious", { evacuate: true, zone: "T2" }),
      "twin",
    );
    await e.handle(event("console.request_roalert"));
    expect(e.snapshot().reach[5]).toMatchObject({
      reached: 1,
      status: "draft",
    });
    await e.handle(event("console.reopen"));
    expect(e.snapshot().reach[4]).toMatchObject({ reached: 0, status: "idle" });
  });
  it("deduplicates delivery/read endpoints across roles, counts total reads separately", async () => {
    const e = new Engine({
      taxiGroup: "group",
      adapters: {
        telegram: async () => ({ delivered: true, simulated: false }),
      },
    });
    await e.telegramStart("42", "taxi__");
    await e.telegramStart("42", "rent_a_car_ubt__");
    await suspend(e);
    await e.handle(
      event("console.approve_messages", { roles: ["taxi", "rent_a_car_ubt"] }),
    );
    expect(e.snapshot().metrics.notifiedFirstMinute).toBe(2);
    for (const r of e.receipts) {
      e.markRead(r.id);
      e.markRead(r.id);
    }
    expect(e.snapshot().metrics).toMatchObject({
      readRecipients: 2,
      readCount: 3,
    });
  });
  it("preserves incident totals through subscription expiry and process restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tower-totals-"));
    try {
      const file = join(dir, "state.json");
      const e = new Engine({
        file,
        adapters: {
          telegram: async () => ({ delivered: true, simulated: false }),
        },
      });
      await e.telegramStart("42", "taxi__");
      await suspend(e);
      await e.handle(event("console.approve_messages", { roles: ["taxi"] }));
      e.markRead(e.receipts[0]!.id);
      e.subscriptions[0]!.expiresAt = new Date(Date.now() - 1).toISOString();
      e.expire();
      const restarted = new Engine({ file });
      expect(restarted.snapshot().metrics).toMatchObject({
        readCount: 1,
        readRecipients: 1,
        notifiedFirstMinute: 1,
      });
      expect(restarted.subscriptions).toHaveLength(0);
      await restarted.handle(event("console.reset"));
      expect(restarted.snapshot().metrics).toMatchObject({
        readCount: 0,
        readRecipients: 0,
        notifiedFirstMinute: 0,
      });
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
  it.each([
    { delay: 60001, delivered: true, expected: 0 },
    { delay: 60000, delivered: true, expected: 1 },
    { delay: 0, delivered: false, expected: 0 },
  ])(
    "measures delivery completion and excludes failed sends %j",
    async ({ delay, delivered, expected }) => {
      vi.useFakeTimers();
      const base = Date.parse("2026-10-31T20:20:00Z");
      vi.setSystemTime(base);
      const e = new Engine({
        adapters: {
          telegram: async () => {
            vi.setSystemTime(base + delay);
            return { delivered, simulated: false };
          },
        },
      });
      e.subscribe(sub());
      await suspend(e);
      await e.handle(event("console.approve_messages", { roles: ["taxi"] }));
      expect(e.snapshot().metrics.notifiedFirstMinute).toBe(expected);
    },
  );
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
  it("reads sim-ab median/interval, returns null on unavailable data, lets twin override", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tower-sim-"));
    try {
      const file = join(dir, "results.json"),
        e = new Engine({ simAbFile: file });
      expect(e.snapshot().metrics.isuTimeToT2).toBeNull();
      writeFileSync(
        file,
        JSON.stringify({
          model: "uncalibrated",
          interval: "empirical p05-p95",
          summaries: [
            {
              coverage: 0.5,
              waves: false,
              metrics: {
                emergencyMeanMinutes: { b: { median: 18, p05: 17, p95: 20 } },
              },
            },
          ],
        }),
      );
      expect(e.snapshot().metrics.isuTimeToT2).toMatchObject({
        median: 18,
        interval: [17, 20],
        source: "sim-ab",
        units: "minutes",
      });
      if (existsSync(simAbResultsFile))
        expect(simAbMetric()).toMatchObject({ source: "sim-ab" });
      await e.handle(
        event("metric.report", { name: "isuTimeToT2", value: 12 }),
        "twin",
      );
      expect(e.snapshot().metrics.isuTimeToT2).toBe(12);
      writeFileSync(file, "broken");
      expect(simAbMetric(file)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true });
    }
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
  it("logs real bot identity and exposes it in HTTP status and subscription links", async () => {
    vi.stubEnv("STATE_FILE", "");
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-token");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(Telegram.prototype, "call").mockImplementation(async (method) =>
      method === "getMe" ? { username: "ActualTowerBot" } : [],
    );
    vi.spyOn(Telegram.prototype, "poll").mockResolvedValue();
    const s = createControlTower();
    try {
      await new Promise<void>((r) => s.http.listen(0, "127.0.0.1", r));
      const base = `http://127.0.0.1:${(s.http.address() as AddressInfo).port}`;
      expect(await (await fetch(`${base}/api/telegram`)).json()).toEqual({
        enabled: true,
        botUsername: "ActualTowerBot",
        deepLinkExample:
          "https://t.me/ActualTowerBot?start=relative_arrivals__W63412__relative",
      });
      const response = await fetch(`${base}/api/subscribe`, {
        method: "POST",
        body: JSON.stringify(sub({ source: "qr" })),
      });
      expect((await response.json()).telegramLink).toContain(
        "t.me/ActualTowerBot",
      );
      expect(log).toHaveBeenCalledWith("Telegram bot @ActualTowerBot");
    } finally {
      await s.stop();
    }
  });
});
