import { urgentText, staffIncident } from './urgency.js';
import { clearPrefix } from '../reset-store.js';
import { say, language } from './texts.js';
import { consumeJoin } from '../join.js';
// Clarion on WhatsApp: one inbound message start to finish (Moni src/whatsapp.js turn() + src/core.js handleMessage).
// State lives in the Tower's Durable Object storage instead of Moni's KV:
//   wa:profile:<phone> -> Profile           wa:ctx:<phone> -> { history }        wa:last:<phone> -> ms of last inbound (24h window)
import { reply, type HistoryEntry } from './agent.js';
import { clockText, closeAt, findFlight, gateName } from './flights.js';
import { Messaging, WINDOW_MS } from './messaging.js';
import { Reports } from './reports.js';
import { toolsFor, type AirportView, type Profile } from './tools.js';
import {
  WhatsAppClient, allowed, failedStatuses, masked, parseWebhook, quickReaction, reactionOf, redact, MEDIA,
  type Fetch, type InboundMessage, type WaEnv,
} from './transport.js';

export type { WaEnv } from './transport.js';
export { WINDOW_MS } from './messaging.js';
/** Demo default for STAFF <code> when the STAFF_CODE secret is not set. */
export const DEFAULT_STAFF_CODE = 'CRAIOVA2026';
export interface WaStore {
  list?<T>(options: { prefix: string; startAfter?: string; limit?: number }): Promise<Map<string, T>>;
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
}

const HISTORY_KEEP = 20;
const DELETE_DATA = /^\s*(sterge|șterge)(-mi)?\s+(toate\s+)?datele(\s+mele)?\s*[.!]*\s*$|^\s*delete\s+(all\s+)?my\s+data\s*[.!]*\s*$/i;

/** "STAFF <code>" -> the code (D11). */
export function parseStaff(text: string) {
  return /^\s*STAFF\s+(\S{1,64})\s*$/i.exec(text)?.[1];
}

/** "START W6 3751 a8f2" -> { flight: "W6 3751", token: "a8f2" } (D4). Missing tokens bind as unverified. */
export function parseStart(text: string) {
  const m = /^\s*START\s+([A-Z][A-Z0-9]|[0-9][A-Z])\s*-?\s*(\d{1,4})(?:\s+([A-Z0-9]{4,64}))?\s*$/i.exec(text);
  return m ? { flight: `${m[1]!.toUpperCase()} ${m[2]}`, token: m[3] } : undefined;
}

export class WhatsAppAgent {
  readonly wa: WhatsAppClient;
  readonly messaging: Messaging;
  readonly reports: Reports;
  private chains = new Map<string, Promise<void>>();
  private fetcher: Fetch;
  constructor(private env: WaEnv, private store: WaStore, private view: AirportView,
    opts: { fetcher?: Fetch; pause?: number; toUnity?: (type: string, data: unknown) => boolean; evacWaitMs?: number } = {}) {
    this.fetcher = opts.fetcher ?? ((i, init) => fetch(i, init));
    this.wa = new WhatsAppClient(env, this.fetcher, opts.pause);
    this.messaging = new Messaging({ store, appUrl: env.APP_URL, wa: this.wa, view, toUnity: opts.toUnity ?? (() => false), evacWaitMs: opts.evacWaitMs });
    this.reports = new Reports(store);
  }

  async reset() {
    await Promise.allSettled([...this.chains.values()]);
    this.chains.clear();
    return {
      ...await this.messaging.reset(),
      ...await this.reports.reset(),
      profiles: await clearPrefix(this.store, 'wa:profile:'),
      histories: await clearPrefix(this.store, 'wa:ctx:'),
      inboundWindows: await clearPrefix(this.store, 'wa:last:'),
    };
  }

  /**
   * A signed, already deduplicated webhook body. Runs after the 200 (ctx.waitUntil): messages from one phone are
   * answered one at a time, in order; one failing never silences the rest. Never throws.
   */
  async inbound(body: unknown): Promise<void> {
    for (const st of failedStatuses(body)) console.error(JSON.stringify({ wa: 'delivery-failed', code: st.code, title: st.title, to: st.phone && masked(st.phone) }));
    const msgs = parseWebhook(body, this.wa.phoneId).filter(m => allowed(this.env, m.phone));
    await Promise.all(msgs.map(m => this.enqueue(m)));
  }

  /** True while a free-form message may be sent to this phone (24h after their last message). */
  async withinWindow(phone: string, now = Date.now()) {
    const last = await this.store.get<number>(`wa:last:${phone}`);
    return typeof last === 'number' && now - last < WINDOW_MS;
  }
  profile(phone: string) { return this.store.get<Profile>(`wa:profile:${phone}`); }

  private enqueue(m: InboundMessage) {
    const next = (this.chains.get(m.phone) ?? Promise.resolve())
      .then(() => this.turn(m))
      .catch(async e => {
        console.error(JSON.stringify({ wa: 'turn-crashed', id: m.id, error: String((e as Error)?.message ?? e).slice(0, 200) }));
        await this.wa.sendText(m.phone, say((await this.profile(m.phone))?.lang, 'fallback')).catch(() => {});
      });
    this.chains.set(m.phone, next);
    void next.finally(() => { if (this.chains.get(m.phone) === next) this.chains.delete(m.phone); });
    return next;
  }

  private async turn(m: InboundMessage) {
    console.log(JSON.stringify({ wa: 'in', id: m.id, type: m.type, from: masked(m.phone) }));
    await this.wa.markReadTyping(m.id);
    const key = `wa:profile:${m.phone}`;
    let profile: Profile = { phone: m.phone, role: 'passenger', lang: 'ro', ...(await this.store.get<Profile>(key)) };
    // Check urgency before sending even a provisional reaction.
    const flight = profile.flight && findFlight(this.view.flights(), profile.flight);
    const flightAlert = flight && (flight.status === 'delayed' || flight.status === 'cancelled')
      && /flight|zbor|gate|poart/i.test(m.text ?? '');
    const urgent = m.text && (urgentText(m.text) || flightAlert || (profile.role === 'staff' && staffIncident(m.text)));
    const quick = m.text && !urgent ? quickReaction(m.text) : null;
    if (quick) await this.wa.sendReaction(m.phone, m.id, quick);

    const initiallyBound = Boolean(profile.flight);
    const save = async (patch: Partial<Profile>) => {
      profile = { ...profile, ...patch }; await this.store.put(key, profile);
      // Bound to a flight or staff: from now on part of the fan-out (flight changes, evacuation).
      if (patch.flight || patch.role === 'staff') await this.messaging.addPhone(m.phone);
    };
    // Every message the person sends opens the 24h window.
    await this.store.put(`wa:last:${m.phone}`, m.at);
    await save({ lastInboundAt: m.at, ...(m.name && { name: m.name }) });

    if (m.text === null) { if (MEDIA.has(m.type)) await this.wa.sendText(m.phone, say(profile.lang, 'textOnly')); return; }
    const chosen = /^(english|en)$/i.test(m.text.trim()) ? 'en' : /^(română|romana|ro)$/i.test(m.text.trim()) ? 'ro' : undefined;
    if (chosen) { await save({ lang: chosen }); await this.wa.sendText(m.phone, say(chosen, 'language')); return; }
    // ş (cedilla, older keyboards) is matched as ș.
    if (DELETE_DATA.test(m.text.replace(/ş/gi, 'ș'))) {
      if (profile.pageToken) await this.store.delete(`page:${profile.pageToken}`);
      for (const k of [key, `wa:ctx:${m.phone}`, `wa:last:${m.phone}`]) await this.store.delete(k);
      await this.messaging.removePhone(m.phone);
      await this.wa.sendText(m.phone, say(profile.lang, 'deleted'));
      return;
    }
    const ctxKey = `wa:ctx:${m.phone}`;
    const ctx = (await this.store.get<{ history: HistoryEntry[] }>(ctxKey)) ?? { history: [] };
    const remember = (user: string, bubbles: string[]) => {
      const at = new Date().toISOString();
      const entries: HistoryEntry[] = [{ role: 'user', text: user, at }, ...bubbles.map(text => ({ role: 'clarion' as const, text, at }))];
      return this.store.put(ctxKey, { history: [...ctx.history, ...entries].slice(-HISTORY_KEEP) });
    };

    const staff = parseStaff(m.text);
    if (staff !== undefined) {
      const ok = staff.toUpperCase() === (this.env.STAFF_CODE || DEFAULT_STAFF_CODE).toUpperCase();
      if (ok) await save({ role: 'staff' });
      const text = ok
        ? say(profile.lang, 'staffRegistered')
        : say(profile.lang, 'staffCodeInvalid');
      await this.wa.sendText(m.phone, text);
      await remember('STAFF ***', [text]);
      return;
    }
    const start = parseStart(m.text);
    if (start) {
      const flight = findFlight(this.view.flights(), start.flight);
      if (!flight) {
        const text = say(profile.lang, 'unknownFlight', start.flight);
        await this.wa.sendText(m.phone, text);
        await remember(m.text, [text]);
        return;
      }
      const pending = await consumeJoin(this.store, start.token, flight.flight);
      if (!pending) console.warn(JSON.stringify({ wa: 'unverified-start', from: masked(m.phone), flight: flight.flight }));
      await save({ flight: flight.flight, airline: flight.airline, token: start.token, verified: Boolean(pending),
        ...(pending && { lang: language(pending.lang) }),
        ...(pending?.name && { name: pending.name }) });
      const clock = this.view.clock();
      const text = say(profile.lang, 'startConnected', flight.flight, flight.destination, gateName(flight.gate), clockText(closeAt(flight)), say(profile.lang, clock.sim ? 'simClock' : 'realClock'));
      const ask = say(profile.lang, 'bagQuestion');
      await this.wa.sendReaction(m.phone, m.id, '✈️');
      await this.wa.sendText(m.phone, text);
      await this.messaging.arrive({ channel: 'whatsapp', phone: m.phone }, flight, profile.hasCheckedBag);
      await this.wa.sendButtons(m.phone, ask, [{ id: 'bag:yes', title: say(profile.lang, 'bagYes') }, { id: 'bag:no', title: say(profile.lang, 'bagNo') }]);
      await remember(`START ${flight.flight}`, [text, ask]);
      return;
    }
    // A tap on the bag question: save it, then ask the agent the question it was for.
    let text = m.text;
    if (m.replyId === 'bag:yes' || m.replyId === 'bag:no') {
      await save({ hasCheckedBag: m.replyId === 'bag:yes' });
      text = say(profile.lang, m.replyId === 'bag:yes' ? 'bagQueryYes' : 'bagQueryNo');
    }

    const started = Date.now();
    const tools = toolsFor({ view: this.view, profile: () => profile, save, report: r => this.reports.add(r),
      pageLink: async () => {
        const link = await this.messaging.pageLink({ channel: 'whatsapp', phone: m.phone });
        const stored = await this.profile(m.phone);
        if (stored?.pageToken) profile.pageToken = stored.pageToken;
        return link;
      } });
    const { bubbles, used } = await reply({ env: this.env, fetcher: this.fetcher, profile, clock: this.view.clock(), history: ctx.history, text: redact(text), tools });
    if (quick && !bubbles.some(reactionOf)) await this.wa.sendReaction(m.phone, m.id, '');
    await this.wa.sendReplies(m.phone, bubbles, m.id);
    if (!initiallyBound && profile.flight) {
      const flight = findFlight(this.view.flights(), profile.flight);
      if (flight) await this.messaging.arrive({ channel: 'whatsapp', phone: m.phone }, flight, profile.hasCheckedBag);
    }
    await remember(redact(text), bubbles);
    console.log(JSON.stringify({ wa: 'turn', id: m.id, tools: used, bubbles: bubbles.length, ms: Date.now() - started }));
  }
}
