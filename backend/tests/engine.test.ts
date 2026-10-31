import { describe,expect,it } from "vitest";
import { Engine,readLatency,seeded } from "../src/engine.js";
import "../src/node-runtime.js";
import type { Envelope } from "../src/types.js";
const event = (type: string, data: Record<string, unknown> = {}): Envelope => ({
  type,
  ts: new Date().toISOString(),
  data,
});
describe("counters, simulation and persistence", () => {
  it("expires channel consent and preserves active subscriptions on reset", async () => {
    const e = new Engine();
    const sub = e.subscribe({
      role: "taxi",
      channel: "whatsapp",
      lang: "ro",
      consent: true,
    });
    sub.expiresAt = new Date(0).toISOString();
    e.expire();
    expect(e.subscriptions).toHaveLength(0);
    e.subscribe({
      role: "staff",
      channel: "whatsapp",
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

describe("removed event and channel contracts", () => {
  it.each(["drone.detected", "ops.suspended", "intercept.launched", "intercept.captured", "payload.suspicious", "console.open_wave", "console.confirm_suspension", "console.request_roalert"])("rejects %s without changing state", async type => {
    const e = new Engine();
    const before = structuredClone(e.snapshot());
    await expect(e.handle(event(type), type.startsWith("console.") ? "console" : "twin")).rejects.toThrow("Unknown event");
    expect(e.snapshot()).toEqual(before);
  });
  it.each(["telegram", "sms", "webpush"])("rejects removed channel %s", channel => {
    const e = new Engine();
    expect(() => e.subscribe({ role: "staff", channel, lang: "ro", consent: true })).toThrow();
    expect(e.subscriptions).toEqual([]);
  });
});
