import { describe, expect, it } from 'vitest';
import { SimStore } from '../src/sim.js';
import { DAY, SECURITY_RATE, DESK_RATE, clockTime, rollingSchedule, scheduleForDay,
  flightSnapshot, arrivalFraction, arrivalsBetween, advanceQueue, queueWait, gateOccupancy, randomStep } from './feed-math.js';

describe('all-day feed math', () => {
  it('rolls the schedule over midnight without resetting absolute time or losing delays', () => {
    const before = rollingSchedule(DAY - 10);
    const delayed = before.find(f => f.destination === 'Londra Luton')!;
    delayed.delayMin = 60;
    const after = rollingSchedule(DAY + 10, before);
    expect(clockTime(DAY + 10)).toBe(10);
    expect(after.find(f => f.std === delayed.std && f.flight === delayed.flight)?.delayMin).toBe(60);
    expect(after.some(f => f.std > 2 * DAY)).toBe(true);
    for (let day = 1; day <= 30; day++) {
      const flights = rollingSchedule(day * DAY);
      expect(flights.filter(f => f.std >= day * DAY && f.std < (day + 1) * DAY)).toHaveLength(5);
      expect(arrivalsBetween(flights, day * DAY, (day + 1) * DAY, 'day').total).toBeCloseTo(1050);
    }
  });

  it('publishes unique flight numbers with valid backend shapes across midnight', () => {
    const store = new SimStore();
    for (const time of [0, 15 * 3600, DAY - 1, DAY + 1, 30 * DAY]) {
      const flights = flightSnapshot(rollingSchedule(time), time);
      expect(flights).toHaveLength(5);
      expect(new Set(flights.map(f => f.flight)).size).toBe(5);
      expect(() => store.flights({ flights })).not.toThrow();
    }
  });

  it('routes only the desk share to the flight group and conserves its passenger total', () => {
    const f = scheduleForDay(0)[3]!;
    const arrivals = arrivalsBetween([f], 0, DAY, 'day');
    expect(arrivals.total).toBeCloseTo(f.pax);
    expect(Object.keys(arrivals.checkIn)).toEqual([f.checkIn]);
    expect(arrivals.security + arrivals.checkIn[f.checkIn]!).toBeCloseTo(f.pax);
    expect(arrivalsBetween([{ ...f, status: 'cancelled' }], 0, DAY, 'rush').total).toBe(0);
    expect(arrivalFraction(f, f.std)).toBeCloseTo(1);
    expect(arrivalFraction(f, 0)).toBe(0);
  });

  it.each([1, 10, 30, 60])('crosses 10 min near 15:10 and recovers after the admin adds a lane (speed %i)', seconds => {
    const flights = rollingSchedule(15 * 3600);
    const run = (intervene: boolean) => {
      let security = 0, firstOver = -1;
      const desks: Record<string, number> = {};
      const samples: Record<number, number> = {};
      for (let time = 15 * 3600; time < 16 * 3600; time += seconds) {
        const demand = arrivalsBetween(flights, time, time + seconds, 'rush');
        let incoming = demand.security;
        for (const [group, count] of Object.entries(demand.checkIn)) {
          const q = advanceQueue(desks[group] ?? 0, count, 3, DESK_RATE, seconds / 60);
          desks[group] = q.waiting; incoming += q.served;
        }
        const minute = (time + seconds - 15 * 3600) / 60;
        const lanes = intervene && time >= 15 * 3600 + 15 * 60 ? 3 : 2;
        security = advanceQueue(security, incoming, lanes, SECURITY_RATE, seconds / 60).waiting;
        const wait = queueWait(security, lanes)!;
        if (wait > 10 && firstOver < 0) firstOver = minute;
        samples[minute] = wait;
      }
      return { firstOver, samples };
    };
    const withLane = run(true), withoutLane = run(false);
    expect(withLane.firstOver).toBeGreaterThanOrEqual(9);
    expect(withLane.firstOver).toBeLessThanOrEqual(11);
    expect(withLane.samples[15]).toBeGreaterThan(10);
    expect(withLane.samples[20]).toBeLessThan(10);
    expect(withoutLane.samples[20]).toBeGreaterThan(10);
    expect(withLane.samples[40]).toBeLessThan(4);
    expect(withLane.samples[60]).toBe(0);
  });

  it('fills gates before boarding and empties them exactly at departure, including delays', () => {
    for (const f of scheduleForDay(1)) {
      expect(gateOccupancy(f, f.std - 2400, 'rush')).toBeGreaterThan(0);
      expect(gateOccupancy(f, f.std - 600, 'rush')).toBeLessThan(gateOccupancy(f, f.std - 1800, 'rush'));
      expect(gateOccupancy(f, f.std, 'rush')).toBe(0);
      expect(gateOccupancy(f, f.std + DAY, 'rush')).toBe(0);
      const delayed = { ...f, delayMin: 60 };
      expect(gateOccupancy(delayed, f.std, 'day')).toBeGreaterThan(0);
      expect(gateOccupancy(delayed, f.std + 3600, 'day')).toBe(0);
      expect(gateOccupancy({ ...f, status: 'cancelled' }, f.std - 2400, 'day')).toBe(0);
    }
  });

  it('preserves fractional service, closes lanes, and never makes negative queues', () => {
    expect(advanceQueue(1, 0, 1, SECURITY_RATE, 1 / 60).served).toBeCloseTo(SECURITY_RATE / 60);
    expect(advanceQueue(1, 2, 0, SECURITY_RATE, 1)).toEqual({ waiting: 3, served: 0 });
    expect(advanceQueue(0, 1, 4, SECURITY_RATE, 10)).toEqual({ waiting: 0, served: 1 });
    expect(queueWait(10, 0)).toBeNull();
  });

  it('replays seeded camera noise and geometry exactly', () => {
    const sequence = (seed: number) => Array.from({ length: 10 }, () => {
      const step = randomStep(seed); seed = step.seed; return step.value;
    });
    expect(sequence(42)).toEqual(sequence(42));
    expect(sequence(42)).not.toEqual(sequence(43));
    expect(sequence(42).every(n => n >= 0 && n < 1)).toBe(true);
  });
});
