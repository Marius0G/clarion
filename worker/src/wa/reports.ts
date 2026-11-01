// Shared D11/D34 reports: WhatsApp and web write the same lifecycle and journal records.
import type { Flight } from './flights.js';
import type { WaStore } from './index.js';

export const ISSUE_KINDS = ['bagaj_abandonat', 'medical', 'securitate', 'aglomerare', 'altele'] as const;
export type IssueKind = typeof ISSUE_KINDS[number];
export { RO_ISSUES as ISSUE_LABELS } from './texts.js';
export const REPORT_TYPES = ['security', 'medical', 'cleaning', 'lost item', 'crowd', 'other'] as const;
export type ReportType = typeof REPORT_TYPES[number];
export type ReportState = 'sent' | 'taken' | 'en_route' | 'resolved';
export interface Report {
  id: string; at: string; kind: IssueKind; node: string | null; text: string; status: 'open' | 'closed';
  source: 'passenger' | 'staff'; phone: string; type: ReportType; place: { node: string | null; name: string };
  photo?: string; priority: 'P1' | 'P2' | 'P3'; state: ReportState;
  timestamps: Partial<Record<ReportState, string>>; etaMin?: number | null; policeEtaMin?: number | null;
}
export type ReportInput = Pick<Report, 'kind' | 'node' | 'text'> & Partial<Pick<Report, 'source' | 'phone' | 'type' | 'place' | 'photo' | 'etaMin' | 'policeEtaMin'>>;
export const reportPriority = (type: ReportType) => type === 'security' || type === 'medical' ? 'P1' : type === 'crowd' ? 'P2' : 'P3';
export const typeForKind = (kind: IssueKind): ReportType => ({ bagaj_abandonat: 'security', securitate: 'security', medical: 'medical', aglomerare: 'crowd', altele: 'other' } as const)[kind];
export const kindForType = (type: ReportType): IssueKind => type === 'security' ? 'securitate' : type === 'medical' ? 'medical' : type === 'crowd' ? 'aglomerare' : 'altele';
export const reportStateLabel = (state: ReportState, en = false) => (en
  ? { sent: 'Sent', taken: 'Taken', en_route: 'Team en route', resolved: 'Resolved' }
  : { sent: 'Trimis', taken: 'Preluat', en_route: 'Echipa pe drum', resolved: 'Rezolvat' })[state];
const locks = new WeakMap<WaStore, Promise<unknown>>();

const fold = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ş/g, 's').replace(/ţ/g, 't');

/** Keyword guess at the kind, for the no-LLM path and when the model leaves it out. */
export function classifyIssue(text: string): IssueKind {
  const t = fold(text);
  if (/unattended.*bag|abandoned.*bag|suspicious.*bag|bag.*(?:unattended|abandoned|suspicious)/.test(t)) return 'bagaj_abandonat';
  if (/(bagaj|valiz|geant|rucsac|colet|pachet)\w*.*(abandon|lasat|singur|nesupravegh|suspect)|(abandon|nesupravegh|suspect)\w*.*(bagaj|valiz|geant|rucsac|colet|pachet)/.test(t)) return 'bagaj_abandonat';
  if (/(faint|injur|bleed|not breathing|heart attack|lesin|lesinat|medic|ranit|sange|infarct|nu respira|cazut|a cazut|ambulant|rau\b|criza)/.test(t)) return 'medical';
  if (/(fight|weapon|knife|threat|theft|bataie|scandal|agresiv|arma|cutit|amenint|furt|fura|violent|intrus|securitate)/.test(t)) return 'securitate';
  if (/(crowded|overcrowd|crush|aglomer|coada|multime|inghesu|imbulzeal|prea multa lume|blocat)/.test(t)) return 'aglomerare';
  return 'altele';
}
export function classifyReportType(text: string): ReportType | undefined {
  const t = fold(text);
  if (/murdar|curaten|varsat|gunoi|dirty|spill|cleaning/.test(t)) return 'cleaning';
  if (/pierdut|pierduta|lost|uitat/.test(t)) return 'lost item';
  const kind = classifyIssue(text);
  return kind === 'altele' ? undefined : typeForKind(kind);
}
export function clearProblem(text: string) {
  return /raporte[az]|raport|report|bataie|lesin|ranit|nu respira|agresiv|arma|cutit|abandonat|suspect|murdar|varsat|gunoi|am pierdut|i lost|fight|faint|injur|bleed|not breathing|weapon|knife|unattended|abandoned|overcrowd|dirty|spill|prea aglomerat|inghesu|imbulzeal/i.test(fold(text));
}
export const isIssueKind = (v: unknown): v is IssueKind => (ISSUE_KINDS as readonly string[]).includes(v as string);

/**
 * Best-match zone/node id for a free-text place. PROVISIONAL ids, the same ones the dashboard plan and flow.report use
 * (entrance, check_in:<group>, bag_drop:<group>, security, airside, gate_<n>, exit_<n>); terminal.json (D7) will replace them.
 * An airline named without a group ("check-in Wizz") resolves through the flights to that airline's desk group (D8).
 */
export function matchNode(text: string, flights: readonly Flight[] = []): string | null {
  const t = fold(text);
  const num = (re: RegExp) => re.exec(t)?.[1];
  const gate = num(/(?:poart\w*|gate)\s*(?:nr\.?|numarul)?\s*(\d{1,2})/);
  if (gate) return `gate_${gate}`;
  const exit = num(/iesir\w*\s*(?:de urgenta\s*)?(\d{1,2})/);
  if (exit) return `exit_${exit}`;
  const group = (base: 'check_in' | 'bag_drop', re: RegExp) => {
    const n = num(re);
    if (n) return `${base}:${n}`;
    const airline = /\b(wizz|w6)\b/.test(t) ? 'W6' : /\b(tarom|ro)\b/.test(t) ? 'RO' : /\b(ryanair|fr)\b/.test(t) ? 'FR' : null;
    const served = airline && flights.find(f => f.airline === airline && f.checkIn)?.checkIn;
    if (served) return base === 'check_in' ? served : served.replace(/^check_in:/, 'bag_drop:');
    return `${base}:1`;
  };
  if (/(bag(aj)?\s*drop|predare\w* bagaj)/.test(t)) return group('bag_drop', /(?:bag\s*drop|predare\w* bagaj\w*)\s*(?:grup\w*|ghiseu\w*)?\s*(\d{1,2})/);
  if (/check[\s-]?in|ghiseu/.test(t)) return group('check_in', /(?:check[\s-]?in|ghiseu\w*)\s*(?:grup\w*)?\s*(\d{1,2})/);
  if (/(securitate|control|scanner|filtru)/.test(t)) return 'security';
  if (/(intrare|usa principala|hol)/.test(t)) return 'entrance';
  if (/(iesire|exit)/.test(t)) return 'exit_1';
  if (/(duty|zona de plecari|plecari|airside|imbarcare)/.test(t)) return 'airside';
  return null;
}

const KEY = 'reports';
const KEEP = 200;

/** Reports in Durable Object storage, newest last. */
export class Reports {
  constructor(private store: WaStore, private changed?: (reports: Report[]) => void,
    private notify?: (report: Report) => Promise<void>) {}
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = (locks.get(this.store) ?? Promise.resolve()).then(work);
    locks.set(this.store, next.catch(() => {}));
    return next;
  }
  async reset() {
    return this.serial(async () => { const reports = (await this.list()).length; await this.store.delete(KEY); return { reports }; });
  }
  async list(): Promise<Report[]> {
    return ((await this.store.get<Report[]>(KEY)) ?? []).map(r => ({ ...r,
      source: r.source ?? 'staff', phone: r.phone ?? '', type: r.type ?? typeForKind(r.kind),
      place: r.place ?? { node: r.node, name: r.node ?? '' }, priority: r.priority ?? reportPriority(r.type ?? typeForKind(r.kind)),
      state: r.state ?? (r.status === 'closed' ? 'resolved' : 'sent'), timestamps: r.timestamps ?? { sent: r.at },
      etaMin: r.etaMin ?? null, policeEtaMin: r.policeEtaMin ?? null }));
  }
  async own(phone: string) { return (await this.list()).filter(r => r.phone.replace(/^\+/, '') === phone.replace(/^\+/, '')); }
  add(input: ReportInput, now = Date.now(), notify = true): Promise<Report> {
    return this.serial(async () => {
      const all = await this.list();
      const type = input.type ?? typeForKind(input.kind);
      if (!REPORT_TYPES.includes(type) || !isIssueKind(input.kind) || !input.text.trim() || input.text.length > 500) throw new Error('Invalid report');
      const n = all.reduce((m, r) => Math.max(m, Number(r.id.replace(/^R/, '')) || 0), 0) + 1;
      const at = new Date(now).toISOString();
      const report: Report = { ...input, id: `R${n}`, at, type, source: input.source ?? 'staff', phone: input.phone ?? '',
        place: input.place ?? { node: input.node, name: input.node ?? '' }, priority: reportPriority(type),
        text: input.text.trim(), status: 'open', state: 'sent', timestamps: { sent: at },
        etaMin: input.etaMin ?? null, policeEtaMin: input.policeEtaMin ?? null };
      const rows = [...all, report].slice(-KEEP);
      await this.store.put(KEY, rows); this.changed?.(rows);
      if (notify) await this.notify?.(report);
      return report;
    });
  }
  transition(id: string, state: ReportState, now = Date.now()): Promise<Report | undefined> {
    return this.serial(async () => {
      const all = await this.list(), report = all.find(r => r.id === id);
      if (!report) return;
      if (report.state === state) return report;
      const next: Record<ReportState, ReportState | null> = { sent: 'taken', taken: 'en_route', en_route: 'resolved', resolved: null };
      if (next[report.state] !== state) throw new Error('Invalid report transition');
      report.state = state; report.status = state === 'resolved' ? 'closed' : 'open';
      report.timestamps[state] = new Date(now).toISOString();
      await this.store.put(KEY, all); this.changed?.(all);
      await this.notify?.(report);
      return report;
    });
  }
  /** Legacy close endpoint follows the same lifecycle, including notifications. */
  async close(id: string): Promise<Report | undefined> {
    let r = (await this.list()).find(r => r.id === id);
    if (!r) return;
    for (const state of ['taken', 'en_route', 'resolved'] as const) {
      if (['sent', 'taken', 'en_route', 'resolved'].indexOf(state) > ['sent', 'taken', 'en_route', 'resolved'].indexOf(r.state)) r = (await this.transition(id, state))!;
    }
    return r;
  }
}
