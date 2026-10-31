import { describe, expect, it } from 'vitest';
import { SimStore, type TerminalFlight } from '../src/sim.js';
import { Engine } from '../src/engine.js';
const flight = (extra: Partial<TerminalFlight> = {}): TerminalFlight => ({ flight: 'W4 1', airline: 'W4', destination: 'Roma', gate: 'gate_1', checkIn: 'check_in:1', std: 4600, gateCloseAt: 4000, status: 'scheduled', delayMin: 0, pax: 180, checkInDesks: [], ...extra });
const status = (sim: SimStore, time = 1000) => sim.status({ running: true, scenario: 'rush', arm: 'B', coverage: 1, seed: 1, simTime: time, speed: 10, agents: 0 });
describe('shared runtime and D0 isolation', () => {
  it('never reads truth.report, agent stages or legacy twin queues for alerts', () => {
    const sim = new SimStore(); status(sim, 3500);
    sim.flights({ flights: [flight()] });
    sim.truth({ zones: [{ zone: 'security', waiting: 500, waitMin: 100 }] });
    sim.flow({ zones: [{ zone: 'security', waiting: 500, waitMin: 100, density: 10 }] }, 'twin');
    sim.batch({ updates: [{ agentId: 'a', role: 'passenger_terminal', persona: '', location: 'security', stage: 'public', phone: 'unknown', action: '' }] });
    expect(sim.alertSnapshot()).toEqual([]);
    sim.flow({ zones: [{ zone: 'security', waiting: 20, waitMin: 11, density: 0.1, coverage: 1 }] }, 'vision');
    const before = sim.alertSnapshot();
    sim.truth({ zones: [{ zone: 'security', waiting: 0, waitMin: 0 }] }, Date.now() + 1000);
    expect(sim.alertSnapshot()).toEqual(before);
    expect(before.some(a => a.kind === 'flight-risk')).toBe(true);
    sim.reset(); expect(sim.alertSnapshot()).toEqual([]);
  });
  it('uses camera staleness and simTime for camera-loss alert timestamps', () => {
    const sim = new SimStore(); status(sim);
    sim.flow({ zones: [{ zone: 'security', waiting: 0, coverage: 1 }] }, 'vision', 100);
    expect(sim.snapshot(true, {}, true, 5101).alerts[0]).toMatchObject({ kind: 'camera-loss', createdAt: 1000 });
  });
  it('exposes alerts in the state stream and permits console-only commands', async () => {
    const engine = new Engine({ seed: 'alerts' });
    status(engine.sim);
    engine.sim.flow({ zones: [{ zone: 'security', waiting: 50, waitMin: 20 }] }, 'vision');
    const id = engine.snapshot().alerts[0]!.id;
    const event = { type: 'console.alert.command', ts: new Date().toISOString(), data: { type: 'ack', id } };
    for (const client of ['twin', 'vision', 'viewer'] as const) await expect(engine.handle(event, client)).rejects.toThrow('Client cannot');
    await engine.handle(event, 'console');
    expect(engine.snapshot().alerts[0]?.state).toBe('acked');
  });
});

it('never lets legacy twin fallback overwrite camera evidence or suppress camera loss', () => {
  const sim = new SimStore(); status(sim);
  sim.flow({ zones: [{ zone: 'security', waiting: 40, waitMin: 20, coverage: 1 }] }, 'vision', 100);
  sim.flow({ zones: [{ zone: 'security', waiting: 0, waitMin: 0 }] }, 'twin', 5200);
  const snapshot = sim.snapshot(true, {}, false, 5200);
  expect(snapshot.flow.security?.source).toBe('twin');
  expect(snapshot.alerts.find(a => a.kind === 'camera-loss')).toMatchObject({ active: true, priority: 'P3' });
});
