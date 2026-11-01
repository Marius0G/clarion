import { backend } from './config'
import type { OpsCommand, OpsRecord } from './sim'

export type OpsResult = { ok: true; command: OpsRecord } | { ok: false; reason: 'offline' | 'auth' | 'invalid' | 'network' }

/** D12: POST /api/ops/command. 202 = sent to Unity, 409 = Unity not connected. */
export async function sendOps(command: OpsCommand): Promise<OpsResult> {
  try {
    const res = await fetch(`${backend.http}/api/ops/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(backend.token ? { Authorization: `Bearer ${backend.token}` } : {}) },
      body: JSON.stringify(command),
    })
    if (res.status === 202) return { ok: true, command: (await res.json()).command }
    return { ok: false, reason: res.status === 409 ? 'offline' : res.status === 401 ? 'auth' : 'invalid' }
  } catch { return { ok: false, reason: 'network' } }
}

/** Sim speed (same as `demo_step.sh speed N`): POST /api/sim/command `{ action: 'start', speed }`. 202 = Unity has it. */
export async function setSimSpeed(speed: number): Promise<boolean> {
  try {
    const res = await fetch(`${backend.http}/api/sim/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(backend.token ? { Authorization: `Bearer ${backend.token}` } : {}) },
      body: JSON.stringify({ action: 'start', speed }),
    })
    return res.status === 202
  } catch { return false }
}
