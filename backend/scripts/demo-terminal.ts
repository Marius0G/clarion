/**
 * Fake Unity + fake vision service for the admin screen (SPEC-v2 contract), so the dashboard runs without Marius's build.
 *
 * Twin (client=twin), every second: sim.status, truth.report (the exact queues, D0). flight.update on connect.
 *   Answers every ops.command with ops.ack and applies a toy effect: staff opens/closes lanes, close/open stops a queue,
 *   redirect moves half a queue, evacuate empties the zones towards the exits.
 * Vision (client=vision), every second: flow.report (noisy camera estimate with coverage, waitingSd, density,
 *   waitMin, waitMinP90, forecast and A7 advice) and crowd.positions, only for zones a camera sees.
 *   Reads the open lanes from GET /api/sim, as the real service does.
 * Not a model of anything: Unity and Marius's service replace it.
 *
 *   BACKEND_URL=http://localhost:8787 DEMO_TOKEN=... npm run demo:terminal
 */
import { WebSocket } from "ws";
const base = process.env.BACKEND_URL ?? `http://localhost:${process.env.PORT ?? 8787}`;
const SIM_SPEED = Number(process.env.SIM_SPEED ?? 30); // sim seconds per real second
// Mirrors the provisional plan in app/src/console/terminal.ts (x, y, w, h in metres).
const rects: Record<string, [number, number, number, number]> = {
  entrance: [0, 8, 14, 44], "check_in:1": [16, 6, 20, 22], "bag_drop:1": [38, 6, 14, 22],
  "check_in:2": [16, 32, 20, 22], "bag_drop:2": [38, 32, 14, 22], security: [55, 14, 14, 32],
  airside: [72, 4, 28, 52], gate_1: [102, 4, 18, 16], gate_2: [102, 22, 18, 16], gate_3: [102, 40, 18, 16],
  exit_1: [0, 54, 12, 6], exit_2: [80, 57, 12, 3],
};
// Unity's truth for each queue: people waiting, lanes open, people served per lane per sim minute, arrivals per sim minute.
const queues: Record<string, { waiting: number; lanes: number; perLane: number; arrivals: number; open: boolean }> = {
  "check_in:1": { waiting: 30, lanes: 2, perLane: 1.0, arrivals: 3.2, open: true },
  "bag_drop:1": { waiting: 12, lanes: 1, perLane: 1.5, arrivals: 1.6, open: true },
  "check_in:2": { waiting: 8, lanes: 2, perLane: 1.0, arrivals: 1.8, open: true },
  "bag_drop:2": { waiting: 4, lanes: 1, perLane: 1.5, arrivals: 0.9, open: true },
  security: { waiting: 70, lanes: 2, perLane: 2.5, arrivals: 0, open: true },
};
// People in zones without a queue.
const crowd: Record<string, number> = { entrance: 12, airside: 50, gate_1: 25, gate_2: 10, gate_3: 4, exit_1: 0, exit_2: 0 };
// What the cameras see (share of each zone). Zones not listed have no camera: vision never reports them.
const cameras: Record<string, number> = { "check_in:1": 0.8, "check_in:2": 0.7, "bag_drop:2": 0.6, security: 0.9, airside: 0.5, gate_1: 0.6 };
const targetMin = (zone: string) => zone === "security" ? 10 : 15; // A7 default targets
const evacuated = new Set<string>();
let simTime = 13 * 3600 + 30 * 60;

const flights = [
  { flight: "W6 3751", airline: "W6", destination: "Londra Luton", std: 15 * 3600, gate: "gate_1", checkIn: "check_in:1", checkInDesks: ["check_in:1"], gateCloseAt: 15 * 3600 - 1200, status: "scheduled", delayMin: 0, pax: 180 },
  { flight: "W6 3311", airline: "W6", destination: "Dortmund", std: 16 * 3600, gate: "gate_2", checkIn: "check_in:1", checkInDesks: ["check_in:1"], gateCloseAt: 16 * 3600 - 1200, status: "scheduled", delayMin: 0, pax: 170 },
  { flight: "RO 642", airline: "RO", destination: "București", std: 14 * 3600 + 1800, gate: "gate_3", checkIn: "check_in:2", checkInDesks: ["check_in:2"], gateCloseAt: 14 * 3600 + 600, status: "delayed", delayMin: 25, pax: 60 },
];

const token = process.env.DEMO_TOKEN ? `&token=${encodeURIComponent(process.env.DEMO_TOKEN)}` : "";
const open = (client: string) => new WebSocket(`${base.replace(/^http/, "ws")}/ws?client=${client}${token}`);
const twin = open("twin"), vision = open("vision");
const sender = (ws: WebSocket) => (type: string, data: unknown) => ws.send(JSON.stringify({ type, ts: new Date().toISOString(), data }));
const toTwin = sender(twin), toVision = sender(vision);
const take = (from: number, n: number) => Math.min(from, Math.max(0, Math.round(n)));
const gauss = () => Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());
const round1 = (n: number) => Math.round(n * 10) / 10;

for (const [name, ws] of [["twin", twin], ["vision", vision]] as const)
  ws.on("message", raw => { const m = JSON.parse(raw.toString()); if (m.type === "error") console.error(`backend (${name}):`, m.data?.message); });

twin.on("message", raw => {
  const m = JSON.parse(raw.toString());
  if (m.type !== "ops.command") return;
  const c = m.data;
  console.log("ops.command", JSON.stringify(c));
  toTwin("ops.ack", { id: c.id });
  const q = queues[c.zone];
  if (c.type === "staff" && q) q.lanes = Math.max(0, q.lanes + c.delta);
  if ((c.type === "close" || c.type === "open") && q) q.open = c.type === "open";
  if (c.type === "redirect" && queues[c.from] && queues[c.to]) { const n = Math.floor(queues[c.from]!.waiting / 2); queues[c.from]!.waiting -= n; queues[c.to]!.waiting += n; }
  if (c.type === "evacuate") for (const z of c.zones) evacuated.add(z);
});

/** Unity: move the true crowd one tick and report sim.status + truth.report. */
function unityTick() {
  const minutes = SIM_SPEED / 60;
  simTime += SIM_SPEED;
  let toSecurity = 0;
  for (const [zone, q] of Object.entries(queues)) {
    if (evacuated.has(zone)) { const n = take(q.waiting, q.waiting * 0.3 + 1); q.waiting -= n; crowd.exit_1! += n; continue; }
    q.waiting += Math.round(q.arrivals * minutes * (0.6 + Math.random() * 0.8));
    const served = q.open ? take(q.waiting, q.lanes * q.perLane * minutes) : 0;
    q.waiting -= served;
    if (zone !== "security") toSecurity += served; else crowd.airside! += served;
  }
  queues.security!.waiting += toSecurity + Math.round(minutes * 2 * Math.random());
  for (const gate of ["gate_1", "gate_2", "gate_3"]) { const n = take(crowd.airside!, crowd.airside! * 0.05 * minutes); crowd.airside! -= n; crowd[gate]! += n; }
  for (const zone of Object.keys(crowd)) if (evacuated.has(zone)) { const n = take(crowd[zone]!, crowd[zone]! * 0.3 + 1); crowd[zone]! -= n; crowd.exit_2! += n; }
  crowd.exit_1 = Math.floor(crowd.exit_1! * 0.7); crowd.exit_2 = Math.floor(crowd.exit_2! * 0.7);

  toTwin("sim.status", { running: true, scenario: "terminal", arm: "B", coverage: 0.5, seed: 1, speed: SIM_SPEED, simTime, agents: 0 });
  toTwin("truth.report", { zones: [
    ...Object.entries(queues).map(([zone, q]) => ({ zone, waiting: q.waiting, waitMin: q.open && q.lanes ? round1(q.waiting / (q.lanes * q.perLane)) : null })),
    ...["airside", "gate_1", "gate_2", "gate_3"].map(zone => ({ zone, waiting: crowd[zone]!, waitMin: null })),
  ] });
}

/** Vision: what the cameras would report, from the truth plus calibrated-looking noise. Lanes from the backend. */
async function visionTick() {
  let lanes: Record<string, number> = {};
  try { lanes = (await (await fetch(`${base}/api/sim`)).json() as { lanes?: Record<string, number> }).lanes ?? {}; } catch { /* backend busy: skip lanes */ }
  const zones = Object.entries(cameras).map(([zone, coverage]) => {
    const q = queues[zone], truth = q ? q.waiting : crowd[zone] ?? 0;
    const sd = Math.max(1, truth * (0.04 + (1 - coverage) * 0.15));
    const waiting = Math.max(0, Math.round(truth + gauss() * sd));
    const [, , w, h] = rects[zone]!;
    const row: Record<string, unknown> = { zone, waiting, waitingSd: round1(sd), density: Math.round((waiting / (w * h)) * 100) / 100, coverage };
    if (!q) return row;
    const n = lanes[zone] ?? q.lanes, mu = q.perLane * 0.95 * n; // the service measures mu itself, a little off
    if (!mu) return { ...row, waitMin: null };
    const lambda = zone === "security" ? queues["check_in:1"]!.lanes * 1.0 + 1.5 : q.arrivals; // sloppy on purpose
    const waitAt = (inMin: number, l = n) => Math.max(0, waiting + (lambda - q.perLane * 0.95 * l) * inMin) / (q.perLane * 0.95 * l);
    const forecast = [30, 60, 90, 120].map(inMin => ({ inMin, waitMin: round1(waitAt(inMin)) }));
    const waitMin = round1(waiting / mu);
    let advice: unknown;
    if (forecast.some(f => f.waitMin > targetMin(zone))) {
      const need = Array.from({ length: 8 }, (_, i) => n + 1 + i).find(l => [30, 60].every(t => waitAt(t, l) <= targetMin(zone))) ?? n + 1;
      const firstOver = forecast.find(f => f.waitMin > targetMin(zone))!;
      advice = { lanes: need, by: Math.max(simTime, simTime + firstOver.inMin * 60 - 600), waitMinIfNot: firstOver.waitMin };
    }
    return { ...row, waitMin, waitMinP90: round1(waitMin + 1.28 * (sd / mu)), forecast, ...(advice ? { advice } : {}) };
  });
  toVision("flow.report", { zones });
  const people: { x: number; y: number }[] = [];
  for (const [zone, coverage] of Object.entries(cameras)) {
    const [x, y, w, h] = rects[zone]!, n = Math.round((queues[zone]?.waiting ?? crowd[zone] ?? 0) * coverage);
    for (let i = 0; i < Math.min(n, 400) && people.length < 2000; i++) people.push({ x: round1(x + 0.8 + Math.random() * (w - 1.6)), y: round1(y + 0.8 + Math.random() * (h - 1.6)) });
  }
  toVision("crowd.positions", { people });
}

await Promise.all([twin, vision].map(ws => new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); })));
console.log(`fake Unity + fake vision connected to ${base}`);
// Start from the lanes the backend holds, so both sides agree.
try { const held = (await (await fetch(`${base}/api/sim`)).json() as { lanes?: Record<string, number> }).lanes ?? {}; for (const [z, q] of Object.entries(queues)) q.lanes = held[z] ?? q.lanes; } catch { /* keep defaults */ }
toTwin("flight.update", { flights });
const tick = () => { unityTick(); void visionTick(); };
tick();
const timer = setInterval(tick, 1000);
for (const ws of [twin, vision]) ws.on("close", code => { clearInterval(timer); console.log(`disconnected (${code})`); process.exit(0); });
