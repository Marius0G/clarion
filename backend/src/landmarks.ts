/** Passenger landmarks from the supplied map. No telemetry or truth.report inputs.
 * Source IDs collapse duplicate symbols (desks → physical group, gate symbol → gate zone).
 * graphNode is the backend routing anchor; x/z retain the actual POI geometry.
 */
import { terminalGraph, zones, points, deskGroups } from './terminal.js';
import { route, FREE_SPEED } from './routing.js';
import contract from '../../docs/contract/terminal.json' with { type: 'json' };
// TODO(WA): Consume this catalogue/matcher in worker/src/wa; use graphNode for backend routing,
// and id for routes/index.json keys. Integration belongs to the WhatsApp stream.
// TODO(MAP): Exterior links are evacuation-only in the supplied backend graph. Keep those skips
// until the graph owner confirms normal access; nearest.exit is a normal-operation exit, not an evacuation instruction.
// Also verify same-floor paths that detour upstairs: these are shortest paths in the provisional graph.
export type Area = 'landside' | 'departures' | 'arrivals';
type Seed = { id: string; name: { ro: string; en: string }; aliases: string[]; area: Area };
export interface Landmark extends Seed {
  graphNode: string; level: 'G' | 'U' | 'X'; floor: 'Parter' | 'Etaj 1' | 'Exterior';
  side: 'landside' | 'airside'; x: number; z: number; sourceIds: string[];
  position: string; nearest: Record<'wc' | 'food' | 'info' | 'exit', { id: string; walkSec: number } | null>;
  desks?: readonly string[];
}
export const normalizeLandmark = (s: string): string => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const L = (id: string, ro: string, en: string, area: Area, ...aliases: string[]): Seed => ({ id, name: { ro, en }, aliases, area })

const seeds: Seed[] = [
  L('door_departures', 'Intrare plecări', 'Departures entrance', 'landside', 'intrare', 'intrarea', 'intrare plecari', 'entrance', 'main entrance'),
  L('door_exit_west', 'Ușă sosiri', 'Arrivals door', 'landside', 'iesire sosiri', 'usa sosiri', 'arrivals exit', 'arrivals door'),
  L('X_KERB_DEPARTURES', 'Trotuar plecări', 'Departures kerb', 'landside', 'trotuar plecari', 'drop off', 'drop-off', 'kerb'),
  L('X_KERB_ARRIVALS', 'Trotuar sosiri', 'Arrivals kerb', 'landside', 'trotuar sosiri', 'pick up', 'pick-up'),
  L('X_TAXI_RANK', 'Taxi', 'Taxi rank', 'landside', 'taxi', 'statie taxi', 'taxi rank', 'cab'),
  L('X_BOLT', 'Bolt', 'Bolt pick-up', 'landside', 'bolt', 'uber', 'ride share', 'ridesharing'),
  L('check_in:1', 'Check-in, ghișeele 1–4', 'Check-in, desks 1–4', 'landside', 'check-in 1', 'checkin 1', 'ghiseu 1', 'ghiseele 1-4', 'desks 1-4'),
  L('check_in:2', 'Check-in, ghișeele 5–8', 'Check-in, desks 5–8', 'landside', 'check-in 2', 'checkin 2', 'ghiseu 5', 'ghiseele 5-8', 'desks 5-8'),
  L('check_in:3', 'Check-in, ghișeele 9–12', 'Check-in, desks 9–12', 'landside', 'check-in 3', 'checkin 3', 'ghiseu 9', 'ghiseele 9-12', 'desks 9-12'),
  L('G_CHECKIN_QUEUE', 'Coadă check-in', 'Check-in queue', 'landside', 'check-in', 'checkin', 'coada check-in', 'check in'),
  L('G_CHECKIN_DESKS', 'Predare bagaje', 'Bag drop', 'landside', 'bag drop', 'predare bagaje', 'bagaj de cala', 'drop bag'),
  L('G_INFO', 'Informații', 'Information desk', 'landside', 'info', 'informatii', 'information', 'help desk'),
  L('G_CENTER', 'Hol central', 'Main hall', 'landside', 'hol central', 'main hall', 'centru'),
  L('G_WEST', 'Hol vest', 'West hall', 'landside', 'hol vest', 'west hall', 'inchirieri auto', 'car rental', 'lost and found', 'obiecte pierdute'),
  L('G_DEPARTURES', 'Hol plecări', 'Departures hall', 'landside', 'plecari', 'departures', 'hol plecari'),
  L('G_MEETING', 'Hol sosiri', 'Arrivals hall', 'landside', 'sosiri', 'arrivals', 'hol sosiri', 'meeting point', 'punct de intalnire'),
  L('G_CAFE', 'Gourmet Bar', 'Gourmet Bar', 'landside', 'gourmet', 'gourmet bar', 'bar', 'cafea parter'),
  L('G_WC', 'Toalete parter', 'Toilets, ground floor', 'landside', 'wc', 'toalete', 'toaleta', 'toilet', 'toilets', 'wc parter'),
  L('U_SECURITY_QUEUE', 'Securitate', 'Security', 'landside', 'securitate', 'security', 'control securitate', 'coada securitate', 'security queue'),
  L('U_CONCOURSE', 'Galerie', 'Gallery', 'landside', 'galerie', 'gallery', 'etaj', 'upstairs'),
  L('U_PASSPORT_DEP', 'Pașapoarte plecări', 'Passport control, departures', 'departures', 'pasapoarte', 'pasaport', 'passport', 'passport control', 'vama'),
  L('U_DUTY_FREE', 'Duty free', 'Duty free', 'departures', 'duty free', 'magazin', 'shop'),
  L('U_CAFE', 'Cafenea', 'Café', 'departures', 'cafenea', 'cafe', 'coffee', 'cafea'),
  L('U_WC', 'Toalete etaj', 'Toilets, upper floor', 'departures', 'wc etaj', 'toalete etaj', 'toilets upstairs'),
  L('U_CORRIDOR_EAST', 'Coridor est', 'East corridor', 'departures', 'coridor', 'coridor est', 'east corridor'),
  ...Array.from({ length: 10 }, (_, i) => L(`U_GATE_${i + 1}`, `Poarta ${i + 1}`, `Gate ${i + 1}`, 'departures', `poarta ${i + 1}`, `gate ${i + 1}`, `g${i + 1}`)),
  L('G_RECLAIM_1', 'Banda 1', 'Baggage belt 1', 'arrivals', 'banda 1', 'belt 1', 'bagaje 1', 'baggage 1'),
  L('G_RECLAIM_2', 'Banda 2', 'Baggage belt 2', 'arrivals', 'banda 2', 'belt 2', 'bagaje 2', 'baggage 2'),
  L('G_ARRIVALS_PASSPORT', 'Pașapoarte sosiri', 'Passport control, arrivals', 'arrivals', 'pasapoarte sosiri', 'arrivals passport'),
]

const nodes = new Map(terminalGraph.nodes.map(n => [n.id, n]));
const zoneById = new Map(zones.map(z => [z.id, z]));
export function landmarkArea(id: string): Area {
  const zone = nodes.get(id)?.zone ?? id;
  if (/^G_RECLAIM_|^G_ARRIVALS_PASSPORT$|^G_GATE_DOOR_/.test(zone) || id === 'door_arrivals_entry') return 'arrivals';
  return zoneById.get(zone)?.side === 'airside' ? 'departures' : 'landside';
}
export function landmarkTransition(from: Area, to: Area): boolean {
  return !(from === 'departures' && to === 'landside') && !((from === 'arrivals') !== (to === 'arrivals') && !(from === 'arrivals' && to === 'landside'));
}
const extra: Record<string, string[]> = {
  U_SECURITY: ['securitate', 'security', 'la control', 'control securitate', 'security control', 'controlul de securitate'],
  U_SECURITY_QUEUE: ['coada securitate', 'security queue', 'coada la control'],
  U_CONCOURSE: ['galerie', 'galeria', 'gallery', 'etaj', 'upstairs'],
  U_PASSPORT_DEP: ['la vama', 'vama', 'pasapoarte', 'passport', 'passport control', 'control pasapoarte'],
  G_RECLAIM_1: ['la bagaje', 'la benzi', 'bagaje', 'baggage reclaim', 'baggage', 'reclaim'],
  U_DUTY_FREE: ['duty', 'dutyfree'], G_WC: ['baie', 'baia', 'toaleta', 'toalete', 'wc', 'bathroom', 'restroom'],
  U_WC: ['baie etaj', 'toaleta etaj', 'wc airside', 'toilet upstairs', 'bathroom upstairs'],
  G_ESCALATOR: ['scarile rulante'], escalator_east_G: ['escalator', 'langa escalator', 'escalator parter', 'escalator downstairs'],
  stairs_east_G: ['la scari', 'scari', 'scarile', 'stairs', 'scari est parter'],
  lift_east_G: ['lift', 'ascensor', 'elevator', 'lift parter', 'lift est parter'],
  X_PARKING_T2: ['parcare', 'parking', 'car park', 'parcare t2'],
  X_BUS_221: ['autobuz', 'bus', 'rat 221', '221'], X_FORECOURT: ['esplanada', 'forecourt'],
  G_DEPARTURES: ['self check in', 'self checkin', 'self service'],
  door_exit_mid: ['iesire', 'exit', 'iesire parcare', 'parking exit'],
  G_MEETING: ['arrivals hall', 'meeting point', 'punct intalnire', 'sala sosiri'],
};
// Keep established IDs/names while giving security and its queue distinct meanings.
seeds.find(l => l.id === 'U_SECURITY_QUEUE')!.name = { ro: 'Coadă securitate', en: 'Security queue' };
seeds.find(l => l.id === 'U_SECURITY_QUEUE')!.aliases = [];
const list = new Map(seeds.map(s => [s.id, s]));
for (const z of zones) if (!list.has(z.id)) list.set(z.id, { id: z.id, name: { ro: z.name_ro, en: z.name_en }, aliases: [], area: landmarkArea(z.id) });
const canonical = (id: string): string => {
  if (id.startsWith('fids_')) {
    const p = points.find(p => p.id === id)!;
    return zones.filter(z => z.level === p.level).sort((a,b) => Math.hypot(a.centre[0]! - p.x,a.centre[1]! - p.z) - Math.hypot(b.centre[0]! - p.x,b.centre[1]! - p.z))[0]!.id;
  }
  let m = /^checkin_(\d+)$/.exec(id); if (m) return `check_in:${Math.ceil(Number(m[1]) / 4)}`;
  m = /^gate_(\d+)$/.exec(id); if (m) return `U_GATE_${m[1]}`;
  m = /^(?:door_apron_gate_|gate_)(\d+)(?:_stairs_G)?$/.exec(id); if (m) return `G_GATE_DOOR_${m[1]}`;
  if (/^security_lane_/.test(id)) return 'U_SECURITY';
  if (/^passport_arr_/.test(id)) return 'G_ARRIVALS_PASSPORT';
  if (/^passport_dep_/.test(id)) return 'U_PASSPORT_DEP';
  if (/^kiosk_[1-4]$/.test(id)) return 'G_DEPARTURES';
  return ({ info_desk: 'G_INFO', wc: 'G_WC', wc_air: 'U_WC', cafe_east: 'G_CAFE', cafe_air: 'U_CAFE', duty_free: 'U_DUTY_FREE', 'check_in:OTHER': 'check_in:3' } as Record<string, string>)[id] ?? id;
};
const names: Record<string, [string, string]> = {
  door_exit_mid: ['Ieșire parcare', 'Parking exit'], door_arrivals_east: ['Ușă sosiri est', 'East arrivals door'],
  door_emergency_west: ['Ieșire urgență vest', 'West emergency exit'], door_emergency_east: ['Ieșire urgență est', 'East emergency exit'],
  door_arrivals_entry: ['Intrare sosiri din peron', 'Arrivals entry from apron'],
  atm_bcr: ['Bancomat BCR', 'BCR ATM'], atm_euronet: ['Bancomat Euronet', 'Euronet ATM'],
  kiosk_west: ['Chioșc verde vest', 'West green kiosk'], vending_1: ['Automat', 'Vending machine'],
  shop_frosted: ['Spații vitrate mate', 'Frosted units'], shop_offices: ['Birouri', 'Offices'], shop_glazed: ['Birou vitrat', 'Glazed office'],
  lost_found: ['Bagaje pierdute', 'Lost & Found'],
};
const anchors = new Map<string, string>();
for (const p of points) {
  if (p.type === 'camera') continue;
  const id = canonical(p.id);
  if (list.has(id)) continue;
  let ro = names[id]?.[0] ?? p.name, en = names[id]?.[1] ?? p.name;
  const gateStair = /^gate_(\d+)_stairs_U$/.exec(id);
  if (gateStair) { ro = `Scări poarta ${gateStair[1]}, etaj`; en = `Gate ${gateStair[1]} stairs upstairs`; }
  else if (['stairs', 'escalator', 'lift'].includes(p.type)) {
    const kind = { stairs: ['Scări', 'Stairs'], escalator: ['Escalator', 'Escalator'], lift: ['Lift', 'Lift'] }[p.type]!;
    const west = id.includes('west'); ro = `${kind[0]} ${west ? 'vest' : 'est'} ${p.level === 'G' ? 'parter' : 'etaj'}`; en = `${west ? 'West' : 'East'} ${kind[1]} ${p.level === 'G' ? 'downstairs' : 'upstairs'}`;
  } else if (p.type === 'flight_screen') { ro = `Panou zboruri ${id.replace('fids_', '').replaceAll('_', ' ')}`; en = `Flight screen ${id.replace('fids_', '').replaceAll('_', ' ')}`; }
  // Non-navigation symbols route to the nearest same-floor named zone. Expose the anchor explicitly.
  const nearestZone = zones.filter(z => z.level === p.level).sort((a,b) => Math.hypot(a.centre[0]! - p.x,a.centre[1]! - p.z) - Math.hypot(b.centre[0]! - p.x,b.centre[1]! - p.z))[0]!;
  const anchor = nodes.has(id) ? id : nearestZone.id;
  anchors.set(id, anchor);
  list.set(id, { id, name: { ro, en }, aliases: [], area: landmarkArea(anchor) });
}
export const landmarks: Landmark[] = [...list.values()].map(s => {
  const graphNode = anchors.get(s.id) ?? s.id, n = nodes.get(graphNode)!;
  const p = points.find(p => p.id === s.id);
  const level = n.level as Landmark['level'];
  const sourceIds = [...new Set([s.id, ...points.filter(p => canonical(p.id) === s.id).map(p => p.id), ...contract.nodes.filter(n => canonical(n.id) === s.id).map(n => n.id)])];
  const aliases = [s.name.ro, s.name.en, ...s.aliases, ...(extra[s.id] ?? []), ...sourceIds, ...contract.nodes.filter(n => canonical(n.id) === s.id).flatMap(n => 'aliases' in n ? n.aliases ?? [] : [])];
  const group = /^check_in:([123])$/.exec(s.id);
  const desks = group ? deskGroups[group[1] as keyof typeof deskGroups] : undefined;
  if (group) {
    aliases.push(`grup ${group[1]}`, `grupul ${group[1]}`, `check in group ${group[1]}`, `bag drop ${group[1]}`, `bag_drop:${group[1]}`);
    for (const d of desks!) { const num = d.replace('checkin_', ''); aliases.push(`ghiseu ${num}`, `ghiseul ${num}`, `desk ${num}`, `counter ${num}`); }
  }
  const gate = /^U_GATE_(\d+)$/.exec(s.id);
  if (gate) aliases.push(`poarta ${gate[1]}`, `gate ${gate[1]}`, `g${gate[1]}`, `poarat ${gate[1]}`, `porta ${gate[1]}`);
  if (s.id === 'atm_bcr') aliases.push('atm', 'bancomat', 'cash machine', 'cash');
  return { ...s, area: landmarkArea(graphNode), graphNode, level, floor: level === 'U' ? 'Etaj 1' : level === 'X' ? 'Exterior' : 'Parter',
    side: zoneById.get(n.zone ?? graphNode)?.side === 'airside' ? 'airside' : 'landside',
    x: p?.x ?? n.x, z: p?.z ?? n.y, sourceIds,
    aliases: [...new Set(aliases.flatMap(a => [a.toLowerCase(), normalizeLandmark(a)]))],
    position: '', nearest: { wc: null, food: null, info: null, exit: null }, ...(desks && { desks }) };
});
/** Free-flow, normal-operation path; never cross arrivals/security boundaries backwards. */
export function landmarkRoute(a: Landmark, b: Landmark) {
  if (!landmarkTransition(a.area, b.area)) return null;
  const r = route(terminalGraph, a.graphNode, b.graphNode, {}, [], { evacuation: false });
  if (!r) return null;
  const areas = r.nodes.map(landmarkArea);
  if (areas.some((x,i) => i > 0 && !landmarkTransition(areas[i-1]!, x)) || a.area !== 'arrivals' && areas.includes('arrivals')) return null;
  return r;
}
for (const l of landmarks) {
  const near = landmarks.filter(p => p.id !== l.id && p.level === l.level && zoneById.has(p.id) && (p.side === l.side || l.id === 'ASSEMBLY_AIRSIDE'))
    .sort((a,b) => Math.hypot(l.x-a.x,l.z-a.z)-Math.hypot(l.x-b.x,l.z-b.z) || a.id.localeCompare(b.id)).slice(0,2);
  l.position = `${l.floor}, ` + near.map(p => { const dx=l.x-p.x,dz=l.z-p.z; const direction=Math.abs(dx)>Math.abs(dz)?(dx>0?'est':'vest'):(dz>0?'nord':'sud'); return `la ${direction} de ${p.name.ro}`; }).join(', ');
  const categories = { wc: ['G_WC','U_WC'], food: ['G_CAFE','U_CAFE','kiosk_west','vending_1'], info: ['G_INFO'], exit: ['door_departures','door_exit_west','door_exit_mid','door_arrivals_east'] };
  for (const [kind, ids] of Object.entries(categories)) {
    const candidates = landmarks.filter(p => ids.includes(p.id)).flatMap(p => {
      const r = landmarkRoute(l,p);
      if (!r) return [];
      const a = nodes.get(l.graphNode)!, b = nodes.get(p.graphNode)!;
      const connectors = l.id === p.id ? 0 : Math.hypot(l.x-a.x,l.z-a.y)/FREE_SPEED + Math.hypot(p.x-b.x,p.z-b.y)/FREE_SPEED;
      return [{ id:p.id, walkSec:l.id === p.id ? 0 : Math.ceil(r.totalSec+connectors) }];
    }).sort((a,b) => a.walkSec-b.walkSec || a.id.localeCompare(b.id));
    l.nearest[kind as keyof Landmark['nearest']] = candidates[0] ?? null;
  }
}
/** Longest whole-token alias wins. A location containing two equally specific places is ambiguous.
 * Optional origin limits generic amenities to a reachable nearest facility.
 */
export function resolveLandmark(text: string, origin?: string): Landmark | null {
  const q = normalizeLandmark(text); if (!q) return null;
  if (origin && /(?:nearest|closest|apropiata|apropiat)/.test(q)) {
    const kind = /\b(wc|toalet[a-z]*|baie|toilet[a-z]*|restroom|bathroom)\b/.test(q) ? 'wc' : /\b(cafea|coffee|food|mancare)\b/.test(q) ? 'food' : /\b(info|information|informatii)\b/.test(q) ? 'info' : /\b(exit|iesire)\b/.test(q) ? 'exit' : null;
    const from = landmarks.find(l => l.id === origin || l.sourceIds.includes(origin));
    if (kind && from) return landmarks.find(l => l.id === from.nearest[kind]?.id) ?? null;
  }
  let best = 0, matches: Landmark[] = [];
  for (const l of landmarks) for (const a of l.aliases) {
    const alias = normalizeLandmark(a);
    if (alias && (` ${q} `).includes(` ${alias} `)) {
      const score = alias.length;
      if (score > best) { best=score; matches=[l]; }
      else if (score===best && !matches.includes(l)) matches.push(l);
    }
  }
  return matches.length === 1 ? matches[0]! : null;
}
/** Coverage audit: every map symbol except cameras has an explicit passenger anchor. */
export const landmarkCoverage = {
  zones: zones.map(z => ({ sourceId:z.id, point:landmarks.find(l => l.sourceIds.includes(z.id))?.id ?? null })),
  points: points.filter(p => p.type !== 'camera').map(p => ({ sourceId:p.id, point:landmarks.find(l => l.sourceIds.includes(p.id))?.id ?? null })),
  nodes: contract.nodes.map(n => ({ sourceId:n.id, point:landmarks.find(l => l.sourceIds.includes(n.id))?.id ?? null })),
  absent: ['smoking area', 'lounge'],
};
