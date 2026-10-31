import type { Adapter } from "./channels/types.js";
import { buttonAction,parseStartCode,parseWhatsAppWebhook } from "./channels/whatsapp.js";
import { fixtureSource,schedule,settlePast } from "./data/flights.js";
import { engineRuntime } from "./runtime.js";
import { SimStore,locations as simLocations,type LegacyLocation } from "./sim.js";
import type { Client,Flight } from "./types.js";
import {
isChannel,
isRole,
roles,
type Agent,
type Draft,
type Envelope,
type Receipt,
type Role,
type State,
type Subscription,
} from "./types.js";
const randomUUID = () => crypto.randomUUID();
/** The only events the camera service (client=vision) may send. */
const visionEvents = ["flow.report", "crowd.positions"];
/** metric.report names: legacy T2 metrics plus the D19 A/B names. */
export const metricNames = ["isuTimeToT2", "carsStartedInVain", "kerbPeak", "peopleInT2AtEvacuation", "minutesLost",
  "securityWaitMean", "securityWaitP90", "missedBoarding", "evacT90", "evacLastOut"];
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
  reset() {
    const cleared = { subscriptions: this.subscriptions.length, agents: this.agents.length,
      receipts: this.receipts.length, engineWhatsappIds: this.whatsappInboundIds.size, ...this.sim.reset() };
    this.generation++;
    this.state = this.fresh();
    this.subscriptions = []; this.agents = []; this.receipts = [];
    this.whatsappInboundIds.clear(); this.firstNotified.clear(); this.readRecipientKeys.clear();
    this.carAgents.clear(); this.carMetricReported = false;
    this.changed();
    return cleared;
  }
  persist() {
    if (this.batchDepth) { this.persistPending = true; return; }
    if (!this.options.file) return;
    const store: Store = {
      state: this.state,
      subscriptions: this.subscriptions,
      agents: this.agents,
      receipts: this.receipts,
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
  templateValues(sub: Pick<Subscription, "role" | "lang" | "flight">, extra: Record<string, string> = {}) {
    const normalize = (s: string) => s.replace(/\s/g, "").toUpperCase();
    const f = this.state.flights.find(f => normalize(f.flight) === normalize(sub.flight ?? "")) ?? (sub.flight ? undefined : this.state.flights.find(f => f.dir === (sub.role === "relative_arrivals" ? "arr" : "dep")));
    const en = sub.lang === "en";
    const unknown = en ? "not yet confirmed" : "încă neconfirmat";
    const labels: Record<Role, [string, string]> = {
      passenger_home: ["pasager", "passenger"], passenger_road: ["pasager pe drum", "passenger on the road"], passenger_terminal: ["pasager în terminal", "passenger in the terminal"], relative_arrivals: ["persoană care așteaptă o sosire", "someone meeting an arrival"], taxi: ["taximetrist", "taxi driver"], rideshare: ["șofer ride-hailing", "ride-hailing driver"], rent_a_car_ubt: ["operator rent-a-car/UBT", "rental/UBT operator"], staff: ["personal aeroportuar", "airport staff"], isu_smurd: ["echipaj ISU/SMURD", "emergency crew"], alt_airport: ["aeroport alternativ", "alternate airport"], public: ["vizitator", "visitor"],
    };
    return { ora: clock(this.state.since), rol: `${labels[sub.role][en ? 1 : 0]}${sub.flight ? ` (${sub.flight})` : ""}` };
  }
  async confirmSubscription(sub: Subscription) {
    if (sub.channel !== "whatsapp") return;
    const draft: Draft = { messageId: randomUUID(), role: sub.role, lang: sub.lang, situation: "subscribe", text: "Clarion", approved: true };
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
  async handle(event: Envelope, client: Client = "console"): Promise<void> {
    return this.batch(() => this.handleEvent(event, client));
  }
  private async handleEvent(
    event: Envelope,
    client: Client = "console",
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
      (type.startsWith("console.") ? client !== "console"
        : client === "vision" ? !visionEvents.includes(type) : client !== "twin")
    )
      throw new Error("Client cannot issue this event");
    switch (type) {
      case 'console.alert.command':
        this.sim.alertCommand(data);
        this.changed();
        return;
      case "sim.status":
        this.sim.status(data);
        return;
      // Camera telemetry: from vision (contract v2), still accepted from a legacy Unity build.
      case "flow.report":
        this.sim.flow(data, client === "vision" ? "vision" : "twin");
        return;
      // D0: Unity's truth, kept apart for the accuracy panel and A/B only.
      case "truth.report":
        this.sim.truth(data);
        return;
      // Contract v2 telemetry: in memory only, read through GET /api/sim.
      case "flight.update":
        this.sim.flights(data);
        return;
      case "crowd.positions":
        this.sim.positions(data, client === "vision" ? "vision" : "twin");
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
          !metricNames.includes(
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
  updateStaffReports(rows: import('./alerts.js').StaffReport[]) {
    this.sim.reports(rows);
    this.changed();
  }
  snapshot() {
    this.expire();
    return {
      ...this.state,
      alerts: this.sim.alertSnapshot(),
      metrics: {
        ...this.state.metrics,
        isuTimeToT2:
          this.state.metrics.isuTimeToT2,
      },
    };
  }
}
