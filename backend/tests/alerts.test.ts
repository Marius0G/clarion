import { describe, expect, it } from 'vitest';
import { Alerts, alertCommand, densityThreshold, type AlertInput } from '../src/alerts.js';
import type { FlowRow, TerminalFlight } from '../src/sim.js';
const row = (extra: Partial<FlowRow> = {}): FlowRow => ({ source: 'vision', waiting: 20, waitMin: 0, coverage: 1, density: 0,
  stale: false, forecast: [], waitingSd: null, waitMinP90: null, peak: 20, updatedAt: '', capacity: null, staff: null, advice: null, ...extra });
const flight = (extra: Partial<TerminalFlight> = {}): TerminalFlight => ({ flight: 'W4 1', airline: 'W4', destination: 'Roma', gate: 'gate_1', checkIn: 'check_in:1', std: 4600, gateCloseAt: 4000, status: 'scheduled', delayMin: 0, pax: 180, checkInDesks: [], ...extra });
const input = (extra: Partial<AlertInput> = {}): AlertInput => ({ simTime: 1000, flow: {}, flights: [], reports: [], ...extra });


describe('D32 camera triggers', () => {
  it.each(['security', 'U_SECURITY_QUEUE', 'check_in:1', 'bag_drop:2'])('uses the D20 target for %s', zone => {
    const alerts = new Alerts();
    const target = zone.includes('SECURITY') || zone === 'security' ? 10 : 15;
    expect(alerts.update(input({ flow: { [zone]: row({ waitMin: target }) } }))).toEqual([]);
    expect(alerts.update(input({ flow: { [zone]: { ...row({ waitMin: target + 1 }), adviceId: 'A7-1' } } }))[0]).toMatchObject({ kind: 'zone-target', priority: 'P2', adviceId: 'A7-1', numbers: { targetMin: target } });
  });
  it('uses only positive forecast horizons through 60 minutes, selecting the first exceedance', () => {
    const alerts = new Alerts();
    expect(alerts.update(input({ flow: { security: row({ forecast: [{ inMin: 0, waitMin: 99 }, { inMin: 61, waitMin: 99 }, { inMin: 30, waitMin: 10 }] }) } }))).toEqual([]);
    expect(alerts.update(input({ flow: { security: row({ forecast: [{ inMin: 60, waitMin: 30 }, { inMin: 30, waitMin: 11 }] }) } }))[0]).toMatchObject({ priority: 'P3', kind: 'forecast-target', numbers: { inMin: 30, at: 2800 } });
  });
  it.each([['airside', 3], ['U_CORRIDOR_EAST', 3], ['security', 5], ['gate_1', 5], ['check_in:1', 5]])('applies moving/standing density threshold in %s', (zone, threshold) => {
    const alerts = new Alerts();
    expect(densityThreshold(String(zone))).toBe(threshold);
    expect(alerts.update(input({ flow: { [zone]: row({ density: Number(threshold) }) } }))).toEqual([]);
    expect(alerts.update(input({ flow: { [zone]: row({ density: Number(threshold) + 0.1 }) } }))[0]).toMatchObject({ priority: 'P1', kind: 'density' });
  });
  it('raises camera loss, suppresses stale hazard numbers, and clears after recovery', () => {
    const alerts = new Alerts();
    const [lost] = alerts.update(input({ flow: { security: row({ stale: true, density: 9, waitMin: 99 }) } }));
    expect(lost).toMatchObject({ priority: 'P3', kind: 'camera-loss', active: true });
    expect(alerts.update(input({ flow: { security: row() } }))[0]).toMatchObject({ active: false, state: 'cleared-unacked' });
    expect(new Alerts().update(input({ flow: { security: row({ coverage: 0 }) } }))[0]?.kind).toBe('camera-loss');
    expect(new Alerts().update(input({ flow: { security: row({ source: 'twin', stale: true, density: 10 }) } }))).toEqual([]);
  });
  it('deduplicates physical aliases but keeps bag drop separate from check-in', () => {
    const alerts = new Alerts();
    const list = alerts.update(input({ flow: { security: row({ waitMin: 12 }), U_SECURITY_QUEUE: row({ waitMin: 12 }), 'check_in:1': row({ waitMin: 20 }), 'bag_drop:1': row({ waitMin: 20 }) } }));
    expect(list).toHaveLength(3);
    const ids = list.map(a => a.id);
    expect(alerts.update(input({ simTime: 1010, flow: { security: row({ waitMin: 13 }) } })).map(a => a.id)).toEqual(ids);
  });
});
describe('staff reports and flight risk', () => {
  const report = { id: 'R1', kind: 'medical', node: 'security', text: 'Ajutor', status: 'open' as const };
  it.each([['securitate', 'P1'], ['bagaj_abandonat', 'P1'], ['medical', 'P2'], ['aglomerare', 'P2']])('prioritizes %s as %s', (kind, priority) => {
    expect(new Alerts().update(input({ reports: [{ ...report, kind }] }))[0]).toMatchObject({ priority, createdAt: 1000 });
  });
  it('deduplicates reports by kind/zone, reannounces new reports, clears when closed', () => {
    const alerts = new Alerts();
    const [a] = alerts.update(input({ reports: [report] }));
    alerts.command({ type: 'ack', id: a!.id }, 1001);
    expect(alerts.update(input({ reports: [report] }))[0]?.state).toBe('acked');
    const added = alerts.update(input({ simTime: 1010, reports: [report, { ...report, id: 'R2' }] }));
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ state: 'unacked', updatedAt: 1010, numbers: { reports: 2 } });
    expect(alerts.update(input({ reports: [{ ...report, status: 'closed' }] }))[0]?.state).toBe('cleared-unacked');
  });
  it('estimates near-close risk from camera queues, honors delays, statuses, unknown cameras and pax cap', () => {
    const data = input({ simTime: 3500, flow: { security: row({ waitMin: 10, waiting: 250 }) }, flights: [flight()] });
    expect(new Alerts().update(data).find(a => a.kind === 'flight-risk')).toMatchObject({ priority: 'P2', flight: 'W4 1', numbers: { estimatedBeforeSecurity: 180, estimated: 1 } });
    for (const f of [flight({ delayMin: 60 }), flight({ status: 'cancelled' }), flight({ status: 'departed' }), flight({ pax: 0 }), flight({ gateCloseAt: 3000 })])
      expect(new Alerts().update({ ...data, flights: [f] }).filter(a => a.kind === 'flight-risk')).toEqual([]);
    for (const r of [row({ waiting: 0 }), row({ stale: true }), row({ coverage: 0 }), row({ source: 'twin' })])
      expect(new Alerts().update({ ...data, flow: { security: r } }).filter(a => a.kind === 'flight-risk')).toEqual([]);
    expect(new Alerts().update({ ...data, flights: [flight({ gateCloseAt: '01:06:40' })] }).some(a => a.kind === 'flight-risk')).toBe(true);
  });
});
describe('ISA-18.2 lifecycle', () => {
  const hot = { security: row({ waitMin: 20 }) };
  it('retains unacked clearance, acknowledges clearance, re-arms recurrence and keeps original creation time', () => {
    const alerts = new Alerts();
    const [a] = alerts.update(input({ flow: hot }));
    expect(alerts.update(input({ simTime: 1010 }))[0]).toMatchObject({ state: 'cleared-unacked', active: false, createdAt: 1000, updatedAt: 1010 });
    expect(alerts.command({ type: 'ack', id: a!.id }, 1020)).toMatchObject({ state: 'acked', active: false });
    expect(alerts.update(input({ simTime: 1030, flow: hot }))[0]).toMatchObject({ id: a!.id, state: 'unacked', active: true, createdAt: 1000, updatedAt: 1030 });
  });
  it('keeps acknowledgement while active, preserves it on clearance, and returns defensive snapshots', () => {
    const alerts = new Alerts();
    const [a] = alerts.update(input({ flow: hot }));
    alerts.command({ type: 'ack', id: a!.id }, 1001);
    expect(alerts.update(input({ flow: hot, simTime: 1002 }))[0]?.updatedAt).toBe(1001);
    const list = alerts.update(input({ simTime: 1010 }));
    expect(list[0]).toMatchObject({ state: 'acked', active: false });
    list[0]!.state = 'unacked';
    expect(alerts.snapshot()[0]?.state).toBe('acked');
  });
  it.each([true, false])('expires shelving on simTime, active=%s', active => {
    const alerts = new Alerts();
    const [a] = alerts.update(input({ flow: hot }));
    expect(alerts.command({ type: 'shelve', id: a!.id, durationSec: 60, reason: 'Verificare' }, 1000)).toMatchObject({ state: 'shelved', shelvedUntil: 1060, shelveReason: 'Verificare' });
    expect(alerts.update(input({ simTime: 1059, flow: active ? hot : {} }))[0]?.state).toBe('shelved');
    expect(alerts.update(input({ simTime: 1060, flow: active ? hot : {} }))[0]).toMatchObject({ state: active ? 'unacked' : 'cleared-unacked', shelvedUntil: null, shelveReason: null, updatedAt: 1060 });
  });
  it('acknowledges shelved alerts and validates unknown ids, duration and reason', () => {
    const alerts = new Alerts();
    const [a] = alerts.update(input({ flow: hot }));
    alerts.command(alertCommand({ type: 'shelve', id: a!.id, durationSec: 10, reason: ' Control ' }), 1000);
    expect(alerts.command({ type: 'ack', id: a!.id }, 1001)).toMatchObject({ state: 'acked', shelvedUntil: null });
    expect(() => alerts.command({ type: 'ack', id: 'missing' }, 1000)).toThrow('Unknown alert');
    for (const d of [null, {}, { type: 'ack', id: '' }, ...[0, -1, Infinity, 86401].map(durationSec => ({ type: 'shelve', id: 'a', durationSec, reason: 'x' })), { type: 'shelve', id: 'a', durationSec: 1, reason: ' ' }]) expect(() => alertCommand(d)).toThrow('Invalid alert command');
    alerts.reset(); expect(alerts.snapshot()).toEqual([]);
  });
});
