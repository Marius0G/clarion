// Staff reports (SPEC-v2 D11): an employee writes freely on WhatsApp, the agent extracts the kind and the place,
// the report is stored and read by the dashboard (GET /api/reports) as a pin on the map.
import type { Flight } from './flights.js';
import type { WaStore } from './index.js';

export const ISSUE_KINDS = ['bagaj_abandonat', 'medical', 'securitate', 'aglomerare', 'altele'] as const;
export type IssueKind = typeof ISSUE_KINDS[number];
export { RO_ISSUES as ISSUE_LABELS } from './texts.js';
/** The exact shape the dashboard pins read. */
export interface Report { id: string; at: string; kind: IssueKind; node: string | null; text: string; status: 'open' | 'closed'; etaMin?: number | null }

const fold = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ş/g, 's').replace(/ţ/g, 't');

/** Keyword guess at the kind, for the no-LLM path and when the model leaves it out. */
export function classifyIssue(text: string): IssueKind {
  const t = fold(text);
  if (/(bagaj|valiz|geant|rucsac|colet|pachet)\w*.*(abandon|lasat|singur|nesupravegh|suspect)|(abandon|nesupravegh|suspect)\w*.*(bagaj|valiz|geant|rucsac|colet|pachet)/.test(t)) return 'bagaj_abandonat';
  if (/(lesin|lesinat|medic|ranit|sange|infarct|nu respira|cazut|a cazut|ambulant|rau\b|criza)/.test(t)) return 'medical';
  if (/(bataie|scandal|agresiv|arma|cutit|amenint|furt|fura|violent|intrus|securitate)/.test(t)) return 'securitate';
  if (/(aglomer|coada|multime|inghesu|imbulzeal|prea multa lume|blocat)/.test(t)) return 'aglomerare';
  return 'altele';
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
  constructor(private store: WaStore) {}
  async reset() {
    const reports = (await this.list()).length;
    // IDs are derived from the stored list, so deleting it also resets the counter.
    await this.store.delete(KEY);
    return { reports };
  }
  async list(): Promise<Report[]> { return ((await this.store.get<Report[]>(KEY)) ?? []).map(r => ({ ...r, etaMin: r.etaMin ?? null })); }
  async add(input: { kind: IssueKind; node: string | null; text: string; etaMin?: number | null }, now = Date.now()): Promise<Report> {
    const all = await this.list();
    const n = all.reduce((m, r) => Math.max(m, Number(r.id.replace(/^R/, '')) || 0), 0) + 1;
    const report: Report = { id: `R${n}`, at: new Date(now).toISOString(), kind: input.kind, node: input.node, text: input.text.slice(0, 500), status: 'open', etaMin: input.etaMin ?? null };
    await this.store.put(KEY, [...all, report].slice(-KEEP));
    return report;
  }
  async close(id: string): Promise<Report | undefined> {
    const all = await this.list();
    const report = all.find(r => r.id === id);
    if (!report) return undefined;
    report.status = 'closed';
    await this.store.put(KEY, all);
    return report;
  }
}
