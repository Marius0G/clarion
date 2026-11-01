/**
 * Places a passenger can name in T2, mapped to node ids of the backend's terminal graph
 * (backend/src/terminal.ts). Names in Romanian and English, plus lowercase aliases for matching typed text.
 * `area`: which part of the terminal the place belongs to, for the normal-operation rules in plan.ts.
 */
export type Area = 'landside' | 'departures' | 'arrivals'
export interface Landmark { id: string; name: { ro: string; en: string }; aliases: string[]; area: Area }

const L = (id: string, ro: string, en: string, area: Area, ...aliases: string[]): Landmark => ({ id, name: { ro, en }, aliases, area })

export const landmarks: Landmark[] = [
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
