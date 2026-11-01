import { useEffect, useRef, useState, type ReactNode } from 'react'

/**
 * Bottom sheet for phones (MapsIndoors: peek 180 px, half, full), a plain side panel on wide screens.
 * Dragging the handle or header moves it; release snaps to the nearest stop, a flick goes one stop further.
 */
export type Snap = 'peek' | 'half' | 'full'
export const PEEK = 180
export function sheetHeight(snap: Snap, viewport: number) {
  return snap === 'peek' ? PEEK : snap === 'half' ? Math.round(viewport * 0.52) : Math.round(viewport * 0.9)
}

export function Sheet({ wide, snap, onSnap, header, children, label }: { wide: boolean; snap: Snap; onSnap: (s: Snap) => void; header?: ReactNode; children: ReactNode; label: string }) {
  const [vh, setVh] = useState(() => (typeof window === 'undefined' ? 800 : window.innerHeight))
  useEffect(() => { const on = () => setVh(window.innerHeight); window.addEventListener('resize', on); return () => window.removeEventListener('resize', on) }, [])
  const drag = useRef<{ y: number; h: number; t: number; moved: boolean } | null>(null)
  const [dragH, setDragH] = useState<number | null>(null)
  if (wide) return <aside className="lm-panel" aria-label={label}>{header}<div className="lm-panel-body">{children}</div></aside>

  const full = sheetHeight('full', vh)
  const h = dragH ?? sheetHeight(snap, vh)
  const stops: Snap[] = ['peek', 'half', 'full']
  const start = (e: React.PointerEvent) => {
    if ((e.target as Element).closest('input, textarea, button:not(.lm-handle), a, select, label')) return
    drag.current = { y: e.clientY, h, t: performance.now(), moved: false }
  }
  const move = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d) return
    const dy = d.y - e.clientY
    if (!d.moved && Math.abs(dy) < 6) return
    if (!d.moved) { d.moved = true; (e.currentTarget as Element).setPointerCapture(e.pointerId) }
    setDragH(Math.min(full, Math.max(96, d.h + dy)))
  }
  const end = (e: React.PointerEvent) => {
    const d = drag.current
    drag.current = null
    if (!d) return
    if (!d.moved) { if ((e.target as Element).closest('.lm-handle')) onSnap(snap === 'peek' ? 'half' : snap === 'half' ? 'full' : 'peek'); return }
    const now = dragH ?? h, v = (d.y - e.clientY) / Math.max(1, performance.now() - d.t)
    let best = stops.reduce((a, b) => Math.abs(sheetHeight(b, vh) - now) < Math.abs(sheetHeight(a, vh) - now) ? b : a)
    const i = stops.indexOf(best)
    if (Math.abs(v) > 0.6) best = stops[Math.max(0, Math.min(2, (now > d.h ? i + (sheetHeight(best, vh) < now ? 1 : 0) : i - (sheetHeight(best, vh) > now ? 1 : 0))))]!
    setDragH(null); onSnap(best)
  }
  return <section className={`lm-sheet s-${snap}${dragH != null ? ' dragging' : ''}`} aria-label={label} style={{ height: h }}
    onPointerDown={start} onPointerMove={move} onPointerUp={end} onPointerCancel={end}>
    <div className="lm-sheet-top">
      <button type="button" className="lm-handle" aria-label={snap === 'full' ? 'Restrânge' : 'Extinde'} onClick={e => { e.preventDefault(); if (e.detail === 0) onSnap(snap === 'peek' ? 'half' : snap === 'half' ? 'full' : 'peek') }}><i /></button>
      {header}
    </div>
    <div className="lm-sheet-body" ref={el => { if (el && snap === 'peek' && dragH == null) el.scrollTop = 0 }} style={{ overflowY: snap === 'peek' && dragH == null ? 'hidden' : 'auto' }}>{children}</div>
  </section>
}
