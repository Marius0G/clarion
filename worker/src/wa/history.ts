// D5b, D6: mean wait per zone and simulated hour, from the cameras' flow.report. The WhatsApp tools fall back to it
// only when a zone has no fresh camera row ("media din istoric pentru aceeași oră").
import type { ZoneRow } from './tools.js';

type Means = Record<string, Record<string, { sum: number; n: number }>>;
interface Store { get<T>(key: string): Promise<T | undefined>; put(key: string, value: unknown): Promise<void> }
const KEY = 'hist:wait';
const hourOf = (simSec: number) => String(Math.floor((((simSec % 86400) + 86400) % 86400) / 3600));

export class WaitHistory {
  private means: Means = {};
  private last = -Infinity;
  /** One sample a minute is plenty for an hourly mean and keeps storage writes low. */
  constructor(private store: Store, private sampleMs = 60_000) {}
  async load() { this.means = await this.store.get<Means>(KEY) ?? {}; }
  /** Fresh camera rows only; returns the storage write, or undefined when the sample was skipped. */
  record(flow: Record<string, ZoneRow>, simSec: number | null, now = Date.now()) {
    if (simSec === null || now - this.last < this.sampleMs) return;
    this.last = now;
    const hour = hourOf(simSec);
    for (const [zone, row] of Object.entries(flow)) {
      if (row.stale || row.waitMin === null || !Number.isFinite(row.waitMin)) continue;
      const bucket = (this.means[zone] ??= {})[hour] ??= { sum: 0, n: 0 };
      bucket.sum += row.waitMin; bucket.n++;
    }
    return this.store.put(KEY, this.means);
  }
  /** Rows shaped like flow rows (waitMin only) for the hour of simSec. */
  rows(simSec: number): Record<string, ZoneRow> {
    const hour = hourOf(simSec);
    return Object.fromEntries(Object.entries(this.means).flatMap(([zone, hours]) => {
      const b = hours[hour];
      return b?.n ? [[zone, { waiting: 0, waitMin: Math.round(b.sum / b.n * 10) / 10 }]] : [];
    }));
  }
}
