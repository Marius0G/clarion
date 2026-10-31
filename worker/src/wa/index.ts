// Clarion on WhatsApp: one inbound message start to finish (Moni src/whatsapp.js turn() + src/core.js handleMessage).
// State lives in the Tower's Durable Object storage instead of Moni's KV:
//   wa:profile:<phone> -> Profile           wa:ctx:<phone> -> { history }        wa:last:<phone> -> ms of last inbound (24h window)
import { reply, FALLBACK, type HistoryEntry } from './agent.js';
import { clockLabel, clockText, findFlight } from './flights.js';
import { toolsFor, type AirportView, type Profile } from './tools.js';
import {
  WhatsAppClient, allowed, failedStatuses, masked, parseWebhook, quickReaction, reactionOf, redact, MEDIA,
  type Fetch, type InboundMessage, type WaEnv,
} from './transport.js';

export type { WaEnv } from './transport.js';
export interface WaStore {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
}

export const WINDOW_MS = 86400000;
const HISTORY_KEEP = 20;
const TEXT_ONLY = 'Deocamdată citesc doar mesaje text. Scrie-mi ce vrei să afli și te ajut.';
const DELETE_DATA = /^\s*(sterge|șterge)(-mi)?\s+(toate\s+)?datele(\s+mele)?\s*[.!]*\s*$|^\s*delete\s+(all\s+)?my\s+data\s*[.!]*\s*$/i;
const BAG_BUTTONS = [{ id: 'bag:yes', title: 'Da, am bagaj' }, { id: 'bag:no', title: 'Doar de mână' }];

/** "START W6 3751 a8f2" -> { flight: "W6 3751", token: "a8f2" } (D4). The token is optional for now. */
export function parseStart(text: string) {
  const m = /^\s*START\s+([A-Z][A-Z0-9]|[0-9][A-Z])\s*-?\s*(\d{1,4})(?:\s+([A-Z0-9]{4,64}))?\s*$/i.exec(text);
  return m ? { flight: `${m[1]!.toUpperCase()} ${m[2]}`, token: m[3] } : undefined;
}

export class WhatsAppAgent {
  readonly wa: WhatsAppClient;
  private chains = new Map<string, Promise<void>>();
  private fetcher: Fetch;
  constructor(private env: WaEnv, private store: WaStore, private view: AirportView, opts: { fetcher?: Fetch; pause?: number } = {}) {
    this.fetcher = opts.fetcher ?? ((i, init) => fetch(i, init));
    this.wa = new WhatsAppClient(env, this.fetcher, opts.pause);
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
        await this.wa.sendText(m.phone, FALLBACK).catch(() => {});
      });
    this.chains.set(m.phone, next);
    void next.finally(() => { if (this.chains.get(m.phone) === next) this.chains.delete(m.phone); });
    return next;
  }

  private async turn(m: InboundMessage) {
    console.log(JSON.stringify({ wa: 'in', id: m.id, type: m.type, from: masked(m.phone) }));
    await this.wa.markReadTyping(m.id);
    // A reaction within a second, before the agent thinks; the agent's own reaction replaces it, or it comes off.
    const quick = m.text ? quickReaction(m.text) : null;
    if (quick) await this.wa.sendReaction(m.phone, m.id, quick);

    const key = `wa:profile:${m.phone}`;
    let profile: Profile = { phone: m.phone, role: 'passenger', ...(await this.store.get<Profile>(key)) };
    const save = async (patch: Partial<Profile>) => { profile = { ...profile, ...patch }; await this.store.put(key, profile); };
    // Every message the person sends opens the 24h window.
    await this.store.put(`wa:last:${m.phone}`, m.at);
    await save({ lastInboundAt: m.at, ...(m.name && { name: m.name }) });

    if (m.text === null) { if (MEDIA.has(m.type)) await this.wa.sendText(m.phone, TEXT_ONLY); return; }
    // ş (cedilla, older keyboards) is matched as ș.
    if (DELETE_DATA.test(m.text.replace(/ş/gi, 'ș'))) {
      for (const k of [key, `wa:ctx:${m.phone}`, `wa:last:${m.phone}`]) await this.store.delete(k);
      await this.wa.sendText(m.phone, 'Gata, am șters tot ce știam despre tine și zborul tău. Dacă vrei să reîncepi, scrie-mi oricând.');
      return;
    }
    const ctxKey = `wa:ctx:${m.phone}`;
    const ctx = (await this.store.get<{ history: HistoryEntry[] }>(ctxKey)) ?? { history: [] };
    const remember = (user: string, bubbles: string[]) => {
      const at = new Date().toISOString();
      const entries: HistoryEntry[] = [{ role: 'user', text: user, at }, ...bubbles.map(text => ({ role: 'clarion' as const, text, at }))];
      return this.store.put(ctxKey, { history: [...ctx.history, ...entries].slice(-HISTORY_KEEP) });
    };

    const start = parseStart(m.text);
    if (start) {
      const flight = findFlight(this.view.flights(), start.flight);
      if (!flight) {
        const text = `Nu găsesc zborul ${start.flight} în orarul de azi. Verifică numărul pe boarding pass și scrie-mi din nou.`;
        await this.wa.sendText(m.phone, text);
        await remember(m.text, [text]);
        return;
      }
      // The token comes from the Wallet card (D4); accepted as-is until Wallet issues and stores tokens.
      await save({ flight: flight.flight, airline: flight.airline, token: start.token, verified: Boolean(start.token) });
      const clock = this.view.clock();
      const text = `Gata ✈️ Te-am conectat la zborul ${flight.flight} spre ${flight.destination}. Poarta ${flight.gate} se închide la ${clockText(flight.gateCloseAt)} (${clockLabel(clock)}).`;
      const ask = 'Ai bagaj de cală? Așa îți spun exact când să fii la aeroport.';
      await this.wa.sendReaction(m.phone, m.id, '✈️');
      await this.wa.sendText(m.phone, text);
      await this.wa.sendButtons(m.phone, ask, BAG_BUTTONS);
      await remember(m.text, [text, ask]);
      return;
    }
    // A tap on the bag question: save it, then ask the agent the question it was for.
    let text = m.text;
    if (m.replyId === 'bag:yes' || m.replyId === 'bag:no') {
      await save({ hasCheckedBag: m.replyId === 'bag:yes' });
      text = `${m.replyId === 'bag:yes' ? 'Am bagaj de cală.' : 'Am doar bagaj de mână.'} Când trebuie să fiu la aeroport?`;
    }

    const started = Date.now();
    const tools = toolsFor({ view: this.view, profile: () => profile, save });
    const { bubbles, used } = await reply({ env: this.env, fetcher: this.fetcher, profile, clock: this.view.clock(), history: ctx.history, text: redact(text), tools });
    if (quick && !bubbles.some(reactionOf)) await this.wa.sendReaction(m.phone, m.id, '');
    await this.wa.sendReplies(m.phone, bubbles, m.id);
    await remember(redact(text), bubbles);
    console.log(JSON.stringify({ wa: 'turn', id: m.id, tools: used, bubbles: bubbles.length, ms: Date.now() - started }));
  }
}
