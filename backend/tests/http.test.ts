import { afterAll, beforeAll, describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import { createControlTower } from "../src/server.js";
const dir = mkdtempSync(join(tmpdir(), "tower-http-"));
let server: ReturnType<typeof createControlTower>, base: string;
beforeAll(async () => {
  vi.stubEnv("STATE_FILE", join(dir, "state.json"));
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
  server = createControlTower();
  await new Promise<void>((r) => server.http.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.http.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await server.stop();
  rmSync(dir, { recursive: true });
  vi.unstubAllEnvs();
});
describe("HTTP and WebSocket contract", () => {
  it("provides health/state, valid CORS preflights and rejects unrelated origins", async () => {
    expect((await (await fetch(`${base}/health`)).json()).ok).toBe(true);
    for (const origin of [
      "http://localhost:5173",
      "https://jury.pages.dev",
      "https://preview.jury.pages.dev",
    ]) {
      const r = await fetch(`${base}/api/state`, {
        method: "OPTIONS",
        headers: { Origin: origin },
      });
      expect(r.status).toBe(204);
      expect(r.headers.get("Access-Control-Allow-Origin")).toBe(origin);
    }
    expect(
      (
        await fetch(`${base}/api/state`, {
          headers: { Origin: "https://pages.dev.attacker.example" },
        })
      ).status,
    ).toBe(403);
  });
  it("validates consent and returns contract subscription response without exposing destinations", async () => {
    const subscribe = (consent: boolean) =>
      fetch(`${base}/api/subscribe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          role: "passenger_home",
          channel: "telegram",
          lang: "en",
          consent,
          source: "jury",
          flight: "W6 3412",
        }),
      });
    expect((await subscribe(false)).status).toBe(400);
    const response = await subscribe(true);
    expect(response.status).toBe(201);
    const result = await response.json();
    expect(result.subscriptionId).toBeTruthy();
    const payload = new URL(result.telegramLink).searchParams.get("start")!;
    expect(payload).toMatch(/^passenger_home__W63412/);
    expect(payload.length).toBeLessThanOrEqual(64);
    await server.engine.telegramStart("123", payload);
    expect(
      server.engine.subscriptions.find((s) => s.id === result.subscriptionId)
        ?.lang,
    ).toBe("en");
    const state = await (await fetch(`${base}/api/state`)).json();
    expect(state.subscriptions).toBeUndefined();
    expect(state.counters.passenger_home.subscribers).toBe(1);
  });
  it("sends state on WebSocket connect and blocks viewer mutations", async () => {
    const ws = new WebSocket(`${base.replace("http", "ws")}/ws?client=viewer`);
    const message = () =>
      new Promise<any>((resolve, reject) => {
        ws.once("message", (m) => resolve(JSON.parse(m.toString())));
        ws.once("error", reject);
      });
    const initial = await message();
    expect(initial.type).toBe("state");
    expect(initial.data.reach).toHaveLength(6);
    expect(initial.data.drone).toBeNull();
    expect(initial.data.phase).toBe("normal");
    const rejected = message();
    ws.send(
      JSON.stringify({
        type: "console.reset",
        ts: new Date().toISOString(),
        data: {},
      }),
    );
    expect((await rejected).type).toBe("error");
    ws.close();
  });
  it("exposes Telegram configuration without secrets", async () => {
    expect(await (await fetch(`${base}/api/telegram`)).json()).toEqual({
      enabled: false,
      botUsername: null,
      deepLinkExample: null,
    });
    expect(server.engine.subscriptions[0]?.source).toBe("jury");
  });
  it("accepts enveloped console actions and rejects twin events over action route", async () => {
    const post = (type: string) =>
      fetch(`${base}/api/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type, ts: new Date().toISOString(), data: {} }),
      });
    expect((await post("agent.register")).status).toBe(400);
    expect((await post("console.reset")).status).toBe(200);
    expect(
      (await (await fetch(`${base}/waze/cifs.json`)).json()).incidents,
    ).toEqual([]);
  });
});
