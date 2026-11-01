import { Auth } from '../../../backend/src/auth.js';
import { route } from '../../../backend/src/routing.js';
import { terminalGraph } from '../../../backend/src/terminal.js';
import { isNodeId, mapNodeId } from '../../../backend/src/mapIds.js';
import { urgentBubbles } from './urgency.js';
import { toBubbles } from './agent.js';
import { clearPrefix } from '../reset-store.js';
import { copy, say, language, localSource, nodeName, type Lang } from './texts.js';
// Outbound passenger messages (SPEC-v2 D10, D14, D15, D17): one fan-out for real phones (WhatsApp) and simulated
// subscribers (Unity agents with a virtual phone, agent.message over the twin WebSocket).
// Storage: wa:subs -> phones with a flight or the staff role   sim:subs -> { [agentId]: SimSubscriber }
//          msg:flights -> { [flightKey]: "status:delayMin" } last change already announced (dedupe)
import { clockText, closeAt, findFlight, flightKey, gateName, type Flight } from './flights.js';
import { arrivalPlan, situationText, ownZones, type AirportView, type Profile } from './tools.js';
export { nodeName } from './tools.js';
import type { PassengerData } from '../../../app/src/me/types.js';
import { masked, type WhatsAppClient } from './transport.js';
import type { WaStore } from './index.js';
import type { OpsCommand } from '../../../backend/src/sim.js';

export const WINDOW_MS = 86400000;
export const NON_URGENT_MS = 15 * 60 * 1000;
/** How long an evacuate waits for vision's evac.plan before the generic message goes out. */
export const EVAC_WAIT_MS = 3000;
/** Added to evac.plan's clearSec for the sweep before an area reopens: the "how long to wait" told to people on the road. */
export const REOPEN_MARGIN_MIN = 20;
export type NotifyKind = 'arrive' | 'flight' | 'route' | 'evacuate' | 'admin';
export interface SimSubscriber { lang?: Lang; agentId: string; role: string; flight: string; pageToken?: string; hasCheckedBag?: boolean }
export type Subscriber = { channel: 'whatsapp'; phone: string } | ({ channel: 'sim' } & SimSubscriber);
export type Delivery = 'sent' | 'outside_window' | 'offline' | 'failed' | 'rate_limited';
const SIM_MAX = 5000;

// ---- agent.register for simulated subscribers (D17).
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
const isSim = (a: any) => a && typeof a === 'object' && a.channel === 'sim';
/**
 * Splits an agent.register payload: `{ agentId, role, channel: "sim", flight }` (one) or entries with channel "sim"
 * inside `agents[]` are simulated subscribers; everything else stays for the engine (legacy shape, unchanged).
 * Throws on an invalid sim entry. rest is null when nothing is left for the engine.
 */
export function splitRegister(data: any): { sims: SimSubscriber[]; rest: any | null } {
  const single = data && typeof data === 'object' && !Array.isArray(data.agents) && isSim(data);
  const entries: any[] = single ? [data] : Array.isArray(data?.agents) ? data.agents.filter(isSim) : [];
  const sims = entries.map(a => {
    if (!text(a.agentId, 100) || !text(a.role, 40) || !text(a.flight, 20) || (a.lang !== undefined && a.lang !== 'ro' && a.lang !== 'en')) throw new Error('Invalid sim agent');
    return { agentId: a.agentId, role: a.role, flight: a.flight, ...(a.lang !== undefined && { lang: a.lang }) };
  });
  if (single) return { sims, rest: null };
  if (!Array.isArray(data?.agents)) return { sims, rest: data };
  if (!sims.length) return { sims, rest: data };
  const others = data.agents.filter((a: any) => !isSim(a));
  return { sims, rest: others.length ? { ...data, agents: others } : null };
}

// ---- evac.plan from vision (A9, A10).
export interface EvacRoute { from: string; exit: string; nodes: string[] }
export interface EvacPlan { id: string; blocked: string[]; clearSec: number; exits: { exit: string; people: number; clearSec: number }[]; routes: EvacRoute[] }
const node = isNodeId;
const secs = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
export function evacPlan(d: any): EvacPlan {
  const ok = d && typeof d === 'object' && text(d.id, 100) && Array.isArray(d.blocked) && d.blocked.length <= 50 && d.blocked.every(node) && secs(d.clearSec) &&
    Array.isArray(d.exits) && d.exits.length <= 50 && d.exits.every((e: any) => e && node(e.exit) && Number.isSafeInteger(e.people) && e.people >= 0 && secs(e.clearSec)) &&
    Array.isArray(d.routes) && d.routes.length >= 1 && d.routes.length <= 500 &&
    d.routes.every((r: any) => r && node(r.from) && node(r.exit) && Array.isArray(r.nodes) && r.nodes.length >= 1 && r.nodes.length <= 200 && r.nodes.every(node));
  if (!ok) throw new Error('Invalid evac plan');
  return {
    id: d.id, blocked: [...d.blocked], clearSec: d.clearSec,
    exits: d.exits.map((e: any) => ({ exit: e.exit, people: e.people, clearSec: e.clearSec })),
    routes: d.routes.map((r: any) => ({ from: r.from, exit: r.exit, nodes: [...r.nodes] })),
  };
}

/**
 * D9: where the person probably is, from the clock against the flight only (no truth, no GPS).
 * gate in the last 15 min before the gate closes, airside in the 45 before that, public otherwise.
 */
export function estimateStage(f: Flight | undefined, now: number): 'public' | 'airside' | 'gate' | null {
  if (!f || f.status === 'cancelled' || f.status === 'departed') return null;
  const left = closeAt(f) - now;
  return left <= 15 * 60 ? 'gate' : left <= 60 * 60 ? 'airside' : 'public';
}
/** A representative node per stage, then the route that leaves from it; else the first route (vision's best exit). */
export function routeFor(plan: EvacPlan, f: Flight | undefined, now: number): EvacRoute {
  const stage = estimateStage(f, now);
  const candidates = stage === 'gate' ? [f?.gate, 'airside'] : stage === 'airside' ? ['airside', 'security'] : stage === 'public' ? [f?.checkIn, f?.checkIn?.replace('check_in:', 'bag_drop:'), 'G_CHECKIN_QUEUE', 'entrance', 'security'] : [];
  for (const c of candidates) { const r = c && (plan.routes.find(x => x.from === c) ?? plan.routes.find(x => mapNodeId(x.from) === mapNodeId(c))); if (r) return r; }
  return plan.routes[0]!;
}

/** D9: estimated current zone plus remaining normal journey, never agent.batch/truth. */
export function affectedByEvacuation(blocked: readonly string[], f: Flight | undefined, now: number): boolean {
  if (!blocked.length) return true;
  const stage = estimateStage(f, now);
  if (!stage || !f) return false;
  const start = stage === 'gate' ? f.gate : stage === 'airside' ? 'airside' : f.checkIn ?? 'entrance';
  const stops = stage === 'public' ? [start, 'security', f.gate] : [start, f.gate];
  const nodes = [...stops];
  for (let i = 1; i < stops.length; i++) nodes.push(...(route(terminalGraph, stops[i - 1]!, stops[i]!)?.nodes ?? []));
  const closed = new Set(blocked.map(mapNodeId));
  return nodes.some(id => closed.has(mapNodeId(id)));
}

export interface MessagingDeps {
  store: WaStore; wa: WhatsAppClient; view: AirportView;
  /** Backend -> Unity on the twin socket; false when Unity is offline. */
  toUnity: (type: string, data: unknown) => boolean;
  appUrl?: string;
  evacWaitMs?: number;
  now?: () => number;
}

export class Messaging {
  private chain: Promise<unknown> = Promise.resolve();
  private planned = new Set<string>();
  private epoch = 0;
  private timers = new Map<ReturnType<typeof setTimeout>, () => void>();
  cancelPending() {
    this.epoch++;
    const timers = this.timers.size;
    for (const [timer, resolve] of this.timers) { clearTimeout(timer); resolve(); }
    this.timers.clear();
    return timers;
  }
  async reset() {
    this.cancelPending();
    await this.chain;
    await this.deliveryChain;
    await this.pageChain;
    this.planned.clear();
    const whatsappSubscribers = (await this.deps.store.get<string[]>('wa:subs') ?? []).length;
    const simSubscribers = Object.keys(await this.sims()).length;
    const evacuation = Number(Boolean(await this.deps.store.get('msg:evacuation')));
    const pageTokens = await clearPrefix(this.deps.store, 'page:');
    const alerts = await clearPrefix(this.deps.store, 'msg:alerts:');
    await this.deps.store.delete('wa:subs');
    await this.deps.store.delete('sim:subs');
    await clearPrefix(this.deps.store, 'msg:');
    return { whatsappSubscribers, simSubscribers, pageTokens, alerts, evacuation };
  }
  constructor(private deps: MessagingDeps) {}

  private pageChain: Promise<unknown> = Promise.resolve();
  private pageSerial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.pageChain.then(work);
    this.pageChain = next.catch(() => {});
    return next;
  }
  private identity(sub: Subscriber) {
    return sub.channel === 'sim' ? `sim:${sub.agentId}` : `wa:${sub.phone}`;
  }
  private async subscriberProfile(sub: Subscriber): Promise<Profile | SimSubscriber | undefined> {
    return sub.channel === 'sim' ? (await this.sims())[sub.agentId]
      : this.deps.store.get<Profile>(`wa:profile:${sub.phone}`);
  }
  /** Random bearer token, separate from the boarding-pass token; always rehydrate the stored profile. */
  pageLink(sub: Subscriber): Promise<string> {
    return this.pageSerial(async () => {
      const p = await this.subscriberProfile(sub);
      if (!p) throw new Error('Unknown subscriber');
      if (!p.pageToken) {
        p.pageToken = crypto.randomUUID();
        if (sub.channel === 'sim') {
          const sims = await this.sims(); sims[sub.agentId] = p as SimSubscriber;
          await this.deps.store.put('sim:subs', sims);
        } else await this.deps.store.put(`wa:profile:${sub.phone}`, p);
        await this.deps.store.put(`page:${p.pageToken}`, sub);
      }
      return `${(this.deps.appUrl ?? 'https://clarion-craiova.pages.dev').replace(/\/$/, '')}/m/${p.pageToken}`;
    });
  }
  async passenger(token: string): Promise<PassengerData | undefined> {
    if (!token || token.length > 100) return;
    const sub = await this.deps.store.get<Subscriber>(`page:${token}`);
    if (!sub) return;
    const p = await this.subscriberProfile(sub);
    if (!p || p.pageToken !== token || !p.flight) return;
    const f = findFlight(this.deps.view.flights(), p.flight);
    if (!f) return;
    const clock = this.deps.view.clock();
    // Unknown bag choice uses the same conservative assumption as WhatsApp.
    const plan = arrivalPlan(f, this.deps.view.flow(), clock, p.hasCheckedBag, this.deps.view.blocked?.(), this.deps.view.history);
    return {
      lang: language(p.lang),
      simTime: clock.sim ? clock.now : null,
      flight: { flight: f.flight, destination: f.destination, std: clockText(f.std), gate: f.gate,
        gateCloseAt: clockText(closeAt(f)), status: f.status, delayMin: f.delayMin },
      arriveBy: plan.beAtEntranceAt,
      queues: plan.queues.map(q => ({ ...q, label: nodeName(q.zone, p.lang), source: localSource(q.source, p.lang) })), entranceToGateMin: plan.totalMin,
      steps: plan.steps.filter(s => s.zone !== 'margin').map(s => ({ zone: s.zone, label: s.zone === 'walk' ? say(p.lang, 'walk', gateName(f.gate)) : nodeName(s.zone, p.lang), waitMin: s.min })),
      alerts: (await this.deps.store.get<PassengerData['alerts']>(`msg:alerts:${this.identity(sub)}`) ?? []).slice(-5),
      evacuation: await this.evacuationFor({ sub, hasCheckedBag: p.hasCheckedBag }, f, p.lang),
    };
  }
  /** D33: during an evacuation the page shows the exit route for his estimated place, or that he should not come yet. */
  private async evacuationFor(s: { sub: Subscriber; hasCheckedBag?: boolean }, f: Flight, lang?: Lang): Promise<PassengerData['evacuation']> {
    const state = await this.deps.store.get<{ active: boolean; zones: string[]; reopenInMin?: number | null }>('msg:evacuation');
    if (!state?.active) return { active: false, zones: [] };
    const now = this.deps.view.clock().now;
    const plan = await this.deps.store.get<EvacPlan>('msg:evacPlan');
    const r = plan?.routes.length ? routeFor(plan, f, now) : null;
    return { active: true, zones: state.zones, ...(r && { route: { exit: nodeName(r.exit, lang), steps: r.nodes.map(n => nodeName(n, lang)) } }),
      ...(this.onTheRoad(s, f, now) && { stayAway: { reopenInMin: state.reopenInMin ?? null } }) };
  }
  /**
   * Pitch, D9: a WhatsApp passenger whose A6 entrance time is still ahead may still be on the road (clock only, no GPS),
   * so he gets the route and also how long to stay away. Simulated subscribers are walking in Unity's terminal.
   */
  private onTheRoad(s: { sub: Subscriber; hasCheckedBag?: boolean }, f: Flight | undefined, now: number) {
    if (s.sub.channel !== 'whatsapp' || !f || estimateStage(f, now) !== 'public') return false;
    return now < closeAt(f) - arrivalPlan(f, this.deps.view.flow(), this.deps.view.clock(), s.hasCheckedBag, this.deps.view.blocked?.(), this.deps.view.history).totalMin * 60;
  }
  private async evacuated(subs: Subscriber[]) {
    const ids = await this.deps.store.get<string[]>('msg:evacuated') ?? [];
    await this.deps.store.put('msg:evacuated', [...new Set([...ids, ...subs.map(s => this.identity(s))])]);
  }
  /** One-time site login, separate from the reusable personal map token. */
  connectLink(phone: string) {
    return new Auth(this.deps.store).createLink(phone.startsWith('+') ? phone : `+${phone}`, this.deps.appUrl ?? 'https://clarion-craiova.pages.dev');
  }
  async arrive(sub: Subscriber, f: Flight, hasCheckedBag?: boolean) {
    const map = await this.pageLink(sub);
    const link = sub.channel === 'whatsapp' && /^\+?\d{8,15}$/.test(sub.phone)
      ? `${map}\nConectare: ${await this.connectLink(sub.phone)}` : map;
    return this.notify(sub, { kind: 'arrive', text: `${this.arriveText(f, hasCheckedBag, (await this.subscriberProfile(sub))?.lang)}\n${link}`, estimate: this.estimate(f, hasCheckedBag) });
  }

  /** Serialises fan-outs so two quick flight.updates cannot both announce one change. */
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.chain.then(work);
    this.chain = next.catch(e => console.error(JSON.stringify({ msg: 'fanout-failed', error: String((e as Error)?.message ?? e).slice(0, 200) })));
    return next;
  }

  /** The one way out for a passenger message: WhatsApp inside the 24h window, or agent.message to Unity. */
  private deliveryChain: Promise<unknown> = Promise.resolve();
  notify(sub: Subscriber, m: { kind: NotifyKind; text: string; estimate?: { flight: string; totalMin: number } }): Promise<Delivery> {
    const next = this.deliveryChain.then(() => this.deliver(sub, m));
    this.deliveryChain = next.catch(() => {});
    return next;
  }
  private async deliver(sub: Subscriber, { estimate, ...m }: { kind: NotifyKind; text: string; estimate?: { flight: string; totalMin: number } }): Promise<Delivery> {
    if (m.kind === 'flight' || m.kind === 'evacuate') m.text = urgentBubbles(toBubbles(m.text)).join('\n');
    const now = this.deps.now?.() ?? Date.now();
    const nonUrgent = m.kind !== 'flight' && m.kind !== 'evacuate';
    const lastKey = `msg:last:${this.identity(sub)}`;
    const last = await this.deps.store.get<number>(lastKey);
    if (nonUrgent && last !== undefined && now - last < NON_URGENT_MS) return 'rate_limited';
    let delivery: Delivery;
    if (sub.channel === 'sim') {
      delivery = this.deps.toUnity('agent.message', { agentId: sub.agentId, text: m.text, kind: m.kind }) ? 'sent' : 'offline';
    } else {
      const last = await this.deps.store.get<number>(`wa:last:${sub.phone}`);
      if (typeof last !== 'number' || (this.deps.now?.() ?? Date.now()) - last >= WINDOW_MS) {
        console.log(JSON.stringify({ msg: 'skipped', reason: 'outside_window', kind: m.kind, to: masked(sub.phone) }));
        return 'outside_window';
      }
      delivery = (await this.deps.wa.sendText(sub.phone, m.text)).ok ? 'sent' : 'failed';
    }
    if (delivery === 'sent') await this.pageSerial(async () => {
      if (nonUrgent) await this.deps.store.put(lastKey, now);
      if (estimate) {
        await this.deps.store.put(`msg:estimate:${this.identity(sub)}`, estimate);
        if (sub.channel === 'whatsapp') {
          const profileKey = `wa:profile:${sub.phone}`;
          const p = await this.deps.store.get<Profile>(profileKey);
          if (p) await this.deps.store.put(profileKey, { ...p, lastWaitEstimate: { at: clockText(this.deps.view.clock().now), totalMin: estimate.totalMin } });
        }
      }
      if (m.kind === 'flight' || m.kind === 'evacuate') {
        const urgentKey = `msg:urgent:${this.identity(sub)}`;
        const received = await this.deps.store.get<{ at: string; kind: string; text: string }[]>(urgentKey) ?? [];
        await this.deps.store.put(urgentKey, [...received, { at: new Date(now).toISOString(), ...m }].slice(-8));
      }
      const key = `msg:alerts:${this.identity(sub)}`;
      const alerts = await this.deps.store.get<PassengerData['alerts']>(key) ?? [];
      await this.deps.store.put(key, [...alerts, { at: new Date(this.deps.now?.() ?? Date.now()).toISOString(), ...m }].slice(-5));
    });
    return delivery;
  }

  // ---- Subscribers.
  async addPhone(phone: string) {
    const list = (await this.deps.store.get<string[]>('wa:subs')) ?? [];
    if (!list.includes(phone)) await this.deps.store.put('wa:subs', [...list, phone]);
  }
  async removePhone(phone: string) {
    const list = (await this.deps.store.get<string[]>('wa:subs')) ?? [];
    if (list.includes(phone)) await this.deps.store.put('wa:subs', list.filter(p => p !== phone));
    for (const kind of ['alerts', 'urgent', 'last', 'estimate']) await this.deps.store.delete(`msg:${kind}:wa:${phone}`);
  }
  private async sims() { return (await this.deps.store.get<Record<string, SimSubscriber>>('sim:subs')) ?? {}; }
  /** Everyone, with the flight each one is bound to (undefined for staff without one). */
  async subscribers(): Promise<{ sub: Subscriber; flight?: string; hasCheckedBag?: boolean; lang?: Lang }[]> {
    const out: { sub: Subscriber; flight?: string; hasCheckedBag?: boolean; lang?: Lang }[] = [];
    for (const phone of (await this.deps.store.get<string[]>('wa:subs')) ?? []) {
      const p = await this.deps.store.get<Profile>(`wa:profile:${phone}`);
      if (p) out.push({ sub: { channel: 'whatsapp', phone }, flight: p.flight, hasCheckedBag: p.hasCheckedBag, lang: p.lang });
    }
    for (const s of Object.values(await this.sims())) out.push({ sub: { channel: 'sim', ...s }, flight: s.flight, hasCheckedBag: s.hasCheckedBag, lang: s.lang });
    return out;
  }

  private estimate(f: Flight, hasCheckedBag?: boolean) {
    return { flight: flightKey(f.flight), totalMin: arrivalPlan(f, this.deps.view.flow(), this.deps.view.clock(), hasCheckedBag, this.deps.view.blocked?.(), this.deps.view.history).totalMin };
  }

  /** D22: compare with the last successfully delivered estimate, never with the previous report. */
  flowChanged() {
    return this.serial(async () => {
      const flights = new Map(this.deps.view.flights().map(f => [flightKey(f.flight), f]));
      let sent = 0;
      for (const s of await this.subscribers()) {
        const f = s.flight && flights.get(flightKey(s.flight));
        if (!f || f.status === 'cancelled' || f.status === 'departed') continue;
        const previous = await this.deps.store.get<{ flight: string; totalMin: number }>(`msg:estimate:${this.identity(s.sub)}`);
        const next = this.estimate(f, s.hasCheckedBag);
        if (!previous || previous.flight !== next.flight || Math.abs(next.totalMin - previous.totalMin) >= 10) {
          if (await this.arrive(s.sub, f, s.hasCheckedBag) === 'sent') sent++;
        }
      }
      return sent;
    });
  }

  /** The current situation and forecast for one passenger. */
  arriveText(f: Flight, hasCheckedBag?: boolean, lang?: Lang) {
    if (f.status === 'cancelled') return copy.cancelledFlight(lang, f);
    if (f.status === 'departed') return copy.departedFlight(lang, f);
    return copy.flightSituation(lang, f, situationText(arrivalPlan(f, this.deps.view.flow(), this.deps.view.clock(), hasCheckedBag, this.deps.view.blocked?.(), this.deps.view.history), lang));
  }

  /** D17: Unity's agents with a virtual phone. Each new one gets the arrive message, like a phone after START. */
  registerSims(list: SimSubscriber[]) {
    return this.serial(async () => {
      const subs = await this.sims();
      const fresh = list.filter(s => !subs[s.agentId] || subs[s.agentId]!.flight !== s.flight);
      for (const s of list) subs[s.agentId] = { ...subs[s.agentId], ...s, lang: language(s.lang) };
      if (Object.keys(subs).length > SIM_MAX) throw new Error(`Sim subscribers exceed ${SIM_MAX}`);
      await this.deps.store.put('sim:subs', subs);
      const flights = this.deps.view.flights();
      for (const s of fresh) {
        const f = findFlight(flights, s.flight);
        if (f) await this.arrive({ channel: 'sim', ...s }, f, s.hasCheckedBag);
      }
      return fresh.length;
    });
  }

  /** Flight changes bypass the non-urgent limit. */
  flightText(f: Flight, hasCheckedBag?: boolean, lang?: Lang) {
    if (f.status === 'cancelled' || f.status === 'departed') return this.arriveText(f, hasCheckedBag, lang);
    const change = f.delayMin > 0
      ? copy.delayedDeparture(lang, f)
      : copy.scheduledDeparture(lang, f);
    return copy.flightChange(lang, f, change, situationText(arrivalPlan(f, this.deps.view.flow(), this.deps.view.clock(), hasCheckedBag, this.deps.view.blocked?.(), this.deps.view.history), lang));
  }

  /**
   * D14, D18 beat 3: after a flight.update, announce each flight whose status became delayed/cancelled or whose delay
   * changed, once per change, to all its subscribers (real + sim). Returns the flights announced.
   */
  flightsChanged() {
    return this.serial(async () => {
      if (this.deps.view.provisional()) return [];
      const seen = (await this.deps.store.get<Record<string, string>>('msg:flights')) ?? {};
      const changed: Flight[] = [];
      for (const f of this.deps.view.flights()) {
        const key = flightKey(f.flight), sig = `${f.status}:${f.delayMin}`;
        const [prevStatus = 'scheduled', prevDelay = '0'] = (seen[key] ?? '').split(':').filter(Boolean);
        seen[key] = sig;
        if (prevStatus === f.status && Number(prevDelay) === f.delayMin) continue;
        if (f.status === 'cancelled' || (f.status === 'delayed' && prevStatus !== 'delayed') || Number(prevDelay) !== f.delayMin) changed.push(f);
      }
      await this.deps.store.put('msg:flights', seen);
      if (!changed.length) return [];
      const subs = await this.subscribers();
      for (const f of changed) {
        let sent = 0;
        for (const s of subs.filter(s => s.flight && flightKey(s.flight) === flightKey(f.flight)))
          if (await this.notify(s.sub, { kind: 'flight', text: this.flightText(f, s.hasCheckedBag, s.lang), estimate: this.estimate(f, s.hasCheckedBag) }) === 'sent') sent++;
        console.log(JSON.stringify({ msg: 'flight-change', flight: f.flight, status: f.status, delayMin: f.delayMin, sent }));
      }
      return changed.map(f => f.flight);
    });
  }

  /** D22: describe an admin decision only to passengers whose queues/gate it affects. */
  adminChanged(command: OpsCommand) {
    return this.serial(async () => {
      if (command.type === 'staff' || command.type === 'evacuate') return 0;
      if (command.type === 'open' && (await this.deps.store.get<{ active: boolean }>('msg:evacuation'))?.active) {
        const left = this.deps.view.blocked?.() ?? [];
        if (!left.length) return this.allClear();
        const state = await this.deps.store.get<{ active: boolean; zones: string[] }>('msg:evacuation');
        await this.deps.store.put('msg:evacuation', { ...state, zones: state!.zones.filter(z => left.includes(z)) });
      }
      const zone = command.type === 'redirect' ? command.from : command.zone;
      let sent = 0;
      for (const s of await this.subscribers()) {
        const f = s.flight ? findFlight(this.deps.view.flights(), s.flight) : undefined;
        if (!f || !['security', f.gate, ...ownZones(f)].includes(zone)) continue;
        const decision = command.type === 'redirect'
          ? copy.redirect(s.lang, command)
          : copy.areaState(s.lang, zone, command);
        if (await this.notify(s.sub, { kind: 'admin', text: `${decision} ${this.arriveText(f, s.hasCheckedBag, s.lang)}`,
          estimate: this.estimate(f, s.hasCheckedBag) }) === 'sent') sent++;
      }
      return sent;
    });
  }

  /** Pitch: open on the last blocked zone is the all clear. Everyone told to leave or stay away hears that it reopened, with the situation now. */
  private async allClear() {
    const told = new Set(await this.deps.store.get<string[]>('msg:evacuated') ?? []);
    for (const key of ['msg:evacuation', 'msg:evacPlan', 'msg:evacuated']) await this.deps.store.delete(key);
    const flights = this.deps.view.flights();
    let sent = 0;
    for (const s of await this.subscribers()) {
      if (!told.has(this.identity(s.sub))) continue;
      const f = s.flight ? findFlight(flights, s.flight) : undefined;
      const text = f ? `${say(s.lang, 'allClear')} ${this.arriveText(f, s.hasCheckedBag, s.lang)}` : say(s.lang, 'allClear');
      if (await this.notify(s.sub, { kind: 'evacuate', text, ...(f && { estimate: this.estimate(f, s.hasCheckedBag) }) }) === 'sent') sent++;
    }
    console.log(JSON.stringify({ msg: 'all-clear', told: told.size, sent }));
    return sent;
  }
  /** Generic evacuation text, sent when vision's evac.plan does not arrive in time. */
  evacuateText(zones: string[], lang?: Lang) {
    return copy.evacuation(lang, zones);
  }
  /**
   * D10, D18 beat 4: an evacuate ops.command. Waits up to evacWaitMs for vision's evac.plan (routes per node);
   * without it, everyone gets the generic message. Returns what went out.
   */
  async evacuate(zones: string[], id: string): Promise<'planned' | 'generic' | 'cancelled'> {
    const epoch = this.epoch;
    await this.deps.store.put('msg:evacuation', { active: true, zones });
    if (epoch !== this.epoch) return 'cancelled';
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => { this.timers.delete(timer); resolve(); }, this.deps.evacWaitMs ?? EVAC_WAIT_MS);
      this.timers.set(timer, resolve);
    });
    if (epoch !== this.epoch) return 'cancelled';
    if (this.planned.has(id)) return 'planned';
    await this.serial(async () => {
      // D31: like the plan, only those estimated in or passing through the blocked zones.
      const flights = this.deps.view.flights(), now = this.deps.view.clock().now, told: Subscriber[] = [];
      for (const s of await this.subscribers()) {
        const f = s.flight ? findFlight(flights, s.flight) : undefined;
        if (!affectedByEvacuation(zones, f, now)) continue;
        const text = this.evacuateText(zones, s.lang) + (this.onTheRoad(s, f, now) ? ` ${copy.evacuationRoad(s.lang, null)}` : '');
        if (await this.notify(s.sub, { kind: 'evacuate', text }) === 'sent') told.push(s.sub);
      }
      await this.evacuated(told);
    });
    return 'generic';
  }
  /** routeTo('exit') during an evacuation: the latest plan's route for this flight's estimated stage; null once nothing is blocked. */
  async evacRouteFor(f: Flight | undefined): Promise<EvacRoute | null> {
    if (!(this.deps.view.blocked?.() ?? []).length) return null;
    const p = await this.deps.store.get<EvacPlan>('msg:evacPlan');
    return p?.routes.length ? routeFor(p, f, this.deps.view.clock().now) : null;
  }
  /** evac.plan: each subscriber gets the route for the node it is estimated to be at; sim agents also walk it (agent.route). */
  plan(p: EvacPlan) {
    this.planned.add(p.id);
    return this.serial(async () => {
      const reopenInMin = Math.ceil(p.clearSec / 60) + REOPEN_MARGIN_MIN;
      await this.deps.store.put('msg:evacuation', { active: true, zones: p.blocked, reopenInMin });
      // Kept for routeTo('exit') while the zones stay blocked. A plan over the storage value limit is skipped: the tool then uses the graph.
      try { await this.deps.store.put('msg:evacPlan', p); } catch { /* Too large. */ }
      const flights = this.deps.view.flights(), now = this.deps.view.clock().now;
      let sent = 0;
      const told: Subscriber[] = [];
      for (const s of await this.subscribers()) {
        const f = s.flight ? findFlight(flights, s.flight) : undefined;
        if (!affectedByEvacuation(p.blocked, f, now)) continue;
        const r = routeFor(p, f, now);
        const blocked = p.blocked.length ? copy.blockedAreas(s.lang, p) : '';
        const text = copy.evacuationRoute(s.lang, blocked, r) + (this.onTheRoad(s, f, now) ? ` ${copy.evacuationRoad(s.lang, reopenInMin)}` : '');
        if (await this.notify(s.sub, { kind: 'evacuate', text }) === 'sent') { sent++; told.push(s.sub); }
        if (s.sub.channel === 'sim') this.deps.toUnity('agent.route', { agentId: s.sub.agentId, nodes: r.nodes, reason: 'evacuate' });
      }
      await this.evacuated(told);
      console.log(JSON.stringify({ msg: 'evac-plan', id: p.id, routes: p.routes.length, sent }));
      return sent;
    });
  }
}
