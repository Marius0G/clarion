import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Level, MapZone, Pt } from '../t2/data'
import { fmt } from '../t2/geometry'
import { zoneDetail } from '../t2/details'
import { PLATE, SHELL, worldAt, zoneGeo } from '../t2/TerminalMap'
import { boundsOf, pad, type Box } from '../t2/stack'
import { categoryOf, floorChanges, FLOOR_NAMES, floorShort, rankOf, shortName, tierOf, type Category, type Lang, type Landmark, type PathNode } from './catalogue'
import { ageLabel, ageMs, crowdLevel, crowdWords, isQueue, isStale, people, rowFor, trend, TREND_MARK, waitBand, type Flow, type Level as Crowd } from './crowd'
import { PointGlyph } from './icons'
import { placeItems, textWidth, type PlaceItem, type Rect } from './placement'
import { floorRuns, remainingRoute } from './team'
import { boxAround, clampView, fitView, lerpView, limitsFor, toMap, viewBox, zoomAt, type Size, type View } from './view'
import '../t2/t2map.css'
import './live.css'

/**
 * Live T2 map for the passenger (/m) and staff (/s) pages: both floors flat (D27), phone first.
 * Pan, pinch, double-tap and wheel zoom move the SVG viewBox, so text stays sharp on iOS.
 * The floor plan is drawn once; crowding updates only set data attributes, read by CSS.
 */
export type WorldPt = { level: Level; x: number; z: number }
export interface ReportPin { id: string; at: WorldPt; state: 'sent' | 'taken' | 'en_route' | 'resolved'; label: string; priority?: string; fade?: number }
export interface TeamMark { at: WorldPt; heading: number; label: string; badge: string | null; pin: string; remaining: RouteDraw }
export interface RouteDraw { path: PathNode[]; changes: { at: PathNode; to: PathNode; up: boolean; text: string }[]; endLabel?: string; exit?: (PathNode & { name: string }) | null; assembly?: (PathNode & { name: string }) | null }
export interface Focus { key: string; pts: WorldPt[]; minW?: number }

interface Props {
  lang: Lang
  mode: 'passenger' | 'staff'
  points: readonly Landmark[]
  flow: Flow
  /** Server time of the flow snapshot, ms. */
  now: number
  selected?: string | null
  onSelect?: (id: string | null) => void
  /** Chip filter: only these categories, all tiers. */
  only?: readonly Category[] | null
  route?: RouteDraw | null
  here?: (WorldPt & { fresh: boolean; label: string }) | null
  pins?: readonly ReportPin[]
  team?: TeamMark | null
  draft?: WorldPt | null
  onDraft?: (p: WorldPt) => void
  /** Report mode: a tap drops the pin instead of selecting. */
  picking?: boolean
  focus?: Focus | null
  /** The staff member's zone: outlined, and the locate button flies to it. */
  home?: { id: string; at: WorldPt; label: string } | null
  /** Screen px hidden under the bottom sheet; focus centres in the visible part. */
  insetBottom?: number
  history?: ReadonlyMap<string, readonly { t: number; n: number }[]>
  evac?: boolean
  children?: ReactNode
}

const at = (p: WorldPt): Pt => worldAt(p.level, p.x, p.z)
const BOUNDS: Box = pad(PLATE.content, 40, 60, 40, 40)
const PLATE_BOX: Record<'G' | 'U', Box> = {
  G: boundsOf(PLATE.zones.G.filter(z => z.level === 'G' && !PLATE.isApron(z)).flatMap(z => z.polygons_px.flatMap(r => r.outer)).map(([x, y]) => [x, y + PLATE.shift('G')] as Pt)),
  U: boundsOf(PLATE.zones.U.flatMap(z => z.polygons_px.flatMap(r => r.outer)).map(([x, y]) => [x, y + PLATE.shift('U')] as Pt)),
}
const ALL_ZONES: MapZone[] = [...PLATE.zones.G, ...PLATE.zones.U]
const ZONE_IDS = new Set(ALL_ZONES.map(z => z.id))
const areaOf = new Map(ALL_ZONES.map(z => [z.id, z.area_m2]))
/** Where a floor's name sits for the current view box (map units), or null when the floor is off screen. */
function floorAt(pk: 'G' | 'U', vb: Box, u: number) {
  const b = PLATE_BOX[pk]
  const x = Math.max(vb[0] + 10 * u, b[0]), y = Math.max(vb[1] + 22 * u, b[1] - 14 * u)
  if (y > vb[1] + vb[3] - 10 * u || b[1] + b[3] < vb[1]) return null
  return { x, y }
}
const reducedMotion = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

/** The floor plan: drawn once per page. */
const Base = memo(function Base() {
  const M = 10
  return <>
    <defs>
      <pattern id="t2-steps" width={0.32 * M} height={10} patternUnits="userSpaceOnUse"><line x1={0} y1={0} x2={0} y2={10} className="p-step" /></pattern>
      <pattern id="t2-seats" width={0.6 * M} height={0.55 * M} patternUnits="userSpaceOnUse"><rect x={0.04 * M} y={0.04 * M} width={0.52 * M} height={0.47 * M} className="p-seat" /></pattern>
      <pattern id="t2-stalls" width={2.5 * M} height={5 * M} patternUnits="userSpaceOnUse"><path d={`M0,0V${5 * M}M0,0H${2.5 * M}`} className="p-stall" /></pattern>
      <pattern id="lm-hatch" width={14} height={14} patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width={14} height={14} className="hatch-bg" /><line x1={0} y1={0} x2={0} y2={14} className="hatch" /></pattern>
      {ALL_ZONES.map(z => <clipPath key={z.id} id={`lmc-${z.id}`}><path d={zoneGeo(z).d} clipRule="evenodd" /></clipPath>)}
    </defs>
    <rect x={BOUNDS[0] - 4000} y={BOUNDS[1] - 4000} width={BOUNDS[2] + 8000} height={BOUNDS[3] + 8000} className="lm-ground" />
    {(['G', 'U'] as const).map(pk => <g key={pk} className={`lm-plate p-${pk}`} transform={`translate(0 ${fmt(PLATE.shift(pk))})`}>
      <g className="lm-shell" aria-hidden="true">{SHELL[pk].map((d, k) => <path key={k} d={d} fillRule="evenodd" strokeWidth={9} />)}</g>
      {PLATE.zones[pk].map(z => {
        const { d, frame: f, pts } = zoneGeo(z)
        return <g key={z.id} className={`lz k-${z.kind}${z.level === 'X' ? ' ext' : ''}${PLATE.isApron(z) ? ' apron' : ''}`} data-zone={z.id} data-testid={`lm-zone-${z.id}`}>
          <path className="fill" d={d} fillRule="evenodd" />
          <g clipPath={`url(#lmc-${z.id})`} className="detail" aria-hidden="true">
            <g transform={`translate(${fmt(f.cx)} ${fmt(f.cy)}) rotate(${fmt(f.angle)})`}>{zoneDetail({ zone: z, f, m: M, pts, base: false })}</g>
          </g>
          <path className="edge" d={d} fillRule="evenodd" />
        </g>
      })}
    </g>)}
  </>
})

/** Words, minutes and people for a place, or null when it has no camera row. */
export function crowdOf(flow: Flow, id: string, now: number) {
  const row = rowFor(flow, id)
  if (!row) return null
  const level = crowdLevel(row, id, now, areaOf.get(id))
  return { row, level, stale: isStale(row, now), queue: isQueue(id) }
}

export function LiveMap(p: Props) {
  const { lang, mode, points, flow, now, selected = null, onSelect, only = null, route, here, pins = [], team, draft, onDraft, picking = false, focus, insetBottom = 0, history, evac = false, home = null } = p
  const wrap = useRef<HTMLDivElement>(null), svg = useRef<SVGSVGElement>(null)
  const [size, setSize] = useState<Size>([390, 600])
  const sizeRef = useRef(size)
  const limits = useMemo(() => limitsFor(BOUNDS, size), [size])
  const limitsRef = useRef(limits)
  const [view, setView] = useState<View>(() => fitView(BOUNDS, [390, 600]))
  const live = useRef(view)
  const anim = useRef(0)
  const insetRef = useRef(insetBottom)
  useLayoutEffect(() => { sizeRef.current = size; limitsRef.current = limits; insetRef.current = insetBottom })

  const apply = useCallback((v: View) => {
    live.current = v
    const el = svg.current
    if (el) el.setAttribute('viewBox', viewBox(v, sizeRef.current).map(n => n.toFixed(2)).join(' '))
  }, [])
  const commit = useCallback(() => setView({ ...live.current }), [])
  const flyTo = useCallback((to: View, ms = 420) => {
    cancelAnimationFrame(anim.current)
    const from = live.current, t0 = performance.now()
    const target = clampView(to, sizeRef.current, limitsRef.current, insetRef.current)
    if (ms <= 0 || reducedMotion()) { apply(target); commit(); return }
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / ms), e = 1 - Math.pow(1 - k, 3)
      apply(lerpView(from, target, e))
      if (k < 1) anim.current = requestAnimationFrame(step)
      else commit()
    }
    anim.current = requestAnimationFrame(step)
  }, [apply, commit])
  useEffect(() => () => cancelAnimationFrame(anim.current), [])

  // Size: the first measurement fits the building, later ones keep the centre.
  const sized = useRef(false)
  useLayoutEffect(() => {
    const el = wrap.current
    if (!el) return
    const measure = () => {
      const r = el.getBoundingClientRect()
      if (r.width < 10 || r.height < 10) return
      const s: Size = [r.width, r.height]
      sizeRef.current = s; limitsRef.current = limitsFor(BOUNDS, s)
      setSize(prev => prev[0] === s[0] && prev[1] === s[1] ? prev : s)
      const next = sized.current ? clampView(live.current, s, limitsRef.current, insetRef.current) : fitView(BOUNDS, s, 8)
      sized.current = true
      apply(next); commit()
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [apply, commit])

  // Focus: fit the given places into the part of the map above the sheet.
  const focusKey = focus?.key
  useEffect(() => {
    if (!focus || !focus.pts.length) return
    const [w, h] = sizeRef.current
    // Keep clear of the zoom buttons on the right (64 px) and the sheet at the bottom.
    const right = 64
    const visible: Size = [Math.max(160, w - right), Math.max(160, h - insetBottom)]
    const box = boxAround(focus.pts.map(at), focus.minW ?? 380)
    const fit = fitView(pad(box, 40), visible, 32)
    const s = Math.min(fit.s, limitsRef.current.min * 6)
    flyTo({ s, cx: fit.cx + right / 2 / s, cy: fit.cy + insetBottom / 2 / s }, 480)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusKey])

  /* ---------- Gestures: one finger pans, two pinch, double tap zooms ---------- */
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const gesture = useRef<{ moved: boolean; start: { x: number; y: number }; t: number; dragDraft: boolean; pinch?: { d: number; mid: Pt; v: View } } | null>(null)
  const lastTap = useRef<{ t: number; x: number; y: number } | null>(null)
  const local = (e: { clientX: number; clientY: number }) => { const r = wrap.current!.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top } }
  const worldOf = (x: number, y: number): WorldPt => PLATE.toWorld(toMap(live.current, sizeRef.current, x, y))
  useEffect(() => {
    const el = wrap.current
    if (!el) return
    const stop = (e: Event) => e.preventDefault()
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      cancelAnimationFrame(anim.current)
      const r = el.getBoundingClientRect()
      const k = Math.exp(-Math.max(-1, Math.min(1, e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0025))) * (e.ctrlKey ? 3 : 1))
      apply(clampView(zoomAt(live.current, k, sizeRef.current, e.clientX - r.left, e.clientY - r.top), sizeRef.current, limitsRef.current, insetRef.current))
      clearTimeout(wheelTimer.current); wheelTimer.current = window.setTimeout(commit, 140)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    el.addEventListener('gesturestart', stop); el.addEventListener('gesturechange', stop)
    return () => { el.removeEventListener('wheel', onWheel); el.removeEventListener('gesturestart', stop); el.removeEventListener('gesturechange', stop) }
  }, [apply, commit])
  const wheelTimer = useRef(0)

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    cancelAnimationFrame(anim.current)
    const pt = local(e)
    pointers.current.set(e.pointerId, pt)
    const dragDraft = !!(e.target as Element).closest?.('[data-draft]')
    if (pointers.current.size === 1) gesture.current = { moved: false, start: pt, t: performance.now(), dragDraft }
    else if (pointers.current.size === 2 && gesture.current) {
      const [a, b] = [...pointers.current.values()] as [{ x: number; y: number }, { x: number; y: number }]
      gesture.current.moved = true; gesture.current.dragDraft = false
      gesture.current.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), mid: [(a.x + b.x) / 2, (a.y + b.y) / 2], v: { ...live.current } }
    }
  }
  const onPointerMove = (e: React.PointerEvent) => {
    const prev = pointers.current.get(e.pointerId), g = gesture.current
    if (!prev || !g) return
    const pt = local(e)
    pointers.current.set(e.pointerId, pt)
    if (g.pinch && pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()] as [{ x: number; y: number }, { x: number; y: number }]
      const d = Math.hypot(a.x - b.x, a.y - b.y), mid: Pt = [(a.x + b.x) / 2, (a.y + b.y) / 2]
      const zoomed = zoomAt(g.pinch.v, d / Math.max(g.pinch.d, 1), sizeRef.current, g.pinch.mid[0], g.pinch.mid[1])
      apply(clampView({ ...zoomed, cx: zoomed.cx - (mid[0] - g.pinch.mid[0]) / zoomed.s, cy: zoomed.cy - (mid[1] - g.pinch.mid[1]) / zoomed.s }, sizeRef.current, limitsRef.current, insetRef.current))
      return
    }
    if (!g.moved && Math.hypot(pt.x - g.start.x, pt.y - g.start.y) < 6) return
    if (!g.moved) { g.moved = true; try { (e.currentTarget as Element).setPointerCapture(e.pointerId) } catch { /* pointer already gone */ } }
    if (g.dragDraft && onDraft) { onDraft(worldOf(pt.x, pt.y)); return }
    const v = live.current
    apply(clampView({ ...v, cx: v.cx - (pt.x - prev.x) / v.s, cy: v.cy - (pt.y - prev.y) / v.s }, sizeRef.current, limitsRef.current, insetRef.current))
  }
  const onPointerUp = (e: React.PointerEvent) => {
    const g = gesture.current
    pointers.current.delete(e.pointerId)
    if (pointers.current.size > 0) { if (g) g.pinch = undefined; return }
    gesture.current = null
    if (!g) return
    if (g.moved) { if (!g.dragDraft) commit(); return }
    // A tap: double tap zooms, single tap selects or drops the report pin.
    const pt = local(e), nowT = performance.now(), last = lastTap.current
    if (last && nowT - last.t < 320 && Math.hypot(pt.x - last.x, pt.y - last.y) < 30) {
      lastTap.current = null
      const v = live.current
      flyTo(v.s >= limitsRef.current.max * 0.7 ? fitView(BOUNDS, sizeRef.current, 8) : zoomAt(v, 2, sizeRef.current, pt.x, pt.y), 260)
      return
    }
    lastTap.current = { t: nowT, x: pt.x, y: pt.y }
    if (picking && onDraft) { onDraft(worldOf(pt.x, pt.y)); return }
    const target = e.target as Element
    const point = target.closest?.('[data-lm]')?.getAttribute('data-lm')
    if (point) { onSelect?.(point); return }
    const zone = target.closest?.('[data-zone]')?.getAttribute('data-zone')
    onSelect?.(zone && points.some(l => l.id === zone) ? zone : null)
  }

  /* ---------- Crowding: CSS only ---------- */
  useEffect(() => {
    const el = svg.current
    if (!el) return
    for (const g of el.querySelectorAll<SVGGElement>('g[data-zone]')) {
      const id = g.dataset.zone!
      const c = crowdOf(flow, id, now)
      const value = !c ? 'none' : c.stale ? 'stale' : c.level
      if (g.dataset.crowd !== value) g.dataset.crowd = value
    }
  }, [flow, now])
  useEffect(() => {
    const el = svg.current
    if (!el) return
    for (const g of el.querySelectorAll<SVGGElement>('g[data-zone]')) { if (g.dataset.zone === home?.id) g.dataset.home = '1'; else delete g.dataset.home }
  }, [home?.id])
  useEffect(() => {
    const el = svg.current
    if (!el) return
    for (const g of el.querySelectorAll<SVGGElement>('g[data-zone]')) {
      const on = g.dataset.zone === selected
      if ((g.dataset.sel === '1') !== on) { if (on) g.dataset.sel = '1'; else delete g.dataset.sel }
    }
  }, [selected])

  /* ---------- Points and labels, laid out for the committed view ---------- */
  const u = 1 / view.s
  const vb = viewBox(view, size)
  const zoom = view.s / limits.min
  const toScreen = (m: Pt): Pt => [(m[0] - vb[0]) * view.s, (m[1] - vb[1]) * view.s]
  const NAME = 14, R = 11
  const shown = useMemo(() => {
    if (!points.length) return []
    const tierMax = zoom >= 3.4 ? 2 : zoom >= 1.7 ? 1 : 0
    const items: (PlaceItem & { l: Landmark; m: Pt; lines: [string, string | null]; crowd: Crowd | null })[] = []
    for (const l of points) {
      const cat = categoryOf(l.id)
      if (cat === 'apron') continue
      const isSel = l.id === selected
      if (evac) continue
      if (only) { if (!only.includes(cat) && !isSel) continue }
      else if (tierOf(l.id) > tierMax && !isSel) continue
      const m = at(l)
      const [sx, sy] = toScreen(m)
      const c = crowdOf(flow, l.id, now)
      let second: string | null = null
      if (c && mode === 'staff') {
        const samples = history?.get(c.row ? Object.keys(flow).find(k => flow[k] === c.row) ?? l.id : l.id)?.map(s => s.n) ?? []
        second = c.stale ? `${lang === 'en' ? 'no data' : 'fără date'} · ${ageLabel(ageMs(c.row, now), lang)}`
          : `${c.row.waiting} ${TREND_MARK[trend(samples)]}${c.queue && c.row.waitMin != null ? ` · ${Math.ceil(c.row.waitMin)} min` : ''} · ${ageLabel(ageMs(c.row, now), lang)}`
      } else if (c && !c.stale && c.level !== 'unknown') {
        const band = c.queue ? waitBand(c.row.waitMin) : null
        second = band ? `${crowdWords(c.level, lang)} · ${band}` : crowdWords(c.level, lang)
      }
      const name = cat === 'gate' ? (lang === 'en' ? 'Gate ' : 'Poarta ') + l.id.replace('U_GATE_', '') : shortName(l, lang)
      const showName = zoom >= 1.7 || isSel || !!only || cat === 'security' || cat === 'checkin' && !l.id.includes(':') || !!second
      const lines: [string, string | null] = [showName ? name : '', second]
      const personsW = second && mode === 'passenger' ? 30 : 0
      const w = Math.max(lines[0] ? textWidth(lines[0], NAME) : 0, second ? textWidth(second, 13) + personsW : 0)
      const h = (lines[0] ? 17 : 0) + (second ? 16 : 0)
      const crowdRank = c && !c.stale && (c.level === 'busy' || c.level === 'very') ? 30 : 0
      items.push({ id: l.id, x: sx, y: sy, r: R, w: lines[0] || second ? w + 2 : 0, h, rank: rankOf(l.id) + crowdRank, force: isSel, l, m, lines, crowd: c && !c.stale ? c.level : null })
    }
    const obstacles: Rect[] = []
    const mark = (w: WorldPt | PathNode, x0: number, y0: number, x1: number, y1: number) => { const [sx, sy] = toScreen(at(w)); obstacles.push([sx + x0, sy + y0, sx + x1, sy + y1]) }
    for (const pk of ['U', 'G'] as const) {
      const f = floorAt(pk, vb, u)
      if (f) obstacles.push([(f.x - vb[0]) * view.s - 4, (f.y - vb[1]) * view.s - 16, (f.x - vb[0]) * view.s + textWidth(FLOOR_NAMES[pk][lang], 15) + 10, (f.y - vb[1]) * view.s + 6])
    }
    if (here) mark(here, -20, -44, 20 + 0, 20)
    for (const pin of pins) mark(pin.at, -12, -50, 24 + textWidth(pin.label, 13) + 12, 4)
    if (team) mark(team.at, -14, -14, 30 + textWidth(team.label, 13) + 60, 14)
    if (draft) mark(draft, -14, -40, 14, 4)
    if (route) {
      for (const c of route.changes) mark(c.at, -14, -14, 24 + textWidth(c.text, 13) + 12, 14)
      const end = route.path[route.path.length - 1]
      if (end) mark(end, -4, -44, 30 + (route.endLabel ? textWidth(route.endLabel, 13) + 12 : 0), 4)
    }
    const placed = new Map(placeItems(items, size, 4, 40, obstacles).map(pl => [pl.id, pl]))
    return items.filter(it => placed.has(it.id)).map(it => ({ ...it, label: placed.get(it.id)!.label }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [points, view, size, flow, now, selected, only, mode, lang, evac, history, here, pins, team, draft, route])

  const pointEls = shown.map(it => {
    const cat = categoryOf(it.l.id)
    const sel = it.l.id === selected
    const lab = it.label
    const lx = lab ? vb[0] + lab.x * u : 0, ly = lab ? vb[1] + lab.y * u : 0
    const [l1, l2] = it.lines
    const top = lab ? ly - (it.h / 2) * u : 0
    const persons = l2 && mode === 'passenger' && it.crowd ? people(it.crowd) : 0
    const textX = (dx: number) => lab!.anchor === 'start' ? lx + dx * u : lab!.anchor === 'end' ? lx : lx + dx * u / 2
    return <g key={it.l.id} className={`lm-pt${sel ? ' sel' : ''}${it.crowd ? ` cr-${it.crowd}` : ''}`} data-lm={it.l.id} data-testid={`lm-point-${it.l.id}`}
      role="button" tabIndex={0} aria-label={`${shortName(it.l, lang)}${it.lines[1] ? `, ${it.lines[1]}` : ''}`}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect?.(it.l.id) } }}>
      <circle className="hit" cx={fmt(it.m[0])} cy={fmt(it.m[1])} r={fmt(22 * u)} />
      {sel && <circle className="sel-ring" cx={fmt(it.m[0])} cy={fmt(it.m[1])} r={fmt((R + 5) * u)} />}
      <PointGlyph cat={cat} x={it.m[0]} y={it.m[1]} r={R * u} label={cat === 'gate' ? it.l.id.replace('U_GATE_', '') : undefined} />
      {lab && <g className={`lm-label a-${lab.anchor}`}>
        {l1 && <text x={fmt(textX(0))} y={fmt(top + 13 * u)} fontSize={fmt(NAME * u)} className="name" textAnchor={lab.anchor}>{l1}</text>}
        {l2 && <g className="crowd">
          {persons > 0 && <g transform={`translate(${fmt(lab.anchor === 'end' ? lx - (textWidth(l2, 13) + 30) * u : lab.anchor === 'middle' ? lx - (textWidth(l2, 13) + 30) * u / 2 : lx)} ${fmt(top + (l1 ? 19 : 2) * u)})`}>
            {[0, 1, 2].map(i => <g key={i} className={i < persons ? 'on' : 'off'} transform={`translate(${fmt((i * 9 + 4) * u)} 0)`}>
              <circle cy={fmt(2.4 * u)} r={fmt(2.2 * u)} /><path d={`M${fmt(-3.4 * u)},${fmt(12 * u)}v${fmt(-4.2 * u)}a${fmt(3.4 * u)},${fmt(3 * u)} 0 0 1 ${fmt(6.8 * u)},0v${fmt(4.2 * u)}z`} />
            </g>)}
          </g>}
          <text x={fmt(lab.anchor === 'end' ? lx : lab.anchor === 'middle' ? lx + (persons ? 15 * u : 0) : lx + (persons ? 30 * u : 0))} y={fmt(top + (l1 ? 30 : 13) * u)} fontSize={fmt(13 * u)} className="cr" textAnchor={lab.anchor}>{l2}</text>
        </g>}
      </g>}
    </g>
  })

  /* ---------- Route ---------- */
  const routeEls = useMemo(() => {
    if (!route || route.path.length < 2) return null
    const end = at(route.path[route.path.length - 1]!)
    return { runs: floorRuns(route.path).map(run => `M${run.map(n => { const q = at(n); return `${fmt(q[0])},${fmt(q[1])}` }).join('L')}`), end }
  }, [route])

  /* ---------- Floors ---------- */
  const floorEls = (['U', 'G'] as const).map(pk => {
    const f = floorAt(pk, vb, u)
    if (!f) return null
    const { x, y } = f
    const [floor, use] = FLOOR_NAMES[pk][lang].split(' · ')
    return <g key={pk} className="lm-floor" aria-hidden="true">
      <text x={fmt(x)} y={fmt(y)} fontSize={fmt(15 * u)}><tspan className="f">{floor}</tspan><tspan className="use" dx={fmt(6 * u)}>{use}</tspan></text>
    </g>
  })

  /** Tags near the right edge (under the zoom buttons) go to the left of their mark. */
  const flip = (m: Pt, text: string) => (m[0] - vb[0]) * view.s + textWidth(text, 13) + 40 > size[0] - 64
  const pinEls = pins.map(pin => {
    const m = at(pin.at), r = 10 * u
    const filled = pin.state === 'taken' || pin.state === 'en_route'
    return <g key={pin.id} className={`lm-pin s-${pin.state}${pin.priority ? ` ${pin.priority}` : ''}`} data-testid={`lm-pin-${pin.id}`} data-state={pin.state} style={pin.fade != null ? { opacity: pin.fade } : undefined}
      role="img" aria-label={pin.label}>
      <path className="stem" d={`M${fmt(m[0])},${fmt(m[1])}v${fmt(-16 * u)}`} strokeWidth={fmt(2 * u)} />
      <circle cx={fmt(m[0])} cy={fmt(m[1] - 16 * u - r)} r={fmt(r)} className={filled ? 'body filled' : 'body'} strokeWidth={fmt(3 * u)} />
      {pin.state === 'resolved' && <path className="check" d={`M${fmt(m[0] - 4.5 * u)},${fmt(m[1] - 26 * u)}l${fmt(3.2 * u)},${fmt(3.4 * u)}l${fmt(6 * u)},${fmt(-7 * u)}`} strokeWidth={fmt(2.4 * u)} />}
      <circle cx={fmt(m[0])} cy={fmt(m[1])} r={fmt(2.6 * u)} className="foot" />
      {flip(m, pin.label) ? <Tag x={m[0] - r - 6 * u} y={m[1] - 16 * u - r} u={u} text={pin.label} dark={filled} end />
        : <Tag x={m[0] + r + 6 * u} y={m[1] - 16 * u - r} u={u} text={pin.label} dark={filled} />}
    </g>
  })

  const renderChanges = (changes: RouteDraw['changes']) => changes.map((c, i) => {
    const a = at(c.at), b = at(c.to), s = 12 * u
    return <g key={i} className="lm-change">
      {[a, b].map((q, k) => <g key={k}>
        <rect x={fmt(q[0] - s)} y={fmt(q[1] - s)} width={fmt(2 * s)} height={fmt(2 * s)} rx={fmt(2 * u)} />
        <path d={c.up ? `M${fmt(q[0])},${fmt(q[1] - s * 0.6)}V${fmt(q[1] + s * 0.6)}M${fmt(q[0] - s * 0.5)},${fmt(q[1] - s * 0.05)}L${fmt(q[0])},${fmt(q[1] - s * 0.6)}L${fmt(q[0] + s * 0.5)},${fmt(q[1] - s * 0.05)}`
          : `M${fmt(q[0])},${fmt(q[1] + s * 0.6)}V${fmt(q[1] - s * 0.6)}M${fmt(q[0] - s * 0.5)},${fmt(q[1] + s * 0.05)}L${fmt(q[0])},${fmt(q[1] + s * 0.6)}L${fmt(q[0] + s * 0.5)},${fmt(q[1] + s * 0.05)}`} strokeWidth={fmt(2.4 * u)} />
      </g>)}
      {flip(a, c.text) ? <Tag x={a[0] - s - 6 * u} y={a[1]} u={u} text={c.text} end /> : <Tag x={a[0] + s + 6 * u} y={a[1]} u={u} text={c.text} />}
    </g>
  })

  const teamEl = team && (() => {
    const m = at(team.at)
    return <>
      <g data-testid="lm-team-route">
        {floorRuns(team.remaining.path).map((run, i) => <path key={i} className="lm-team-line" data-floor={run[0]!.level}
          d={`M${run.map(n => { const q = at(n); return `${fmt(q[0])},${fmt(q[1])}` }).join('L')}`}
          strokeWidth={fmt(2.5 * u)} strokeDasharray={`${fmt(6 * u)} ${fmt(5 * u)}`} />)}
        {renderChanges(team.remaining.changes)}
      </g>
      <g className="lm-team" data-testid="lm-team" style={{ transform: `translate(${fmt(m[0])}px, ${fmt(m[1])}px)` }} role="img" aria-label={team.label}>
        <g transform={`rotate(${fmt((team.heading * 180) / Math.PI)})`}>
          <rect x={fmt(-11 * u)} y={fmt(-11 * u)} width={fmt(22 * u)} height={fmt(22 * u)} rx={fmt(3 * u)} className="body" strokeWidth={fmt(2.5 * u)} />
          <path d={`M${fmt(-4 * u)},${fmt(-5 * u)}L${fmt(5 * u)},0L${fmt(-4 * u)},${fmt(5 * u)}`} className="arrow" strokeWidth={fmt(2.6 * u)} />
        </g>
        {flip(m, team.label + (team.badge ?? '')) ? <Tag x={-14 * u} y={0} u={u} text={team.badge ? `${team.label} · ${team.badge}` : team.label} dark end />
          : <Tag x={14 * u} y={0} u={u} text={team.badge ? `${team.label} · ${team.badge}` : team.label} dark />}
      </g>
    </>
  })()

  const hereEl = here && (() => {
    const m = at(here)
    return <g className={`lm-here${here.fresh ? '' : ' old'}`} data-testid="lm-here" role="img" aria-label={here.label}>
      <circle cx={fmt(m[0])} cy={fmt(m[1])} r={fmt(18 * u)} className="halo" />
      <circle cx={fmt(m[0])} cy={fmt(m[1])} r={fmt(8 * u)} className="dot" strokeWidth={fmt(3 * u)} />
      <Tag x={m[0] - 0} y={m[1] - 30 * u} u={u} text={here.label} dark={here.fresh} center />
    </g>
  })()

  const draftEl = draft && (() => {
    const m = at(draft)
    return <g className="lm-draft" data-draft="1" data-testid="lm-draft">
      <circle cx={fmt(m[0])} cy={fmt(m[1] - 22 * u)} r={fmt(26 * u)} className="grab" />
      <path d={`M${fmt(m[0])},${fmt(m[1])}l${fmt(-9 * u)},${fmt(-16 * u)}a${fmt(11 * u)},${fmt(11 * u)} 0 1 1 ${fmt(18 * u)},0z`} className="body" strokeWidth={fmt(2.5 * u)} />
      <circle cx={fmt(m[0])} cy={fmt(m[1] - 21 * u)} r={fmt(4 * u)} className="eye" />
    </g>
  })()

  const changes = route?.changes ?? []
  const routeLayer = routeEls && <g className={`lm-route${evac ? ' evac' : ''}`} data-testid="lm-route">
    {routeEls.runs.map((d, i) => <g key={i}>
      <path d={d} className="halo" strokeWidth={fmt(14 * u)} />
      <path d={d} className="line" strokeWidth={fmt(7 * u)} />
      <path d={d} className="flow" strokeWidth={fmt(3 * u)} strokeDasharray={`${fmt(3 * u)} ${fmt(15 * u)}`} style={{ ['--dash' as string]: `${fmt(18 * u)}` }} />
    </g>)}
    {renderChanges(changes)}
    {route?.exit && (() => {
      const e = at(route.exit)
      return <g className="lm-exit" data-testid="lm-exit">
        <circle cx={fmt(e[0])} cy={fmt(e[1])} r={fmt(8 * u)} />
        {flip(e, route.exit.name) ? <Tag x={e[0] - 22 * u} y={e[1] - 24 * u} u={u} text={route.exit.name} dark end />
          : <Tag x={e[0] + 22 * u} y={e[1] - 24 * u} u={u} text={route.exit.name} dark />}
      </g>
    })()}
    {route?.assembly && (() => {
      const e = routeEls.end, a = at(route.assembly)
      return <g className="lm-assembly">
        {!route.exit && <path d={`M${fmt(e[0])},${fmt(e[1])}L${fmt(a[0])},${fmt(a[1])}`} className="out" strokeWidth={fmt(5 * u)} strokeDasharray={`${fmt(9 * u)} ${fmt(6 * u)}`} />}
        <circle cx={fmt(a[0])} cy={fmt(a[1])} r={fmt(12 * u)} className="spot" strokeWidth={fmt(3 * u)} />
        <Tag x={a[0]} y={a[1] - 20 * u} u={u} text={route.assembly.name} dark center />
      </g>
    })()}
    {!route?.assembly && <g className="lm-end">
      <path d={`M${fmt(routeEls.end[0])},${fmt(routeEls.end[1])}v${fmt(-30 * u)}h${fmt(18 * u)}l${fmt(-5 * u)},${fmt(6 * u)}l${fmt(5 * u)},${fmt(6 * u)}h${fmt(-18 * u)}`} className="flag" strokeWidth={fmt(2.4 * u)} />
      {route?.endLabel && <Tag x={routeEls.end[0] + 22 * u} y={routeEls.end[1] - 24 * u} u={u} text={route.endLabel} dark />}
    </g>}
  </g>

  const zoomBtn = (k: number) => { const [w, h] = sizeRef.current; flyTo(zoomAt(live.current, k, sizeRef.current, w / 2, (h - insetBottom) / 2), 220) }
  const vbStr = vb.map(n => n.toFixed(2)).join(' ')
  return <div ref={wrap} className={`lm${picking ? ' picking' : ''}${evac ? ' evac' : ''}${only ? ' filtering' : ''} m-${mode}`} data-zoom={zoom >= 3.4 ? 2 : zoom >= 1.7 ? 1 : 0}
    onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
    <svg ref={svg} className="t2map lm-svg" viewBox={vbStr} preserveAspectRatio="xMidYMid meet" role="group" aria-label={lang === 'en' ? 'Terminal map' : 'Harta terminalului'} data-testid="live-map">
      <Base />
      <g className="lm-floors">{floorEls}</g>
      {routeLayer}
      <g className="lm-points">{pointEls}</g>
      <g className="lm-marks">{teamEl}{pinEls}{hereEl}{draftEl}</g>
    </svg>
    <div className="lm-zoom" role="group" aria-label="Zoom" style={{ bottom: insetBottom + 12 }}>
      <button type="button" onPointerDown={e => e.stopPropagation()} onClick={() => zoomBtn(1.6)} aria-label={lang === 'en' ? 'Zoom in' : 'Mărește'}>+</button>
      <button type="button" onPointerDown={e => e.stopPropagation()} onClick={() => zoomBtn(1 / 1.6)} aria-label={lang === 'en' ? 'Zoom out' : 'Micșorează'}>−</button>
      {(here ?? home) && <button type="button" className="locate" onPointerDown={e => e.stopPropagation()} onClick={() => { const m = at(here ?? home!.at); const s = Math.max(live.current.s, limitsRef.current.min * 3); flyTo({ s, cx: m[0], cy: m[1] + insetBottom / 2 / s }) }} aria-label={here?.label ?? home!.label}>
        <svg viewBox="-12 -12 24 24" width="20" height="20" aria-hidden="true"><circle r="5" /><path d="M0,-11V-7M0,7V11M-11,0H-7M7,0H11" /></svg>
      </button>}
    </div>
    {p.children}
  </div>
}

/** Flat label box (D29): white with ink, or navy with white for live things. */
function Tag({ x, y, u, text, dark = false, center = false, end = false }: { x: number; y: number; u: number; text: string; dark?: boolean; center?: boolean; end?: boolean }) {
  const size = 13, w = textWidth(text, size) + 12, h = 22
  const left = center ? x - (w / 2) * u : end ? x - w * u : x
  return <g className={`lm-tag${dark ? ' dark' : ''}`}>
    <rect x={fmt(left)} y={fmt(y - (h / 2) * u)} width={fmt(w * u)} height={fmt(h * u)} rx={fmt(2 * u)} />
    <text x={fmt(left + 6 * u)} y={fmt(y + 4.6 * u)} fontSize={fmt(size * u)}>{text}</text>
  </g>
}

/** Team position along its route, as a map mark. */
export function teamMark(path: readonly PathNode[], t: number, label: string, pinLevel: Level, pinId: string, lang: Lang): TeamMark | null {
  const remaining = remainingRoute(path, t)
  if (!remaining) return null
  const m = at(remaining.at), next = at(remaining.next), level = remaining.at.level
  const heading = Math.atan2(next[1] - m[1], next[0] - m[0])
  const plate = (l: Level) => l === 'U' ? 1 : 0
  return { at: remaining.at, heading, label, pin: pinId,
    remaining: { path: remaining.path, changes: floorChanges(remaining.path, lang) },
    badge: plate(level) !== plate(pinLevel) ? `${floorShort(level, lang)} ${plate(pinLevel) > plate(level) ? '↑' : '↓'}` : null }
}

/** Nearest landmark to a world point on the same floor (report pins). */
export function nearestLandmark(points: readonly Landmark[], p: WorldPt): Landmark | undefined {
  const plate = (l: Level) => l === 'U' ? 1 : 0
  let best: Landmark | undefined, d = Infinity
  for (const l of points) {
    const cat = categoryOf(l.id)
    if (plate(l.level) !== plate(p.level) || cat === 'apron' || cat === 'assembly') continue
    // Zones count from anywhere inside them: prefer the zone the pin sits in.
    const dist = Math.hypot(l.x - p.x, l.z - p.z) * (ZONE_IDS.has(l.id) ? 1 : 0.8)
    if (dist < d) { d = dist; best = l }
  }
  return best
}
