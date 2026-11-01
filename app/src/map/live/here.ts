/**
 * "Ești aici" without GPS (D9): the place the passenger picked on the page ("Sunt aici", kept on this phone),
 * the landmark he last told WhatsApp, or the stage estimated from the clock. Fresh for 10 minutes, then grey.
 */
export const HERE_KEY = 'clarion.here'
export const FRESH_MS = 10 * 60_000
export const DROP_MS = 30 * 60_000

export type HereSource = 'picked' | 'whatsapp' | 'stage'
export interface Here { id: string; source: HereSource; fresh: boolean }

export function readPicked(): { id: string; at: number } | null {
  try {
    const v = JSON.parse(localStorage.getItem(HERE_KEY) ?? 'null') as { id?: unknown; at?: unknown } | null
    return v && typeof v.id === 'string' && typeof v.at === 'number' ? { id: v.id, at: v.at } : null
  } catch { return null }
}
export function savePicked(id: string, at = Date.now()) {
  try { localStorage.setItem(HERE_KEY, JSON.stringify({ id, at })) } catch { /* storage off: the pick lasts for this page only */ }
}

/** Stage → a representative landmark, the same choice the backend makes for the route picture. */
export function stagePlace(stage: 'public' | 'airside' | 'gate' | null | undefined, gate?: string | null): string | null {
  if (stage === 'gate' && gate && /^\d+$/.test(gate)) return `U_GATE_${gate}`
  if (stage === 'airside') return 'U_CORRIDOR_EAST'
  if (stage === 'public') return 'door_departures'
  return null
}

export function resolveHere(o: { picked?: { id: string; at: number } | null; told?: { id: string; ageSec: number } | null; stage?: string | null; now: number }): Here | null {
  const pickedAge = o.picked ? o.now - o.picked.at : Infinity
  const toldAge = o.told ? o.told.ageSec * 1000 : Infinity
  // The newest fresh source wins.
  if (pickedAge <= FRESH_MS || toldAge <= FRESH_MS) {
    return pickedAge <= toldAge ? { id: o.picked!.id, source: 'picked', fresh: true } : { id: o.told!.id, source: 'whatsapp', fresh: true }
  }
  if (o.stage) return { id: o.stage, source: 'stage', fresh: true }
  if (pickedAge <= DROP_MS) return { id: o.picked!.id, source: 'picked', fresh: false }
  if (toldAge <= DROP_MS) return { id: o.told!.id, source: 'whatsapp', fresh: false }
  return null
}
