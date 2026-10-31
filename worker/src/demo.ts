import { demoBoardingPass } from '../../backend/src/bcbp.js';
import type { Flight } from './wa/flights.js';

// Unity currently supplies destination labels, not airport codes. Never invent a code for an unknown label.
const destinations: Record<string, string> = {
  'londra luton': 'LTN', 'london luton': 'LTN', 'milano bergamo': 'BGY', bergamo: 'BGY',
  'bucuresti otopeni': 'OTP', 'bucharest otopeni': 'OTP', 'londra stansted': 'STN',
  'london stansted': 'STN', dortmund: 'DTM',
};
export function boardingFromSchedule(flight: Flight, name?: string, now = new Date()) {
  const label = flight.destination.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
  const destination = /^[A-Z]{3}$/.test(flight.destination) ? flight.destination : destinations[label];
  if (!destination) throw new Error('Destination airport code unavailable');
  // D13 has time-of-day only. Anchor the simulated operating day to today's Bucharest calendar date.
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Bucharest', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const part = (key: string) => parts.find(p => p.type === key)!.value;
  const day = new Date(`${part('year')}-${part('month')}-${part('day')}T00:00:00Z`);
  day.setUTCSeconds(flight.std);
  return demoBoardingPass({ flight: flight.flight, destination, localDeparture: day.toISOString().slice(0, 19), name });
}
