import { describe, it, expect, vi } from 'vitest';
import { Engine } from '../src/engine.js';
import { engineRuntime } from '../src/runtime.js';
import { agentRoute, opsCommand, opsWire, SimStore } from '../src/sim.js';
const event = (type: string, data = {}) => ({ type, ts: new Date().toISOString(), data });
const snap = (e: Engine) => e.sim.snapshot(true, {}) as any;
const zone = (zone: string, waiting: number, extra = {}) => ({ zone, waiting, capacity: null, waitMin: null, ...extra });
const flight = (extra = {}) => ({ flight: 'W6 3751', airline: 'W6', destination: 'London Luton', std: 52200, gate: 'gate_1', checkInDesks: ['check_in:W6'], gateCloseAt: 51000, status: 'scheduled', delayMin: 0, pax: 180, ...extra });

describe('flow.report v2 (D5b, D8)', () => {
  it('accepts staff, forecast and per-airline zones', async () => {
    const e = new Engine();
    await e.handle(event('flow.report', { zones: [
      zone('check_in:W6', 40, { capacity: 50, waitMin: 12, staff: 3, forecast: [{ inMin: 30, waitMin: 15 }, { inMin: 60, waitMin: 20 }] }),
      zone('bag_drop:ro', 8, { staff: 1 }), zone('security', 60, { staff: null, forecast: null }),
    ] }), 'twin');
    expect(snap(e).flow).toMatchObject({
      'check_in:W6': { waiting: 40, capacity: 50, waitMin: 12, staff: 3, forecast: [{ inMin: 30, waitMin: 15 }, { inMin: 60, waitMin: 20 }] },
      'bag_drop:RO': { waiting: 8, staff: 1, forecast: null },
      security: { waiting: 60, staff: null, forecast: null },
    });
  });
  it('rejects the whole report on any invalid v2 field', async () => {
    const e = new Engine();
    for (const bad of [zone('check_in:W', 1), zone('check_in:W6X', 1), zone('gate_1', 1), zone('kerb', 1, { staff: -1 }), zone('kerb', 1, { staff: 1.5 }),
      zone('kerb', 1, { forecast: {} }), zone('kerb', 1, { forecast: [{ inMin: 30 }] }), zone('kerb', 1, { forecast: [{ inMin: 30, waitMin: -1 }] }),
      zone('kerb', 1, { forecast: Array.from({ length: 13 }, (_, i) => ({ inMin: i, waitMin: 1 })) })])
      await expect(e.handle(event('flow.report', { zones: [zone('security', 1), bad] }), 'twin')).rejects.toThrow();
    // The same airline twice, once in lower case, is a duplicate.
    await expect(e.handle(event('flow.report', { zones: [zone('check_in:W6', 1), zone('check_in:w6', 2)] }), 'twin')).rejects.toThrow();
    expect(snap(e).flow).toEqual({});
  });
  it('allows one zone per airline beyond the six legacy zones', async () => {
    const e = new Engine();
    const zones = ['W6', 'RO', 'FR', 'LH', '0B', 'H4', 'TK', 'OS'].flatMap(c => [zone(`check_in:${c}`, 1), zone(`bag_drop:${c}`, 1)]);
    await e.handle(event('flow.report', { zones }), 'twin');
    expect(Object.keys(snap(e).flow)).toHaveLength(16);
  });
});

describe('flight.update (D14)', () => {
  it('replaces the schedule and normalises nulls', async () => {
    const e = new Engine();
    await e.handle(event('flight.update', { flights: [flight(), flight({ flight: 'RO 642', airline: 'ro', gate: null, gateCloseAt: null, delayMin: null, pax: null, status: 'delayed', std: '14:30' })] }), 'twin');
    expect(snap(e).flights).toEqual([
      { flight: 'W6 3751', airline: 'W6', destination: 'London Luton', std: 52200, gate: 'gate_1', checkInDesks: ['check_in:W6'], gateCloseAt: 51000, status: 'scheduled', delayMin: 0, pax: 180 },
      { flight: 'RO 642', airline: 'RO', destination: 'London Luton', std: '14:30', gate: null, checkInDesks: ['check_in:W6'], gateCloseAt: null, status: 'delayed', delayMin: 0, pax: null },
    ]);
    expect(Date.parse(snap(e).flightsAt)).not.toBeNaN();
    await e.handle(event('flight.update', { flights: [] }), 'twin');
    expect(snap(e).flights).toEqual([]);
  });
  it('rejects the whole schedule on any invalid flight', async () => {
    const e = new Engine();
    await e.handle(event('flight.update', { flights: [flight()] }), 'twin');
    for (const bad of [{ status: 'landed' }, { airline: 'W' }, { flight: '' }, { std: -1 }, { gate: 'Gate 1' }, { checkInDesks: 'check_in:W6' }, { delayMin: -5 }, { pax: 1.5 }, { destination: 1 }])
      await expect(e.handle(event('flight.update', { flights: [flight({ flight: 'RO 1' }), flight(bad)] }), 'twin')).rejects.toThrow();
    await expect(e.handle(event('flight.update', { flights: [flight(), flight()] }), 'twin')).rejects.toThrow();
    await expect(e.handle(event('flight.update', {}), 'twin')).rejects.toThrow();
    expect(snap(e).flights.map((f: any) => f.flight)).toEqual(['W6 3751']);
  });
});

describe('crowd.positions', () => {
  it('keeps the latest snapshot, at most once per ~second, max 2000 people', () => {
    const s = new SimStore();
    expect(s.positions({ people: [{ x: 1, y: 2, kind: 'pax' }, { x: 3.5, y: 4, kind: 'staff' }] }, 10_000)).toBe(true);
    expect(s.positions({ people: [] }, 10_500)).toBe(false);
    expect((s.snapshot(true, {}) as any).positions.people).toHaveLength(2);
    expect(s.positions({ people: [{ x: 5, y: 5, kind: 'pax' }] }, 11_000)).toBe(true);
    expect((s.snapshot(true, {}) as any).positions.people).toEqual([{ x: 5, y: 5, kind: 'pax' }]);
    for (const people of [[{ x: 1, y: 1, kind: 'dog' }], [{ x: 1, kind: 'pax' }], [{ x: Infinity, y: 1, kind: 'pax' }], Array.from({ length: 2001 }, () => ({ x: 0, y: 0, kind: 'pax' }))])
      expect(() => s.positions({ people }, 20_000)).toThrow();
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
