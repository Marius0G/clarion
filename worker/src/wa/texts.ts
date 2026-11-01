import { zones, points } from '../../../backend/src/terminal.js';
import { clockText, etd, gateName, type Flight } from './flights.js';
import type { arrivalPlan } from './tools.js';
import type { OpsCommand } from '../../../backend/src/sim.js';
import type { EvacPlan, EvacRoute } from './messaging.js';
// D23: all deterministic passenger copy lives here; absent choices remain Romanian.
export type Lang = 'ro' | 'en';
export const language = (value: unknown): Lang => value === 'en' ? 'en' : 'ro';
const texts = {
  margin: ['Marjă', 'Margin'],
  provisional: ['Orar provizoriu de test, nu orarul real al aeroportului.', 'Provisional test schedule, not the real airport schedule.'],
  flightHint: ['Cere-i numărul zborului (ex: W6 3751).', 'Ask for the flight number (for example W6 3751).'],
  unknownFlightHint: ['Zborul nu e în orarul de azi. Roagă-l să verifice numărul.', 'The flight is not in today’s schedule. Ask them to check the number.'],
  "cancelledNote": ["Zborul e anulat. Informațiile despre alternative sunt disponibile la compania aeriană.", "The flight is cancelled. Alternative options are available from the airline."],
  "departedNote": ["Zborul a plecat deja.", "The flight has already departed."],
  "eta": ["Echipa ajunge în ~{0} min", "The team arrives in ~{0} min"],
  "policeEta": ["Poliția aeroportului ajunge în ~{0} min", "Airport police arrive in ~{0} min"],
  "fromSecurity": ["De la securitate la poarta {0} faci ~{1} min.", "From security to gate {0} is ~{1} min on foot."],
  "evacRoad": ["Dacă sunteți încă pe drum, nu veniți acum: estimăm că zona se redeschide în ~{0} min. Vă scriem când se poate.", "If you are still on the way, do not come now: we expect the area to reopen in ~{0} min. We will message you when it does."],
  "evacRoadUnknown": ["Dacă sunteți încă pe drum, nu veniți acum. Vă scriem când zona se redeschide.", "If you are still on the way, do not come now. We will message you when the area reopens."],
  "allClear": ["Terminalul s-a redeschis.", "The terminal has reopened."],
  "history": ["~{0} min la {1} (media din istoric la ora asta)", "~{0} min at {1} (same-hour history)"],
  "noEta": ["ETA indisponibil: loc necunoscut sau traseu blocat.", "ETA unavailable: location unknown or route blocked."],
  "reportSent": ["Raportul e pe harta din dashboard. Echipa de intervenție a fost anunțată. {0}", "The report is on the dashboard map. The response team has been notified. {0}"],
  "unknownPlace": ["loc neprecizat", "location unspecified"],
  "whereIssue": ["Ce s-a întâmplat și unde?", "What happened and where?"],
  "reportUnavailable": ["Nu pot trimite raportul acum. Sună la dispecerat.", "The report could not be sent. Call the dispatch desk."],
  "staffOnly": ["Doar angajații aeroportului pot raporta incidente aici.", "Only airport staff can report incidents here."],
  "route": ["De la intrare: {0}. ~{1} min.", "From the entrance: {0}. ~{1} min."],
  "noRoute": ["Nu există un traseu liber cunoscut. Personalul are informații despre traseele disponibile.", "No clear route is currently known. Staff have information on available routes."],
  "noQueues": ["Nu am date live despre cozi acum.", "Live queue data is unavailable right now."],
  "later": [", ~{0} min peste {1} min", ", ~{0} min in {1} min"],
  "unknownNow": ["timp necunoscut acum", "current wait unknown"],
  "cancelled": [" Zborul e anulat.", " Flight cancelled."],
  "delay": [" Întârziat {0} min.", " Delayed by {0} min."],
  "flightInfo": ["{0} spre {1}: poarta {2}, plecare {3}, poarta se închide la {4}.{6}", "{0} to {1}: gate {2}, departure {3}, gate closes at {4}.{6}"],
  "staffReport": ["Am primit ({0}): {1}, {2}. {3}", "Received ({0}): {1}, {2}. {3}"],
  "greeting": ["Salut! Sunt Clarion, asistentul Aeroportului Craiova ✈️ Aici sunt disponibile cozile acum și prognoza, durata estimată până la poartă și informațiile despre zbor.", "Hi! I am Clarion, Craiova Airport’s assistant ✈️ I can share current queues and forecasts, estimated time to the gate and flight information."],
  "bagAssumed": ["Am socotit și predarea bagajului. Ai bagaj de cală?", "The estimate includes bag drop. Do you have checked baggage?"],
  "askFlight": ["Care este numărul zborului (ex: W6 3751)?", "What is your flight number (for example W6 3751)?"],
  "refusal": ["Aici nu te pot ajuta, dar pentru zbor și aeroport sunt aici oricând 🙂", "I can help with your flight and the airport 🙂"],
  "tangled": ["Hmm, m-am încurcat puțin 😅 Poți să o spui altfel?", "I lost track a little 😅 Could you rephrase that?"],
  "situation": ["{0} {5} Poarta {1} se închide la {2}. Cu situația de acum, de la intrare la poartă ~{3} min, inclusiv 10 min marjă.", "{0} {5} Gate {1} closes at {2}. With current conditions, entrance to gate takes ~{3} min, including a 10 min margin."],
  "estimated": ["~{0} min", "~{0} min"],
  "forecast": ["~{0} min la {1}", "~{0} min at {1}"],
  "now": ["{0} min acum", "{0} min now"],
  "walk": ["Drum până la poarta {0}", "Walk to gate {0}"],
  "fallback": [
    "Am o problemă tehnică. Informațiile nu sunt disponibile acum.",
    "There is a technical problem. Information is unavailable right now."
  ],
  "textOnly": [
    "Deocamdată citesc doar mesaje text. Ce informații despre aeroport sau zbor te interesează?",
    "I can read text messages for now. What would you like to know about the airport or your flight?"
  ],
  "language": [
    "Voi răspunde în română.",
    "I will reply in English."
  ],
  "bagYes": [
    "Da, am bagaj",
    "Checked baggage"
  ],
  "bagNo": [
    "Doar de mână",
    "Hand baggage only"
  ],
  "bagQueryYes": [
    "Am bagaj de cală. Când se schimbă cozile?",
    "I have checked baggage. When are the queues expected to change?"
  ],
  "bagQueryNo": [
    "Am doar bagaj de mână. Când se schimbă cozile?",
    "I have hand baggage only. When are the queues expected to change?"
  ],
  "simClock": [
    "ora simulării",
    "simulation time"
  ],
  "realClock": [
    "ora locală",
    "local time"
  ],
  "deleted": [
    "Gata, am șters tot ce știam despre tine și zborul tău. Dacă vrei să reîncepi, scrie-mi oricând.",
    "Your data and flight details have been deleted. You can message me again anytime."
  ],
  "staffRegistered": [
    "Gata, ești înregistrat ca angajat al aeroportului 👷 Scrie-mi orice problemă vezi în terminal (ex: „bagaj abandonat lângă check-in 2”) și o trimit imediat pe harta din dashboard.",
    "You are registered as airport staff 👷 Report any terminal issue here (for example, unattended baggage near check-in 2) and it will appear on the dashboard map."
  ],
  "staffCodeInvalid": [
    "Codul de angajat nu e corect. Verifică-l cu coordonatorul de tură și scrie din nou STAFF <cod>.",
    "Invalid staff code. Check with your shift coordinator and send STAFF <code> again."
  ],
  "bagQuestion": [
    "Ai bagaj de cală?",
    "Do you have checked baggage?"
  ],
  "unknownFlight": [
    "Nu găsesc zborul {0} în orarul de azi. Numărul zborului apare pe boarding pass.",
    "Flight {0} is not in today's schedule. The flight number is on your boarding pass."
  ],
  "startConnected": [
    "Gata ✈️ Te-am conectat la zborul {0} spre {1}. Poarta {2} se închide la {3}.",
    "Connected ✈️ Your flight is {0} to {1}. Gate {2} closes at {3}."
  ]
} as const;
export function say(lang: Lang | undefined, key: keyof typeof texts, ...values: (string | number)[]): string {
  return texts[key][language(lang) === 'en' ? 1 : 0].replace(/\{(\d+)\}/g, (_, i) => String(values[Number(i)] ?? ''));
}

export const ZONE_NAMES: Record<string, string> = {
  check_in: 'Check-in', bag_drop: 'Predare bagaje', security: 'Control de securitate',
  arrivals_hall: 'Sala de sosiri', taxi_rank: 'Stația de taxi', kerb: 'Zona de oprire',
};

export const EN_ZONE_NAMES: Record<string, string> = { check_in: 'Check-in', bag_drop: 'Bag drop', security: 'Security', arrivals_hall: 'Arrivals hall', taxi_rank: 'Taxi rank', kerb: 'Kerb' };

export const copy = {
  places: (lang: Lang | undefined) => lang === 'en' ? ({ entrance: 'Entrance', airside: 'Departures area', team_post: 'Response team post' } as Record<string, string>) : ({ entrance: 'Intrarea', airside: 'Zona de plecări', team_post: 'Postul echipei' } as Record<string, string>),
  group: (lang: Lang | undefined, name: string | undefined, suffix: string) => lang === 'en' ? `${name}, group ${suffix}` : `${name}, grupul ${suffix}`,
  numberedNode: (lang: Lang | undefined, n: RegExpExecArray) => lang === 'en' ? `${n[1] === 'gate' ? 'Gate' : 'Exit'} ${n[2]}` : `${n[1] === 'gate' ? 'Poarta' : 'Ieșirea'} ${n[2]}`,
  gateWalk: (lang: Lang | undefined, flight: Flight) => lang === 'en' ? `Walk to gate ${gateName(flight.gate)}` : `Drum până la poarta ${gateName(flight.gate)}`,
  cancelledFlight: (lang: Lang | undefined, f: Flight) => lang === 'en' ? `Flight ${f.flight} to ${f.destination} is cancelled. Alternative options are available from the airline.` : `Zborul ${f.flight} spre ${f.destination} e anulat. Informațiile despre alternative sunt disponibile la compania aeriană.`,
  departedFlight: (lang: Lang | undefined, f: Flight) => lang === 'en' ? `Flight ${f.flight} to ${f.destination} has departed.` : `Zborul ${f.flight} spre ${f.destination} a plecat.`,
  flightSituation: (lang: Lang | undefined, f: Flight, situation: string) => lang === 'en' ? `Flight ${f.flight} to ${f.destination}. ${situation}` : `Zborul ${f.flight} spre ${f.destination}. ${situation}`,
  delayedDeparture: (lang: Lang | undefined, f: Flight) => lang === 'en' ? `is delayed by ${f.delayMin} min. Departure: ${clockText(etd(f))} instead of ${clockText(f.std)}` : `are o întârziere de ${f.delayMin} min. Plecarea: ${clockText(etd(f))} în loc de ${clockText(f.std)}`,
  scheduledDeparture: (lang: Lang | undefined, f: Flight) => lang === 'en' ? `departs as scheduled at ${clockText(etd(f))}` : `pleacă la ora programată, ${clockText(etd(f))}`,
  flightChange: (lang: Lang | undefined, f: Flight, change: string, situation: string) => lang === 'en' ? `Flight ${f.flight} to ${f.destination} ${change}. ${situation}` : `Zborul ${f.flight} spre ${f.destination} ${change}. ${situation}`,
  redirect: (lang: Lang | undefined, command: Extract<OpsCommand, { type: 'redirect' }>) => lang === 'en' ? `${nodeName(command.from, lang)}: flow is redirected to ${nodeName(command.to, lang)}.` : `${nodeName(command.from)}: fluxul este mutat la ${nodeName(command.to)}.`,
  areaState: (lang: Lang | undefined, zone: string, command: OpsCommand) => lang === 'en' ? `${nodeName(zone, lang)}: the area is ${command.type === 'close' ? 'closed' : 'open'}.` : `${nodeName(zone)}: zona este ${command.type === 'close' ? 'închisă' : 'deschisă'}.`,
  evacuation: (lang: Lang | undefined, zones: string[]) => lang === 'en' ? `Evacuation: ${zones.map(z => nodeName(z, lang)).join(', ')} closed. Leave the area and follow signs to the nearest exit.` : `Evacuare: ${zones.map(n => nodeName(n)).join(', ')} ${zones.length > 1 ? 'sunt închise' : 'e închisă'}. Părăsește zona și urmează indicatoarele spre cea mai apropiată ieșire.`,
  /** Pitch: someone who may still be on the road is told not to come, and for how long (evac.plan clearSec plus a margin). */
  evacuationRoad: (lang: Lang | undefined, reopenInMin: number | null) => reopenInMin === null ? say(lang, 'evacRoadUnknown') : say(lang, 'evacRoad', reopenInMin),
  blockedAreas: (lang: Lang | undefined, p: EvacPlan) => lang === 'en' ? `${p.blocked.map(z => nodeName(z, lang)).join(', ')} closed. ` : `${p.blocked.map(n => nodeName(n)).join(', ')} ${p.blocked.length > 1 ? 'sunt închise' : 'e închisă'}. `,
  evacuationRoute: (lang: Lang | undefined, blocked: string, r: EvacRoute) => lang === 'en' ? `Evacuation: ${blocked}Exit via ${nodeName(r.exit, lang)}: ${r.nodes.map(z => nodeName(z, lang)).join(' → ')}. Follow signs and staff instructions.` : `Evacuare: ${blocked}Ieși pe ${nodeName(r.exit)}: ${r.nodes.map(n => nodeName(n)).join(' → ')}. Urmează indicatoarele și personalul.`,
  situation: (lang: Lang | undefined, plan: ReturnType<typeof arrivalPlan>) => {
    const queues = plan.queues.map(q => queueText(nodeName(q.zone, lang), q.nowMin, q.forecast, lang)).join(' ');
    const walk = plan.steps.find(s => s.zone === 'walk')?.min ?? 0;
    const wait = plan.steps.filter(s => !['walk', 'margin'].includes(s.zone)).reduce((n, s) => n + s.min, 0);
    return lang === 'en'
      ? `${queues} To gate ${plan.gate}: ~${walk} min walking, ${wait < 1 ? 'no queue' : `~${wait} min in queues`}. Gate ${plan.gate} closes at ${plan.gateCloseAt}.`
      : `${queues} Până la poarta ${plan.gate} ~${walk} min de mers, ${wait < 1 ? 'fără coadă' : `~${wait} min la cozi`}. Poarta ${plan.gate} se închide la ${plan.gateCloseAt}.`;
  },
};
export function localSource(source: string, lang?: Lang) {
  return lang === 'en' ? ({ 'prognoză': 'forecast', 'acum': 'now', 'estimare standard': 'standard estimate', 'istoric': 'same-hour history' } as Record<string, string>)[source] ?? source : source;
}

export const EN_ISSUES = { bagaj_abandonat: 'Unattended baggage', medical: 'Medical', securitate: 'Security', aglomerare: 'Crowding', altele: 'Other' };

/** "check_in:2" -> "Check-in, grupul 2" (desk group, D8); "check_in:W6" -> "Check-in W6" (legacy per airline). */
export function zoneName(zone: string, lang?: Lang) {
  const real = zones.find(z => z.id === zone);
  if (real) return lang === 'en' ? real.name_en : real.name_ro;
  const point = points.find(p => p.id === zone && p.evacuation_exit);
  if (point) return lang === 'en' ? 'Exit' : 'Ieșire';
  const [base, suffix] = zone.split(':');
  const name = (lang === 'en' ? EN_ZONE_NAMES : ZONE_NAMES)[base!] ?? base;
  if (!suffix) return name!;
  return /^\d+$/.test(suffix) ? copy.group(lang, name, suffix) : `${name} ${suffix}`;
}
/** Readable node: "gate_2" -> "Poarta 2", "exit_1" -> "Ieșirea 1", "check_in:2" -> "Check-in, grupul 2". */
export function nodeName(id: string, lang?: Lang) {
  const amenity = points.find(p => p.id === id && ['atm', 'information', 'wc', 'cafe', 'shop'].includes(p.type));
  if (amenity) return amenity.type === 'atm' ? `ATM ${amenity.name}` : amenity.name;
  const n = /^(gate|exit)_(\d+)$/.exec(id);
  if (n) return copy.numberedNode(lang, n);
  return copy.places(lang)[id] ?? zoneName(id, lang);
}


export const RO_ISSUES = { bagaj_abandonat: 'bagaj abandonat', medical: 'urgență medicală', securitate: 'problemă de securitate', aglomerare: 'aglomerare', altele: 'incident' };

/** Hamburg bands, keeping approximate figures only where they add information. */
export function waitBand(min: number | null, lang?: Lang): string {
  if (min === null) return lang === 'en' ? 'wait unknown' : 'timp necunoscut';
  if (min < 1) return lang === 'en' ? 'no queue' : 'fără coadă';
  const band = min <= 3 ? (lang === 'en' ? 'short queue' : 'coadă mică') : min <= 10 ? (lang === 'en' ? 'moderate queue' : 'coadă moderată') : (lang === 'en' ? 'long queue' : 'coadă mare');
  return `${band}, ~${Math.round(min)} min`;
}
export function queueText(name: string, now: number | null, forecast: { inMin: number; waitMin: number }[] = [], lang?: Lang) {
  const future = forecast.filter(p => p.inMin > 0 && p.inMin <= 120);
  const full = [30, 60, 90, 120].every(m => future.some(p => p.inMin === m));
  if (now !== null && now < 1 && full && future.every(p => p.waitMin < 1)) {
    return lang === 'en' ? `No queue at ${name === 'Security' ? 'security' : name}, and none is expected in the next 2 hours.` : `Nu e coadă la ${name === 'Control de securitate' ? 'securitate' : name} și nu se așteaptă să se formeze în următoarele 2 ore.`;
  }
  const peak = future.reduce<typeof future[number] | undefined>((a, b) => !a || b.waitMin > a.waitMin ? b : a, undefined);
  return `${name}: ${waitBand(now, lang)} ${lang === 'en' ? 'now' : 'acum'}${peak ? `; ${waitBand(peak.waitMin, lang)} ${lang === 'en' ? 'in' : 'peste'} ${peak.inMin} min` : ''}.`;
}
/** Last-line guard for generated copy; the clock itself remains the airport clock. */
export function passengerText(text: string) {
  let personal = false;
  return text.replace(/https?:\/\/[^\s]+/g, url => {
    if (!url.includes('/m/')) return text.includes('/m/') || url.includes('/join?login=') ? '' : url;
    if (personal) return '';
    personal = true; return url;
  }).replace(/\s*\([^)]*(?:simul|simulation|estimare|estimate|ora locală|local time|ora din chat|demo)[^)]*\)/gi, '')
    .replace(/[^.!?\n]*(?:simulăr|simulation|estimare|demo)[^.!?\n]*[.!?]?/gi, '').trim();
}
