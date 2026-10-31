import type { MapZone } from './data'

/**
 * What a passenger or the admin reads on the map: short place names, never Marius's codes (G1, U4, P7).
 * Gates and apron doors are shown as numbered badges instead of text.
 */
const NAMES: Record<string, [string, string]> = {
  G_CHECKIN_DESKS: ['Check-in', 'Check-in'],
  G_CHECKIN_QUEUE: ['Coadă check-in', 'Check-in queue'],
  G_ARRIVALS_EXIT: ['Ieșire sosiri', 'Arrivals exit'],
  G_INFO: ['Informații', 'Information'],
  G_ESCALATOR: ['Spre securitate', 'To security'],
  G_STAIRS_WEST: ['Scări', 'Stairs'],
  G_WC: ['WC', 'WC'],
  G_CAFE: ['Gourmet Bar', 'Gourmet Bar'],
  G_DEPARTURES: ['Plecări', 'Departures'],
  G_CENTER: ['Hol central', 'Main hall'],
  G_MEETING: ['Sosiri', 'Arrivals'],
  G_WEST: ['Hol vest', 'West hall'],
  G_RECLAIM_1: ['Banda 1', 'Belt 1'],
  G_RECLAIM_2: ['Banda 2', 'Belt 2'],
  G_ARRIVALS_PASSPORT: ['Pașapoarte sosiri', 'Arrivals passport'],
  U_SECURITY_QUEUE: ['Coadă securitate', 'Security queue'],
  U_SECURITY: ['Securitate', 'Security'],
  U_ESCALATOR_TOP: ['Escalator', 'Escalator'],
  U_CONCOURSE: ['Galerie', 'Gallery'],
  U_PASSPORT_DEP: ['Pașapoarte', 'Passport control'],
  U_DUTY_FREE: ['Duty free', 'Duty free'],
  U_CAFE: ['Cafenea', 'Café'],
  U_WC: ['WC', 'WC'],
  U_CORRIDOR_EAST: ['Coridor est', 'East corridor'],
  X_KERB_DEPARTURES: ['Trotuar plecări', 'Departures kerb'],
  X_KERB_ARRIVALS: ['Trotuar sosiri', 'Arrivals kerb'],
  X_TAXI_RANK: ['Taxi', 'Taxi'],
  X_BOLT: ['Bolt', 'Bolt'],
  X_BUS_221: ['Autobuz 221', 'Bus 221'],
  ASSEMBLY_LANDSIDE_WEST: ['Adunare vest', 'Assembly west'],
  ASSEMBLY_LANDSIDE_EAST: ['Adunare est', 'Assembly east'],
  ASSEMBLY_AIRSIDE: ['Adunare peron', 'Assembly apron'],
  X_PARKING_T2: ['Parcare T2', 'T2 parking'],
  X_PARKING_EAST: ['Parcare est', 'East parking'],
  X_FORECOURT: ['', ''],
}

export type ZoneLabel =
  | { kind: 'gate'; number: string; small: boolean; text: string }
  | { kind: 'text'; text: string }

export function zoneLabel(z: MapZone, lang: 'ro' | 'en' = 'ro'): ZoneLabel {
  const gate = /^U_GATE_(\d+)$/.exec(z.id)
  if (gate) return { kind: 'gate', number: gate[1]!, small: false, text: lang === 'en' ? `Gate ${gate[1]}` : `Poarta ${gate[1]}` }
  const door = /^G_GATE_DOOR_(\d+)$/.exec(z.id)
  if (door) return { kind: 'gate', number: door[1]!, small: true, text: lang === 'en' ? `Apron door ${door[1]}` : `Ieșire peron ${door[1]}` }
  const known = NAMES[z.id]
  const fallback = (lang === 'en' ? z.name_en : z.name_ro).replace(/\s*\*$/, '').replace(/\s*\(.*\)\s*$/, '')
  return { kind: 'text', text: known ? known[lang === 'en' ? 1 : 0] : fallback }
}

/** Name for lists and tooltips: the map label, falling back to the package name. */
export const placeName = (z: MapZone, lang: 'ro' | 'en' = 'ro') => {
  const l = zoneLabel(z, lang)
  return l.text || (lang === 'en' ? z.name_en : z.name_ro).replace(/\s*\*$/, '')
}
