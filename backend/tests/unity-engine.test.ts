import { describe, it, expect, vi } from 'vitest';
import { Engine } from '../src/engine.js';
import { engineRuntime } from '../src/runtime.js';
const event = (type: string, data = {}) => ({ type, ts: new Date().toISOString(), data });
const row = (i: number) => ({ agentId: `u${i}`, role: 'taxi', persona: 'p07', location: 'road', phone: 'read', action: 'wait' });
describe('Unity shared engine', () => {
  it('coalesces 400 deliveries and 400 due reads to one write/state per operation', async () => {
    const write = vi.spyOn(engineRuntime, 'write').mockImplementation(() => {});
    const exists = vi.spyOn(engineRuntime, 'exists').mockReturnValue(false);
    try {
      const emit = vi.fn(); const e = new Engine({ file: 'test', emit });
      await e.handle(event('agent.register', { agents: Array.from({ length: 400 }, (_, i) => ({ agentId: `u${i}`, role: 'taxi', channel: 'telegram' })) }), 'twin');
      await e.handle(event('drone.detected', { nearRunway: '26', distanceM: 2000, bearingDeg: 90, source: 'radar' }), 'twin');
      await e.handle(event('console.confirm_suspension'));
      write.mockClear(); emit.mockClear();
      await e.handle(event('console.approve_messages', { roles: ['taxi'] }));
      expect(write).toHaveBeenCalledTimes(1);
      expect(emit.mock.calls.filter(c => c[0] === 'state')).toHaveLength(1);
      expect(e.receipts).toHaveLength(400);
      write.mockClear(); emit.mockClear();
      e.tick(Math.max(...e.receipts.map(r => r.actAt!)) + 1);
      expect(write).toHaveBeenCalledTimes(1);
      expect(emit.mock.calls.filter(c => c[0] === 'state')).toHaveLength(1);
      expect(e.state.counters.taxi.read).toBe(400);
      write.mockClear(); emit.mockClear();
      await e.handle(event('agent.batch', { updates: Array.from({ length: 400 }, (_, i) => row(i)) }), 'twin');
      expect(write).toHaveBeenCalledTimes(1);
      expect(emit.mock.calls.filter(c => c[0] === 'state')).toHaveLength(1);
      expect(e.state.presence.taxi.road).toBe(400);
      write.mockClear(); emit.mockClear();
      await e.handle(event('agent.batch', { updates: [row(999)] }), 'twin');
      await e.handle(event('sim.status', { running: true, scenario: 'S2', arm: 'B', coverage: .5, seed: 42, speed: 60, simTime: 100, agents: 401 }), 'twin');
      expect(write).not.toHaveBeenCalled(); expect(emit).not.toHaveBeenCalled();
    } finally { write.mockRestore(); exists.mockRestore(); }
  });
  it('validates batches atomically, bounds the store and accepts new metrics', async () => {
    const e = new Engine();
    for (const change of [{ phone: 'bad' }, { action: 'x'.repeat(41) }, { trigger: 'x'.repeat(41) }, { thought: 'x'.repeat(201) }, { lat: 1 }, { lat: 91, lon: 1 }, { lon: Infinity, lat: 1 }, { role: 'bad' }]) {
      await expect(e.handle(event('agent.batch', { updates: [row(0), { ...row(1), ...change }] }), 'twin')).rejects.toThrow();
      expect(e.sim.agents(new URLSearchParams())).toHaveLength(0);
    }
    await expect(e.handle(event('agent.batch', { updates: Array.from({length: 501}, (_,i) => row(i)) }), 'twin')).rejects.toThrow();
    for (let i = 0; i < 10; i++) await e.handle(event('agent.batch', { updates: Array.from({length:500}, (_,j) => row(i*500+j)) }), 'twin');
    await expect(e.handle(event('agent.batch', { updates: [row(5000)] }), 'twin')).rejects.toThrow('5000');
    expect(e.sim.agents(new URLSearchParams())).toHaveLength(5000);
    for (const name of ['peopleInT2AtEvacuation', 'minutesLost']) { await e.handle(event('metric.report', { name, value: 2 }), 'twin'); expect((e.state.metrics as any)[name]).toBe(2); }
    await expect(e.handle(event('sim.status', {}), 'viewer')).rejects.toThrow();
  });
  it('treats null optionals as absent and empty filters as unset', async () => {
    const e = new Engine();
    await e.handle(event('agent.batch', { updates: [{ ...row(0), trigger: null, thought: null, lat: null, lon: null }] }), 'twin');
    expect(e.sim.agents(new URLSearchParams())[0]).toEqual(row(0));
    expect(e.sim.agents(new URLSearchParams('role=&location=&action='))).toHaveLength(1);
    expect(e.sim.agents(new URLSearchParams('role=taxi&location=&action=wait'))).toHaveLength(1);
    expect(e.sim.agents(new URLSearchParams('role=police&location='))).toHaveLength(0);
  });
  it('does not broadcast state when registered rows repeat unchanged presence', async () => {
    const emit = vi.fn(); const e = new Engine({ emit });
    await e.handle(event('agent.register', { agents: [{ agentId: 'u0', role: 'taxi', channel: 'telegram' }] }), 'twin');
    await e.handle(event('agent.batch', { updates: [row(0)] }), 'twin');
    emit.mockClear();
    await e.handle(event('agent.batch', { updates: [{ ...row(0), phone: 'acting', thought: 'same place' }] }), 'twin');
    expect(emit.mock.calls.filter(c => c[0] === 'state')).toHaveLength(0);
  });
});
