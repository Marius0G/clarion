import { mkdtempSync,readFileSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach,describe,expect,it,vi } from "vitest";
import type { Outbound } from "../src/channels/types.js";
import { buttonAction,catalog,createWhatsApp,fillTemplate,parseStartCode,parseWhatsAppWebhook,selectTemplate,verifyWhatsApp,whatsappPayload } from "../src/channels/whatsapp.js";
import { FidsAdapter,mapFids } from "../src/data/flights.js";
import { Engine } from "../src/engine.js";
import "../src/node-runtime.js";
import { roles } from "../src/types.js";
const m: Outbound = {messageId: "m", receiptId: "r", role: "passenger_home", lang: "ro", destination: "40712345678", text: "Clarion", situation: "subscribe"};
const payload = (value: unknown) => ({entry: [{changes: [{value}]}]});
const inbound = (text: string, id: string = crypto.randomUUID()) => payload({messages: [{id, from: m.destination, timestamp: String(Math.floor(Date.now()/1000)), text: {body: text}}]});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe("WhatsApp templates", () => {
  it("matches the submitted catalog verbatim", () => {
    expect(catalog).toEqual(JSON.parse(readFileSync(new URL("../../whatsapp/templates.json", import.meta.url), "utf8")));
  });
  it("maps only the documented roles and languages", () => {
    for (const role of roles) expect(selectTemplate(role, "evacuation", "en")?.name).toBe("evacuare_terminal");
  });
  it("fills every supported template from incident state with named parameters and no placeholders", () => {
    const engine = new Engine();
    for (const role of roles) for (const lang of ["ro", "en"] as const) for (const situation of ["subscribe", "evacuation"] as const) {
      const t = selectTemplate(role, situation, lang);
      if (!t) continue;
      const filled = fillTemplate(t, engine.templateValues({role, lang, flight: "W6 3412"}));
      expect(filled.text).not.toMatch(/\{\{/);
      expect(filled.parameters.every(p => p.parameter_name && p.text)).toBe(true);
    }
    const t = selectTemplate("taxi", "subscribe", "ro")!;
    expect(() => fillTemplate(t, {})).toThrow("Missing WhatsApp parameter");
  });
  it("builds Cloud API templates with catalog buttons outside the window, text only inside it", () => {
    const values = new Engine().templateValues({role: m.role, lang: m.lang});
    const p = whatsappPayload({...m, values}) as any;
    expect(p.template.name).toBe("abonare_confirmata");
    expect(p.template.components.filter((c: any) => c.type === "button").map((c: any) => c.parameters[0].payload)).toEqual(["Opresc alertele"]);
    expect(whatsappPayload({...m, values, lastInboundAt: new Date().toISOString()})?.type).toBe("text");
    expect(whatsappPayload({...m, values, lastInboundAt: new Date(Date.now()-86400000).toISOString()})?.type).toBe("template");
    expect(whatsappPayload({...m, situation: undefined, role: "public"})).toBeUndefined();
    expect(whatsappPayload({...m, situation: undefined, role: "public", lastInboundAt: new Date().toISOString()})?.type).toBe("text");
  });
  it("uses team env names and waits for webhook before claiming delivery", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({messages:[{id:"wamid.1"}]})));
    const send = createWhatsApp({WHATSAPP_TOKEN:"secret", WHATSAPP_PHONE_NUMBER_ID:"123"}, fetcher);
    expect(await send({...m, values: new Engine().templateValues({role:m.role,lang:m.lang})})).toEqual({delivered:false,simulated:false,providerId:"wamid.1"});
    expect(fetcher.mock.calls[0]![0]).toBe("https://graph.facebook.com/v23.0/123/messages");
    expect((await createWhatsApp({})(m)).simulated).toBe(true);
  });
});
describe("WhatsApp webhook and presence", () => {
  it("verifies challenge only with a configured matching token", () => {
    const q = new URLSearchParams("hub.mode=subscribe&hub.verify_token=secret&hub.challenge=42");
    expect(verifyWhatsApp(q,"secret")).toBe("42");
    expect(verifyWhatsApp(q,"wrong")).toBeUndefined(); expect(verifyWhatsApp(q)).toBeUndefined();
  });
  it("parses START and jury QR codes, rejects arbitrary text", () => {
    expect(parseStartCode("CLARION PASAGER W43831")).toEqual({role:"passenger_home",flight:"W43831",lang:"ro"});
    expect(parseStartCode("START CLARION relative_arrivals W6 3412 EN")).toEqual({role:"relative_arrivals",flight:"W63412",lang:"en"});
    expect(parseStartCode("START TAXI")).toEqual({role:"taxi",flight:undefined,lang:"ro"});
    expect(parseStartCode("hello")).toBeUndefined();
  });
  it("parses batched statuses, legacy buttons and interactive buttons", () => {
    const events = parseWhatsAppWebhook(payload({statuses:[{id:"a",status:"sent"},{id:"a",status:"delivered"},{id:"a",status:"read"},{id:"b",status:"failed"}],messages:[{id:"1",from:"123",button:{text:"Sunt pe drum"}},{id:"2",from:"123",interactive:{button_reply:{title:"Plec acum"}}}]}));
    expect(events.map(e => e.kind)).toEqual(["status","status","status","message","message"]);
    expect(buttonAction("I am in the terminal")).toBe("terminal");
    expect(buttonAction("I have not left yet")).toBe("home");
    expect(buttonAction("Stop alerts")).toBe("unsubscribe");
  });
  it("subscribes once per webhook, persists window, advances delivery/read once, updates and stops presence", async () => {
    const send = vi.fn().mockResolvedValue({delivered:false,simulated:false,providerId:"wamid.1"});
    const e = new Engine({adapters:{whatsapp:send}});
    const start = inbound("START CLARION PASAGER W43831", "same");
    await e.whatsappWebhook(start); await e.whatsappWebhook(start);
    expect(e.subscriptions).toHaveLength(1); expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0].lastInboundAt).toBeTruthy();
    expect(e.state.presence.passenger_home.unknown).toBe(1);
    expect(e.state.counters.passenger_home.delivered).toBe(0);
    const statuses = payload({statuses:[{id:"wamid.1",status:"sent"},{id:"wamid.1",status:"read"}]});
    await e.whatsappWebhook(statuses); await e.whatsappWebhook(statuses);
    expect(e.state.counters.passenger_home).toEqual({subscribers:1,sent:1,delivered:1,read:1});
    await e.whatsappWebhook(inbound("Sunt pe drum"));
    expect(e.state.presence.passenger_home.road).toBe(1); expect(e.state.presence.passenger_home.unknown).toBe(0);
    await e.whatsappWebhook(inbound("Opresc alertele"));
    expect(e.subscriptions).toHaveLength(0); expect(e.state.presence.passenger_home.road).toBe(0);
  });
  it("retains phone presence, replay IDs and live-flight diversions through Node restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clarion-restart-"));
    try {
      const options = {file: join(dir, "state.json"), adapters:{whatsapp:vi.fn().mockResolvedValue({delivered:false,simulated:true})}};
      const first = new Engine(options);
      const start = inbound("CLARION PASAGER W43831", "persisted-id");
      await first.whatsappWebhook(start); await first.whatsappWebhook(inbound("Sunt pe drum"));
      first.state.flights.push({flight:"W4 3752",dir:"arr",city:"London Luton",iata:"LTN",sched:new Date().toISOString(),est:new Date().toISOString(),status:"diverted",divertedTo:"OTP"});
      first.persist();
      const next = new Engine(options);
      await next.whatsappWebhook(start);
      expect(options.adapters.whatsapp).toHaveBeenCalledTimes(1);
      expect(next.state.presence.passenger_home.road).toBe(1);
      expect(next.state.flights.find(f => f.flight === "W4 3752")?.divertedTo).toBe("OTP");
    } finally { rmSync(dir, {recursive:true}); }
  });
  it("counts Unity moves once, rejects invalid updates, and accepts WhatsApp replies", async () => {
    const e = new Engine();
    const event = (type:string,data:object) => e.handle({type,ts:new Date().toISOString(),data},"twin");
    await event("agent.register",{agents:[{agentId:"a",role:"taxi",channel:"whatsapp"}]});
    await event("agent.update",{agentId:"a",role:"taxi",location:"kerb",action:"wait"});
    await event("agent.update",{agentId:"a",role:"taxi",location:"road"});
    expect(e.state.presence.taxi).toEqual({home:0,road:1,terminal:0,kerb:0,unknown:0});
    await expect(event("agent.update",{agentId:"a",role:"taxi",location:"moon"})).rejects.toThrow();
    await e.whatsappWebhook(inbound("START PASAGER")); e.updatePresence("whatsapp",m.destination!,"Nu am plecat încă");
    expect(e.state.presence.passenger_home.home).toBe(1);
  });
});
describe("recorded FIDS", () => {
  const departures = JSON.parse(readFileSync(new URL("./fixtures/fids-departures-2026-10-31.json",import.meta.url),"utf8"));
  const arrivals = JSON.parse(readFileSync(new URL("./fixtures/fids-arrivals-2026-10-31.json",import.meta.url),"utf8"));
  it("maps recorded UTC timestamps, arrival estimates and airport directions", () => {
    expect(mapFids(departures,"dep")[0]).toMatchObject({flight:"W4 3831",dir:"dep",iata:"CRL",sched:"2026-10-31T12:10:00.000Z"});
    expect(mapFids(arrivals,"arr")[0]).toMatchObject({iata:"LTN",est:"2026-10-31T11:08:00.000Z"});
    expect(() => mapFids({},"dep")).toThrow();
  });
  it("caches for five minutes then falls back to labelled fixture on failure", async () => {
    const fetcher = vi.fn().mockImplementation(async (url:string) => new Response(JSON.stringify(url.includes("departures") ? departures : arrivals)));
    const fids = new FidsAdapter(fetcher);
    expect((await fids.get(1000)).dataSource).toBe("fids");
    await fids.get(2000); expect(fetcher).toHaveBeenCalledTimes(2);
    fetcher.mockRejectedValue(new Error("offline"));
    expect((await fids.get(301001)).dataSource).toBe("fixture");
    expect(fetcher.mock.calls[0]![1].signal).toBeInstanceOf(AbortSignal);
  });
});
