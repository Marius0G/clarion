/** D26: map ids, logical kinds and D8 desk groups. Never merge airline telemetry into a shared queue. */
export const isNodeId = (v: unknown): v is string => typeof v === 'string' && /^(?:[a-z][a-z0-9_]{0,39}(?:_[GU])?(:[A-Za-z0-9_-]{1,16})?|[A-Z][A-Z0-9_]{0,39})$/.test(v);
export type ZoneKind = 'entrance' | 'check_in' | 'bag_drop' | 'security' | 'airside' | 'gate' | 'exit'
  | 'passport' | 'reclaim' | 'taxi_rank' | 'kerb' | 'arrivals_hall' | 'stairs' | 'lift'
  | 'circulation' | 'service' | 'waiting' | 'shops' | 'wc' | 'parking';
const desks = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => `checkin_${a + i}`);
export const deskGroups = { W6: desks(1, 6), RO: desks(7, 8), FR: desks(9, 10), OTHER: desks(11, 12) } as const;
export function desksForAirline(airline: string): readonly string[] {
  return deskGroups[airline.toUpperCase() as keyof typeof deskGroups] ?? deskGroups.OTHER;
}
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
  if (group) return `check_in:${({ '1': 'W6', '2': 'RO', '3': 'FR', '4': 'OTHER' } as Record<string, string>)[group[1]!] ?? (group[1]!.toUpperCase() in deskGroups ? group[1]!.toUpperCase() : 'OTHER')}`;
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
  if (rows[canonical] !== undefined) return rows[canonical];
  return Object.entries(rows).find(([key]) => mapNodeId(key) === canonical && (!key.includes(':') || key.split(':')[0] === id.split(':')[0]))?.[1];
}
