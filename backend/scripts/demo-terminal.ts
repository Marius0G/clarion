/**
 * Fake Unity + fake vision service on the real T2 map (docs/contract/map), so the admin screen runs without
 * Marius's build. Same contract as SPEC-v2; not a model of anything: Unity and vision/ replace it.
 *
 * Twin (client=twin), every second: sim.status, truth.report (exact queues, D0), flight.update on connect and change.
 *   Answers every ops.command with ops.ack and applies a toy effect.
 * Vision (client=vision), every second: flow.report (noisy estimate, coverage, forecast, A7 advice) and
 *   crowd.positions (persistent people who walk, in world metres with level), only where a camera sees.
 *
 *   BACKEND_URL=http://localhost:8787 DEMO_TOKEN=... npm run demo:terminal
 *   Knobs (env): SIM_SPEED (sim s per real s, 30), LOAD (arrivals x, 1), COVERAGE (camera share x, 1), START (HH:MM, 13:30)
 *   Keys (TTY): + / - load, s security surge, c check-in surge, d delay next flight, x cancel it, k camera outage at
 *   security, e end evacuations, r reset, q quit.
 */
import { WebSocket } from "ws";
import zoneData from "../../docs/contract/map/zones.json" with { type: "json" };
import navData from "../../docs/contract/terminal.json" with { type: "json" };

type Level = "G" | "U" | "X";
type XZ = [number, number];
interface Ring { outer: XZ[]; holes?: XZ[][] }
const base = process.env.BACKEND_URL ?? `http://localhost:${process.env.PORT ?? 8787}`;
const SIM_SPEED = Number(process.env.SIM_SPEED ?? 30);
let load = Number(process.env.LOAD ?? 1);
const coverageScale = Number(process.env.COVERAGE ?? 1);
const [h0, m0] = (process.env.START ?? "13:30").split(":").map(Number);

// ---------- geometry ----------
const zoneGeo = new Map(zoneData.zones.map(z => [z.id, { level: z.level as Level, area: z.area_m2, rings: z.polygons_world as Ring[] }]));
const inRing = ([x, z]: XZ, ring: XZ[]) => {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i]!, [xj, zj] = ring[j]!;
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) hit = !hit;
  }
  return hit;
};
const insideZone = (p: XZ, id: string) => zoneGeo.get(id)!.rings.some(r => inRing(p, r.outer) && !(r.holes ?? []).some(h => inRing(p, h)));
function randomIn(id: string): XZ {
  const ring = zoneGeo.get(id)!.rings[0]!.outer;
  const xs = ring.map(p => p[0]), zs = ring.map(p => p[1]);
  for (let i = 0; i < 200; i++) {
    const p: XZ = [Math.min(...xs) + Math.random() * (Math.max(...xs) - Math.min(...xs)), Math.min(...zs) + Math.random() * (Math.max(...zs) - Math.min(...zs))];
    if (insideZone(p, id)) return p;
  }
  return [xs.reduce((a, b) => a + b) / xs.length, zs.reduce((a, b) => a + b) / zs.length];
}

// ---------- the true terminal (Unity) ----------
/** Queues: people waiting, lanes open, people served per lane per sim minute, arrivals per sim minute, where they stand. */
interface Queue { waiting: number; lanes: number; perLane: number; arrivals: number; open: boolean; zone: string; next: string | null }
const lanes0 = navData.lanes as Record<string, { initial: number }>;
const fresh = (): Record<string, Queue> => ({
  "check_in:1": { waiting: 34, lanes: lanes0["check_in:1"]!.initial, perLane: 0.75, arrivals: 1.2, open: true, zone: "G_CHECKIN_QUEUE", next: "U_SECURITY_QUEUE" },
  "check_in:2": { waiting: 12, lanes: lanes0["check_in:2"]!.initial, perLane: 0.75, arrivals: 0.7, open: true, zone: "G_CHECKIN_QUEUE", next: "U_SECURITY_QUEUE" },
  "check_in:3": { waiting: 5, lanes: lanes0["check_in:3"]!.initial, perLane: 0.75, arrivals: 0.4, open: true, zone: "G_CHECKIN_QUEUE", next: "U_SECURITY_QUEUE" },
  U_SECURITY_QUEUE: { waiting: 45, lanes: lanes0.security!.initial, perLane: 1.6, arrivals: 1.6, open: true, zone: "U_SECURITY_QUEUE", next: "U_CONCOURSE" },
  U_PASSPORT_DEP: { waiting: 10, lanes: 2, perLane: 2.2, arrivals: 0, open: true, zone: "U_PASSPORT_DEP", next: "U_CORRIDOR_EAST" },
});
/** Places without a queue: people present. */
const freshCrowd = (): Record<string, number> => ({
  G_DEPARTURES: 40, G_CENTER: 14, G_WEST: 10, G_CAFE: 12, G_MEETING: 18, X_KERB_DEPARTURES: 8, X_TAXI_RANK: 6,
  U_SECURITY: 6, U_CONCOURSE: 55, U_DUTY_FREE: 16, U_CAFE: 12, U_CORRIDOR_EAST: 20,
  U_GATE_1: 30, U_GATE_2: 12, U_GATE_3: 0, U_GATE_6: 8, U_GATE_8: 0,
});
/** Lane key the backend keeps for a queue (D12 one counter per place). */
const laneKeyOf = (q: string) => q === "U_SECURITY_QUEUE" ? "security" : q;
let queues = fresh(), crowd = freshCrowd();
const evacuated = new Set<string>();
const startTime = (h0 ?? 13) * 3600 + (m0 ?? 30) * 60;
let simTime = startTime;
const hhmm = (s: number) => `${String(Math.floor(s / 3600) % 24).padStart(2, "0")}:${String(Math.floor(s / 60) % 60).padStart(2, "0")}`;
const at = (h: number, m = 0) => h * 3600 + m * 60;
const freshFlights = () => [
  { flight: "W6 3751", airline: "W6", destination: "Londra Luton", std: at(14, 40), gate: "U_GATE_1", checkIn: "check_in:1", pax: 186 },
  { flight: "RO 642", airline: "RO", destination: "București", std: at(15, 5), gate: "U_GATE_2", checkIn: "check_in:2", pax: 64 },
  { flight: "W6 3311", airline: "W6", destination: "Dortmund", std: at(15, 30), gate: "U_GATE_6", checkIn: "check_in:1", pax: 172 },
  { flight: "FR 2104", airline: "FR", destination: "Bergamo", std: at(16, 10), gate: "U_GATE_3", checkIn: "check_in:3", pax: 160 },
  { flight: "W6 4405", airline: "W6", destination: "Memmingen", std: at(16, 45), gate: "U_GATE_8", checkIn: "check_in:2", pax: 180 },
].map(f => ({ ...f, checkInDesks: [] as string[], gateCloseAt: f.std - 1200, status: "scheduled", delayMin: 0 }));
let flights = freshFlights();

// ---------- cameras (vision) ----------
/** Share of each place a camera sees. Not listed = no camera: vision never reports it (shows as unknown). */
const cameras0: Record<string, number> = {
  G_CHECKIN_QUEUE: 0.85, G_DEPARTURES: 0.6, G_CENTER: 0.5, U_SECURITY_QUEUE: 0.9, U_SECURITY: 0.7, U_PASSPORT_DEP: 0.8,
  U_CONCOURSE: 0.55, U_CORRIDOR_EAST: 0.5, U_GATE_1: 0.6, U_GATE_2: 0.6, U_GATE_6: 0.5, X_TAXI_RANK: 0.4,
};
let outage = false;
const coverageOf = (zone: string) => (outage && zone.startsWith("U_SECURITY")) ? 0 : Math.min(1, (cameras0[zone] ?? 0) * coverageScale);
const targetMin = (q: string) => q === "U_SECURITY_QUEUE" ? 10 : q === "U_PASSPORT_DEP" ? 10 : 15;

// ---------- persistent people, so dots walk instead of jumping ----------
interface Dot { x: number; z: number; tx: number; tz: number; zone: string; staff: boolean }
const dots = new Map<string, Dot[]>();
const placeCount = (zone: string) =>
  Object.values(queues).filter(q => q.zone === zone).reduce((s, q) => s + q.waiting, 0) + (crowd[zone] ?? 0);
function syncDots() {
  for (const zone of new Set([...Object.values(queues).map(q => q.zone), ...Object.keys(crowd)])) {
    const want = Math.min(400, placeCount(zone)), list = dots.get(zone) ?? [];
    while (list.length > want) list.splice(Math.floor(Math.random() * list.length), 1);
    while (list.length < want) { const [x, z] = randomIn(zone); const [tx, tz] = randomIn(zone); list.push({ x, z, tx, tz, zone, staff: Math.random() < 0.03 }); }
    dots.set(zone, list);
  }
}
function walk() {
  for (const list of dots.values()) for (const d of list) {
    const queue = /QUEUE|PASSPORT/.test(d.zone);
    const step = queue ? 0.35 : 1.1; // metres per real second: queues shuffle, halls walk
    const dx = d.tx - d.x, dz = d.tz - d.z, dist = Math.hypot(dx, dz);
    if (dist < step) { [d.tx, d.tz] = randomIn(d.zone); continue; }
    const nx = d.x + (dx / dist) * step, nz = d.z + (dz / dist) * step;
    if (insideZone([nx, nz], d.zone)) { d.x = nx; d.z = nz; } else [d.tx, d.tz] = randomIn(d.zone);
  }
}

// ---------- sockets ----------
const token = process.env.DEMO_TOKEN ? `&token=${encodeURIComponent(process.env.DEMO_TOKEN)}` : "";
const open = (client: string) => new WebSocket(`${base.replace(/^http/, "ws")}/ws?client=${client}${token}`);
const twin = open("twin"), vision = open("vision");
const sender = (ws: WebSocket) => (type: string, data: unknown) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type, ts: new Date().toISOString(), data })); };
const toTwin = sender(twin), toVision = sender(vision);
const take = (from: number, n: number) => Math.min(from, Math.max(0, Math.round(n)));
const gauss = () => Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());
const round1 = (n: number) => Math.round(n * 10) / 10;
const sendFlights = () => toTwin("flight.update", { flights });
let lastEvent = "";
const note = (s: string) => { lastEvent = `${hhmm(simTime)} ${s}`; };

for (const [name, ws] of [["twin", twin], ["vision", vision]] as const)
  ws.on("message", raw => { const m = JSON.parse(raw.toString()); if (m.type === "error") console.error(`\nbackend (${name}):`, m.data?.message); });

/** Which queue a command's zone names: lane keys, zone ids and legacy aliases. */
function queueFor(zone: string): string | null {
  if (zone === "security" || zone === "U_SECURITY_QUEUE" || zone === "U_SECURITY") return "U_SECURITY_QUEUE";
  const g = /^(?:check_in|bag_drop):(\d)$/.exec(zone); if (g) return `check_in:${g[1]}`;
  if (zone === "G_CHECKIN_QUEUE" || zone === "G_CHECKIN_DESKS") return Object.entries(queues).filter(([k]) => k.startsWith("check_in")).sort((a, b) => b[1].waiting - a[1].waiting)[0]![0];
  return queues[zone] ? zone : null;
}
twin.on("message", raw => {
  const m = JSON.parse(raw.toString());
  if (m.type !== "ops.command") return;
  const c = m.data;
  toTwin("ops.ack", { id: c.id });
  const q = c.zone ? queueFor(c.zone) : null;
  if (c.type === "staff" && q) { queues[q]!.lanes = Math.max(0, Math.min(6, queues[q]!.lanes + c.delta)); note(`${q} ${c.delta > 0 ? "+" : ""}${c.delta} linie → ${queues[q]!.lanes}`); }
  if ((c.type === "close" || c.type === "open") && q) { queues[q]!.open = c.type === "open"; note(`${c.type} ${q}`); }
  if (c.type === "redirect") {
    const from = queueFor(c.from), to = queueFor(c.to);
    if (from && to && from !== to) { const n = Math.floor(queues[from]!.waiting / 2); queues[from]!.waiting -= n; queues[to]!.waiting += n; note(`redirect ${n} ${from} → ${to}`); }
  }
  if (c.type === "evacuate") { for (const z of c.zones) evacuated.add(z); note(`evacuate ${c.zones.join(", ")}`); }
});

/** Unity: move the true crowd one tick, report sim.status + truth.report. */
function unityTick() {
  const minutes = SIM_SPEED / 60;
  simTime += SIM_SPEED;
  const toPlace: Record<string, number> = {};
  for (const [id, q] of Object.entries(queues)) {
    if (evacuated.has(q.zone) || evacuated.has(id)) { q.waiting -= take(q.waiting, q.waiting * 0.25 + 1); continue; }
    q.waiting += Math.round(q.arrivals * load * minutes * (0.6 + Math.random() * 0.8));
    const served = q.open ? take(q.waiting, q.lanes * q.perLane * minutes * (0.85 + Math.random() * 0.3)) : 0;
    q.waiting -= served;
    if (q.next && queues[q.next]) queues[q.next]!.waiting += served; else if (q.next) toPlace[q.next] = (toPlace[q.next] ?? 0) + served;
  }
  for (const [z, n] of Object.entries(toPlace)) crowd[z] = (crowd[z] ?? 0) + n;
  // Landside walk-ins, airside drift towards the gate of the next flights, boarding empties a gate.
  crowd.G_DEPARTURES = Math.max(10, Math.round((crowd.G_DEPARTURES ?? 0) * 0.97 + 2 * load * minutes * Math.random()));
  const move = (from: string, to: string, share: number) => { const n = take(crowd[from] ?? 0, (crowd[from] ?? 0) * share * minutes); crowd[from] = (crowd[from] ?? 0) - n; crowd[to] = (crowd[to] ?? 0) + n; };
  move("U_CONCOURSE", "U_DUTY_FREE", 0.03); move("U_DUTY_FREE", "U_CORRIDOR_EAST", 0.06); move("U_CONCOURSE", "U_CORRIDOR_EAST", 0.04);
  const upcoming = flights.filter(f => f.status !== "cancelled" && f.status !== "departed" && f.std + f.delayMin * 60 > simTime).slice(0, 3);
  for (const f of upcoming) move("U_CORRIDOR_EAST", f.gate, 0.05 / upcoming.length);
  for (const f of flights) {
    const dep = f.std + f.delayMin * 60;
    if (f.status === "scheduled" && simTime >= dep - 1800 && simTime < dep) { f.status = "boarding"; sendFlights(); note(`boarding ${f.flight}`); }
    if ((f.status === "boarding" || f.status === "delayed") && simTime >= dep) { f.status = "departed"; crowd[f.gate] = 0; sendFlights(); note(`departed ${f.flight}`); }
    if (f.status === "delayed" && simTime >= dep - 1800 && simTime < dep) { f.status = "boarding"; sendFlights(); }
  }
  for (const z of Object.keys(crowd)) if (evacuated.has(z)) crowd[z] = (crowd[z] ?? 0) - take(crowd[z] ?? 0, (crowd[z] ?? 0) * 0.25 + 1);

  toTwin("sim.status", { running: true, scenario: "terminal", arm: "B", coverage: 0.5, seed: 1, speed: SIM_SPEED, simTime, agents: 0 });
  toTwin("truth.report", { zones: [
    ...Object.entries(queues).map(([zone, q]) => ({ zone, waiting: q.waiting, waitMin: q.open && q.lanes ? round1(q.waiting / (q.lanes * q.perLane)) : null })),
    ...Object.entries(crowd).filter(([z]) => cameras0[z]).map(([zone, waiting]) => ({ zone, waiting, waitMin: null })),
  ] });
}

/** Vision: what the cameras would report, from the truth plus noise. Lanes from the backend (D12). */
async function visionTick() {
  let held: Record<string, number> = {};
  try { held = (await (await fetch(`${base}/api/sim`)).json() as { lanes?: Record<string, number> }).lanes ?? {}; } catch { /* backend busy */ }
  const rows: Record<string, unknown>[] = [];
  const estimate = (truth: number, coverage: number) => {
    const sd = Math.max(1, truth * (0.04 + (1 - coverage) * 0.15));
    return { waiting: Math.max(0, Math.round(truth + gauss() * sd)), sd };
  };
  for (const [id, q] of Object.entries(queues)) {
    const coverage = coverageOf(q.zone);
    if (coverage < 0.1) continue;
    const { waiting, sd } = estimate(q.waiting, coverage);
    const n = held[laneKeyOf(id)] ?? q.lanes, mu = q.perLane * 0.95; // the service measures mu itself, a little off
    const area = zoneGeo.get(q.zone)!.area / (id.startsWith("check_in") ? 3 : 1);
    const row: Record<string, unknown> = { zone: id, waiting, waitingSd: round1(sd), density: round1(waiting / area), coverage: round1(coverage) };
    if (!q.open || !n) { rows.push({ ...row, waitMin: null }); continue; }
    const lambda = q.arrivals * load + (id === "U_SECURITY_QUEUE" ? Object.entries(queues).filter(([k]) => k.startsWith("check_in")).reduce((s, [, c]) => s + Math.min(c.arrivals * load, c.lanes * c.perLane), 0) : 0);
    const waitAt = (inMin: number, l = n) => Math.max(0, waiting + (lambda - mu * l) * inMin) / (mu * l);
    const forecast = [30, 60, 90, 120].map(inMin => ({ inMin, waitMin: round1(waitAt(inMin)) }));
    const waitMin = round1(waiting / (mu * n));
    let advice: unknown;
    if (forecast.some(f => f.waitMin > targetMin(id))) {
      const need = Array.from({ length: 6 }, (_, i) => n + 1 + i).find(l => [30, 60].every(t => waitAt(t, l) <= targetMin(id))) ?? n + 1;
      const firstOver = forecast.find(f => f.waitMin > targetMin(id))!;
      advice = { lanes: need, by: Math.max(simTime, simTime + firstOver.inMin * 60 - 600), waitMinIfNot: firstOver.waitMin };
    }
    rows.push({ ...row, waitMin, waitMinP90: round1(waitMin + 1.28 * (sd / (mu * n))), forecast, ...(advice ? { advice } : {}) });
  }
  // The check-in hall shows its worst group; security's hall carries the queue's wait (as vision/ does).
  const groups = rows.filter(r => String(r.zone).startsWith("check_in:"));
  if (groups.length) { const worst = groups.reduce((a, b) => (Number(b.waitMin) || 0) > (Number(a.waitMin) || 0) ? b : a); rows.push({ ...worst, zone: "G_CHECKIN_QUEUE", waiting: groups.reduce((s, r) => s + Number(r.waiting), 0) }); }
  for (const [zone, truth] of Object.entries(crowd)) {
    const coverage = coverageOf(zone);
    if (coverage < 0.1) continue;
    const { waiting, sd } = estimate(truth, coverage);
    const sec = zone === "U_SECURITY" ? rows.find(r => r.zone === "U_SECURITY_QUEUE") : undefined;
    rows.push({ zone, waiting, waitingSd: round1(sd), density: round1(waiting / zoneGeo.get(zone)!.area), coverage: round1(coverage), ...(sec ? { waitMin: sec.waitMin } : {}) });
  }
  toVision("flow.report", { zones: rows });
  const people: { x: number; z: number; level: Level; kind: "pax" | "staff" }[] = [];
  for (const [zone, list] of dots) {
    const coverage = coverageOf(zone);
    if (coverage < 0.1) continue;
    const level = zoneGeo.get(zone)!.level;
    for (const d of list.slice(0, Math.round(list.length * Math.min(1, coverage + 0.25)))) if (people.length < 2000) people.push({ x: round1(d.x), z: round1(d.z), level, kind: d.staff ? "staff" : "pax" });
  }
  toVision("crowd.positions", { people });
}

// ---------- keys ----------
function status() {
  const s = queues.U_SECURITY_QUEUE!;
  const line = `${hhmm(simTime)}  load ${load.toFixed(1)}x  security ${s.waiting} pers/${s.lanes} linii  check-in ${["1", "2", "3"].map(g => queues[`check_in:${g}`]!.waiting).join("/")}${outage ? "  CAMERA OFF" : ""}${evacuated.size ? `  evac ${[...evacuated].join(",")}` : ""}  | ${lastEvent}`;
  if (process.stdout.isTTY) process.stdout.write(`\r\x1b[2K${line.slice(0, (process.stdout.columns || 120) - 1)}`);
}
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.setEncoding("utf8");
  process.stdin.on("data", (k: string) => {
    if (k === "q" || k === "\u0003") process.exit(0);
    if (k === "+" || k === "=") { load = Math.min(4, load + 0.25); note(`load ${load}x`); }
    if (k === "-") { load = Math.max(0, load - 0.25); note(`load ${load}x`); }
    if (k === "s") { queues.U_SECURITY_QUEUE!.waiting += 60; note("security surge +60"); }
    if (k === "c") { queues["check_in:1"]!.waiting += 40; note("check-in 1 surge +40"); }
    if (k === "k") { outage = !outage; note(outage ? "camera outage at security" : "camera back"); }
    if (k === "e") { evacuated.clear(); note("evacuations cleared"); }
    if (k === "d" || k === "x") {
      const f = flights.find(f => f.status === "scheduled" || f.status === "boarding");
      if (f) { if (k === "d") { f.status = "delayed"; f.delayMin += 30; } else f.status = "cancelled"; sendFlights(); note(`${f.flight} ${f.status}${k === "d" ? ` +${f.delayMin} min` : ""}`); }
    }
    if (k === "r") { queues = fresh(); crowd = freshCrowd(); flights = freshFlights(); evacuated.clear(); outage = false; simTime = startTime; dots.clear(); sendFlights(); note("reset"); }
    status();
  });
}

await Promise.all([twin, vision].map(ws => new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); })));
console.log(`fake Unity + fake vision on the T2 map, connected to ${base}`);
if (process.stdin.isTTY) console.log("keys: + - load · s security surge · c check-in surge · d delay · x cancel · k camera off · e end evac · r reset · q quit");
// Start from the lanes the backend holds, so both sides agree.
try {
  const held = (await (await fetch(`${base}/api/sim`)).json() as { lanes?: Record<string, number> }).lanes ?? {};
  for (const [id, q] of Object.entries(queues)) q.lanes = held[laneKeyOf(id)] ?? q.lanes;
} catch { /* keep defaults */ }
sendFlights();
const tick = () => { unityTick(); syncDots(); void visionTick(); status(); };
tick();
const timer = setInterval(tick, 1000);
// Dots walk 4 times a second; positions go out with the vision tick (the backend keeps ~1/s).
const walker = setInterval(walk, 250);
for (const ws of [twin, vision]) ws.on("close", code => { clearInterval(timer); clearInterval(walker); console.log(`\ndisconnected (${code})`); process.exit(0); });
