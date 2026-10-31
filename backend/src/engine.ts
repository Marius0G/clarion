import { SimStore, locations as simLocations, type LegacyLocation } from "./sim.js";
import { wazeFeed } from "./channels/waze.js";
import { engineRuntime } from "./runtime.js";
const randomUUID = () => crypto.randomUUID();
import {
  roles,
  waveRoles,
  isRole,
  isChannel,
  type Agent,
  type Draft,
  type Envelope,
  type Receipt,
  type Role,
  type Situation,
  type State,
  type Subscription,
} from "./types.js";
import { buttonAction, parseStartCode, parseWhatsAppWebhook } from "./channels/whatsapp.js";
import type { Flight } from "./types.js";
import { render } from "./messages.js";
import { fixtureSource, schedule, settlePast } from "./data/flights.js";
import { roalertDraft } from "./channels/roalert.js";
import type { Adapter, Outbound } from "./channels/types.js";
// Demo assumption: 10 drivers/minute while the simulated Waze closure is active.
export const WAZE_DRIVERS_PER_MINUTE = 10;
const iso = () => new Date().toISOString();
const flightKey = (value: string) => value.replace(/\s/g, "").toUpperCase();
const clock = (date: string) =>
  new Intl.DateTimeFormat("ro-RO", {
    timeZone: "Europe/Bucharest",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(date));
export function seeded(seed: string): number {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return ((h >>> 0) + 0.5) / 4294967296;
}
export function readLatency(seed: string, speed: number): number {
  const u = seeded(seed + ":u"),
    v = seeded(seed + ":v");
  return (
    (360000 *
      Math.exp(0.7 * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v))) /
    speed
  );
}
interface Store {
  state: State;
  subscriptions: Subscription[];
  agents: Agent[];
  receipts: Receipt[];
  telegramOffset: number;
  firstNotified: string[];
  readRecipientKeys?: string[];
  carAgents: string[];
  carMetricReported?: boolean;
  whatsappInboundIds?: string[];
}
interface Options {
  file?: string;
  emit?: (type: string, data: any) => void;
  adapters?: Partial<Record<string, Adapter>>;
  simSpeed?: number;
  seed?: string;
  autoConfirm?: boolean;
  wavesEnabled?: boolean;
  waveCount?: number;
  waveMinutes?: number;
  taxiGroup?: string;
  simAbFile?: string;
}
export class Engine {
  readonly sim = new SimStore();
  private batchDepth = 0;
  private dirty = false;
  private persistPending = false;
  async batch<T>(work: () => T | Promise<T>): Promise<T> {
    this.batchDepth++;
    try { return await work(); }
    finally { this.endBatch(); }
  }
  private endBatch() {
    if (--this.batchDepth !== 0) return;
    const dirty = this.dirty, persist = this.persistPending;
    this.dirty = this.persistPending = false;
    if (dirty) this.changed();
    else if (persist) this.persist();
  }
  state: State;
  subscriptions: Subscription[] = [];
  agents: Agent[] = [];
  receipts: Receipt[] = [];
  telegramOffset = 0;
  private whatsappInboundIds = new Set<string>();
  private firstNotified = new Set<string>();
  private readRecipientKeys = new Set<string>();
  private carAgents = new Set<string>();
  private generation = 0;
  private carMetricReported = false;
  constructor(private options: Options = {}) {
    this.state = this.fresh();
    if (options.file && engineRuntime.exists(options.file)) {
      const saved = engineRuntime.read(options.file) as Store;
      if (
        !saved.state ||
        !Array.isArray(saved.subscriptions) ||
        !Array.isArray(saved.receipts)
      )
        throw new Error(
          "Invalid persisted state; refusing to discard subscribers",
        );
      this.whatsappInboundIds = new Set(saved.whatsappInboundIds ?? []);
      this.state = saved.state;
      this.subscriptions = saved.subscriptions;
      this.agents = saved.agents;
      this.receipts = saved.receipts;
      this.telegramOffset = saved.telegramOffset ?? 0;
      this.firstNotified = new Set(saved.firstNotified);
      this.readRecipientKeys = new Set(
        saved.readRecipientKeys ??
          this.receipts.filter((r) => r.read).map((r) => this.recipientKey(r)),
      );
      this.carAgents = new Set(saved.carAgents);
      this.carMetricReported = saved.carMetricReported ?? false;
    }
    const persistedDiversions = this.state.flights.filter(f => f.status === "diverted");
    this.state.flights = schedule().map((f) => {
      const previous = this.state.flights.find(
        (p) => p.flight === f.flight && p.dir === f.dir,
      );
      return previous && this.state.phase !== "normal"
        ? {
            ...f,
            status: previous.status,
            divertedTo: previous.divertedTo,
            est: previous.status === "diverted" ? previous.est : f.est,
          }
        : f;
    });
    for (const f of persistedDiversions) if (!this.state.flights.some(p => flightKey(p.flight) === flightKey(f.flight) && p.dir === f.dir)) this.state.flights.push(f);
    this.state.dataSource = "fixture";
    this.state.dataSourceDetail = fixtureSource;
    this.state.drone ??= null;
    this.state.reach ??= [];
    for (const role of roles)
      this.state.counters[role] ??= {
        subscribers: 0,
        sent: 0,
        delivered: 0,
        read: 0,
      };
    for (const sub of this.subscriptions) sub.source ??= "direct";
    this.expire();
  }
  private fresh(): State {
    return {
      presence: {} as State["presence"],
      drone: null,
      reach: [],
      phase: "normal",
      since: iso(),
      reason: null,
      evacuate: false,
      estimatedReopen: new Date(Date.now() + 3600000).toISOString(),
      confirmedAt: null,
      flights: schedule(),
      drafts: [],
      counters: Object.fromEntries(
        roles.map((r) => [
          r,
          { subscribers: 0, sent: 0, delivered: 0, read: 0 },
        ]),
      ) as State["counters"],
      roalertDraft: null,
      waves: [],
      timeline: [],
      metrics: {
        notifiedFirstMinute: 0,
        readCount: 0,
        readRecipients: 0,
        carsStartedInVain: 0,
        isuTimeToT2: null,
        kerbPeak: null,
      },
      dataSource: "fixture",
      dataSourceDetail: fixtureSource,
    };
  }
  persist() {
    if (this.batchDepth) { this.persistPending = true; return; }
    if (!this.options.file) return;
    const store: Store = {
      state: this.state,
      subscriptions: this.subscriptions,
      agents: this.agents,
      receipts: this.receipts,
      telegramOffset: this.telegramOffset,
      firstNotified: [...this.firstNotified],
      readRecipientKeys: [...this.readRecipientKeys],
      carAgents: [...this.carAgents],
      carMetricReported: this.carMetricReported,
      whatsappInboundIds: [...this.whatsappInboundIds],
    };
    engineRuntime.write(this.options.file, store);
  }

  private changed() {
    if (this.batchDepth) { this.dirty = true; return; }
    this.recount();
    this.persist();
    this.options.emit?.("state", this.snapshot());
  }
  private recount() {
    this.state.presence = Object.fromEntries(roles.map(role => {
      const counts = { home: 0, road: 0, terminal: 0, kerb: 0, unknown: 0 };
      for (const p of [...this.subscriptions, ...this.agents].filter(p => p.role === role)) counts[p.location ?? "unknown"]++;
      return [role, counts];
    })) as State["presence"];
    for (const role of roles)
      this.state.counters[role].subscribers =
        this.subscriptions.filter((s) => s.role === role).length +
        this.agents.filter((a) => a.role === role).length;
    const incident =
      this.state.phase === "suspended" || this.state.phase === "recovery";
    const closure = wazeFeed(this.state).incidents.length > 0;
    const counts = [
      this.subscriptions.filter((s) => s.source === "relative").length,
      this.subscriptions.filter((s) => s.flight).length,
      this.subscriptions.length,
      this.receipts.filter(
        (r) =>
          [
            "taxi",
            "rideshare",
            "rent_a_car_ubt",
            "staff",
            "alt_airport",
          ].includes(r.role) &&
          !this.agents.some((a) => a.agentId === r.recipient),
      ).length,
      closure && this.state.confirmedAt
        ? Math.floor(
            (Math.max(0, Date.now() - Date.parse(this.state.confirmedAt)) /
              60000) *
              WAZE_DRIVERS_PER_MINUTE,
          )
        : 0,
      this.state.roalertDraft ? 1 : 0,
    ];
    this.state.reach = [
      "share_link",
      "flight_subscriptions",
      "daily_value",
      "contacts",
      "location",
      "ro_alert",
    ].map((key, i) => ({
      step: i + 1,
      key,
      reached: counts[i]!,
      status:
        i === 5
          ? this.state.roalertDraft
            ? "draft"
            : "idle"
          : i === 4
            ? closure
              ? "active"
              : "idle"
            : i === 2
              ? incident
                ? "active"
                : "idle"
              : counts[i]! > 0
                ? "active"
                : "idle",
    }));
    this.state.metrics.readRecipients = this.readRecipientKeys.size;
    this.state.metrics.notifiedFirstMinute = this.firstNotified.size;
  }
  private timeline(type: string, data: Record<string, unknown> = {}) {
    this.state.timeline.push({
      type,
      ts: iso(),
      phase: this.state.phase,
      data,
    });
  }
  private transition(phase: State["phase"], type: string) {
    this.state.phase = phase;
    this.state.since = iso();
    this.timeline(type);
  }
  private requirePhase(...phases: State["phase"][]) {
    if (!phases.includes(this.state.phase))
      throw new Error(`Action not allowed in ${this.state.phase}`);
  }
  expire() {
    const n = this.subscriptions.length;
    this.subscriptions = this.subscriptions.filter(
      (s) => Date.parse(s.expiresAt) > Date.now(),
    );
    const active = new Set(this.subscriptions.map((s) => s.id));
    this.receipts = this.receipts.filter(
      (r) =>
        r.simulated ||
        active.has(r.recipient) ||
        r.recipient.startsWith("taxi-group:"),
    );
    if (n !== this.subscriptions.length) this.changed();
    else this.recount();
  }
  subscribe(input: Record<string, any>): Subscription {
    if (
      !isRole(input.role) ||
      !isChannel(input.channel) ||
      !["ro", "en"].includes(input.lang) ||
      input.consent !== true
    )
      throw new Error("Valid role, channel, lang and consent:true required");
    if (
      input.flight !== undefined &&
      (typeof input.flight !== "string" ||
        !/^[A-Z0-9 -]+$/i.test(input.flight) ||
        input.flight.replace(/\s/g, "").length > 10)
    )
      throw new Error("Invalid flight");
    if (
      input.destination !== undefined &&
      (typeof input.destination !== "string" || input.destination.length > 160)
    )
      throw new Error("Invalid destination");
    if (input.channel === "telegram" && input.destination !== undefined)
      throw new Error("Telegram chat must be bound by /start");
    if (
      input.source !== undefined &&
      !["jury", "relative", "qr", "direct"].includes(input.source)
    )
      throw new Error("Invalid subscription source");
    const flight = this.state.flights.find(
      (f) => flightKey(f.flight) === flightKey(String(input.flight ?? "")),
    );
    const date = input.date ?? flight?.sched ?? iso();
    if (typeof date !== "string" || !Number.isFinite(Date.parse(date)))
      throw new Error("Invalid flight date");
    const expiresAt = new Date(Date.parse(date) + 48 * 3600000).toISOString();
    if (Date.parse(expiresAt) <= Date.now())
      throw new Error("Flight subscription expired");
    const sub: Subscription = {
      id: randomUUID(),
      role: input.role,
      channel: input.channel,
      lang: input.lang,
      source: input.source ?? "direct",
      consent: true,
      flight: input.flight,
      date,
      route: flight?.iata,
      expiresAt,
      destination: input.destination,
    };
    this.subscriptions.push(sub);
    this.changed();
    return sub;
  }
  async telegramStart(chat: string, payload: string): Promise<void> {
    const [role, rawFlight, suffix, explicitSource] = payload.split("__");
    const sources = ["jury", "relative", "qr", "direct"];
    const subscriptionId =
      suffix && !sources.includes(suffix) ? suffix : undefined;
    const source =
      explicitSource ??
      (suffix && sources.includes(suffix)
        ? suffix
        : role === "relative_arrivals"
          ? "relative"
          : "direct");
    if (!sources.includes(source)) throw new Error("Invalid Telegram source");
    if (!isRole(role)) throw new Error("Unknown Telegram role");
    const flight = rawFlight
      ?.replace(/_/g, " ")
      .replace(/([A-Z]\d)(\d+)/, "$1 $2");
    this.expire();
    // Optional opaque suffix preserves the exact channel consent/lang from /api/subscribe.
    let sub = subscriptionId
      ? this.subscriptions.find(
          (s) =>
            s.id.replace(/-/g, "") === subscriptionId.replace(/-/g, "") &&
            s.role === role &&
            s.channel === "telegram" &&
            (!s.destination || s.destination === chat),
        )
      : undefined;
    if (subscriptionId && !sub)
      throw new Error("Invalid or expired Telegram subscription");
    sub ??= this.subscriptions.find(
      (s) =>
        s.destination === chat &&
        s.role === role &&
        s.flight === flight &&
        s.channel === "telegram",
    );
    if (!sub)
      sub = this.subscribe({
        role,
        flight: flight || undefined,
        channel: "telegram",
        source,
        lang: "ro",
        consent: true,
      });
    sub.destination = chat;
    this.changed();
  }
  telegramLink(sub: Subscription, bot: string): string {
    const flight = (sub.flight ?? "").replace(/\s/g, "");
    // UUID suffix is optional; Telegram limits start payloads to 64 characters.
    const base = `${sub.role}__${flight}`;
    const suffix = `__${sub.id.replace(/-/g, "")}`;
    return `https://t.me/${bot}?start=${encodeURIComponent(base.length + suffix.length <= 64 ? base + suffix : base)}`;
  }
  templateValues(sub: Pick<Subscription, "role" | "lang" | "flight">, extra: Record<string, string> = {}) {
    const normalize = (s: string) => s.replace(/\s/g, "").toUpperCase();
    const f = this.state.flights.find(f => normalize(f.flight) === normalize(sub.flight ?? "")) ?? (sub.flight ? undefined : this.state.flights.find(f => f.dir === (sub.role === "relative_arrivals" ? "arr" : "dep")));
    const en = sub.lang === "en";
    const unknown = en ? "not yet confirmed" : "încă neconfirmat";
    const labels: Record<Role, [string, string]> = {
      passenger_home: ["pasager", "passenger"], passenger_road: ["pasager pe drum", "passenger on the road"], passenger_terminal: ["pasager în terminal", "passenger in the terminal"], relative_arrivals: ["persoană care așteaptă o sosire", "someone meeting an arrival"], taxi: ["taximetrist", "taxi driver"], rideshare: ["șofer ride-hailing", "ride-hailing driver"], rent_a_car_ubt: ["operator rent-a-car/UBT", "rental/UBT operator"], staff: ["personal aeroportuar", "airport staff"], isu_smurd: ["echipaj ISU/SMURD", "emergency crew"], alt_airport: ["aeroport alternativ", "alternate airport"], public: ["vizitator", "visitor"],
    };
    const time = clock(this.state.since);
    const eta = f ? clock(f.est) : unknown;
    return {
      rol: `${labels[sub.role][en ? 1 : 0]}${sub.flight ? ` (${sub.flight})` : ""}`, ora: time,
      motiv: this.state.reason === "drone" ? (en ? "unauthorised drone reported near the runway" : "dronă neautorizată semnalată lângă pistă") : this.state.reason === "weather" ? (en ? "weather conditions" : "condiții meteo") : (en ? "operational incident" : "incident operațional"),
      zbor: sub.flight ?? f?.flight ?? unknown, destinatie: f?.city ?? unknown, origine: f?.city ?? unknown,
      aeroport: f?.divertedTo ?? unknown, ora_update: clock(new Date(Date.now() + 600000).toISOString()),
      ora_minima: clock(this.state.estimatedReopen), instructiuni: en ? "Follow the dispatcher instructions and keep emergency access clear." : "Urmați indicațiile dispecerului și păstrați liber accesul echipajelor de urgență.",
      ora_plecare: eta, ora_aterizare: eta, ora_sosire: eta, ora_acces: clock(this.state.estimatedReopen),
      interval: extra.window || `${clock(this.state.estimatedReopen)}–${clock(new Date(Date.parse(this.state.estimatedReopen) + 1200000).toISOString())}`,
      pasageri: unknown,
    };
  }
  async confirmSubscription(sub: Subscription) {
    if (sub.channel !== "whatsapp") return;
    const draft: Draft = { messageId: randomUUID(), role: sub.role, lang: sub.lang, situation: "runway_closed", text: "Clarion", approved: true };
    const receipt = this.newReceipt(draft, sub.id, false);
    let result: import("./channels/types.js").Delivery | undefined;
    try { result = await this.options.adapters?.whatsapp?.({messageId: draft.messageId, receiptId: receipt.id, role: sub.role, lang: sub.lang, destination: sub.destination, text: "Clarion: alerte activate / alerts activated", situation: "subscribe", values: this.templateValues(sub), lastInboundAt: sub.lastInboundAt}); } catch { console.warn("Clarion WhatsApp subscription confirmation failed"); }
    receipt.providerId = result?.providerId;
    receipt.simulated = result?.simulated ?? false;
    if (result?.delivered) { receipt.delivered = true; this.state.counters[sub.role].delivered++; this.notified(receipt); }
    this.changed();
  }
  updatePresence(channel: Subscription["channel"], destination: string, text: string) {
    const action = buttonAction(text);
    if (!action) return;
    if (action === "unsubscribe") this.subscriptions = this.subscriptions.filter(s => s.channel !== channel || s.destination !== destination);
    else if (action !== "read") for (const sub of this.subscriptions.filter(s => s.channel === channel && s.destination === destination)) sub.location = action;
    this.changed();
  }
  async whatsappWebhook(body: unknown) {
    for (const e of parseWhatsAppWebhook(body)) {
      if (e.kind === "status") {
        const r = this.receipts.find(r => r.providerId === e.id);
        if (!r || (e.destination && !this.subscriptions.some(s => s.id === r.recipient && s.destination === e.destination))) continue;
        if (e.status !== "sent" && !r.delivered) { r.delivered = true; this.state.counters[r.role].delivered++; this.notified(r, e.at); }
        if (e.status === "read") this.markRead(r.id);
      } else {
        if (this.whatsappInboundIds.has(e.id)) continue;
        const inboundAt = e.at ?? iso();
        const start = parseStartCode(e.text);
        this.expire();
        let sub = this.subscriptions.find(s => s.channel === "whatsapp" && s.destination === e.destination && (!start || s.role === start.role && flightKey(s.flight ?? "") === flightKey(start.flight ?? "")));
        if (start && !sub) sub = this.subscribe({...start, channel: "whatsapp", destination: e.destination, source: "jury", consent: true});
        for (const s of this.subscriptions.filter(s => s.channel === "whatsapp" && s.destination === e.destination)) {
          if (!s.lastInboundAt || inboundAt > s.lastInboundAt) s.lastInboundAt = inboundAt;
        }
        if (sub && start) await this.confirmSubscription(sub);
        this.whatsappInboundIds.add(e.id);
        if (this.whatsappInboundIds.size > 5000) this.whatsappInboundIds.delete(this.whatsappInboundIds.values().next().value!);
        this.updatePresence("whatsapp", e.destination, e.text);
        if (e.contextId) {
          const r = this.receipts.find(r => r.providerId === e.contextId);
          if (r) this.markRead(r.id, e.destination);
        }
      }
    }
    this.changed();
  }
  updateFlights(flights: Flight[], dataSource: "fids" | "fixture") {
    const previous = this.state.flights;
    this.state.flights = flights.map((f) => settlePast(f)).map(f => {
      const old = previous.find(p => flightKey(p.flight) === flightKey(f.flight) && p.dir === f.dir);
      if (old?.status === "diverted") return {...f, status: old.status, divertedTo: old.divertedTo, est: old.est};
      return this.state.phase === "suspended" && f.status === "scheduled" ? {...f, status: "suspended"} : {...f};
    });
    for (const old of previous.filter(f => f.status === "diverted")) if (!this.state.flights.some(f => flightKey(f.flight) === flightKey(old.flight) && f.dir === old.dir)) this.state.flights.push(old);
    this.state.dataSource = dataSource;
    this.state.dataSourceDetail = dataSource === "fixture" ? fixtureSource : "Live CRA schedule from fids.flightradar.live; incident status overlays are simulated.";
    this.changed();
  }
  private values(
    flight?: string,
    extra: Record<string, string> = {},
  ): Record<string, string> {
    const f =
      this.state.flights.find(
        (f) => flightKey(f.flight) === flightKey(flight ?? ""),
      ) ??
      this.state.flights.find((f) => f.status === "diverted") ??
      this.state.flights[0];
    return {
      dest: f?.city ?? "destinație",
      from: f?.city ?? "Bergamo",
      to: f?.divertedTo ?? "OTP",
      eta: clock(f?.est ?? iso()),
      flight: flight ?? f?.flight ?? "W6 3412",
      reopen: clock(this.state.estimatedReopen),
      next: clock(new Date(Date.now() + 10 * 60000).toISOString()),
      demand: clock(
        new Date(
          Date.parse(this.state.estimatedReopen) + 30 * 60000,
        ).toISOString(),
      ),
      wave: "1",
      window: "",
      ...extra,
    };
  }
  private draft(
    situation: Situation,
    flight?: string,
    extra: Record<string, string> = {},
    only: readonly Role[] = roles,
  ): Draft[] {
    const created = only.flatMap((role) =>
      (["ro", "en"] as const).map((lang) => ({
        messageId: randomUUID(),
        role,
        lang,
        situation,
        text: render(role, situation, lang, this.values(flight, extra)),
        approved: false,
        flight,
      })),
    );
    this.state.drafts.push(...created);
    return created;
  }
  private confirm() {
    this.requirePhase("detection");
    this.state.confirmedAt = iso();
    this.transition("suspended", "console.confirm_suspension");
    this.state.flights = this.state.flights.map((f) => settlePast(f));
    this.state.flights.forEach((f) => {
      if (f.status === "scheduled") f.status = "suspended";
    });
    this.draft("runway_closed");
    for (const flight of this.state.flights.filter(
      (f) => f.status === "diverted",
    ))
      this.draft("diverted", flight.flight);
    if (this.state.evacuate) this.draft("evacuation");
  }
  private recovery() {
    this.requirePhase("suspended");
    this.state.evacuate = false;
    this.transition("recovery", "recovery.started");
    const count =
        this.options.wavesEnabled === false ? 0 : (this.options.waveCount ?? 3),
      minutes = this.options.waveMinutes ?? 10;
    this.state.waves = Array.from({ length: count }, (_, i) => ({
      wave: i + 1,
      window: {
        from: new Date(Date.now() + i * minutes * 60000).toISOString(),
        to: new Date(Date.now() + (i + 1) * minutes * 60000).toISOString(),
      },
      roles: this.rolesInWave(i + 1),
      opened: false,
    }));
  }
  async handle(event: Envelope, client: "twin" | "console" | "viewer" = "console"): Promise<void> {
    return this.batch(() => this.handleEvent(event, client));
  }
  private async handleEvent(
    event: Envelope,
    client: "twin" | "console" | "viewer" = "console",
  ): Promise<void> {
    if (
      !event ||
      typeof event.type !== "string" ||
      !event.data ||
      typeof event.data !== "object" ||
      Array.isArray(event.data) ||
      !Number.isFinite(Date.parse(event.ts))
    )
      throw new Error("Invalid JSON envelope");
    const { type, data } = event;
    if (
      client === "viewer" ||
      (type.startsWith("console.") ? client !== "console" : client !== "twin")
    )
      throw new Error("Client cannot issue this event");
    switch (type) {
      case "sim.status":
        this.sim.status(data);
        return;
      case "flow.report":
        this.sim.flow(data);
        return;
      // Contract v2 telemetry: in memory only, read through GET /api/sim.
      case "flight.update":
        this.sim.flights(data);
        return;
      case "crowd.positions":
        this.sim.positions(data);
        return;
      case "ops.ack":
        this.sim.ack(data);
        return;
      case "agent.batch": {
        const updates = this.sim.batch(data);
        const registered = new Map(this.agents.map(a => [a.agentId, a]));
        let changed = false;
        for (const row of updates) {
          const agent = registered.get(row.agentId);
          // Terminal node ids stay in the sim store; presence counts keep the legacy places.
          const location = (simLocations as readonly string[]).includes(row.location) ? row.location as LegacyLocation : agent?.location;
          if (!agent || (agent.role === row.role && agent.location === location && agent.action === row.action)) continue;
          agent.role = row.role; agent.location = location; agent.action = row.action; changed = true;
        }
        if (changed) this.changed();
        return;
      }
      case "drone.detected":
        this.requirePhase("normal");
        if (
          !["08", "26"].includes(data.nearRunway) ||
          !["radar", "report"].includes(data.source) ||
          !Number.isFinite(data.distanceM) ||
          data.distanceM < 0 ||
          !Number.isFinite(data.bearingDeg) ||
          data.bearingDeg < 0 ||
          data.bearingDeg >= 360 ||
          ((data.lat !== undefined || data.lon !== undefined) &&
            (!Number.isFinite(data.lat) ||
              !Number.isFinite(data.lon) ||
              Math.abs(data.lat) > 90 ||
              Math.abs(data.lon) > 180))
        )
          throw new Error("Invalid detection");
        {
          const angular = data.distanceM / 6371000,
            bearing = (data.bearingDeg * Math.PI) / 180;
          const originLat = (44.3181 * Math.PI) / 180,
            originLon = (23.8886 * Math.PI) / 180;
          const lat = Math.asin(
            Math.sin(originLat) * Math.cos(angular) +
              Math.cos(originLat) * Math.sin(angular) * Math.cos(bearing),
          );
          const lon =
            originLon +
            Math.atan2(
              Math.sin(bearing) * Math.sin(angular) * Math.cos(originLat),
              Math.cos(angular) - Math.sin(originLat) * Math.sin(lat),
            );
          this.state.drone = {
            lat: data.lat ?? (lat * 180) / Math.PI,
            lon: data.lon ?? (((lon * 180) / Math.PI + 540) % 360) - 180,
            distanceM: data.distanceM,
            bearingDeg: data.bearingDeg,
            nearRunway: data.nearRunway,
            source: data.source,
            at: event.ts,
          };
        }
        this.state.reason = "drone";
        this.transition("detection", type);
        break;
      case "ops.suspended":
        this.requirePhase("normal", "detection", "suspended");
        if (
          !["drone", "weather", "other"].includes(data.reason) ||
          !Number.isFinite(Date.parse(data.estimatedReopen))
        )
          throw new Error("Invalid suspension");
        this.state.reason = data.reason;
        this.state.estimatedReopen = data.estimatedReopen;
        if (this.state.phase === "normal") this.transition("detection", type);
        if (this.options.autoConfirm && this.state.phase === "detection")
          this.confirm();
        break;
      case "console.confirm_suspension":
        this.confirm();
        break;
      case "console.approve_messages":
        this.requirePhase("suspended", "recovery");
        if (!Array.isArray(data.roles) || !data.roles.every(isRole))
          throw new Error("roles[] required");
        await this.approve(data.roles);
        break;
      case "intercept.launched":
        this.requirePhase("detection", "suspended");
        if (!Number.isInteger(data.count) || data.count < 1 || data.count > 5)
          throw new Error("Invalid interceptor count");
        this.timeline(type, { count: data.count });
        break;
      case "intercept.captured":
        this.requirePhase("detection", "suspended");
        if (data.method !== "net") throw new Error("Invalid capture");
        this.timeline(type, { method: "net" });
        break;
      case "payload.suspicious":
        this.requirePhase("detection", "suspended");
        if (data.evacuate !== true || data.zone !== "T2")
          throw new Error("Invalid evacuation");
        this.state.evacuate = true;
        this.timeline(type, { zone: "T2" });
        if (this.state.confirmedAt) this.draft("evacuation");
        break;
      case "flight.diverted": {
        this.requirePhase("detection", "suspended");
        if (
          typeof data.flight !== "string" ||
          typeof data.from !== "string" ||
          typeof data.to !== "string" ||
          !Number.isFinite(Date.parse(data.eta))
        )
          throw new Error("Invalid diversion");
        let f = this.state.flights.find(
          (f) => f.flight === data.flight && f.dir === "arr",
        );
        if (!f) {
          f = {
            flight: data.flight,
            dir: "arr",
            city: data.from,
            iata: data.from,
            sched: data.eta,
            est: data.eta,
            status: "scheduled",
          };
          this.state.flights.push(f);
        }
        f.status = "diverted";
        f.divertedTo = data.to;
        f.est = data.eta;
        this.timeline(type, { flight: data.flight, to: data.to });
        if (this.state.confirmedAt) this.draft("diverted", data.flight);
        break;
      }
      case "console.request_roalert":
        this.requirePhase("suspended");
        if (!this.state.evacuate)
          throw new Error("RO-Alert draft requires evacuation");
        this.state.roalertDraft = roalertDraft(this.values().next!);
        this.timeline(type);
        break;
      case "ops.reopened":
        this.requirePhase("suspended", "recovery");
        this.timeline(type, { awaitingConsole: true });
        break;
      case "console.reopen":
        this.requirePhase("suspended", "recovery");
        if (this.state.phase === "suspended") this.recovery();
        else {
          if (this.state.waves.some((w) => !w.opened))
            throw new Error("Open all configured waves before final reopening");
          this.transition("normal", "console.reopen");
          this.state.reason = null;
          this.state.drone = null;
          this.state.roalertDraft = null;
          this.state.flights.forEach((f) => {
            if (f.status === "suspended") f.status = "scheduled";
          });
          const drafts = this.draft("reopened");
          await this.sendDrafts(drafts);
        }
        break;
      case "console.open_wave": {
        this.requirePhase("recovery");
        const wave = this.state.waves.find((w) => w.wave === data.wave);
        if (!wave || wave.opened)
          throw new Error("Unknown or already opened wave");
        if (this.state.waves.some((w) => w.wave < wave.wave && !w.opened))
          throw new Error("Open waves in order");
        wave.opened = true;
        this.timeline(type, { wave: wave.wave });
        this.options.emit?.("wave.green", {
          wave: wave.wave,
          window: wave.window,
          roles: wave.roles,
        });
        const extra = {
          wave: String(wave.wave),
          window: `${clock(wave.window.from)}–${clock(wave.window.to)}`,
        };
        const drafts = this.draft("reopen_wave", undefined, extra, wave.roles);
        await this.sendDrafts(drafts, wave.wave, extra);
        break;
      }
      case "agent.register": {
        if (!Array.isArray(data.agents) || data.agents.length > 10000)
          throw new Error("agents[] required (max 10000)");
        for (const a of data.agents)
          if (
            typeof a.agentId !== "string" ||
            a.agentId.length > 100 ||
            !isRole(a.role) ||
            !isChannel(a.channel)
          )
            throw new Error("Invalid agent");
        for (const a of data.agents)
          if (!this.agents.some((b) => b.agentId === a.agentId))
            this.agents.push({
              agentId: a.agentId,
              role: a.role,
              channel: a.channel,
              wave: this.waveForRole(a.role),
            });
        break;
      }
      case "agent.update": {
        if (typeof data.agentId !== "string" || !isRole(data.role) || !["home", "road", "terminal", "kerb"].includes(data.location) || (data.action !== undefined && typeof data.action !== "string")) throw new Error("Invalid agent update");
        const agent = this.agents.find(a => a.agentId === data.agentId);
        if (!agent) throw new Error("Unknown agent");
        agent.role = data.role; agent.location = data.location; agent.action = data.action;
        break;
      }
      case "metric.report":
        if (
          !["isuTimeToT2", "carsStartedInVain", "kerbPeak", "peopleInT2AtEvacuation", "minutesLost"].includes(
            data.name,
          ) ||
          !Number.isFinite(data.value) ||
          data.value < 0
        )
          throw new Error("Invalid metric");
        if (data.name === "carsStartedInVain") this.carMetricReported = true;
        (this.state.metrics as unknown as Record<string, number>)[data.name] =
          data.value;
        this.timeline(type, { name: data.name, value: data.value });
        break;
      case "console.reset": {
        this.generation++;
        this.state = this.fresh();
        this.receipts = [];
        this.firstNotified.clear();
        this.readRecipientKeys.clear();
        this.carAgents.clear();
        this.carMetricReported = false;
        this.agents = [];
        this.timeline(type);
        break;
      }
      default:
        throw new Error(`Unknown event: ${type}`);
    }
    this.changed();
  }
  private async approve(selected: Role[]) {
    // Only the newest situation per role is actionable (evacuation supersedes runway notices).
    const pending = this.state.drafts.filter(
      (d) => selected.includes(d.role) && !d.approved,
    );
    const latest = pending.filter(
      (d) =>
        !pending.some(
          (other) =>
            other.role === d.role &&
            other.lang === d.lang &&
            this.state.drafts.indexOf(other) > this.state.drafts.indexOf(d),
        ),
    );
    for (const d of pending) d.approved = true;
    await this.sendDrafts(latest);
  }
  private async sendDrafts(
    drafts: Draft[],
    wave?: number,
    extra: Record<string, string> = {},
  ) {
    this.expire();
    const generation = this.generation;
    for (const draft of drafts) {
      draft.approved = true;
      const matches = (role: Role, flight?: string) =>
        role === draft.role &&
        (!draft.flight ||
          !flight ||
          flightKey(draft.flight) === flightKey(flight));
      const people = this.subscriptions.filter(
        (s) =>
          matches(s.role, s.flight) &&
          s.lang === draft.lang &&
          (!wave || this.subscriptionWave(s) === wave),
      );
      const agents = this.agents.filter(
        (a) =>
          a.role === draft.role &&
          draft.lang === "ro" &&
          (!wave || a.wave === wave),
      );
      for (const sub of people) {
        if (generation !== this.generation) return;
        const receipt = this.newReceipt(draft, sub.id, false);
        const adapter = this.options.adapters?.[sub.channel];
        const m: Outbound = {
          messageId: draft.messageId,
          receiptId: receipt.id,
          role: sub.role,
          lang: sub.lang,
          destination: sub.destination,
          situation: draft.situation,
          values: this.templateValues({...sub, flight: sub.flight ?? draft.flight}, extra),
          lastInboundAt: sub.lastInboundAt,
          text: render(
            sub.role,
            draft.situation,
            sub.lang,
            this.values(sub.flight ?? draft.flight, extra),
          ),
        };
        let ok = false;
        try {
          const result = await adapter?.(m);
          ok = result?.delivered ?? false;
          receipt.simulated = result?.simulated ?? false;
          receipt.providerId = result?.providerId;
        } catch {
          console.warn(`Send failed: ${sub.channel} ${draft.role}`);
        }
        if (generation !== this.generation) return;
        if (ok) {
          receipt.delivered = true;
          this.state.counters[sub.role].delivered++;
          this.notified(receipt);
        }
        this.options.emit?.("alert.sent", {
          messageId: draft.messageId,
          role: sub.role,
          channel: sub.channel,
          recipients: 1,
          lang: sub.lang,
        });
        this.changed();
      }
      for (const agent of agents) {
        const receipt = this.newReceipt(draft, agent.agentId, true);
        receipt.delivered = true;
        this.state.counters[agent.role].delivered++;
        this.notified(receipt);
        const seed = `${this.options.seed ?? "control-tower"}:${agent.agentId}:${draft.situation}`;
        receipt.readAt =
          Date.now() + readLatency(seed, this.options.simSpeed ?? 60);
        receipt.willAct = seeded(seed + ":act") < 0.48;
        receipt.actAt = receipt.readAt + 30000 / (this.options.simSpeed ?? 60);
        agent.state = "notified";
        this.options.emit?.("agent.notified", {
          agentId: agent.agentId,
          state: "notified",
        });
        this.options.emit?.("alert.sent", {
          messageId: draft.messageId,
          role: agent.role,
          channel: agent.channel,
          recipients: 1,
          lang: "ro",
        });
      }
      if (
        draft.role === "taxi" &&
        draft.lang === "ro" &&
        this.options.taxiGroup
      ) {
        const destination = this.options.taxiGroup;
        const receipt = this.newReceipt(
          draft,
          `taxi-group:${destination}`,
          false,
        );
        try {
          const result = await this.options.adapters?.telegram?.({
            messageId: draft.messageId,
            receiptId: receipt.id,
            role: "taxi",
            lang: "ro",
            destination,
            text: render(
              "taxi",
              draft.situation,
              "ro",
              this.values(draft.flight, extra),
            ),
          });
          if (result?.delivered) {
            receipt.delivered = true;
            this.state.counters.taxi.delivered++;
            this.notified(receipt);
          }
        } catch {
          console.warn("Taxi group send failed");
        }
        this.options.emit?.("alert.sent", {
          messageId: draft.messageId,
          role: "taxi",
          channel: "telegram",
          recipients: 1,
          lang: "ro",
        });
      }
    }
    this.changed();
  }
  private subscriptionWave(s: Subscription) {
    return this.waveForRole(s.role);
  }
  private waveForRole(role: Role) {
    const group = waveRoles.findIndex((roles) => roles.includes(role));
    return Math.min(group + 1, this.options.waveCount ?? 3);
  }
  private rolesInWave(wave: number) {
    return roles.filter((role) => this.waveForRole(role) === wave);
  }
  private newReceipt(
    draft: Draft,
    recipient: string,
    simulated: boolean,
  ): Receipt {
    const r: Receipt = {
      id: randomUUID(),
      role: draft.role,
      recipient,
      messageId: draft.messageId,
      delivered: false,
      read: false,
      simulated,
      notifiedAt: iso(),
    };
    this.receipts.push(r);
    this.state.counters[draft.role].sent++;
    this.persist();
    return r;
  }
  private recipientKey(r: Receipt): string {
    const sub = this.subscriptions.find((s) => s.id === r.recipient);
    // Recipient endpoints, not inferred people across unrelated channels.
    return this.agents.some((a) => a.agentId === r.recipient)
      ? `agent:${r.recipient}`
      : sub?.destination
        ? `${sub.channel}:${sub.destination}`
        : r.recipient;
  }
  private notified(r: Receipt, at?: string) {
    r.deliveredAt = at && Date.parse(at) <= Date.now() ? at : iso();
    const elapsed =
      Date.parse(r.deliveredAt) - Date.parse(this.state.confirmedAt ?? "");
    if (r.delivered && elapsed >= 0 && elapsed <= 60000)
      this.firstNotified.add(this.recipientKey(r));
  }
  markRead(id: string, chat?: string) {
    const r = this.receipts.find((r) => r.id === id);
    if (!r || r.read || !r.delivered) return;
    if (
      chat &&
      !this.subscriptions.some(
        (s) => s.id === r.recipient && s.destination === chat,
      ) &&
      r.recipient !== `taxi-group:${chat}`
    )
      return;
    r.read = true;
    this.readRecipientKeys.add(this.recipientKey(r));
    this.state.counters[r.role].read++;
    this.state.metrics.readCount++;
    const agent = this.agents.find((a) => a.agentId === r.recipient);
    if (agent) {
      agent.state = "read";
      this.options.emit?.("agent.notified", {
        agentId: agent.agentId,
        state: "read",
      });
    }
    this.changed();
  }
  tick(now = Date.now()) {
    this.batchDepth++;
    try { this.tickReceipts(now); } finally { this.endBatch(); }
  }
  private tickReceipts(now: number) {
    for (const r of this.receipts) {
      if (r.simulated && r.readAt && r.readAt <= now && !r.read)
        this.markRead(r.id);
      if (r.simulated && r.read && r.actAt && r.actAt <= now && !r.acted) {
        r.acted = true;
        const agent = this.agents.find((a) => a.agentId === r.recipient);
        if (agent && r.willAct) {
          agent.state = "acting";
          this.options.emit?.("agent.notified", {
            agentId: agent.agentId,
            state: "acting",
          });
        }
        if (
          !this.carMetricReported &&
          agent &&
          !r.willAct &&
          ["passenger_home", "relative_arrivals", "taxi", "rideshare"].includes(
            agent.role,
          ) &&
          !this.carAgents.has(agent.agentId)
        ) {
          this.carAgents.add(agent.agentId);
          this.state.metrics.carsStartedInVain++;
        }
        this.changed();
      }
    }
  }
  snapshot() {
    this.expire();
    return {
      ...this.state,
      metrics: {
        ...this.state.metrics,
        isuTimeToT2:
          this.state.metrics.isuTimeToT2 ?? engineRuntime.metric(this.options.simAbFile),
      },
    };
  }
}
