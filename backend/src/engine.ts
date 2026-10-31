import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import {
  roles,
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
import { render } from "./messages.js";
import { fixtureSource, schedule } from "./data/flights.js";
import { roalertDraft } from "./channels/roalert.js";
import type { Adapter, Outbound } from "./channels/types.js";
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
  carAgents: string[];
  carMetricReported?: boolean;
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
}
export class Engine {
  state: State;
  subscriptions: Subscription[] = [];
  agents: Agent[] = [];
  receipts: Receipt[] = [];
  telegramOffset = 0;
  private firstNotified = new Set<string>();
  private carAgents = new Set<string>();
  private generation = 0;
  private carMetricReported = false;
  constructor(private options: Options = {}) {
    this.state = this.fresh();
    if (options.file && existsSync(options.file)) {
      const saved = JSON.parse(readFileSync(options.file, "utf8")) as Store;
      if (
        !saved.state ||
        !Array.isArray(saved.subscriptions) ||
        !Array.isArray(saved.receipts)
      )
        throw new Error(
          "Invalid persisted state; refusing to discard subscribers",
        );
      this.state = saved.state;
      this.subscriptions = saved.subscriptions;
      this.agents = saved.agents;
      this.receipts = saved.receipts;
      this.telegramOffset = saved.telegramOffset ?? 0;
      this.firstNotified = new Set(saved.firstNotified);
      this.carAgents = new Set(saved.carAgents);
      this.carMetricReported = saved.carMetricReported ?? false;
    }
    this.expire();
  }
  private fresh(): State {
    return {
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
        carsStartedInVain: 0,
        isuTimeToT2: null,
        kerbPeak: null,
      },
      dataSource: fixtureSource,
    };
  }
  persist() {
    if (!this.options.file) return;
    mkdirSync(dirname(this.options.file), { recursive: true });
    const store: Store = {
      state: this.state,
      subscriptions: this.subscriptions,
      agents: this.agents,
      receipts: this.receipts,
      telegramOffset: this.telegramOffset,
      firstNotified: [...this.firstNotified],
      carAgents: [...this.carAgents],
      carMetricReported: this.carMetricReported,
    };
    writeFileSync(this.options.file + ".tmp", JSON.stringify(store, null, 2), {
      mode: 0o600,
    });
    renameSync(this.options.file + ".tmp", this.options.file);
  }
  private changed() {
    this.recount();
    this.persist();
    this.options.emit?.("state", this.state);
  }
  private recount() {
    for (const role of roles)
      this.state.counters[role].subscribers =
        this.subscriptions.filter((s) => s.role === role).length +
        this.agents.filter((a) => a.role === role).length;
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
    const [role, rawFlight, subscriptionId] = payload.split("__");
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
  ): Draft[] {
    const created = roles.flatMap((role) =>
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
      roles: [...roles],
      opened: false,
    }));
  }
  async handle(
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
      case "drone.detected":
        this.requirePhase("normal");
        if (
          !["09", "27"].includes(data.nearRunway) ||
          !["radar", "report"].includes(data.source) ||
          !Number.isFinite(data.distanceM) ||
          !Number.isFinite(data.bearingDeg)
        )
          throw new Error("Invalid detection");
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
        const drafts = this.draft("reopen_wave", undefined, extra);
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
              wave:
                1 +
                Math.floor(seeded(a.agentId) * (this.options.waveCount ?? 3)),
            });
        break;
      }
      case "metric.report":
        if (
          !["isuTimeToT2", "carsStartedInVain", "kerbPeak"].includes(
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
    return 1 + Math.floor(seeded(s.id) * (this.options.waveCount ?? 3));
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
  private notified(r: Receipt) {
    const sub = this.subscriptions.find((s) => s.id === r.recipient);
    const recipientKey = r.simulated
      ? `agent:${r.recipient}`
      : sub?.destination
        ? `${sub.channel}:${sub.destination}`
        : r.recipient;
    if (
      this.state.confirmedAt &&
      Date.now() - Date.parse(this.state.confirmedAt) <= 60000 &&
      !this.firstNotified.has(recipientKey)
    ) {
      this.firstNotified.add(recipientKey);
      this.state.metrics.notifiedFirstMinute++;
    }
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
    return this.state;
  }
}
