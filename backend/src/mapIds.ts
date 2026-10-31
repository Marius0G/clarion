/** D26: map ids, logical kinds and D8 desk groups. Never merge airline telemetry into a shared queue. */
export const isNodeId = (v: unknown): v is string => typeof v === 'string' && /^(?:[a-z][a-z0-9_]{0,39}(?:_[GU])?(:[A-Za-z0-9_-]{1,16})?|[A-Z][A-Z0-9_]{0,39})$/.test(v);
export type ZoneKind = 'entrance' | 'check_in' | 'bag_drop' | 'security' | 'airside' | 'gate' | 'exit'
  | 'passport' | 'reclaim' | 'taxi_rank' | 'kerb' | 'arrivals_hall' | 'stairs' | 'lift'
  | 'circulation' | 'service' | 'waiting' | 'shops' | 'wc' | 'parking';
const desks = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => `checkin_${a + i}`);
/** D26 (Marius, terminal.json): three physical groups of 4 desks, assigned per flight by time slot, not by airline. */
export const deskGroups = { '1': desks(1, 4), '2': desks(5, 8), '3': desks(9, 12) } as const;
/** Legacy per-airline aliases; `check_in:OTHER` has no desks. */
export const groupAliases: Readonly<Record<string, string>> = { W6: '1', RO: '2', FR: '3' };
const groupOf = (g: string) => g in deskGroups ? g : groupAliases[g.toUpperCase()] ?? null;
/** Desks of a group id (`check_in:2`, `2`, or a legacy alias such as `check_in:RO`). */
export function desksForGroup(group: string): readonly string[] {
  const g = groupOf(group.replace(/^(?:check_in|bag_drop):/, ''));
  return g ? deskGroups[g as keyof typeof deskGroups] : [];
}
/** @deprecated groups follow the flight's time slot; kept for old callers via the legacy alias. */
export function desksForAirline(airline: string): readonly string[] { return desksForGroup(airline); }
export const idAliases: Readonly<Record<string, string>> = {
  entrance: 'G_DEPARTURES', security: 'U_SECURITY_QUEUE', airside: 'U_CORRIDOR_EAST',
  check_in: 'G_CHECKIN_QUEUE', bag_drop: 'G_CHECKIN_DESKS',
  arrivals_hall: 'G_MEETING', taxi_rank: 'X_TAXI_RANK', kerb: 'X_KERB_DEPARTURES',
  exit_1: 'door_exit_west', exit_2: 'door_exit_mid', team_post: 'G_INFO',
};
/** Physical anchor only: distinct group ids remain distinct in flow.report. */
export function mapNodeId(id: string): string {
  const gate = /^(?:G|gate_|U_GATE_)(10|[1-9])$/.exec(id);
  if (gate) return `U_GATE_${gate[1]}`;
  const group = /^(?:check_in|bag_drop):(.+)$/.exec(id);
  if (group) { const g = groupOf(group[1]!); return g ? `check_in:${g}` : id; }
  return idAliases[id] ?? id;
}
export function logicalKind(id: string, fallback = 'circulation'): ZoneKind {
  if (/^(check_in|bag_drop):/.test(id)) return id.split(':')[0] as ZoneKind;
  if (/^(?:G|gate_|U_GATE_)(10|[1-9])$/.test(id)) return 'gate';
  if (/CHECKIN/.test(id)) return 'check_in';
  if (/SECURITY/.test(id)) return 'security';
  if (/PASSPORT/.test(id)) return 'passport';
  if (/RECLAIM/.test(id)) return 'reclaim';
  if (id === 'X_TAXI_RANK') return 'taxi_rank';
  if (/KERB|X_BOLT/.test(id)) return 'kerb';
  if (id === 'G_DEPARTURES') return 'entrance';
  if (id === 'G_MEETING' || id === 'G_ARRIVALS_EXIT') return 'arrivals_hall';
  if (id.startsWith('ASSEMBLY_')) return 'exit';
  if (id in idAliases) return logicalKind(idAliases[id]!, fallback);
  return (['queue', 'service'].includes(fallback) ? 'service' : fallback) as ZoneKind;
}
/** Exact row first, then equivalent legacy/physical ids. Does not sum overlapping camera zones. */
export function flowRow<T>(rows: Readonly<Record<string, T>>, id: string): T | undefined {
  if (rows[id] !== undefined) return rows[id];
  const canonical = mapNodeId(id);
  // Desk groups: bag_drop:N and check_in:N share an anchor but are different queues; never read one as the other.
  const sameKind = !id.includes(':') || canonical.split(':')[0] === id.split(':')[0];
  if (sameKind && rows[canonical] !== undefined) return rows[canonical];
  return Object.entries(rows).find(([key]) => mapNodeId(key) === canonical && (!key.includes(':') || key.split(':')[0] === id.split(':')[0]))?.[1];
}

/**
 * D12 lane counters live under one key per place (terminal.json `lanes`): `security` and `check_in:1..3`.
 * Commands may name the zone (`U_SECURITY_QUEUE`) or an alias (`check_in:W6`); they all land on the same counter.
 */
export const laneZones: Readonly<Record<string, string>> = { security: 'U_SECURITY_QUEUE', 'check_in:1': 'G_CHECKIN_QUEUE', 'check_in:2': 'G_CHECKIN_QUEUE', 'check_in:3': 'G_CHECKIN_QUEUE' };
export function laneKey(id: string): string {
  if (id in laneZones) return id;
  const canonical = mapNodeId(id);
  if (canonical in laneZones) return canonical;
  if (/^check_in:/.test(canonical)) return canonical;
  return Object.entries(laneZones).find(([key, zone]) => !key.includes(':') && zone === canonical)?.[0] ?? id;
}
