import "../src/node-runtime.js";
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine, readLatency, seeded } from "../src/engine.js";
import { roles, waveRoles, type Envelope, type Role } from "../src/types.js";
import { render, situations } from "../src/messages.js";
import type { Outbound } from "../src/channels/types.js";
import { wazeFeed } from "../src/channels/waze.js";
const event = (type: string, data: Record<string, unknown> = {}): Envelope => ({
  type,
  ts: new Date().toISOString(),
  data,
});
const detection = () =>
  event("drone.detected", {
    distanceM: 2000,
    bearingDeg: 270,
    nearRunway: "26",
    source: "radar",
  });
async function suspend(e: Engine) {
  await e.handle(detection(), "twin");
  await e.handle(event("console.confirm_suspension"));
}
describe("state machine and dispatch", () => {
  it("keeps detection internal and twin cannot bypass human confirmation", async () => {
    const send = vi.fn(async (_m: Outbound) => ({
      delivered: true,
      simulated: false,
    }));
    const e = new Engine({ adapters: { telegram: send } });
    e.subscribe({
      role: "taxi",
      channel: "telegram",
      lang: "ro",
      consent: true,
    });
    await e.handle(detection(), "twin");
    await e.handle(
      event("ops.suspended", {
        reason: "drone",
        estimatedReopen: new Date().toISOString(),
      }),
      "twin",
    );
    await expect(
      e.handle(event("console.approve_messages", { roles })),
    ).rejects.toThrow();
    await e.handle(
      event("payload.suspicious", { evacuate: true, zone: "T2" }),
      "twin",
    );
    expect(e.state.phase).toBe("detection");
    expect(send).not.toHaveBeenCalled();
    expect(e.state.drafts).toEqual([]);
    await e.handle(event("console.confirm_suspension"));
    expect(e.state.phase).toBe("suspended");
    await e.handle(event("console.approve_messages", { roles }));
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0].text).toContain("eliberați zona");
  });
  it("rejects viewers and twin console commands; supports explicit batch autoConfirm", async () => {
    const e = new Engine({ autoConfirm: true });
    await expect(e.handle(detection(), "viewer")).rejects.toThrow();
    await e.handle(detection(), "twin");
    await expect(
      e.handle(event("console.confirm_suspension"), "twin"),
    ).rejects.toThrow();
    await e.handle(
      event("ops.suspended", {
        reason: "drone",
        estimatedReopen: new Date().toISOString(),
      }),
      "twin",
    );
    expect(e.state.phase).toBe("suspended");
  });
  it("requires ordered waves, then normal; logs every transition", async () => {
    const e = new Engine();
    await suspend(e);
    await e.handle(event("ops.reopened"), "twin");
    expect(e.state.phase).toBe("suspended");
    await e.handle(event("console.reopen"));
    expect(e.state.phase).toBe("recovery");
    await expect(e.handle(event("console.reopen"))).rejects.toThrow();
    await expect(
      e.handle(event("console.open_wave", { wave: 2 })),
    ).rejects.toThrow();
    for (let wave = 1; wave <= 3; wave++)
      await e.handle(event("console.open_wave", { wave }));
    await e.handle(event("console.reopen"));
    expect(e.state.phase).toBe("normal");
    expect(
      e.state.timeline
        .filter((t) =>
          [
            "drone.detected",
            "console.confirm_suspension",
            "recovery.started",
            "console.reopen",
          ].includes(t.type),
        )
        .map((t) => t.phase),
    ).toEqual(["detection", "suspended", "recovery", "normal"]);
  });
  it("reopens by role, in the team's order", async () => {
    const send = vi.fn(async (_m: Outbound) => ({
      delivered: true,
      simulated: false,
    }));
    const e = new Engine({ adapters: { telegram: send } });
    for (const [i, role] of roles.entries())
      await e.telegramStart(String(i + 1), `${role}__`);
    await suspend(e);
    await e.handle(event("console.reopen"));
    expect(e.state.waves.map((w) => [...w.roles].sort())).toEqual(
      waveRoles.map((group) => [...group].sort()),
    );
    for (const group of waveRoles) {
      send.mockClear();
      await e.handle(
        event("console.open_wave", { wave: waveRoles.indexOf(group) + 1 }),
      );
      expect(send.mock.calls.map(([m]) => m.role).sort()).toEqual(
        [...group].sort(),
      );
    }
  });
  it("puts every role in exactly one wave, also with fewer waves", async () => {
    expect([...waveRoles.flat()].sort()).toEqual([...roles].sort());
    const e = new Engine({ waveCount: 2 });
    await suspend(e);
    await e.handle(event("console.reopen"));
    expect(e.state.waves.flatMap((w) => w.roles).sort()).toEqual(
      [...roles].sort(),
    );
  });
  it("does not suspend flights whose time has already passed", async () => {
    const hour = 3600000;
    const flight = (name: string, dir: "dep" | "arr", offset: number) => {
      const time = new Date(Date.now() + offset * hour).toISOString();
      return { flight: name, dir, city: "Test", iata: "TST", sched: time, est: time, status: "scheduled" as const };
    };
    const e = new Engine();
    e.updateFlights(
      [flight("OLD1", "dep", -2), flight("OLD2", "arr", -2), flight("NEXT", "dep", 2)],
      "fids",
    );
    await suspend(e);
    expect(e.state.flights.map((f) => f.status)).toEqual(["departed", "landed", "suspended"]);
  });
  it("supports waves disabled", async () => {
    const e = new Engine({ wavesEnabled: false });
    await suspend(e);
    await e.handle(event("console.reopen"));
    expect(e.state.waves).toEqual([]);
    await e.handle(event("console.reopen"));
    expect(e.state.phase).toBe("normal");
  });
  it("never sends RO-Alert, only drafts during evacuation", async () => {
    const e = new Engine();
    await suspend(e);
    await expect(e.handle(event("console.request_roalert"))).rejects.toThrow();
    await e.handle(
      event("payload.suspicious", { evacuate: true, zone: "T2" }),
      "twin",
    );
    await e.handle(event("console.request_roalert"));
    expect(e.state.roalertDraft).toContain("NU ESTE TRIMISĂ");
  });
});
describe("messages", () => {
  for (const role of roles)
    for (const situation of situations)
      for (const lang of ["ro", "en"] as const)
        it(`${role}/${situation}/${lang}`, () => {
          const text = render(role, situation, lang, {
            dest: "Bergamo",
            from: "Bergamo",
            to: "OTP",
            eta: "00:40",
            reopen: "04:30",
            next: "04:00",
            demand: "05:00",
            flight: "W6 3412",
            wave: "1",
            window: "04:30–04:40",
          });
          expect(text).not.toMatch(/[{}]|https?:|www\./);
          expect(text.length).toBeGreaterThan(60);
          expect(text).toContain("04:00");
        });
});
describe("counters, simulation and persistence", () => {
  it("counts one first-minute endpoint when a chat subscribes to multiple roles", async () => {
    const e = new Engine({
      adapters: {
        telegram: async () => ({ delivered: true, simulated: false }),
      },
    });
    await e.telegramStart("123", "taxi__");
    await e.telegramStart("123", "staff__");
    await suspend(e);
    await e.handle(
      event("console.approve_messages", { roles: ["taxi", "staff"] }),
    );
    expect(e.state.metrics.notifiedFirstMinute).toBe(1);
  });
  it("renders the subscriber flight route even when flight spacing differs", async () => {
    const send = vi.fn(async (_message: Outbound) => ({
      delivered: true,
      simulated: false,
    }));
    const e = new Engine({ adapters: { sms: send } });
    e.subscribe({
      role: "passenger_home",
      channel: "sms",
      lang: "en",
      flight: "w63402",
      consent: true,
      destination: "+40001",
    });
    await suspend(e);
    await e.handle(
      event("console.approve_messages", { roles: ["passenger_home"] }),
    );
    expect(send.mock.calls[0]![0].text).toContain("London Luton");
  });

  it("deduplicates approval/read, validates callback owner and excludes dry runs from delivered", async () => {
    const e = new Engine({
      adapters: {
        telegram: async (m) => ({
          delivered: !!m.destination,
          simulated: !m.destination,
        }),
      },
    });
    const a = e.subscribe({
      role: "taxi",
      channel: "telegram",
      lang: "en",
      consent: true,
    });
    await e.telegramStart("123", `taxi____${a.id}`);
    e.subscribe({
      role: "taxi",
      channel: "telegram",
      lang: "ro",
      consent: true,
    });
    await suspend(e);
    await e.handle(event("console.approve_messages", { roles: ["taxi"] }));
    await e.handle(event("console.approve_messages", { roles: ["taxi"] }));
    expect(e.state.counters.taxi).toEqual({
      subscribers: 2,
      sent: 2,
      delivered: 1,
      read: 0,
    });
    const r = e.receipts.find((r) => r.delivered)!;
    e.markRead(r.id, "999");
    expect(e.state.counters.taxi.read).toBe(0);
    e.markRead(r.id, "123");
    e.markRead(r.id, "123");
    expect(e.state.counters.taxi.read).toBe(1);
  });
  it("routes diversion notices only to matching flights and uses recipient destination", async () => {
    const send = vi.fn(async (_m: Outbound) => ({
      delivered: true,
      simulated: false,
    }));
    const e = new Engine({ adapters: { sms: send } });
    e.subscribe({
      role: "relative_arrivals",
      channel: "sms",
      lang: "ro",
      flight: "W6 3412",
      consent: true,
      destination: "+40001",
    });
    e.subscribe({
      role: "relative_arrivals",
      channel: "sms",
      lang: "ro",
      flight: "W6 9999",
      consent: true,
      destination: "+40002",
    });
    await suspend(e);
    await e.handle(
      event("console.approve_messages", { roles: ["relative_arrivals"] }),
    );
    send.mockClear();
    await e.handle(
      event("flight.diverted", {
        flight: "W6 3412",
        from: "BGY",
        to: "OTP",
        eta: new Date().toISOString(),
      }),
      "twin",
    );
    await e.handle(
      event("console.approve_messages", { roles: ["relative_arrivals"] }),
    );
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0].text).toContain("OTP");
    expect(send.mock.calls[0]![0].destination).toBe("+40001");
  });
  it("persists subscribers, receipts and pending seeded reads across restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "control-tower-"));
    try {
      const file = join(dir, "state.json");
      const e = new Engine({ file });
      e.subscribe({
        role: "staff",
        channel: "webpush",
        lang: "en",
        consent: true,
      });
      await e.handle(
        event("agent.register", {
          agents: [{ agentId: "a", role: "taxi", channel: "telegram" }],
        }),
        "twin",
      );
      await suspend(e);
      await e.handle(event("console.approve_messages", { roles: ["taxi"] }));
      const restarted = new Engine({ file });
      expect(restarted.subscriptions).toHaveLength(1);
      expect(restarted.state.counters.taxi.delivered).toBe(1);
      restarted.tick(Date.now() + 3600000);
      expect(restarted.state.counters.taxi.read).toBe(1);
      expect(restarted.state.metrics.notifiedFirstMinute).toBe(1);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
  it("keeps a Unity-reported car count authoritative over pending proxy reads", async () => {
    const e = new Engine();
    await e.handle(
      event("agent.register", {
        agents: Array.from({ length: 20 }, (_, i) => ({
          agentId: `cars-${i}`,
          role: "taxi",
          channel: "telegram",
        })),
      }),
      "twin",
    );
    await suspend(e);
    await e.handle(event("console.approve_messages", { roles: ["taxi"] }));
    await e.handle(
      event("metric.report", { name: "carsStartedInVain", value: 7 }),
      "twin",
    );
    e.tick(Date.now() + 3600000);
    expect(e.state.metrics.carsStartedInVain).toBe(7);
    for (const c of Object.values(e.state.counters)) {
      expect(c.read).toBeLessThanOrEqual(c.delivered);
      expect(c.delivered).toBeLessThanOrEqual(c.sent);
    }
  });
  it("expires channel consent and preserves active subscriptions on reset", async () => {
    const e = new Engine();
    const sub = e.subscribe({
      role: "taxi",
      channel: "telegram",
      lang: "ro",
      consent: true,
    });
    sub.expiresAt = new Date(0).toISOString();
    e.expire();
    expect(e.subscriptions).toHaveLength(0);
    e.subscribe({
      role: "staff",
      channel: "webpush",
      lang: "en",
      consent: true,
    });
    await e.handle(event("console.reset"));
    expect(e.state.counters.staff.subscribers).toBe(1);
    expect(e.state.counters.staff.sent).toBe(0);
  });
  it("has seeded log-normal median close to six minutes and 48% acting", () => {
    const samples = Array.from({ length: 10000 }, (_, i) =>
      readLatency(`agent-${i}`, 1),
    ).sort((a, b) => a - b);
    expect(samples[5000]).toBeGreaterThan(330000);
    expect(samples[5000]).toBeLessThan(390000);
    const rate =
      Array.from({ length: 10000 }, (_, i) => seeded(`agent-${i}:act`)).filter(
        (n) => n < 0.48,
      ).length / 10000;
    expect(rate).toBeGreaterThan(0.44);
    expect(rate).toBeLessThan(0.52);
    expect(readLatency("same", 60)).toBe(readLatency("same", 1) / 60);
  });
});
describe("Waze CIFS", () => {
  it("does not expose evacuation before confirmation", async () => {
    const e = new Engine();
    await e.handle(detection(), "twin");
    await e.handle(
      event("payload.suspicious", { evacuate: true, zone: "T2" }),
      "twin",
    );
    expect(wazeFeed(e.state).incidents).toEqual([]);
  });
  it("returns a stable ROAD_CLOSED incident only during suspension/evacuation", async () => {
    const e = new Engine();
    expect(wazeFeed(e.state).incidents).toEqual([]);
    await suspend(e);
    const incident = wazeFeed(e.state).incidents[0]!;
    expect(incident.type).toBe("ROAD_CLOSED");
    expect(incident.direction).toBe("BOTH_DIRECTIONS");
    expect(
      incident.polyline.split(" ").map(Number).every(Number.isFinite),
    ).toBe(true);
    expect(incident.polyline.split(" ")).toHaveLength(10);
    expect(Date.parse(incident.endtime)).toBeGreaterThan(
      Date.parse(incident.starttime),
    );
    await e.handle(event("console.reopen"));
    expect(wazeFeed(e.state).incidents).toEqual([]);
  });
});
