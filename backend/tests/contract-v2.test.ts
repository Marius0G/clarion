import { describe, it, expect, vi } from 'vitest';
import { Engine } from '../src/engine.js';
import { engineRuntime } from '../src/runtime.js';
import { agentRoute, FLOW_STALE_MS, opsCommand, opsWire, SimStore } from '../src/sim.js';
import { initialLanes } from '../src/terminal.js';
const event = (type: string, data = {}) => ({ type, ts: new Date().toISOString(), data });
const snap = (e: Engine) => e.sim.snapshot(true, {}) as any;
const zone = (zone: string, waiting: number, extra = {}) => ({ zone, waiting, ...extra });
const flight = (extra = {}) => ({ flight: 'W6 3751', airline: 'W6', destination: 'London Luton', std: 52200, gate: 'gate_1', checkInDesks: ['check_in:W6'], gateCloseAt: 51000, status: 'scheduled', delayMin: 0, pax: 180, ...extra });

describe('flow.report v2 (D0, D5b, D8)', () => {
  it('accepts any terminal.json zone id, coverage, forecast, the A3/A4 fields and advice', async () => {
    const e = new Engine();
    await e.handle(event('flow.report', { zones: [
      zone('check_in:2', 40, { waitMin: 12, coverage: 0.8, waitingSd: 3.5, density: 1.2, waitMinP90: 17, forecast: [{ inMin: 30, waitMin: 15 }, { inMin: 60, waitMin: 20 }], advice: { lanes: 3, by: 50700, waitMinIfNot: 18 } }),
      zone('bag_drop:2', 8), zone('security', 60, { forecast: null, coverage: null, advice: 'Deschide o linie până la 14:05' }), zone('gate_3', 5, { advice: { lanes: 1, by: '14:05', waitMin: 9 } }),
    ] }), 'vision');
    const flow = snap(e).flow;
    expect(flow['check_in:2']).toEqual({ waiting: 40, waitMin: 12, coverage: 0.8, waitingSd: 3.5, density: 1.2, waitMinP90: 17, forecast: [{ inMin: 30, waitMin: 15 }, { inMin: 60, waitMin: 20 }],
      advice: { lanes: 3, by: 50700, waitMinIfNot: 18 }, peak: 40, updatedAt: expect.any(String), stale: false, source: 'vision', capacity: null, staff: null });
    expect(flow['bag_drop:2']).toMatchObject({ waiting: 8, waitMin: null, coverage: null, waitingSd: null, density: null, waitMinP90: null, forecast: null, advice: null });
    expect(flow.security.advice).toBe('Deschide o linie până la 14:05');
    expect(flow.gate_3.advice).toEqual({ lanes: 1, by: '14:05', waitMinIfNot: 9 });
  });
  it('keeps accepting legacy staff/capacity from a Unity build', async () => {
    const e = new Engine();
    await e.handle(event('flow.report', { zones: [zone('check_in:W6', 40, { capacity: 50, staff: 3 }), zone('bag_drop:ro', 8, { staff: 1 })] }), 'twin');
    expect(snap(e).flow).toMatchObject({ 'check_in:W6': { waiting: 40, capacity: 50, staff: 3, source: 'twin' }, 'bag_drop:RO': { waiting: 8, staff: 1 } });
  });
  it('rejects the whole report on any invalid field', async () => {
    const e = new Engine();
    for (const bad of [zone('Check_in:2', 1), zone('check in', 1), zone('2gate', 1), zone('check_in:', 1), zone('kerb', -1), zone('kerb', 1.5),
      zone('kerb', 1, { staff: -1 }), zone('kerb', 1, { staff: 1.5 }), zone('kerb', 1, { coverage: 1.2 }), zone('kerb', 1, { coverage: -0.1 }),
      zone('kerb', 1, { waitingSd: -1 }), zone('kerb', 1, { density: -1 }), zone('kerb', 1, { density: 99 }), zone('kerb', 1, { waitMinP90: 'x' }), zone('kerb', 1, { waitMin: -1 }),
      zone('kerb', 1, { advice: '' }), zone('kerb', 1, { advice: 'x'.repeat(201) }), zone('kerb', 1, { advice: [] }), zone('kerb', 1, { advice: { lanes: -1 } }), zone('kerb', 1, { advice: { lanes: 1.5 } }),
      zone('kerb', 1, { advice: { by: -5 } }), zone('kerb', 1, { advice: { waitMinIfNot: -2 } }),
      zone('kerb', 1, { forecast: {} }), zone('kerb', 1, { forecast: [{ inMin: 30 }] }), zone('kerb', 1, { forecast: [{ inMin: 30, waitMin: -1 }] }),
      zone('kerb', 1, { forecast: Array.from({ length: 13 }, (_, i) => ({ inMin: i, waitMin: 1 })) })])
      await expect(e.handle(event('flow.report', { zones: [zone('security', 1), bad] }), 'vision')).rejects.toThrow();
    // The same zone twice (two-letter suffixes are case-folded) is a duplicate.
    await expect(e.handle(event('flow.report', { zones: [zone('check_in:W6', 1), zone('check_in:w6', 2)] }), 'vision')).rejects.toThrow();
    await expect(e.handle(event('flow.report', { zones: [] }), 'vision')).rejects.toThrow();
    expect(snap(e).flow).toEqual({});
  });
  it('allows up to 64 zones per report', async () => {
    const e = new Engine();
    const zones = Array.from({ length: 32 }, (_, i) => [zone(`check_in:${i}`, 1), zone(`bag_drop:${i}`, 1)]).flat();
    await e.handle(event('flow.report', { zones }), 'vision');
    expect(Object.keys(snap(e).flow)).toHaveLength(64);
    await expect(e.handle(event('flow.report', { zones: [...zones, zone('security', 1)] }), 'vision')).rejects.toThrow();
  });
  it('tells never-seen and stale zones apart from zero', () => {
    const s = new SimStore();
    s.flow({ zones: [zone('security', 0)] }, 'vision', 1_000);
    const at = (now: number) => (s.snapshot(true, {}, true, now) as any).flow;
    expect(at(1_000).security).toMatchObject({ waiting: 0, stale: false });
    expect(at(1_000)['check_in:2']).toBeUndefined();
    expect(at(1_000 + FLOW_STALE_MS + 1).security).toMatchObject({ waiting: 0, stale: true });
    s.flow({ zones: [zone('gate_1', 3)] }, 'vision', 7_000);
    expect(at(7_000)).toMatchObject({ security: { stale: true }, gate_1: { stale: false } });
  });
  it('ignores legacy Unity flow and positions while vision is reporting', () => {
    const s = new SimStore();
    expect(s.flow({ zones: [zone('security', 10)] }, 'vision', 10_000)).toBe(true);
    expect(s.flow({ zones: [zone('security', 99)] }, 'twin', 11_000)).toBe(false);
    expect(s.positions({ people: [{ x: 1, y: 1 }] }, 'vision', 10_000)).toBe(true);
    expect(s.positions({ people: [{ x: 9, y: 9, kind: 'pax' }] }, 'twin', 12_000)).toBe(false);
    expect((s.snapshot(true, {}, true, 11_000) as any).flow.security.waiting).toBe(10);
    expect(s.flow({ zones: [zone('security', 99)] }, 'twin', 10_000 + FLOW_STALE_MS + 1)).toBe(true);
    expect((s.snapshot(true, {}) as any).flow.security).toMatchObject({ waiting: 99, source: 'twin' });
  });
});

describe('client=vision', () => {
  it('may send only flow.report and crowd.positions', async () => {
    const e = new Engine();
    await e.handle(event('crowd.positions', { people: [{ x: 1, y: 2 }] }), 'vision');
    for (const [type, data] of [['sim.status', {}], ['ops.ack', { id: 'x' }], ['truth.report', { zones: [{ zone: 'security', waiting: 1 }] }], ['metric.report', { name: 'evacT90', value: 1 }], ['console.reset', {}]] as const)
      await expect(e.handle(event(type, data), 'vision')).rejects.toThrow('Client cannot issue');
    expect(snap(e).positions.people).toEqual([{ x: 1, y: 2 }]);
  });
});

describe('truth.report (D0)', () => {
  it('is stored apart from flow, at most once per ~second, from the twin only', async () => {
    const s = new SimStore();
    expect((s.snapshot(true, {}) as any).truth).toBeNull();
    expect(s.truth({ zones: [{ zone: 'security', waiting: 42, waitMin: 11.5 }, { zone: 'check_in:2', waiting: 7, waitMin: null }] }, 10_000)).toBe(true);
    expect(s.truth({ zones: [{ zone: 'security', waiting: 1, waitMin: 1 }] }, 10_500)).toBe(false);
    const snapshot = s.snapshot(true, {}) as any;
    expect(snapshot.truth).toEqual({ zones: { security: { waiting: 42, waitMin: 11.5 }, 'check_in:2': { waiting: 7, waitMin: null } }, at: new Date(10_000).toISOString() });
    expect(snapshot.flow).toEqual({});
    for (const zones of [[], [{ zone: 'security', waiting: -1 }], [{ zone: 'security', waiting: 1, waitMin: -1 }], [{ zone: 'Security', waiting: 1 }], [{ zone: 'security', waiting: 1 }, { zone: 'security', waiting: 2 }]])
      expect(() => s.truth({ zones }, 20_000)).toThrow();
    const e = new Engine();
    await e.handle(event('truth.report', { zones: [{ zone: 'security', waiting: 3, waitMin: 1 }] }), 'twin');
    expect(snap(e).truth.zones.security.waiting).toBe(3);
  });
});

describe('lanes (D12)', () => {
  it('start from the provisional plan and change with staff commands, never below 0', () => {
    const s = new SimStore();
    const lanes = () => (s.snapshot(true, {}) as any).lanes;
    expect(lanes()).toEqual(initialLanes);
    s.sent(opsCommand({ type: 'staff', zone: 'security', delta: 1 }));
    expect(s.lanes('security')).toBe(initialLanes.security! + 1);
    s.sent(opsCommand({ type: 'staff', zone: 'bag_drop:2', delta: -5 }));
    expect(s.lanes('bag_drop:2')).toBe(0);
    s.sent(opsCommand({ type: 'staff', zone: 'gate_9', delta: 2 }));
    expect(lanes().gate_9).toBe(2);
    s.sent(opsCommand({ type: 'close', zone: 'security' }));
    expect(s.lanes('security')).toBe(initialLanes.security! + 1);
    expect(s.lanes('nowhere')).toBeNull();
  });
});

describe('metric.report (D19)', () => {
  it('accepts the A/B names and keeps the old ones', async () => {
    const e = new Engine();
    for (const name of ['securityWaitMean', 'securityWaitP90', 'missedBoarding', 'evacT90', 'evacLastOut', 'kerbPeak'])
      await e.handle(event('metric.report', { name, value: 4 }), 'twin');
    expect(e.state.metrics).toMatchObject({ securityWaitMean: 4, securityWaitP90: 4, missedBoarding: 4, evacT90: 4, evacLastOut: 4, kerbPeak: 4 });
    await expect(e.handle(event('metric.report', { name: 'evacT50', value: 1 }), 'twin')).rejects.toThrow('Invalid metric');
  });
});

describe('flight.update (D14)', () => {
  it('replaces the schedule and normalises nulls', async () => {
    const e = new Engine();
    await e.handle(event('flight.update', { flights: [flight(), flight({ flight: 'RO 642', airline: 'ro', checkIn: 'check_in:2', gate: null, gateCloseAt: null, delayMin: null, pax: null, status: 'delayed', std: '14:30' })] }), 'twin');
    expect(snap(e).flights).toEqual([
      { flight: 'W6 3751', airline: 'W6', destination: 'London Luton', std: 52200, gate: 'gate_1', checkInDesks: ['check_in:W6'], gateCloseAt: 51000, status: 'scheduled', delayMin: 0, pax: 180 },
      { flight: 'RO 642', airline: 'RO', destination: 'London Luton', std: '14:30', gate: null, checkInDesks: ['check_in:W6'], checkIn: 'check_in:2', gateCloseAt: null, status: 'delayed', delayMin: 0, pax: null },
    ]);
    expect(Date.parse(snap(e).flightsAt)).not.toBeNaN();
    await e.handle(event('flight.update', { flights: [] }), 'twin');
    expect(snap(e).flights).toEqual([]);
  });
  it('rejects the whole schedule on any invalid flight', async () => {
    const e = new Engine();
    await e.handle(event('flight.update', { flights: [flight()] }), 'twin');
    for (const bad of [{ status: 'landed' }, { airline: 'W' }, { flight: '' }, { std: -1 }, { gate: 'Gate 1' }, { checkInDesks: 'check_in:W6' }, { checkIn: 'security' }, { checkIn: 'Check In 2' }, { delayMin: -5 }, { pax: 1.5 }, { destination: 1 }])
      await expect(e.handle(event('flight.update', { flights: [flight({ flight: 'RO 1' }), flight(bad)] }), 'twin')).rejects.toThrow();
    await expect(e.handle(event('flight.update', { flights: [flight(), flight()] }), 'twin')).rejects.toThrow();
    await expect(e.handle(event('flight.update', {}), 'twin')).rejects.toThrow();
    expect(snap(e).flights.map((f: any) => f.flight)).toEqual(['W6 3751']);
  });
});

describe('crowd.positions', () => {
  it('keeps the latest snapshot, at most once per ~second, max 2000 people', () => {
    const s = new SimStore();
    expect(s.positions({ people: [{ x: 1, y: 2, kind: 'pax' }, { x: 3.5, y: 4, kind: 'staff' }] }, 'twin', 10_000)).toBe(true);
    expect(s.positions({ people: [] }, 'twin', 10_500)).toBe(false);
    expect((s.snapshot(true, {}) as any).positions.people).toHaveLength(2);
    expect(s.positions({ people: [{ x: 5, y: 5, kind: 'pax' }] }, 'twin', 11_000)).toBe(true);
    expect((s.snapshot(true, {}) as any).positions.people).toEqual([{ x: 5, y: 5, kind: 'pax' }]);
    for (const people of [[{ x: 1, y: 1, kind: 'dog' }], [{ x: 1, kind: 'pax' }], [{ y: 1 }], [{ x: Infinity, y: 1, kind: 'pax' }], Array.from({ length: 2001 }, () => ({ x: 0, y: 0, kind: 'pax' }))])
      expect(() => s.positions({ people }, 'vision', 20_000)).toThrow();
    expect((s.snapshot(true, {}) as any).positions.people).toEqual([{ x: 5, y: 5, kind: 'pax' }]);
  });
  it('is accepted from the twin without persisting or broadcasting', async () => {
    const write = vi.spyOn(engineRuntime, 'write').mockImplementation(() => {});
    try {
      const emit = vi.fn(); const e = new Engine({ emit });
      write.mockClear();
      await e.handle(event('crowd.positions', { people: [{ x: 10, y: 20, kind: 'pax' }] }), 'twin');
      expect(snap(e).positions.people).toHaveLength(1);
      expect(write).not.toHaveBeenCalled(); expect(emit).not.toHaveBeenCalled();
      await expect(e.handle(event('crowd.positions', { people: [] }), 'console')).rejects.toThrow('Client cannot issue');
    } finally { write.mockRestore(); }
  });
});

describe('agent.batch v2', () => {
  const row = (extra = {}) => ({ agentId: 'u1', role: 'passenger_terminal', persona: 'p01', location: 'terminal', phone: 'read', action: 'walk', ...extra });
  it('accepts stage and terminal node locations', async () => {
    const e = new Engine();
    await e.handle(event('agent.batch', { updates: [row({ stage: 'airside', location: 'gate_1' }), row({ agentId: 'u2', stage: null, location: 'check_in:w6' })] }), 'twin');
    expect(e.sim.agents(new URLSearchParams())).toEqual([
      expect.objectContaining({ agentId: 'u1', stage: 'airside', location: 'gate_1' }),
      expect.objectContaining({ agentId: 'u2', location: 'check_in:W6' }),
    ]);
    expect(e.sim.agents(new URLSearchParams())[1]).not.toHaveProperty('stage');
  });
  it('rejects an unknown stage or location for the whole batch', async () => {
    const e = new Engine();
    for (const bad of [{ stage: 'lounge' }, { location: 'Gate 1' }, { location: '' }])
      await expect(e.handle(event('agent.batch', { updates: [row({ agentId: 'ok' }), row(bad)] }), 'twin')).rejects.toThrow();
    expect(e.sim.agents(new URLSearchParams())).toEqual([]);
  });
  it('does not copy terminal node ids into registered presence', async () => {
    const e = new Engine();
    await e.handle(event('agent.register', { agents: [{ agentId: 'u1', role: 'passenger_terminal', channel: 'whatsapp' }] }), 'twin');
    await e.handle(event('agent.batch', { updates: [row()] }), 'twin');
    await e.handle(event('agent.batch', { updates: [row({ location: 'gate_1', action: 'board' })] }), 'twin');
    expect(e.agents[0]).toMatchObject({ location: 'terminal', action: 'board' });
  });
});

describe('ops.command / ops.ack (D12)', () => {
  it('validates the five command types', () => {
    expect(opsCommand({ type: 'staff', zone: 'bag_drop:w6', delta: 1, extra: true })).toEqual({ type: 'staff', zone: 'bag_drop:W6', delta: 1 });
    expect(opsCommand({ type: 'redirect', from: 'security', to: 'security_2' })).toEqual({ type: 'redirect', from: 'security', to: 'security_2' });
    expect(opsCommand({ type: 'evacuate', zones: ['gate_1', 'airside'] })).toEqual({ type: 'evacuate', zones: ['gate_1', 'airside'] });
    expect(opsCommand({ type: 'close', zone: 'gate_2' })).toEqual({ type: 'close', zone: 'gate_2' });
    expect(opsCommand({ type: 'open', zone: 'gate_2' })).toEqual({ type: 'open', zone: 'gate_2' });
    for (const bad of [null, {}, { type: 'drone' }, { type: 'staff', zone: 'security', delta: 0 }, { type: 'staff', zone: 'security', delta: 1.5 }, { type: 'staff', zone: 'security', delta: 21 },
      { type: 'staff', zone: 'Security', delta: 1 }, { type: 'redirect', from: 'security', to: 'security' }, { type: 'evacuate', zones: [] }, { type: 'evacuate', zones: ['a', 'a'] },
      { type: 'evacuate', zones: 'gate_1' }, { type: 'close' }, { type: 'open', zone: 'x y' }])
      expect(() => opsCommand(bad)).toThrow('Invalid ops command');
  });
  it('tracks sent commands until Unity acknowledges them', async () => {
    const e = new Engine();
    const record = e.sim.sent(opsCommand({ type: 'staff', zone: 'security', delta: 1 }));
    expect(record).toMatchObject({ type: 'staff', zone: 'security', delta: 1, status: 'sent', ackedAt: null });
    expect(opsWire(record)).toEqual({ type: 'staff', zone: 'security', delta: 1, id: record.id });
    expect(snap(e).ops[0]).toMatchObject({ id: record.id, status: 'sent' });
    await expect(e.handle(event('ops.ack', { id: 'nope' }), 'twin')).rejects.toThrow('Unknown ops command');
    await expect(e.handle(event('ops.ack', { id: record.id }), 'console')).rejects.toThrow('Client cannot issue');
    await e.handle(event('ops.ack', { id: record.id }), 'twin');
    await e.handle(event('ops.ack', { id: record.id }), 'twin');
    expect(snap(e).ops[0]).toMatchObject({ id: record.id, status: 'acked' });
    expect(Date.parse(snap(e).ops[0].ackedAt)).not.toBeNaN();
  });
  it('keeps the newest 50 commands, newest first', () => {
    const s = new SimStore();
    const ids = Array.from({ length: 60 }, () => s.sent({ type: 'close', zone: 'gate_1' }).id);
    const ops = (s.snapshot(true, {}) as any).ops;
    expect(ops).toHaveLength(50);
    expect(ops[0].id).toBe(ids.at(-1));
  });
});

describe('agent.route', () => {
  it('validates the node path and reason', () => {
    expect(agentRoute({ agentId: 'u1', nodes: ['entrance', 'check_in:w6', 'security', 'gate_1'], reason: 'gate' }))
      .toEqual({ agentId: 'u1', nodes: ['entrance', 'check_in:W6', 'security', 'gate_1'], reason: 'gate' });
    for (const bad of [{ agentId: '', nodes: ['a'], reason: 'gate' }, { agentId: 'u1', nodes: [], reason: 'gate' }, { agentId: 'u1', nodes: ['a'], reason: 'lunch' }, { agentId: 'u1', nodes: ['A B'], reason: 'gate' }])
      expect(() => agentRoute(bad)).toThrow('Invalid agent route');
  });
});
