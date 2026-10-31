import { mkdtempSync,rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll,beforeAll,describe,expect,it,vi } from "vitest";
import { WebSocket } from "ws";
import { createControlTower } from "../src/server.js";
const dir = mkdtempSync(join(tmpdir(), "tower-http-"));
let server: ReturnType<typeof createControlTower>, base: string;
beforeAll(async () => {
  vi.stubEnv("STATE_FILE", join(dir, "state.json"));
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
    expect(await (await fetch(`${base}/health`)).json()).toEqual({ ok: true, service: "clarion" });
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
          channel: "whatsapp",
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
  it("accepts enveloped console actions and rejects twin events over action route", async () => {
    const post = (type: string) =>
      fetch(`${base}/api/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type, ts: new Date().toISOString(), data: {} }),
      });
    expect((await post("agent.register")).status).toBe(400);
    expect((await post("console.reset")).status).toBe(200);
  });
});

describe("WhatsApp webhook HTTP routes", () => {
  it("checks the verification token and processes jury subscriptions and buttons", async () => {
    vi.stubEnv("WHATSAPP_VERIFY_TOKEN", "verify-test");
    vi.stubEnv("WHATSAPP_TOKEN", "");
    const good = await fetch(`${base}/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=verify-test&hub.challenge=1234`);
    expect(good.status).toBe(200); expect(await good.text()).toBe("1234");
    expect((await fetch(`${base}/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=bad&hub.challenge=1234`)).status).toBe(403);
    const post = (text: string) => fetch(`${base}/webhooks/whatsapp`, {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({entry:[{changes:[{value:{messages:[{id:crypto.randomUUID(),from:"40700000000",text:{body:text}}]}}]}]})});
    expect((await post("CLARION PASAGER W43831")).status).toBe(200);
    expect((await post("Sunt în terminal")).status).toBe(200);
    const state = await (await fetch(`${base}/api/state`)).json();
    expect(state.presence.passenger_home.terminal).toBe(1);
    expect((await post("Opresc alertele")).status).toBe(200);
  });
});
