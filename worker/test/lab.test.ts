import { describe, expect, it } from 'vitest';
import { check, matchesLanguage, MAX_BUBBLE_CHARS, runLab, SCRIPTS, validateInput, type LabTurn } from '../src/wa/lab.js';
import { labPage } from '../src/wa/labpage.js';
import { metaExplanation, safeText, WaEvents } from '../src/wa/events.js';

const turn = (patch: Partial<LabTurn> = {}): LabTurn => ({ user: 'Salut', replies: ['Sunt Clarion, pentru informații despre aeroport.'], tools: [], ms: 1, lang: 'ro', ...patch });
class Store {
  data = new Map<string, unknown>();
  async get<T>(k: string) { return this.data.get(k) as T | undefined; }
  async put(k: string, v: unknown) { this.data.set(k, structuredClone(v)); }
  async delete(k: string) { return this.data.delete(k); }
}
const view = { clock: () => ({ now: 8 * 3600, sim: true }), flow: () => ({}), provisional: () => true,
  flights: () => [{ flight: 'W6 3751', airline: 'W6', destination: 'Londra Luton', gate: 'gate_2', std: 10 * 3600, gateCloseAt: 9.5 * 3600, status: 'scheduled' as const, delayMin: 0, checkInDesks: ['check_in:1'], checkIn: 'check_in:1' }] };

describe('mechanical WhatsApp lab checks', () => {
  it('renders a self-contained page with valid browser JavaScript', () => {
    const script = labPage().match(/<script>([\s\S]*)<\/script>/)![1]!;
    expect(() => new Function(script)).not.toThrow();
  });
  it('accepts descriptive replies, reactions on non-urgent turns and isolated links', () => {
    expect(check([turn({ replies: ['[react]✈️', 'Poarta G2 este deschisă.', 'https://example.test/m/token'] })])).toEqual([]);
  });
  it('catches every advertised violation', () => {
    const broken = check([turn({ replies: [] }), turn({ replies: ['undefined null NaN U_SECURITY_QUEUE check_in:1 abonare abonează Pleacă acum!'], expectedTool: 'queues' }),
      turn({ lang: 'en' }), turn({ replies: ['The gate is open.'] }), turn({ replies: ['Sunt Clarion. '.repeat(MAX_BUBBLE_CHARS)] }),
      turn({ replies: Array(5).fill('Poarta este deschisă.') }), turn({ urgent: true, replies: ['[react]✈️', 'Poarta este deschisă 🧳'] }),
      turn({ unknown: true }), turn({ errors: ['Provider failed'] })]).map(v => v.rule);
    for (const rule of ['non-empty', 'invalid-value', 'raw-id', 'abonare', 'orders', 'language', 'bubble-length', 'bubble-count', 'urgent-emoji', 'expected-tool', 'unknown-fact', 'agent-error']) expect(broken).toContain(rule);
  });
  it('allows direct evacuation instructions but forbids reactions, flags and keycaps', () => {
    expect(check([turn({ evacuate: true, urgent: true, replies: ['Mergi spre ieșire.'] })])).toEqual([]);
    for (const e of ['🇷🇴', '1️⃣', '[react]']) expect(check([turn({ urgent: true, replies: [e] })]).map(v => v.rule)).toContain('urgent-emoji');
  });
  it('checks language per bubble and ignores URL text', () => {
    expect(matchesLanguage('The security queue is now 12 minutes.', 'en')).toBe(true);
    expect(matchesLanguage('Securitate: 12 minute acum.', 'en')).toBe(false);
    expect(matchesLanguage('The gate is open.', 'ro')).toBe(false);
    expect(matchesLanguage('https://example.test/airport', 'ro')).toBe(true);
  });
  it('rejects malformed inputs and prototype script names', () => {
    for (const input of [null, [], { script: '__proto__' }, { script: 'constructor' }, { texts: [] }, { texts: [2] }, { texts: [''] }, { texts: Array(21).fill('hi') }, { keep: 'yes' }, { script: 'gate', texts: ['hi'] }]) expect(() => validateInput(input)).toThrow();
  });
});
describe('isolated lab mechanism', () => {
  it('runs all scripts through real tools, captures all sends and leaves real storage untouched', async () => {
    const store = new Store(); await store.put('wa:profile:+40712345678', { name: 'real' });
    const before = [...store.data];
    const report = await runLab({}, view, {}, store, async () => { throw Error('Unexpected network access'); });
    expect(Object.keys(report.results)).toEqual(Object.keys(SCRIPTS));
    expect(new Set(Object.values(report.results).map(r => r.phone)).size).toBe(Object.keys(SCRIPTS).length);
    expect([...store.data]).toEqual(before);
    expect(report.results.startFlight!.stored.profile).toMatchObject({ verified: true });
    expect(report.results.staffIssue!.transcript.at(-1)!.tools).toContain('reportIssue');
    expect(report.results.evacuation!.transcript.at(-1)!.replies.join(' ')).toMatch(/evacua/i);
    expect(report.pass, JSON.stringify(report.failed.map(n => [n, report.results[n]!.violations]))).toBe(true);
  });
  it('captures model errors and turns them into failed checks without sending Graph traffic', async () => {
    const report = await runLab({ ANTHROPIC_API_KEY: 'test' }, view, { texts: ['Cât se așteaptă la securitate?'] }, new Store(), async () => { throw Error('Model unavailable'); });
    expect(report.pass).toBe(false);
    expect(report.results.custom!.violations).toEqual(expect.arrayContaining([expect.objectContaining({ rule: 'agent-error', detail: 'Model unavailable' })]));
  });
  it('retains state only in the separate lab namespace when keep is requested', async () => {
    const store = new Store();
    const r = await runLab({}, view, { texts: ['English'], keep: true }, store);
    const phone = r.results.custom!.phone;
    expect([...store.data.keys()]).toEqual([`lab:kept:${phone}`]);
    expect(r.results.custom!.stored.profile?.lang).toBe('en');
  });
});
describe('real traffic event ring', () => {
  it('caps concurrent events, persists across instances and masks phone-like text', async () => {
    const store = new Store(); const ring = new WaEvents(store);
    await Promise.all(Array.from({ length: 205 }, (_, i) => ring.record({ kind: 'inbound', phone: '+40712345678', text: `${i} Call +40712345678 ${'x'.repeat(300)}` })));
    const rows = await new WaEvents(store).list();
    expect(rows).toHaveLength(200);
    expect(rows[0]!.text).toMatch(/^5 Call/);
    expect(JSON.stringify(rows)).not.toContain('40712345');
    expect(rows.every(r => r.phone === '•••678' && r.text!.length <= 200)).toBe(true);
    expect(safeText('hello +40 712 345 678')).toBe('hello •••678');
  });
  it.each([131030, 131047, 131026, 190, 131009])('explains Meta code %s', code => {
    expect(metaExplanation(code)).not.toContain('inspect');
  });
});
