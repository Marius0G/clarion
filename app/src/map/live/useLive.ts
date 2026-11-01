import { useEffect, useRef, useState } from 'react'
import { backend } from '../../backend/config'
import { loadIndex, type RouteIndex } from './catalogue'
import { pushHistory, type Flow } from './crowd'

/**
 * Camera crowding, polled every `ms` (default 2 s). Uses the light `/api/sim/flow` and falls back to
 * `/api/sim` on an older backend. `now` is the server's clock, so data age does not depend on the phone's.
 */
export function useFlow(ms = 2000) {
  const [state, setState] = useState<{ flow: Flow; now: number; ok: boolean; history: Map<string, { t: number; n: number }[]> }>(() => ({ flow: {}, now: Date.now(), ok: false, history: new Map() }))
  const history = useRef<Map<string, { t: number; n: number }[]> | null>(null)
  useEffect(() => {
    let alive = true, light = true, busy = false
    const poll = async () => {
      if (busy) return
      busy = true
      try {
        let r = await fetch(`${backend.http}${light ? '/api/sim/flow' : '/api/sim'}`, { cache: 'no-store', signal: AbortSignal.timeout(4000) })
        if (light && r.status === 404) { light = false; r = await fetch(`${backend.http}/api/sim`, { cache: 'no-store', signal: AbortSignal.timeout(4000) }) }
        if (!r.ok) throw new Error(String(r.status))
        const data = await r.json() as { flow?: Flow; at?: string }
        const now = data.at && Number.isFinite(Date.parse(data.at)) ? Date.parse(data.at) : Date.now()
        const flow = data.flow && typeof data.flow === 'object' ? data.flow : {}
        history.current ??= new Map()
        // A new Map each time, so the trend labels re-render with it.
        const next = new Map(pushHistory(history.current, flow, now))
        history.current = next
        if (alive) setState({ flow, now, ok: true, history: next })
      } catch { if (alive) setState(s => ({ ...s, now: s.now + ms, ok: false })) }
      finally { busy = false }
    }
    void poll()
    const timer = setInterval(() => void poll(), ms)
    return () => { alive = false; clearInterval(timer) }
  }, [ms])
  return state
}

/** The landmark catalogue and route index, loaded once. */
export function useIndex() {
  const [index, setIndex] = useState<RouteIndex | null>(null)
  const [error, setError] = useState(false)
  useEffect(() => {
    let alive = true
    loadIndex().then(i => { if (alive) setIndex(i) }).catch(() => { if (alive) setError(true) })
    return () => { alive = false }
  }, [])
  return { index, error }
}

/** Phone or desktop layout (side panel from 1024 px). */
export function useWide(min = 1024) {
  const query = `(min-width: ${min}px)`
  const [wide, setWide] = useState(() => typeof window !== 'undefined' && !!window.matchMedia?.(query).matches)
  useEffect(() => {
    const m = window.matchMedia?.(query)
    if (!m) return
    const on = () => setWide(m.matches)
    m.addEventListener('change', on)
    return () => m.removeEventListener('change', on)
  }, [query])
  return wide
}

/** A clock that ticks every `ms`, for moving markers and fading pins. */
export function useTick(ms = 1000) {
  const [t, setT] = useState(() => Date.now())
  useEffect(() => { const id = setInterval(() => setT(Date.now()), ms); return () => clearInterval(id) }, [ms])
  return t
}

/** Window height for the sheet stops. */
export function useViewportHeight() {
  const [vh, setVh] = useState(() => (typeof window === 'undefined' ? 800 : window.innerHeight))
  useEffect(() => { const on = () => setVh(window.innerHeight); window.addEventListener('resize', on); return () => window.removeEventListener('resize', on) }, [])
  return vh
}
