import { expect, it } from 'vitest';
import { boardingFromSchedule } from '../src/demo.js';
import { PROVISIONAL_FLIGHTS } from '../src/wa/flights.js';
it('anchors Unity times to the Bucharest calendar date, including midnight rollover', () => {
  const flight = { ...PROVISIONAL_FLIGHTS[0]!, flight: 'W63751' };
  const result = boardingFromSchedule(flight, 'Ionescu/Ana', new Date('2026-10-31T23:30:00Z'));
  expect(result.localDeparture).toBe('2026-11-01T09:40:00');
  expect(result.bcbp.slice(44, 47)).toBe('305');
  expect(result.passengerName).toBe('IONESCU/ANA');
  expect(boardingFromSchedule({ ...flight, std: 25 * 3600 }, undefined, new Date('2026-10-31T23:30:00Z')).localDeparture)
    .toBe('2026-11-02T01:00:00');
});
it('accepts explicit destination codes and rejects unknown destination labels', () => {
  const flight = PROVISIONAL_FLIGHTS[0]!;
  expect(boardingFromSchedule({ ...flight, destination: 'FCO' }).destination).toBe('FCO');
  expect(() => boardingFromSchedule({ ...flight, destination: 'Unknown city' })).toThrow('airport code unavailable');
});
