import { Auth, bearer, normalizePhone } from './auth.js';
import type { WhatsAppAgent, WaStore } from '../../worker/src/wa/index.js';
import type { Profile, AirportView } from '../../worker/src/wa/tools.js';
import { REPORT_TYPES, kindForType, type ReportType, type ReportState } from '../../worker/src/wa/reports.js';
import { terminalGraph, zoneAreas } from './terminal.js';
import { mapNodeId } from './mapIds.js';
import { route, zoneDensities } from './routing.js';
import type { SimStore } from './sim.js';

export interface PersonalRoutes {
  store: WaStore; agent: WhatsAppAgent; sim: SimStore; view: AirportView;
  env: { STAFF_PHONES?: string; STAFF_ASSIGNMENTS?: string }; operator: boolean;
}
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
/** Identical authenticated API for Worker and Node. Operator reads remain on the existing reports endpoint. */
export async function personalRoute(request: Request, deps: PersonalRoutes): Promise<Response | undefined> {
  const url = new URL(request.url), path = url.pathname;
  const state = /^\/api\/reports\/([A-Za-z0-9_-]{1,40})\/(state|close)$/.exec(path);
  if (path !== '/api/chat' && path !== '/api/me' && path !== '/api/staff' && !path.startsWith('/api/staff/tasks/') && !(path === '/api/reports' && request.method === 'POST') && !state) return;
  try {
    if (state && request.method === 'POST') {
      if (!deps.operator) return json({ error: 'Operator token required' }, 401);
      let report;
      if (state[2] === 'close') report = await deps.agent.reports.close(state[1]!);
      else {
        const input = await request.json() as { state?: ReportState };
        if (!input || !['taken', 'en_route', 'resolved'].includes(input.state ?? '')) throw new Error('Invalid report state');
        report = await deps.agent.reports.transition(state[1]!, input.state!);
      }
      return report ? json(report) : json({ error: 'Unknown report' }, 404);
    }
    const phone = await new Auth(deps.store).currentPhone(bearer(request.headers));
    if (path === '/api/me' && request.method === 'GET') {
      const token = url.searchParams.get('token') ?? '';
      if (!phone && !token) return json({ error: 'Session required' }, 401);
      const data = await deps.agent.messaging.passenger(phone ? '' : token, phone ?? undefined);
      if (!data) return json({ error: 'Unknown passenger' }, 404);
      // The legacy bearer page token can read its own data, but cannot submit reports.
      const legacy = !phone ? await deps.store.get<{ phone?: string }>(`page:${token}`) : undefined;
      return json({ ...data, reports: phone || legacy?.phone ? await deps.agent.reports.own(phone ?? legacy!.phone!) : [] });
    }
    if (!phone && deps.operator && path === '/api/reports' && request.method === 'POST') {
      const input = await request.json() as { id?: string; kind: import('../../worker/src/wa/reports.js').IssueKind; node: string | null; text: string; status?: string };
      if (input.status === 'closed' && input.id) return json(await deps.agent.reports.close(input.id));
      const node = input.node;
      if (node !== null && (typeof node !== 'string' || !terminalGraph.nodes.some(n => n.id === mapNodeId(node)))) throw new Error('Invalid place');
      return json(await deps.agent.reports.add({ kind: input.kind, node: input.node, text: input.text, source: 'staff' }));
    }
    if (!phone) return json({ error: 'Session required' }, 401);
    const stored = await deps.agent.profile(phone);
    const staff = stored?.role === 'staff' || (deps.env.STAFF_PHONES ?? '').split(',').some(p => normalizePhone(p.trim()) === phone);
    const profile: Profile = { phone, ...stored, role: staff ? 'staff' : 'passenger' };
    if (path === '/api/reports' && request.method === 'POST') {
      const input = await request.json() as { type: ReportType; place: { node: string; name: string }; text: string; photo?: string };
      if (!input || !REPORT_TYPES.includes(input.type) || typeof input.text !== 'string' || input.text.length > 500 ||
        !input.place || typeof input.place.node !== 'string' || !terminalGraph.nodes.some(n => n.id === mapNodeId(input.place.node)) ||
        typeof input.place.name !== 'string' || !input.place.name.trim() || input.place.name.length > 120 ||
        (input.photo !== undefined && (typeof input.photo !== 'string' || input.photo.length > 2000 || !/^https:\/\//.test(input.photo)))) throw new Error('Invalid report');
      const path = route(terminalGraph, 'team_post', input.place.node, zoneDensities(deps.view.flow(), zoneAreas), deps.view.blocked?.());
      return json(await deps.agent.reports.add({ kind: kindForType(input.type), type: input.type, node: input.place.node,
        place: input.place, text: input.text, photo: input.photo, phone, source: profile.role, etaMin: path ? Math.ceil(path.totalSec / 60) : null }), 201);
    }
    if (path === '/api/chat') {
      if (request.method === 'GET') return json({ history: await deps.agent.chatHistory(phone) });
      if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
      const input = await request.json() as { text?: unknown; replyId?: unknown };
      if (!input || typeof input.text !== 'string' || !input.text.trim() || input.text.length > 2000 ||
        (input.replyId !== undefined && (typeof input.replyId !== 'string' || input.replyId.length > 120))) throw new Error('Invalid message');
      if (!await chatAllowance(deps.store, bearer(request.headers)!)) return json({ error: 'Message limit', retryAfter: 60 }, 429);
      const bubbles = await deps.agent.chat(phone, input.text.trim(), typeof input.replyId === 'string' ? input.replyId : null);
      return json({ bubbles, history: await deps.agent.chatHistory(phone) });
    }
    if (!staff) return json({ error: 'Staff role required' }, 403);
    const { role, zone, tasks } = assignedTasks(deps.sim, deps.env, profile);
    if (path === '/api/staff' && request.method === 'GET') return json({ lang: profile.lang === 'en' ? 'en' : 'ro', role, zone, reports: await deps.agent.reports.own(phone),
      tasks, alerts: deps.sim.alertSnapshot().filter(a => a.active && a.zoneId && mapNodeId(a.zoneId) === mapNodeId(zone)) });
    const task = /^\/api\/staff\/tasks\/([^/]+)\/(confirm|done)$/.exec(path);
    if (task && request.method === 'POST') {
      if (!tasks.some(t => t.id === task[1])) return json({ error: 'Unknown task' }, 404);
      return json(deps.sim.staffTask(task[1]!, task[2] === 'confirm' ? 'confirmed' : 'done'));
    }
    return json({ error: 'Not found' }, 404);
  } catch (error) { return json({ error: error instanceof Error ? error.message : 'Invalid request' }, 400); }
}

export function assignedTasks(sim: SimStore, env: PersonalRoutes['env'], profile: Profile) {
  const phone = profile.phone;
  const directory = JSON.parse(env.STAFF_ASSIGNMENTS ?? '{}') as Record<string, { role?: Profile['staffRole']; zone?: string }>;
  const assignment = directory[phone];
  const role = assignment?.role ?? profile.staffRole ?? 'security_supervisor', zone = assignment?.zone ?? profile.zone ?? 'security';
  if (!['security_supervisor', 'hall_agent', 'incident_commander'].includes(role) || !terminalGraph.nodes.some(n => n.id === mapNodeId(zone))) throw new Error('Invalid staff assignment');
  const tasks = sim.snapshot(false, {}).ops.filter(t => {
    const owner = t.type === 'staff' ? 'security_supervisor' : t.type === 'redirect' ? 'hall_agent' : t.type === 'evacuate' ? 'incident_commander' : null;
    const zones = t.type === 'evacuate' ? t.zones : [t.type === 'redirect' ? t.from : t.zone];
    return owner === role && (role === 'incident_commander' || zones.some(id => mapNodeId(id) === mapNodeId(zone)));
  });
  return { role, zone, tasks };
}

export async function staffTaskTool(store: WaStore, sim: SimStore, env: PersonalRoutes['env'], phone: string, input: { id?: string; action?: string }) {
  const stored = await store.get<Profile>(`wa:profile:${phone}`);
  if (stored?.role !== 'staff' && !(env.STAFF_PHONES ?? '').split(',').some(p => normalizePhone(p.trim()) === phone)) throw new Error('Staff role required');
  const { tasks } = assignedTasks(sim, env, { phone, ...stored, role: 'staff' });
  if (!input.id && !input.action) return tasks;
  if (!tasks.some(t => t.id === input.id) || !['confirm', 'done'].includes(input.action ?? '')) throw new Error('Invalid assigned task');
  return sim.staffTask(input.id!, input.action === 'confirm' ? 'confirmed' : 'done');
}

export const CHAT_PER_MINUTE = 12;
const chatLocks = new WeakMap<WaStore, Promise<unknown>>();
async function chatAllowance(store: WaStore, session: string) {
  const next = (chatLocks.get(store) ?? Promise.resolve()).then(async () => {
    const key = `chat:rate:${session}`, now = Date.now();
    const prior = await store.get<{ start: number; count: number }>(key);
    const window = prior && now - prior.start < 60_000 ? prior : { start: now, count: 0 };
    if (window.count >= CHAT_PER_MINUTE) return false;
    await store.put(key, { ...window, count: window.count + 1 });
    return true;
  });
  chatLocks.set(store, next.catch(() => {}));
  return next;
}
