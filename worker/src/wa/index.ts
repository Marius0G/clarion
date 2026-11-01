import { staffAssignment } from './staff.js';
import { mapNodeId } from '../../../backend/src/mapIds.js';
import { zoneDensities, route } from '../../../backend/src/routing.js';
import { zoneAreas, terminalGraph } from '../../../backend/src/terminal.js';
import { RouteImages, resolveLandmark } from './airport-info.js';
import { Auth, normalizePhone, parseLogin } from '../../../backend/src/auth.js';
import { metaExplanation, type Observe } from './events.js';
import { lostItemClaim, extractFacts, messageLanguage, lookupNote, NOTES_MAX, type PassengerContext } from './context.js';
import { urgentText, staffIncident } from './urgency.js';
import { clearPrefix } from '../reset-store.js';
import { say, language, passengerText, nodeName } from './texts.js';
import { consumeJoin } from '../join.js';
// Clarion on WhatsApp: one inbound message start to finish (Moni src/whatsapp.js turn() + src/core.js handleMessage).
// State lives in the Tower's Durable Object storage instead of Moni's KV:
//   wa:profile:<phone> -> Profile           wa:ctx:<phone> -> { history }        wa:last:<phone> -> ms of last inbound (24h window)
import { reply, foldHistory, type HistoryEntry } from './agent.js';
import { clockText, closeAt, findFlight, gateName } from './flights.js';
import { Messaging, WINDOW_MS } from './messaging.js';
import { Reports, reportStateLabel, classifyReportType, clearProblem, matchNode, kindForType, REPORT_TYPES, type ReportType } from './reports.js';
import { toolsFor, type AirportView, type Profile } from './tools.js';
import {
  WhatsAppClient, passengerBubbles, allowed, failedStatuses, masked, parseWebhook, quickReaction, reactionOf, redact, MEDIA,
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

export type ChatEntry = HistoryEntry & { id: string; channel: 'web' | 'whatsapp' };
export type PersonEvent = { type: 'chat'; entry: ChatEntry } | { type: 'report'; report: import('./reports.js').Report } | { type: 'me' } | { type: 'typing'; on: boolean };

export class WhatsAppAgent {
  readonly wa: WhatsAppClient;
  readonly messaging: Messaging;
  readonly reports: Reports;
  private chains = new Map<string, Promise<void>>();
  private fetcher: Fetch;
  private observe?: Observe;
  private images: RouteImages;
  private personEvent?: (phone: string, event: PersonEvent) => void;
  private traces = new Map<string, { tools: string[]; bubbles: number }>();
  constructor(private env: WaEnv, private store: WaStore, private view: AirportView,
    opts: { personEvent?: (phone: string, event: PersonEvent) => void; fetcher?: Fetch; pause?: number; toUnity?: (type: string, data: unknown) => boolean; evacWaitMs?: number; observe?: Observe; reportsChanged?: (reports: import('./reports.js').Report[]) => void } = {}) {
    this.personEvent = opts.personEvent;
    this.fetcher = opts.fetcher ?? ((i, init) => fetch(i, init));
    this.observe = opts.observe;
    this.images = new RouteImages(env.APP_URL ?? 'https://clarion-craiova.pages.dev', this.fetcher);
    this.wa = new WhatsAppClient(env, this.fetcher, opts.pause, async event => {
      const trace = event.phone && this.traces.get(event.phone.replace(/^\+/, ''));
      if (trace && (event.type === 'text' || event.type === 'interactive')) trace.bubbles++;
      await this.observe?.(event);
    });
    this.messaging = new Messaging({ store, appUrl: env.APP_URL, wa: this.wa, view, toUnity: opts.toUnity ?? (() => false), evacWaitMs: opts.evacWaitMs, images: this.images, historyAppended: async (phone, entry) => this.emit(phone, { type: 'chat', entry: { ...entry, text: await this.historyText(phone, entry.text) } }) });
    const versions = new Map<string, string>();
    this.reports = new Reports(store, rows => {
      opts.reportsChanged?.(rows);
      for (const report of rows) {
        const version = JSON.stringify(report);
        if (report.phone && versions.get(report.id) !== version) this.emit(report.phone, { type: 'report', report: { ...report, text: redact(report.text) } });
        versions.set(report.id, version);
      }
    }, async r => {
      if (!r.phone) return;
      const en = (await this.profile(r.phone))?.lang === 'en';
      await this.messaging.notify({ channel: 'whatsapp', phone: r.phone }, { kind: 'admin', requested: true,
        text: r.source === 'staff' && r.type === 'crowd' && r.state === 'sent' ? (en ? 'Passed on. Dispatch decides.' : 'Am transmis. Dispeceratul decide.') : `${r.id} · ${reportStateLabel(r.state, en)} · ${r.place.name === r.node && r.node ? nodeName(r.node, en ? 'en' : 'ro') : r.place.name}${r.etaMin == null || r.state === 'resolved' ? '' : ` · ETA ~${r.etaMin} min`}` });
    });
  }

  async reset() {
    await Promise.allSettled([...this.chains.values()]);
    this.chains.clear();
    return {
      ...await this.messaging.reset(),
      ...await this.reports.reset(),
      profiles: await clearPrefix(this.store, 'wa:profile:'),
      histories: await clearPrefix(this.store, 'wa:ctx:'),
      reportDrafts: await clearPrefix(this.store, 'wa:report:'),
      inboundWindows: await clearPrefix(this.store, 'wa:last:'),
    };
  }

  /**
   * A signed, already deduplicated webhook body. Runs after the 200 (ctx.waitUntil): messages from one phone are
   * answered one at a time, in order; one failing never silences the rest. Never throws.
   */
  async inbound(body: unknown): Promise<void> {
    for (const st of failedStatuses(body)) {
      console.error(JSON.stringify({ wa: 'delivery-failed', code: st.code, title: st.title, to: st.phone && masked(st.phone) }));
      await this.observe?.({ kind: 'send-failure', phone: st.phone ?? undefined, code: st.code, explanation: metaExplanation(st.code) });
    }
    const msgs = parseWebhook(body, this.wa.phoneId).filter(m => parseLogin(m.text) || allowed(this.env, m.phone));
    await Promise.all(msgs.map(m => this.receive(m)));
  }

  /** True while a free-form message may be sent to this phone (24h after their last message). */
  async withinWindow(phone: string, now = Date.now()) {
    const last = await this.store.get<number>(`wa:last:${phone}`);
    return typeof last === 'number' && now - last < WINDOW_MS;
  }
  profile(phone: string) { return this.store.get<Profile>(`wa:profile:${phone}`); }

  /** Parsed webhook messages and isolated lab messages enter the same serialized turn. */
  receive(m: InboundMessage, channel: 'whatsapp' | 'web' = 'whatsapp', output: HistoryEntry[] = []) {
    const next = (this.chains.get(m.phone) ?? Promise.resolve()).catch(() => {})
      .then(async () => {
        const started = Date.now();
        const trace = { tools: [] as string[], bubbles: 0 };
        this.traces.set(m.phone.replace(/^\+/, ''), trace);
        await this.observe?.({ kind: 'inbound', phone: m.phone, type: m.type, text: redact(m.text ?? '') });
        this.emit(m.phone, { type: 'typing', on: true });
        try { await this.conversationTurn(m, channel, output); }
        catch (e) {
          const error = String((e as Error)?.message ?? e);
          await this.observe?.({ kind: 'agent-error', phone: m.phone, text: error });
          console.error(JSON.stringify({ wa: 'turn-crashed', id: m.id, error: error.slice(0, 200) }));
          if (channel === 'web') throw e;
          await this.wa.sendText(m.phone, say((await this.profile(m.phone))?.lang, 'fallback')).catch(() => {});
        } finally {
          this.emit(m.phone, { type: 'typing', on: false });
          this.emit(m.phone, { type: 'me' });
          this.traces.delete(m.phone.replace(/^\+/, ''));
          await this.observe?.({ kind: 'turn', phone: m.phone, ...trace, ms: Date.now() - started });
        }
      });
    this.chains.set(m.phone, next);
    void next.then(() => { if (this.chains.get(m.phone) === next) this.chains.delete(m.phone); }, () => { if (this.chains.get(m.phone) === next) this.chains.delete(m.phone); });
    return next;
  }

  async chat(phone: string, text: string, replyId: string | null = null) {
    const output: HistoryEntry[] = [];
    await this.receive({ id: crypto.randomUUID(), phone, name: '', type: 'text', text, replyId, at: Date.now() }, 'web', output);
    return output;
  }

  private emit(phone: string, event: PersonEvent) {
    // A disconnected browser must never break durable history or WhatsApp delivery.
    try { this.personEvent?.(phone, event); } catch { /* Closed peer. */ }
  }

  private async historyText(phone: string, text: string) {
    const token = (await this.profile(phone))?.pageToken;
    const link = token ? `${(this.env.APP_URL ?? 'https://clarion-craiova.pages.dev').replace(/\/$/, '')}/m/${token}` : undefined;
    // Only this phone's generated personal link survives the API-key redactor.
    return link ? text.split(link).map(redact).join(link) : redact(text);
  }

  async chatHistory(phone: string): Promise<ChatEntry[]> {
    const ctx = await this.store.get<PassengerContext>(`wa:ctx:${phone}`);
    const alerts = await this.store.get<(HistoryEntry & { id?: string })[]>(`msg:alerts:wa:${phone}`) ?? [];
    const entries = [...(ctx?.history ?? []), ...alerts.map(e => ({ ...e, role: 'clarion' as const, channel: 'whatsapp' as const }))];
    return Promise.all(entries.map(async e => {
      // Older history has no id. A content digest survives reconnects and history folding.
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([phone, e.role, e.channel ?? 'whatsapp', e.timestamp, e.at, e.text, e.image, e.buttons])));
      const id = (e as ChatEntry).id ?? 'legacy:' + Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
      return { ...e, id, text: await this.historyText(phone, e.text), channel: e.channel ?? 'whatsapp' };
    })).then(rows => rows.sort((a, b) => a.timestamp !== undefined && b.timestamp !== undefined ? a.timestamp - b.timestamp : a.at.localeCompare(b.at)));
  }

  private async conversationTurn(m: InboundMessage, channel: 'whatsapp' | 'web', output: HistoryEntry[]) {
    // A scoped transport shares the full turn without mutating the live WhatsApp client.
    const graph = async (body: Record<string, unknown>) => {
      const result = channel === 'web' ? { ok: true } : await this.wa.graph(body);
      if (result.ok) {
        const interactive = body.interactive as { body?: { text: string }; action?: { buttons: { reply: { id: string; title: string } }[] } } | undefined;
        const image = body.image as { link: string; caption: string } | undefined;
        const reaction = body.reaction as { emoji?: string } | undefined;
        const text = (body.text as { body?: string } | undefined)?.body ?? interactive?.body?.text ?? image?.caption ?? (reaction?.emoji ? `[react]${reaction.emoji}` : undefined);
        if (text) output.push({ id: crypto.randomUUID(), role: 'clarion', text: redact(text), at: clockText(this.view.clock().now), timestamp: Date.now(), channel,
          ...(interactive && { buttons: interactive.action?.buttons.map(b => b.reply) }), ...(image && { image: image.link }) } as ChatEntry);
      }
      return result;
    };
    const transport = new Proxy(channel === 'web' ? new WhatsAppClient(this.env, this.fetcher, 0) : this.wa, {
      get: (target, property, receiver) => property === 'graph' ? graph : Reflect.get(target, property, receiver),
    });
    await this.turn(m, transport, channel);
    if (m.text && !(channel === 'whatsapp' && parseLogin(m.text)) && !DELETE_DATA.test(m.text.replace(/ş/gi, 'ș'))) {
      const key = `wa:ctx:${m.phone}`, ctx = await this.store.get<PassengerContext>(key) ?? { history: [] };
      const entries: ChatEntry[] = [{ id: m.id, role: 'user', text: parseStaff(m.text) !== undefined ? 'STAFF ***' : redact(m.text), at: clockText(this.view.clock().now), timestamp: m.at, channel }, ...output as ChatEntry[]];
      await this.store.put(key, { ...ctx, ...await foldHistory(this.env, this.fetcher, ctx, entries) });
      for (const entry of entries) this.emit(m.phone, { type: 'chat', entry });
    }
  }

  private async turn(m: InboundMessage, transport: WhatsAppClient, channel: 'whatsapp' | 'web') {
    console.log(JSON.stringify({ wa: 'in', id: m.id, type: m.type, from: masked(m.phone) }));
    const login = parseLogin(m.text);
    if (login && channel === 'whatsapp') {
      const ok = await new Auth(this.store).bindLogin(login, m.phone);
      await this.store.put(`wa:last:${m.phone}`, m.at);
      if (allowed(this.env, m.phone)) await transport.sendText(m.phone, ok ? 'Gata, ești conectat pe site.' : 'Cod expirat sau folosit. Cere un cod nou pe site.');
      return;
    }
    await transport.markReadTyping(m.id);
    const key = `wa:profile:${m.phone}`;
    let profile: Profile = { phone: m.phone, role: 'passenger', lang: 'ro', ...(await this.store.get<Profile>(key)) };
    if ((this.env.STAFF_PHONES ?? '').split(',').some(p => normalizePhone(p.trim()) === m.phone)) profile.role = 'staff';
    if (profile.role === 'staff') profile.zone = staffAssignment(this.env, profile).zone;
    // Check urgency before sending even a provisional reaction.
    const flight = profile.flight && findFlight(this.view.flights(), profile.flight);
    const flightAlert = flight && (flight.status === 'delayed' || flight.status === 'cancelled')
      && /flight|zbor|gate|poart/i.test(m.text ?? '');
    const urgent = m.text && (clearProblem(m.text) || m.replyId?.startsWith('rep:') || urgentText(m.text) || flightAlert || (profile.role === 'staff' && staffIncident(m.text)));
    const quick = m.text && !urgent ? quickReaction(m.text) : null;
    if (quick && channel === 'whatsapp') await this.wa.sendReaction(m.phone, m.id, quick);

    const initiallyBound = Boolean(profile.flight);
    const save = async (patch: Partial<Profile>) => {
      const base = { ...profile, ...await this.store.get<Profile>(key) };
      profile = { ...base, ...patch, ...(patch.needs && { needs: { ...base.needs, ...patch.needs } }) }; await this.store.put(key, profile);
      // Bound to a flight or staff: from now on part of the fan-out (flight changes, evacuation).
      if (patch.flight || patch.role === 'staff') await this.messaging.addPhone(m.phone);
    };
    // Every message the person sends opens the 24h window.
    if (channel === 'whatsapp') await this.store.put(`wa:last:${m.phone}`, m.at);
    await save({ role: profile.role, lastInboundAt: m.at, ...(m.name && { name: m.name }) });

    if (m.photo) {
      const draft = await this.store.get<object>(`wa:report:${m.phone}`) ?? { text: m.text ?? '' };
      await this.store.put(`wa:report:${m.phone}`, { ...draft, photo: m.photo });
      m.text ??= '';
    }
    if (m.text === null) { if (MEDIA.has(m.type)) await transport.sendText(m.phone, say(profile.lang, 'textOnly')); return; }
    const chosen = /^(english|en)$/i.test(m.text.trim()) ? 'en' : /^(română|romana|ro)$/i.test(m.text.trim()) ? 'ro' : undefined;
    if (chosen) { await save({ lang: chosen, languageExplicit: true }); await transport.sendText(m.phone, say(chosen, 'language')); return; }
    const detected = messageLanguage(m.text);
    if (!profile.languageExplicit && detected) await save({ lang: detected });
    // ş (cedilla, older keyboards) is matched as ș.
    if (DELETE_DATA.test(m.text.replace(/ş/gi, 'ș'))) {
      if (profile.pageToken) await this.store.delete(`page:${profile.pageToken}`);
      for (const k of [key, `wa:ctx:${m.phone}`, `wa:last:${m.phone}`]) await this.store.delete(k);
      await this.messaging.removePhone(m.phone);
      await transport.sendText(m.phone, say(profile.lang, 'deleted'));
      return;
    }
    const ctxKey = `wa:ctx:${m.phone}`;
    const ctx = (await this.store.get<PassengerContext>(ctxKey)) ?? { history: [] };
    const alerts = await this.store.get<PassengerContext['alerts']>(`msg:urgent:wa:${m.phone}`)
      ?? await this.store.get<PassengerContext['alerts']>(`msg:alerts:wa:${m.phone}`) ?? [];
    ctx.alerts = alerts.filter(a => a.kind === 'flight' || a.kind === 'evacuate');
    const persistContext = async () => this.store.put(ctxKey, ctx);

    const staff = parseStaff(m.text);
    if (staff !== undefined) {
      const ok = channel === 'whatsapp' && staff.toUpperCase() === (this.env.STAFF_CODE || DEFAULT_STAFF_CODE).toUpperCase();
      if (ok) await save({ role: 'staff' });
      const text = ok
        ? say(profile.lang, 'staffRegistered')
        : say(profile.lang, 'staffCodeInvalid');
      await transport.sendText(m.phone, text);
      await persistContext();
      return;
    }
    const start = parseStart(m.text);
    if (start) {
      const flight = findFlight(this.view.flights(), start.flight);
      if (!flight) {
        const text = say(profile.lang, 'unknownFlight', start.flight);
        await transport.sendText(m.phone, text);
        await persistContext();
        return;
      }
      const pending = await consumeJoin(this.store, start.token, flight.flight);
      if (!pending) console.warn(JSON.stringify({ wa: 'unverified-start', from: masked(m.phone), flight: flight.flight }));
      await save({ flight: flight.flight, gate: gateName(flight.gate), airline: flight.airline, token: start.token, verified: Boolean(pending),
        ...(pending && { lang: language(pending.lang), languageExplicit: true }),
        ...(pending?.name && { name: pending.name }) });
      const clock = this.view.clock();
      const text = say(profile.lang, 'startConnected', flight.flight, flight.destination, gateName(flight.gate), clockText(closeAt(flight)), say(profile.lang, clock.sim ? 'simClock' : 'realClock'));
      const ask = say(profile.lang, 'bagQuestion');
      const urgentStart = flight.status === 'delayed' || flight.status === 'cancelled';
      if (!urgentStart) await transport.sendReaction(m.phone, m.id, '✈️');
      await transport.sendText(m.phone, urgentStart ? text.replace(/✈️\s*/gu, '') : text);
      if (channel === 'web') await transport.sendText(m.phone, this.messaging.arriveText(flight, profile.hasCheckedBag, profile.lang));
      else await this.messaging.arrive({ channel: 'whatsapp', phone: m.phone }, flight, profile.hasCheckedBag, true);
      await transport.sendButtons(m.phone, ask, [{ id: 'bag:yes', title: say(profile.lang, 'bagYes') }, { id: 'bag:no', title: say(profile.lang, 'bagNo') }]);
      await persistContext();
      return;
    }
    // Reports from either role use one bounded slot-filling flow; missing type/place are button choices.
    const reportKey = `wa:report:${m.phone}`;
    let draft = await this.store.get<{ text: string; type?: ReportType; node?: string; photo?: string }>(reportKey);
    if (draft || (profile.role === 'staff' && classifyReportType(m.text) === 'crowd') || (profile.role === 'passenger' && (clearProblem(m.text) || lostItemClaim(m.text))) || /^(raportează|raporteaza|raport|report)[.! ]*$/i.test(m.text) || m.replyId?.startsWith('rep:')) {
      const en = profile.lang === 'en';
      const index = await this.images.index();
      const words = (value: string) => value.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
      const reportText = words(m.text);
      const mentioned = index?.points.flatMap(p => [p.name.ro, p.name.en, ...p.aliases].map(name => ({ node: p.id, name: words(name) })))
        .filter(p => p.name && ` ${reportText} `.includes(` ${p.name} `)).sort((a, b) => b.name.length - a.name.length)[0]?.node;
      draft ??= { text: /^(raportează|raporteaza|raport|report)[.! ]*$/i.test(m.text) ? '' : m.text,
        type: classifyReportType(m.text), node: mentioned ?? matchNode(m.text, this.view.flights()) ?? undefined };
      if (m.replyId?.startsWith('rep:type:')) {
        const selected = m.replyId.slice(9) as ReportType;
        if (REPORT_TYPES.includes(selected)) draft.type = selected;
      } else if (m.replyId?.startsWith('rep:loc:')) {
        const selected = m.replyId.slice(8);
        if (index?.points.some(p => p.id === selected) || ['door_departures', 'U_SECURITY_QUEUE'].includes(selected)) draft.node = selected;
      } else if (!m.replyId?.startsWith('rep:page:')) {
        draft.type ??= classifyReportType(m.text);
        draft.node ??= mentioned ?? resolveLandmark(m.text, index) ?? matchNode(m.text, this.view.flights()) ?? undefined;
        if (!draft.text && !/^(raportează|raporteaza|raport|report)[.! ]*$/i.test(m.text)) draft.text = m.text;
      }
      if (profile.role === 'staff' && draft.type === 'crowd') draft.node ??= profile.zone;
      await this.store.put(reportKey, draft);
      if (!draft.type) {
        const names = en ? ['Security', 'Medical', 'Cleaning', 'Lost item', 'Crowd', 'Other'] : ['Securitate', 'Medical', 'Curățenie', 'Obiect pierdut', 'Aglomerare', 'Altele'];
        for (const offset of [0, 3]) await transport.sendButtons(m.phone, en ? 'Type' : 'Tip', REPORT_TYPES.slice(offset, offset + 3).map((type, i) => ({ id: `rep:type:${type}`, title: names[offset + i]! })));
        return;
      }
      if (!draft.node) {
        const choices = index?.points ?? [{ id: 'door_departures', name: { ro: 'Intrare plecări', en: 'Entrance' } }, { id: 'U_SECURITY_QUEUE', name: { ro: 'Securitate', en: 'Security' } }];
        const offset = m.replyId?.startsWith('rep:page:') ? Number(m.replyId.slice(9)) || 0 : 0;
        await transport.sendButtons(m.phone, en ? 'Place' : 'Reper', [...choices.slice(offset, offset + 2).map(p => ({ id: `rep:loc:${p.id}`, title: p.name[en ? 'en' : 'ro'].slice(0, 20) })),
          { id: `rep:page:${offset + 2 < choices.length ? offset + 2 : 0}`, title: en ? 'More' : 'Alte repere' }]);
        return;
      }
      if (!draft.text) { await transport.sendText(m.phone, en ? 'Description' : 'Descriere'); return; }
      const path = route(terminalGraph,
        'team_post', draft.node, zoneDensities(this.view.flow(), zoneAreas), this.view.blocked?.());
      const reported = await this.reports.add({ kind: kindForType(draft.type), type: draft.type, node: draft.node,
        place: { node: draft.node, name: index?.points.find(p => p.id === draft!.node)?.name[en ? 'en' : 'ro'] ?? draft.node },
        text: draft.text, photo: draft.photo, phone: m.phone, source: profile.role, etaMin: draft.type === 'crowd' ? null : path ? Math.ceil(path.totalSec / 60) : null }, Date.now(), channel === 'whatsapp' && !(profile.role === 'staff' && draft.type === 'crowd'));
      if (profile.role === 'staff' && draft.type === 'crowd') await transport.sendText(m.phone, en ? 'Passed on. Dispatch decides.' : 'Am transmis. Dispeceratul decide.');
      if (channel === 'web' && !(profile.role === 'staff' && draft.type === 'crowd')) await transport.sendText(m.phone, `${reported.id} · ${reportStateLabel(reported.state, en)}${reported.etaMin == null ? '' : ` · ETA ~${reported.etaMin} min`}`);
      if (draft.type === 'lost item') await transport.sendText(m.phone, en ? `${/security|securitate/i.test(draft.text) ? 'Items lost at security are kept by security staff. ' : ''}Lost & Found is at Information. I passed your description and location on to staff.`
          : `${/security|securitate/i.test(draft.text) ? 'Obiectele pierdute la securitate sunt păstrate de personalul de securitate. ' : ''}Lost & Found este la Informații. Am transmis personalului descrierea și locul.`);
      await this.store.delete(reportKey);
      return;
    }
    // A tap on the bag question: save it, then ask the agent the question it was for.
    let text = m.text;
    if (m.replyId === 'bag:yes' || m.replyId === 'bag:no') {
      await save({ hasCheckedBag: m.replyId === 'bag:yes' });
      text = say(profile.lang, m.replyId === 'bag:yes' ? 'bagQueryYes' : 'bagQueryNo');
    }

    const landmark = m.replyId?.startsWith('loc:') ? m.replyId.slice(4) : resolveLandmark(text, /sunt|aflu|from|at |check|duty|hol|poart|gate|intrare|entrance/i.test(text) ? await this.images.index() : null);
    const statedLandmark = landmark && (profile.pendingRoute || !/wc|toalet|toilet|food|eat|cafe|coffee|atm|info|duty/i.test(text) || /sunt la|sunt in|ma aflu|from |i am at|i'm at/i.test(text)) ? landmark : undefined;
    if (statedLandmark) await save({ position: { node: statedLandmark, at: this.view.clock().now * 1000 } });
    const pending = landmark ? profile.pendingRoute : undefined;
    await save(extractFacts(redact(text)));
    const lastQuestion = ctx.history.filter(e => e.role === 'clarion').at(-1)?.text ?? '';
    if (/bagaj de cală|checked baggage/i.test(lastQuestion) && /^(da|nu|yes|no)[.! ]*$/i.test(text.trim())) {
      await save({ hasCheckedBag: /^(da|yes)/i.test(text.trim()) });
      text = say(profile.lang, profile.hasCheckedBag ? 'bagQueryYes' : 'bagQueryNo');
    }
    const code = /\b([a-z][a-z0-9]|[0-9][a-z])\s?-?(\d{3,4})\b/i.exec(text)?.slice(1).join(' ').toUpperCase();
    const spokenFlight = code && findFlight(this.view.flights(), code);
    if (spokenFlight && profile.flight !== spokenFlight.flight && !text.includes('?')) await save({ flight: spokenFlight.flight, airline: spokenFlight.airline, gate: gateName(spokenFlight.gate), verified: false });
    const started = Date.now();
    const tools = toolsFor({ reports: () => this.reports.list(), routeIndex: () => this.images.index(), view: this.view, profile: () => profile, save, report: r => this.reports.add({ ...r, phone: m.phone, source: profile.role }, Date.now(), false), evacRoute: f => this.messaging.evacRouteFor(f),
      pageLink: async () => {
        const link = await this.messaging.pageLink({ channel: 'whatsapp', phone: m.phone });
        const stored = await this.profile(m.phone);
        if (stored?.pageToken) profile.pageToken = stored.pageToken;
        return link;
      } });
    let waitEstimate: Profile['lastWaitEstimate'];
    let routeResult: any;
    const trackedTools = Object.fromEntries(Object.entries(tools).map(([name, fn]) => [name, async (input: any) => {
      this.traces.get(m.phone.replace(/^\+/, ''))?.tools.push(name);
      const result = await fn(name === 'routeTo' && statedLandmark ? { ...input, from: statedLandmark } : input);
      if (name === 'routeTo') routeResult = result;
      if (name === 'whenToArrive' && typeof (result as any)?.totalMin === 'number') waitEstimate = { at: clockText(this.view.clock().now), totalMin: (result as any).totalMin };
      const note = lookupNote(name, result);
      if (note) ctx.notes = [...(ctx.notes ?? []), { at: clockText(this.view.clock().now), tool: name, note }].slice(-NOTES_MAX);
      return result;
    }]));
    const answer = pending ? await (async () => {
      const r = await trackedTools.routeTo!({ ...pending, from: landmark });
      const result = r as any;
      return { bubbles: [result.note, ...(result.link ? [result.link] : [])], used: ['routeTo'] };
    })() : await reply({ env: this.env, fetcher: this.fetcher, profile, clock: this.view.clock(), history: ctx.history, memory: ctx, text: redact(text), tools: trackedTools, onError: async error => { await this.observe?.({ kind: 'agent-error', phone: m.phone, text: error }); } });
    const { used } = answer;
    const bubbles = ((routeResult?.status === 'needs_location' || (!urgent && routeResult?.status === 'ready')) ? [routeResult.note, ...(routeResult.link ? [routeResult.link] : [])] : answer.bubbles).map(passengerText).filter(Boolean);
    if (quick && !bubbles.some(reactionOf)) await transport.sendReaction(m.phone, m.id, '');
    const bagChoice = profile.hasCheckedBag === undefined && bubbles.some(b => b.includes(say(profile.lang, 'bagQuestion')));
    const delivered = routeResult?.status === 'needs_location'
      ? (await transport.sendButtons(m.phone, routeResult.note, routeResult.buttons)).ok
      : bagChoice ? await (async () => {
        const short = bubbles.flatMap(b => passengerBubbles(b));
        const prompt = short.find(b => b.includes(say(profile.lang, 'bagQuestion')))!;
        const other = short.filter(b => b !== prompt);
        const sent = !other.length || await transport.sendReplies(m.phone, other, m.id);
        const choice = await transport.sendButtons(m.phone, prompt, [{ id: 'bag:yes', title: say(profile.lang, 'bagYes') }, { id: 'bag:no', title: say(profile.lang, 'bagNo') }]);
        return sent && choice.ok;
      })() : await transport.sendReplies(m.phone, bubbles, m.id);
    if (delivered && ['ready', 'evacuation'].includes(routeResult?.status)) {
      try {
        const evacuation = await this.store.get<{ active: boolean; zones: string[] }>('msg:evacuation');
        if (evacuation?.active || routeResult.status === 'evacuation') {
          const live = await this.messaging.evacRouteFor(profile.flight ? findFlight(this.view.flights(), profile.flight) : undefined);
          const candidates = [routeResult.from, ...(evacuation?.zones ?? [])];
          for (const zone of candidates) {
            const image = await this.images.evacuation(zone);
            if (!image?.link || (live && mapNodeId(image.exit) !== mapNodeId(live.exit))) continue;
            await transport.sendImage(m.phone, image.link, profile.lang === 'en' ? 'Evacuation route' : 'Traseu de evacuare');
            break;
          }
        } else {
          const blocked = [...(this.view.blocked?.() ?? []), ...Object.entries(zoneDensities(this.view.flow(), zoneAreas)).filter(([, density]) => density >= 5.4).map(([zone]) => zone)];
          const image = await this.images.image(routeResult.from, routeResult.to, routeResult, blocked);
          if (image) await transport.sendImage(m.phone, image.link, `${routeResult.destination} · ~${Math.ceil(image.walkSec / 60)} min`);
        }
      } catch { /* Text delivery must never depend on a preview. */ }
    }
    if (delivered && waitEstimate) await save({ lastWaitEstimate: waitEstimate });
    if (!initiallyBound && profile.flight) {
      const flight = findFlight(this.view.flights(), profile.flight);
      if (flight) {
        if (channel === 'web') await transport.sendText(m.phone, this.messaging.arriveText(flight, profile.hasCheckedBag, profile.lang));
        else await this.messaging.arrive({ channel: 'whatsapp', phone: m.phone }, flight, profile.hasCheckedBag);
      }
    }
    await persistContext();
    console.log(JSON.stringify({ wa: 'turn', id: m.id, tools: used, bubbles: bubbles.length, ms: Date.now() - started }));
  }
}
