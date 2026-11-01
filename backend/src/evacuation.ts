import { route, type Route } from './routing.js';
import { mapNodeId, plan, zones, type TerminalPlan } from './terminal.js';

/**
 * Backend evacuation routing, the fallback when no evac.plan arrives from vision. The rule:
 * people in the public (landside) area leave by the landside doors; people airside (gates, departures
 * lounge, baggage hall) leave by the apron doors and the arrivals entry. Then the nearest assembly
 * point on that side. route() runs in evacuation mode, so emergency-only crossings are open.
 */
export interface Evacuation { from: string; exit: string; assembly: string; route: Route }

const sideOfZone = new Map(zones.map(z => [z.id, z.side]));
/** Side of an exit door: apron doors and the arrivals entry open airside. */
export const exitSide = (id: string): 'landside' | 'airside' => /apron|arrivals_entry/.test(id) ? 'airside' : 'landside';

export function evacuationRoute(from: string, density: Readonly<Record<string, number | null | undefined>> = {},
  blocked: readonly string[] = [], graph: TerminalPlan = plan): Evacuation | null {
  const nodes = new Map(graph.nodes.map(n => [n.id, n]));
  const start = nodes.get(mapNodeId(from));
  if (!start) return null;
  const side = sideOfZone.get(start.zone ?? start.id) ?? 'landside';
  const doors = graph.nodes.filter(n => n.kind === 'exit' && !n.id.startsWith('ASSEMBLY_') && exitSide(n.id) === side);
  const best = doors.map(d => route(graph, from, d.id, density, blocked, { evacuation: true }))
    .filter((r): r is Route => r !== null).sort((a, b) => a.totalSec - b.totalSec)[0];
  if (!best) return null;
  const exit = best.nodes[best.nodes.length - 1]!, door = nodes.get(exit)!;
  const assembly = zones.filter(z => z.id.startsWith('ASSEMBLY_') && z.side === side)
    .sort((a, b) => Math.hypot(a.centre[0]! - door.x, a.centre[1]! - door.y) - Math.hypot(b.centre[0]! - door.x, b.centre[1]! - door.y))[0]!.id;
  return { from, exit, assembly, route: best };
}
