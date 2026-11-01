import { normalizePhone } from '../../../backend/src/auth.js';
import { mapNodeId } from '../../../backend/src/mapIds.js';
import { terminalGraph } from '../../../backend/src/terminal.js';
import type { Profile } from './tools.js';

export function staffAssignment(env: { STAFF_ASSIGNMENTS?: string }, profile: Profile) {
  const directory = JSON.parse(env.STAFF_ASSIGNMENTS ?? '{}') as Record<string, { role?: Profile['staffRole']; zone?: string }>;
  const assignment = Object.entries(directory).find(([phone]) => normalizePhone(phone) === normalizePhone(profile.phone))?.[1];
  const role = assignment?.role ?? profile.staffRole ?? 'security_supervisor';
  const zone = assignment?.zone ?? profile.zone ?? 'security';
  if (!['security_supervisor', 'hall_agent', 'incident_commander'].includes(role) || !terminalGraph.nodes.some(n => n.id === mapNodeId(zone))) throw new Error('Invalid staff assignment');
  return { role, zone };
}
