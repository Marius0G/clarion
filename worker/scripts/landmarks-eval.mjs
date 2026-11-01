/** Deterministic passenger language + pre-rendered asset evaluation. No network or LLM.
 * Run: node worker/scripts/landmarks-eval.mjs (uses the existing backend tsx loader).
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

// Explicit expected answers, independent of the catalogue's aliases.
const examples = [
  ['door_departures', 'Sunt la intrare', 'Where is the main entrance?'],
  ['door_departures', 'intrarea plecari', 'departures entrance'],
  ['door_exit_west', 'usa sosiri', 'arrivals door'],
  ['door_exit_mid', 'iesire parcare', 'parking exit'],
  ['door_arrivals_east', 'ușă sosiri est', 'east arrivals door'],
  ['door_emergency_east', 'ieșire urgență est', 'east emergency exit'],
  ['door_emergency_west', 'iesire urgenta vest', 'west emergency exit'],
  ['X_KERB_DEPARTURES', 'trotuar plecari', 'drop off'],
  ['X_KERB_ARRIVALS', 'trotuar sosiri', 'pick up'],
  ['X_TAXI_RANK', 'Unde e statia taxi?', 'Where is the taxi rank?'],
  ['X_BOLT', 'Sunt la Bolt', 'Bolt pick-up'],
  ['X_PARKING_T2', 'parcare t2', 'T2 car park'],
  ['X_PARKING_EAST', 'parcare est', 'east car park'],
  ['X_BUS_221', 'autobuz', 'bus stop 221'],
  ['X_FORECOURT', 'esplanada', 'forecourt'],
  ['check_in:1', 'check-in 1', 'check in group 1'],
  ['check_in:2', 'check-in 2', 'check in group 2'],
  ['check_in:3', 'check-in 3', 'check in group 3'],
  ['check_in:1', 'ghișeul 2', 'desk 4'],
  ['check_in:2', 'ghiseul 6', 'counter 8'],
  ['check_in:3', 'ghiseul 10', 'desk 12'],
  ['check_in:1', 'bag drop 1', 'desks 1-4'],
  ['check_in:2', 'bag drop 2', 'desks 5-8'],
  ['check_in:3', 'bag drop 3', 'desks 9-12'],
  ['G_CHECKIN_DESKS', 'predare bagaje', 'Where is bag drop?'],
  ['G_CHECKIN_QUEUE', 'coada check-in', 'check in'],
  ['G_DEPARTURES', 'self check in', 'self checkin'],
  ['G_INFO', 'informații', 'Where is the help desk?'],
  ['G_CENTER', 'hol central', 'main hall'],
  ['G_WEST', 'inchirieri auto', 'car rental'],
  ['G_MEETING', 'hol sosiri', 'arrivals hall'],
  ['G_MEETING', 'punct de intalnire', 'meeting point'],
  ['G_CAFE', 'Gourmet Bar', 'gourmet'],
  ['G_CAFE', 'cafea parter', 'bar'],
  ['G_WC', 'Unde este toaleta?', 'Where is the bathroom?'],
  ['G_WC', 'toaletă', 'restroom'],
  ['G_WC', 'baie', 'toilets'],
  ['U_WC', 'toaleta etaj', 'toilets upstairs'],
  ['U_WC', 'wc etaj', 'bathroom upstairs'],
  ['U_SECURITY', 'la control', 'security control'],
  ['U_SECURITY', 'control securitate', 'security'],
  ['U_SECURITY_QUEUE', 'coada la control', 'security queue'],
  ['U_CONCOURSE', 'galerie', 'gallery'],
  ['U_PASSPORT_DEP', 'la vamă', 'passport control'],
  ['U_PASSPORT_DEP', 'control pasapoarte', 'departures passport control'],
  ['G_ARRIVALS_PASSPORT', 'pasapoarte sosiri', 'arrivals passport'],
  ['U_DUTY_FREE', 'duty', 'duty free'],
  ['U_CAFE', 'cafea', 'coffee'],
  ['U_CORRIDOR_EAST', 'coridor est', 'east corridor'],
  ['G_RECLAIM_1', 'la bagaje', 'baggage reclaim'],
  ['G_RECLAIM_1', 'la benzi', 'belt 1'],
  ['G_RECLAIM_2', 'banda 2', 'baggage belt 2'],
  ['escalator_east_G', 'lângă escalator', 'escalator downstairs'],
  ['escalator_east_U', 'escalator est etaj', 'east escalator upstairs'],
  ['stairs_east_G', 'la scări', 'east stairs downstairs'],
  ['stairs_west_G', 'scari vest parter', 'west stairs downstairs'],
  ['stairs_west_U', 'scari vest etaj', 'west stairs upstairs'],
  ['stairs_east_U', 'scari est etaj', 'east stairs upstairs'],
  ['lift_east_G', 'langa lift', 'elevator'],
  ['lift_east_U', 'lift est etaj', 'east lift upstairs'],
  ['lift_west_G', 'lift vest parter', 'west lift downstairs'],
  ['lift_west_U', 'lift vest etaj', 'west lift upstairs'],
  ['atm_bcr', 'bancomat', 'BCR ATM'],
  ['atm_euronet', 'bancomat Euronet', 'Euronet ATM'],
  ['lost_found', 'bagaje pierdute', 'lost & found'],
  ['shop_sixt', 'Sunt la Sixt', 'Where is Sixt?'],
  ['shop_autonom', 'Autonom', 'I am at Autonom'],
  ['shop_pricecarz', 'PriceCarz', 'I am at PriceCarz'],
  ['vending_1', 'automat', 'vending machine'],
  ['kiosk_west', 'chiosc verde vest', 'west green kiosk'],
];
export const landmarkCases = examples.flatMap(([id, ro, en]) => [{ text: ro, expected: id }, { text: en, expected: id }]).concat(
  Array.from({ length: 10 }, (_, i) => ({ text: `Cum ajung la poarat ${i + 1}?`, expected: `U_GATE_${i + 1}` })),
  Array.from({ length: 10 }, (_, i) => ({ text: `Take me to gate ${i + 1}`, expected: `U_GATE_${i + 1}` })),
  Array.from({ length: 10 }, (_, i) => ({ text: `sunt la g${i + 1}`, expected: `U_GATE_${i + 1}` })),
);
export const origins = ['door_departures', 'escalator_east_G', 'G_MEETING', 'U_GATE_5', 'G_RECLAIM_1'];
export function evaluateLandmarks(resolve, index, root = fileURLToPath(new URL('../../app/public', import.meta.url))) {
  const failures = []; let passed = 0, images = 0, skips = 0, samePoint = 0;
  for (const c of landmarkCases) {
    const result = resolve(c.text);
    if (result?.id !== c.expected) { failures.push({ ...c, actual: result?.id ?? null }); continue; }
    let valid = true;
    for (const from of origins) {
      if (from === result.id) { samePoint++; continue; }
      const r = index.routes[`${from}__${result.id}`];
      if (r) {
        if (existsSync(`${root}${r.file}`)) images++;
        else { failures.push({ ...c, from, error: `Missing image ${r.file}` }); valid = false; }
      } else if (index.skipped.some(s => s.from === from && s.to === result.id && index.skipReasons[s.reason])) skips++;
      else { failures.push({ ...c, from, error: 'No route or documented skip' }); valid = false; }
    }
    if (valid) passed++;
  }
  return { total: landmarkCases.length, passed, accuracy: 100 * passed / landmarkCases.length, images, documentedSkips: skips, samePoint, failures };
}
async function main() {
  const require = createRequire(new URL('../../backend/package.json', import.meta.url));
  const { tsImport } = require('tsx/esm/api');
  const { resolveLandmark } = await tsImport('../../backend/src/landmarks.ts', import.meta.url);
  const index = JSON.parse(readFileSync(new URL('../../app/public/routes/index.json', import.meta.url), 'utf8'));
  const report = evaluateLandmarks(resolveLandmark, index);
  console.log(JSON.stringify(report, null, 2));
  if (report.accuracy < 95) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error); process.exitCode = 1; });
