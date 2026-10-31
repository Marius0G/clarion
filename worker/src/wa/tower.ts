// The Tower's data as the WhatsApp agent sees it: the sim clock (D13), flow rows (D5b, D8) and flights (D14).
import { clockFrom, currentFlights, isProvisional, type Flight } from './flights.js';
import type { AirportView, ZoneRow } from './tools.js';

interface SimSnapshot { simTime: number | null; flow: Record<string, ZoneRow> }
export interface SimSource { snapshot(connected: boolean, metrics: unknown): SimSnapshot }

/** unityFlights: the schedule from flight.update once it is wired (D14); until then the provisional fixture. */
export function airportView(sim: SimSource, connected: () => boolean, unityFlights: () => readonly Flight[] | null = () => null): AirportView {
  return {
    clock: () => clockFrom(sim.snapshot(false, null).simTime, connected()),
    flow: () => sim.snapshot(false, null).flow,
    flights: () => currentFlights(unityFlights()),
    provisional: () => isProvisional(unityFlights()),
  };
}
