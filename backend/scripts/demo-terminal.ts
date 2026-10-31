/**
 * Fake Unity for the admin screen (SPEC-v2 contract), so the dashboard can be shown without Marius's build.
 * Connects as the twin and, every second: sim.status, flow.report (with staff), crowd.positions.
 * Sends flight.update on connect. Answers every ops.command with ops.ack and applies a toy effect:
 * staff changes the processing rate, close/open stops/starts a queue, redirect moves half a queue,
 * evacuate empties the zones towards the exits. Not a model of anything: Unity replaces it.
 *
 *   BACKEND_URL=http://localhost:8787 DEMO_TOKEN=... npm run demo:terminal
 */
import { WebSocket } from "ws";
const base = process.env.BACKEND_URL ?? `http://localhost:${process.env.PORT ?? 8787}`;
const SIM_SPEED = Number(process.env.SIM_SPEED ?? 30); // sim seconds per real second
// Mirrors the provisional plan in app/src/console/terminal.ts (x, y, w, h in metres).
const rects: Record<string, [number, number, number, number]> = {
  entrance: [0, 8, 14, 44], "check_in:W6": [16, 6, 20, 22], "bag_drop:W6": [38, 6, 14, 22],
  "check_in:RO": [16, 32, 20, 22], "bag_drop:RO": [38, 32, 14, 22], security: [55, 14, 14, 32],
  airside: [72, 4, 28, 52], gate_1: [102, 4, 18, 16], gate_2: [102, 22, 18, 16], gate_3: [102, 40, 18, 16],
  exit_1: [0, 54, 12, 6], exit_2: [80, 57, 12, 3],
};
// Queues Unity reports in flow.report: capacity, staff, people served per staff per sim minute.
const queues: Record<string, { waiting: number; capacity: number; staff: number; perStaff: number; open: boolean }> = {
  "check_in:W6": { waiting: 30, capacity: 40, staff: 2, perStaff: 1.0, open: true },
  "bag_drop:W6": { waiting: 12, capacity: 20, staff: 1, perStaff: 1.5, open: true },
  "check_in:RO": { waiting: 8, capacity: 30, staff: 2, perStaff: 1.0, open: true },
  "bag_drop:RO": { waiting: 4, capacity: 15, staff: 1, perStaff: 1.5, open: true },
  security: { waiting: 70, capacity: 100, staff: 3, perStaff: 2.5, open: true },
};
// People in zones without a queue (dots only).
const crowd: Record<string, number> = { entrance: 12, airside: 50, gate_1: 25, gate_2: 10, gate_3: 4, exit_1: 0, exit_2: 0 };
const staffAt: Record<string, number> = { entrance: 1, airside: 2, gate_1: 1, gate_2: 1, gate_3: 0 };
const evacuated = new Set<string>();
const arrivalsPerMin: Record<string, number> = { "check_in:W6": 3.2, "bag_drop:W6": 1.6, "check_in:RO": 1.8, "bag_drop:RO": 0.9 };
let simTime = 13 * 3600 + 30 * 60;

const flights = [
  { flight: "W6 3751", airline: "W6", destination: "Londra Luton", std: 15 * 3600, gate: "gate_1", checkInDesks: ["check_in:W6"], gateCloseAt: 15 * 3600 - 1200, status: "scheduled", delayMin: 0, pax: 180 },
  { flight: "W6 3311", airline: "W6", destination: "Dortmund", std: 16 * 3600, gate: "gate_2", checkInDesks: ["check_in:W6"], gateCloseAt: 16 * 3600 - 1200, status: "scheduled", delayMin: 0, pax: 170 },
  { flight: "RO 642", airline: "RO", destination: "București", std: 14 * 3600 + 1800, gate: "gate_3", checkInDesks: ["check_in:RO"], gateCloseAt: 14 * 3600 + 600, status: "delayed", delayMin: 25, pax: 60 },
];

const socket = new WebSocket(`${base.replace(/^http/, "ws")}/ws?client=twin${process.env.DEMO_TOKEN ? `&token=${encodeURIComponent(process.env.DEMO_TOKEN)}` : ""}`);
const send = (type: string, data: unknown) => socket.send(JSON.stringify({ type, ts: new Date().toISOString(), data }));
const take = (from: number, n: number) => Math.min(from, Math.max(0, Math.round(n)));

socket.on("message", raw => {
  const m = JSON.parse(raw.toString());
  if (m.type === "error") console.error("backend:", m.data?.message);
  if (m.type !== "ops.command") return;
  const c = m.data;
  console.log("ops.command", JSON.stringify(c));
  send("ops.ack", { id: c.id });
  const q = queues[c.zone];
  if (c.type === "staff") { if (q) q.staff = Math.max(0, q.staff + c.delta); else staffAt[c.zone] = Math.max(0, (staffAt[c.zone] ?? 0) + c.delta); }
  if ((c.type === "close" || c.type === "open") && q) q.open = c.type === "open";
  if (c.type === "redirect" && queues[c.from] && queues[c.to]) { const n = Math.floor(queues[c.from]!.waiting / 2); queues[c.from]!.waiting -= n; queues[c.to]!.waiting += n; }
  if (c.type === "evacuate") for (const z of c.zones) evacuated.add(z);
});

function tick() {
  const minutes = SIM_SPEED / 60;
  simTime += SIM_SPEED;
  const toSecurity = { n: 0 };
  for (const [zone, q] of Object.entries(queues)) {
    if (evacuated.has(zone)) { const n = take(q.waiting, q.waiting * 0.3 + 1); q.waiting -= n; crowd.exit_1! += n; continue; }
    q.waiting += Math.round((arrivalsPerMin[zone] ?? 0) * minutes * (0.6 + Math.random() * 0.8));
    const served = q.open ? take(q.waiting, q.staff * q.perStaff * minutes) : 0;
    q.waiting -= served;
    if (zone !== "security") toSecurity.n += served; else crowd.airside! += served;
  }
  queues.security!.waiting += toSecurity.n + Math.round(minutes * 2 * Math.random());
  for (const gate of ["gate_1", "gate_2", "gate_3"]) { const n = take(crowd.airside!, crowd.airside! * 0.05 * minutes); crowd.airside! -= n; crowd[gate]! += n; }
  for (const zone of Object.keys(crowd)) if (evacuated.has(zone)) { const n = take(crowd[zone]!, crowd[zone]! * 0.3 + 1); crowd[zone]! -= n; crowd.exit_2! += n; }
  crowd.exit_1 = Math.floor(crowd.exit_1! * 0.7); crowd.exit_2 = Math.floor(crowd.exit_2! * 0.7);

  send("sim.status", { running: true, scenario: "terminal", arm: "B", coverage: 0.5, seed: 1, speed: SIM_SPEED, simTime, agents: 0 });
  send("flow.report", { zones: Object.entries(queues).map(([zone, q]) => {
    const rate = q.open ? q.staff * q.perStaff : 0;
    return { zone, waiting: q.waiting, capacity: q.capacity, staff: q.staff, waitMin: rate ? Math.round((q.waiting / rate) * 10) / 10 : null,
      forecast: [30, 60, 90, 120].map(inMin => ({ inMin, waitMin: rate ? Math.round(((q.waiting + (arrivalsPerMin[zone] ?? 1) * inMin - rate * inMin * 0.9) / rate) * 10) / 10 : 0 })).map(f => ({ ...f, waitMin: Math.max(0, f.waitMin) })) };
  }) });
  const people: { x: number; y: number; kind: "pax" | "staff" }[] = [];
  const dots = (zone: string, n: number, kind: "pax" | "staff") => {
    const [x, y, w, h] = rects[zone]!;
    for (let i = 0; i < Math.min(n, 400) && people.length < 2000; i++) people.push({ x: x + 0.8 + Math.random() * (w - 1.6), y: y + 0.8 + Math.random() * (h - 1.6), kind });
  };
  for (const [zone, q] of Object.entries(queues)) { dots(zone, q.waiting, "pax"); dots(zone, q.staff, "staff"); }
  for (const [zone, n] of Object.entries(crowd)) { dots(zone, n, "pax"); dots(zone, staffAt[zone] ?? 0, "staff"); }
  send("crowd.positions", { people });
}

await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
console.log(`fake Unity connected to ${base}`);
send("flight.update", { flights });
tick();
const timer = setInterval(tick, 1000);
socket.on("close", () => { clearInterval(timer); console.log("disconnected"); process.exit(0); });
