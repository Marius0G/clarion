// The Tower's data as the WhatsApp agent sees it: the sim clock (D13), flow rows (D5b, D8) and flights (D14).
import { clockFrom, currentFlights, fromSim, isProvisional, type SimFlightRow } from './flights.js';
import type { AirportView, ZoneRow } from './tools.js';

interface SimSnapshot { simTime: number | null; flow: Record<string, ZoneRow>; flights?: readonly SimFlightRow[] }
export interface SimSource { snapshot(connected: boolean, metrics: unknown): SimSnapshot }

/** Flights come from Unity's flight.update (sim store); the provisional fixture only until one has arrived. */
export function airportView(sim: SimSource, connected: () => boolean): AirportView {
  const unity = () => fromSim(sim.snapshot(false, null).flights);
  return {
    clock: () => clockFrom(sim.snapshot(false, null).simTime, connected()),
    flow: () => sim.snapshot(false, null).flow,
    flights: () => currentFlights(unity()),
    provisional: () => isProvisional(unity()),
  };
}
