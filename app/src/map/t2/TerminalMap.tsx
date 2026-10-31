import { useEffect, useRef, useState, type ReactNode } from 'react'
import { frames, levelNames, points, worldToPx, zones, type Level, type MapPoint, type MapZone, type Pt } from './data'
import { fmt, frameOf, inRing, ringPath } from './geometry'
import { zoneDetail } from './details'
import { placeName, zoneLabel } from './labels'
import { alertOf, densityStep, placeLabels, SHAPE, textWidth, type LabelItem, type Priority } from './layout'
import { boundsOf, connectorPairs, dividerY, fitAspect, onPlate, pad, plateOffset, stackGap, type Box } from './stack'
import './t2map.css'

/**
 * T2 map: both floors flat on one screen, upper floor above the ground floor, same x,z frame,
 * joined by the real stairs, escalator and lift. Drawn from Marius's zones.json / points.json.
 * Zones without data stay neutral; never invent numbers here.
 */
export type ZoneState = 'normal' | 'near' | 'full'
export interface ZoneView {
  state?: ZoneState | null; people?: number | null; waitMin?: number | null; closed?: boolean
  /** D32 priority from the backend; without it `full` is P2 and `near` is P3. */
  alert?: Priority | null
}
export interface MapDot { x: number; z: number; level: Level; kind?: 'pax' | 'staff' }
/** What the map draws on top of the floor. Missing = on, except `heat` (off). */
export interface MapLayers { dots?: boolean; heat?: boolean; labels?: boolean; points?: boolean; pins?: boolean }

interface Props {
  /** Highlighted floor (its name, test ids, focus). Both floors are always drawn; `X` highlights the ground plate's exterior edge. */
  level: Level
  views?: Record<string, ZoneView>
  selected?: string | null
  highlight?: string[]
  onZone?: (id: string) => void
  dots?: MapDot[]
  route?: Pt[]
  cameras?: boolean
  base?: boolean
  lang?: 'ro' | 'en'
  className?: string
  /** Report pins, in pixels of this level. */
  markers?: { id: string; at: Pt; label: string }[]
  /** data-testid prefix for the highlighted floor's zones (`t2-zone-` by default). */
  testIdPrefix?: string
  layers?: MapLayers
  /** Fly to this zone whenever it changes. */
  focus?: string | null
  /** Plain wheel / trackpad zooms (full-screen maps). Off: only ctrl/pinch, so the page keeps scrolling. */
  wheelZoom?: boolean
  /** + − 0 keys zoom while the page has no input focused. */
  keys?: boolean
  /** Hover card for a zone; null = no card. */
  describe?: (id: string) => ReactNode
  /** Clicking a floor's name asks for that floor. */
  onLevel?: (level: Level) => void
}

/* ---------- One pixel space for everything: the G/U frame, 10 px per metre ---------- */
const M = frames.G.ppm
const toPx = (x: number, z: number): Pt => worldToPx(x, z, 'G')
type WorldRing = { outer: Pt[]; holes?: Pt[][] }
const ZONES: MapZone[] = zones.map(z => z.level !== 'X' ? z : {
  ...z, polygons_px: (z as unknown as { polygons_world: WorldRing[] }).polygons_world
    .map(r => ({ outer: r.outer.map(([x, y]) => toPx(x, y)), holes: (r.holes ?? []).map(h => h.map(([x, y]) => toPx(x, y))) })),
})
const POINTS: MapPoint[] = points.filter(p => p.level !== 'X')
/** A level's pixels (markers, routes) in the shared space. */
const fromLevel = (p: Pt, level: Level): Pt => level !== 'X' ? p
  : toPx(p[0] / frames.X.ppm + frames.X.x0, frames.X.z1 - p[1] / frames.X.ppm)

/** Landside edge of the ground plate (D27): kerbs, taxi, ride-hailing, forecourt. Drawn lighter. */
const EDGE = new Set(['X_FORECOURT', 'X_TAXI_RANK', 'X_KERB_ARRIVALS', 'X_KERB_DEPARTURES', 'X_BOLT'])
type PlateKey = 'G' | 'U'
const PLATES: { key: PlateKey; i: number }[] = [{ key: 'G', i: 0 }, { key: 'U', i: 1 }]
const PLATE_ZONES: Record<PlateKey, MapZone[]> = {
  G: [...ZONES.filter(z => EDGE.has(z.id)), ...ZONES.filter(z => z.level === 'G')],
  U: ZONES.filter(z => z.level === 'U'),
}
const BUILDING: Record<PlateKey, MapZone[]> = { G: ZONES.filter(z => z.level === 'G'), U: PLATE_ZONES.U }
const ringsOf = (list: MapZone[]) => list.flatMap(z => z.polygons_px.map(r => r.outer))
const PLATE_BOX: Record<PlateKey, Box> = { G: boundsOf(ringsOf(PLATE_ZONES.G).flat()), U: boundsOf(ringsOf(PLATE_ZONES.U).flat()) }
const GAP = stackGap(PLATE_BOX.G, PLATE_BOX.U, 90)
const DIVIDER = dividerY(PLATE_BOX.G, PLATE_BOX.U, GAP)
const plateOf = (l: Level) => l === 'U' ? 1 : 0
const P = (l: Level, p: Pt): Pt => onPlate(plateOf(l), GAP, p)
const CONNECTORS = connectorPairs(points)
const CONTENT: Box = boundsOf(PLATES.flatMap(({ key, i }) => ringsOf(PLATE_ZONES[key]).flat().map(p => onPlate(i, GAP, p))))
/** The whole map, with room for the floor names on the left, at 16:9 for the projector. */
const FULL: Box = fitAspect(pad(CONTENT, 60, 50, 60, 50), 16 / 9)

/* ---------- Zone geometry caches ---------- */
type Geo = { d: string; frame: ReturnType<typeof frameOf>; pts: MapPoint[] }
const geoCache = new Map<string, Geo>()
function geoOf(z: MapZone): Geo {
  let g = geoCache.get(z.id)
  if (!g) {
    const pts = POINTS.filter(p => p.level === z.level && z.polygons_px.some(r => inRing(p.px, r)))
    g = { d: z.polygons_px.map(ringPath).join(''), frame: frameOf(z.polygons_px[0]!.outer), pts }
    geoCache.set(z.id, g)
  }
  return g
}
const SHELL: Record<PlateKey, string[]> = { G: BUILDING.G.map(z => geoOf(z).d), U: BUILDING.U.map(z => geoOf(z).d) }

/** Padded box around a zone, at the full map's aspect ratio, never smaller than 1/8 of it. */
function zoneBox(z: MapZone): Box {
  const [bx, by, bw, bh] = boundsOf(z.polygons_px.flatMap(r => r.outer).map(p => P(z.level, p)))
  const ratio = FULL[3] / FULL[2]
  let w = Math.max(bw * 2.4, FULL[2] / 8), h = w * ratio
  if (h < bh * 2.4) { h = bh * 2.4; w = h / ratio }
  w = Math.min(w, FULL[2]); h = w * ratio
  return clampBox([bx + bw / 2 - w / 2, by + bh / 2 - h / 2, w, h], FULL)
}
const ease = (t: number) => 1 - Math.pow(1 - t, 3)
const reducedMotion = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
const clampBox = (v: Box, b: Box): Box => [Math.min(Math.max(v[0], b[0]), b[0] + b[2] - v[2]), Math.min(Math.max(v[1], b[1]), b[1] + b[3] - v[3]), v[2], v[3]]

/* ---------- Point icons, flat, fixed pixel size ---------- */
const ICONS = new Set(['door', 'emergency_exit', 'stairs', 'escalator', 'lift', 'information', 'wc'])
function PointIcon({ p, at, s }: { p: MapPoint; at: Pt; s: number }) {
  const t = `translate(${fmt(at[0])} ${fmt(at[1])})`
  const label = p.name.split(' / ')[0]
  const h = s / 2
  switch (p.type) {
    case 'door': return <g transform={t} className="i-door"><title>{label}</title>
      <rect x={-h * 0.7} y={-h * 0.7} width={s * 0.7} height={s * 0.7} /></g>
    case 'emergency_exit': return <g transform={t} className="i-exit"><title>{label}</title>
      <rect x={-h} y={-h * 0.8} width={s} height={s * 0.8} />
      <path d={`M${-h * 0.55},0H${h * 0.5}M${h * 0.1},${-h * 0.4}L${h * 0.5},0L${h * 0.1},${h * 0.4}`} /></g>
    case 'stairs': return <g transform={t} className="i-vert"><title>Scări</title><rect x={-h} y={-h} width={s} height={s} />
      <path d={`M${-h * 0.6},${h * 0.5}h${h * 0.4}v${-h * 0.4}h${h * 0.4}v${-h * 0.4}h${h * 0.4}`} /></g>
    case 'escalator': return <g transform={t} className="i-vert"><title>Escalator</title><rect x={-h} y={-h} width={s} height={s} />
      <path d={`M${-h * 0.55},${h * 0.5}L${h * 0.45},${-h * 0.5}M${0},${-h * 0.5}h${h * 0.45}v${h * 0.45}`} /></g>
    case 'lift': return <g transform={t} className="i-vert"><title>Lift</title><rect x={-h} y={-h} width={s} height={s} />
      <path className="solid" d={`M0,${-h * 0.62}l${h * 0.38},${h * 0.44}h${-h * 0.76}ZM0,${h * 0.62}l${h * 0.38},${-h * 0.44}h${-h * 0.76}Z`} /></g>
    case 'information': return <g transform={t} className="i-info"><title>Informații</title><rect x={-h} y={-h} width={s} height={s} />
      <text y={h * 0.5} fontSize={s * 0.8}>i</text></g>
    case 'wc': return <g transform={t} className="i-tag"><title>Toalete</title><rect x={-h * 1.2} y={-h * 0.8} width={s * 1.2} height={s * 0.8} />
      <text y={h * 0.34} fontSize={s * 0.48}>WC</text></g>
    default: return null
  }
}

function CameraCone({ p }: { p: MapPoint }) {
  const [x, y] = p.px
  const yaw = ((p.yaw ?? 0) * Math.PI) / 180, half = (((p.hfov ?? 60) / 2) * Math.PI) / 180, r = 5 * M
  const a = [Math.sin(yaw - half) * r, -Math.cos(yaw - half) * r], b = [Math.sin(yaw + half) * r, -Math.cos(yaw + half) * r]
  return <g transform={`translate(${fmt(x)} ${fmt(y)})`} className="i-cam"><title>{`Cameră: ${p.name}`}</title>
    <path className="cone" d={`M0,0L${fmt(a[0]!)},${fmt(a[1]!)}A${fmt(r)},${fmt(r)} 0 0 1 ${fmt(b[0]!)},${fmt(b[1]!)}Z`} />
    <circle r={0.35 * M} /></g>
}

const TEXT = {
  ro: { esc: 'Escalator, doar urcare', stairs: 'Scări', lift: 'Lift', people: 'pers.' },
  en: { esc: 'Escalator, up only', stairs: 'Stairs', lift: 'Lift', people: 'ppl' },
}
const NAME = 15, NUM = 15, GATE = 22

export function TerminalMap({ level, views = {}, selected = null, highlight = [], onZone, dots = [], route, cameras = false, base = false, lang = 'ro', className, markers = [], testIdPrefix = 't2-zone-', layers = {}, focus = null, wheelZoom = false, keys = false, describe, onLevel }: Props) {
  const show = { dots: layers.dots !== false, heat: layers.heat === true, labels: layers.labels !== false, points: layers.points !== false, pins: layers.pins !== false }
  const tx = TEXT[lang]
  const lit = new Set(highlight)
  const full = FULL
  const activeIdx = plateOf(level)

  const [view, setView] = useState<Box>(full)
  const svgRef = useRef<SVGSVGElement>(null)
  const anim = useRef(0)
  const viewRef = useRef(view)
  useEffect(() => { viewRef.current = view })
  const flyTo = (to: Box, ms = 420) => {
    cancelAnimationFrame(anim.current)
    const from = viewRef.current, t0 = performance.now()
    if (ms <= 0 || reducedMotion()) ms = 1
    const step = (now: number) => {
      const k = ease(Math.min(1, (now - t0) / ms))
      setView(from.map((v, i) => v + (to[i]! - v) * k) as Box)
      if (k < 1) anim.current = requestAnimationFrame(step)
    }
    anim.current = requestAnimationFrame(step)
  }
  useEffect(() => () => cancelAnimationFrame(anim.current), [])

  /* Screen size: labels and icons keep a fixed pixel size (≥ 14 px) whatever the zoom. */
  const [screen, setScreen] = useState<[number, number]>([1600, 900])
  useEffect(() => {
    const el = svgRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(([e]) => { if (e && e.contentRect.width > 0) setScreen([e.contentRect.width, e.contentRect.height]) })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const u = Math.max(view[2] / screen[0], screen[1] > 0 ? view[3] / screen[1] : 0)

  const [hover, setHover] = useState<{ id: string; x: number; y: number; w: number; h: number } | null>(null)
  const hoverAt = (id: string, e: { clientX: number; clientY: number }) => {
    const r = svgRef.current?.getBoundingClientRect()
    if (r) setHover({ id, x: e.clientX - r.left, y: e.clientY - r.top, w: r.width, h: r.height })
  }
  const drag = useRef<{ x: number; y: number; v: Box; moved: boolean } | null>(null)
  const dragged = useRef(false)
  const click = (id: string) => { if (!dragged.current) onZone?.(id) }
  const zoomed = view[2] < full[2] - 1
  const scaled = ([x, y, w, h]: Box, k: number, cx?: number, cy?: number): Box => {
    const nw = Math.min(full[2], Math.max(full[2] / 8, w * k)), nh = nw * (full[3] / full[2])
    const px = cx ?? x + w / 2, py = cy ?? y + h / 2
    return clampBox([px - ((px - x) * nw) / w, py - ((py - y) * nh) / h, nw, nh], full)
  }
  const zoomBy = (k: number, cx?: number, cy?: number) => flyTo(scaled(viewRef.current, k, cx, cy), 260)

  // Fly to the focused zone when it changes.
  const focusZone = focus ? ZONES.find(z => z.id === focus) : undefined
  useEffect(() => {
    if (focusZone) flyTo(zoneBox(focusZone), 520)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusZone?.id])
  useEffect(() => {
    if (!keys) return
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      if (e.metaKey || e.ctrlKey || e.altKey || el?.closest('input, select, textarea, [contenteditable]')) return
      if (e.key === '+' || e.key === '=') zoomBy(0.66)
      else if (e.key === '-' || e.key === '_') zoomBy(1.5)
      else if (e.key === '0') flyTo(full)
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })
  const toSvg = (clientX: number, clientY: number): Pt => {
    const r = svgRef.current!.getBoundingClientRect()
    return [view[0] + ((clientX - r.left) / r.width) * view[2], view[1] + ((clientY - r.top) / r.height) * view[3]]
  }
  // Pinch / ctrl+wheel zooms; a plain wheel keeps scrolling the page unless `wheelZoom`.
  useEffect(() => {
    const el = svgRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (!wheelZoom && !e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      cancelAnimationFrame(anim.current)
      const r = el.getBoundingClientRect()
      const pan = wheelZoom && !e.ctrlKey && e.deltaMode === 0 && Math.abs(e.deltaX) > 0.5
      setView(v => {
        if (pan) return clampBox([v[0] + (e.deltaX / r.width) * v[2], v[1] + (e.deltaY / r.height) * v[3], v[2], v[3]], FULL)
        const cx = v[0] + ((e.clientX - r.left) / r.width) * v[2], cy = v[1] + ((e.clientY - r.top) / r.height) * v[3]
        const k = Math.exp(Math.max(-1, Math.min(1, e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0025))) * (e.ctrlKey ? 4 : 1))
        const nw = Math.min(FULL[2], Math.max(FULL[2] / 8, v[2] * k)), nh = nw * (FULL[3] / FULL[2])
        return clampBox([cx - ((cx - v[0]) * nw) / v[2], cy - ((cy - v[1]) * nh) / v[3], nw, nh], FULL)
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [wheelZoom])

  /* ---------- Plates ---------- */
  const zoneClass = (z: MapZone) => {
    const v = views[z.id]
    const a = alertOf(v)
    const step = densityStep(v?.people, z.area_m2)
    return ['t2-zone', `k-${z.kind}`, v?.state ? `s-${v.state}` : 's-none', step != null ? `dn-${step}` : '', a ? `a-${a}` : '',
      z.level === 'X' ? 'ext' : '', z.approx ? 'approx' : '', selected === z.id ? 'sel' : '', lit.has(z.id) ? 'lit' : '',
      v?.closed ? 'closed' : '', onZone ? 'click' : ''].filter(Boolean).join(' ')
  }
  const plateEls = PLATES.map(({ key: pk, i }) => {
    const zoneEls = PLATE_ZONES[pk].map(z => {
      const { d, frame: f, pts } = geoOf(z)
      const v = views[z.id]
      return <g key={z.id} className={zoneClass(z)} data-zone={z.id} data-testid={z.level === level ? `${testIdPrefix}${z.id}` : undefined}
        aria-pressed={onZone ? selected === z.id : undefined}
        role={onZone ? 'button' : undefined} tabIndex={onZone ? 0 : undefined} aria-label={placeName(z, lang)}
        onClick={onZone ? () => click(z.id) : undefined}
        onPointerEnter={describe ? e => hoverAt(z.id, e) : undefined}
        onPointerMove={describe ? e => { if (!drag.current?.moved) hoverAt(z.id, e) } : undefined}
        onPointerLeave={describe ? () => setHover(h => h?.id === z.id ? null : h) : undefined}
        onKeyDown={onZone ? e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); click(z.id) } } : undefined}>
        {!describe && <title>{`${placeName(z, lang)}${z.approx ? (lang === 'en' ? ' (approximate)' : ' (aproximativ)') : ''}`}</title>}
        <path className="fill" d={d} fillRule="evenodd" />
        <g clipPath={`url(#t2c-${z.id})`} className="detail">
          <g transform={`translate(${fmt(f.cx)} ${fmt(f.cy)}) rotate(${fmt(f.angle)})`}>{zoneDetail({ zone: z, f, m: M, pts, base })}</g>
        </g>
        <path className="edge" d={d} fillRule="evenodd" />
        {v?.closed && <path className="cross" d={d} fillRule="evenodd" />}
      </g>
    })
    const heat = show.heat && i === activeIdx ? dots.filter(dt => plateOf(dt.level) === i) : []
    return <g key={pk} className={`t2-plate p-${pk}${i === activeIdx ? ' on' : ''}`} data-plate={pk} transform={`translate(0 ${fmt(plateOffset(i, GAP))})`}>
      {base && <image href={`/map/base_${frames[pk].key}.jpg`} width={frames[pk].width} height={frames[pk].height} className="t2-base" preserveAspectRatio="none" />}
      <g className="t2-shell" aria-hidden="true">{SHELL[pk].map((sd, k) => <path key={k} d={sd} fillRule="evenodd" strokeWidth={0.9 * M} />)}</g>
      <g className="t2-zones">{zoneEls}</g>
      {heat.length > 0 && <g className="t2-heat" aria-hidden="true" filter="url(#t2-blur)">
        {heat.map((dt, k) => { const [x, y] = toPx(dt.x, dt.z); return <circle key={k} cx={fmt(x)} cy={fmt(y)} r={fmt(2.4 * M)} /> })}
      </g>}
      {cameras && <g className="t2-cams" aria-hidden="true">{POINTS.filter(p => p.type === 'camera' && p.level === pk).map(p => <CameraCone key={p.id} p={p} />)}</g>}
    </g>
  })

  /* ---------- Connectors: the east core is the passenger path; apron stairs are markers only ---------- */
  const linkEls = CONNECTORS.filter(c => c.role !== 'apron').map(c => {
    const a = P('G', c.ground.px), b = P('U', c.upper.px)
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1
    const ux = (b[0] - a[0]) / len, uy = (b[1] - a[1]) / len
    const title = c.type === 'escalator' ? tx.esc : c.type === 'lift' ? tx.lift : tx.stairs
    const s = (c.role === 'core' ? 9 : 6) * u
    const arrows = c.oneWay ? [0.3, 0.55, 0.8].map(f => [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f] as Pt) : []
    return <g key={c.id} className={`t2-link l-${c.type} r-${c.role}`} data-link={c.id} data-testid={`link-${c.id}`}>
      <title>{title}</title>
      <line className="hit" x1={fmt(a[0])} y1={fmt(a[1])} x2={fmt(b[0])} y2={fmt(b[1])} strokeWidth={fmt(14 * u)} />
      <line className="l" x1={fmt(a[0])} y1={fmt(a[1])} x2={fmt(b[0])} y2={fmt(b[1])} />
      {arrows.map((m, k) => <path key={k} className="arrow" d={`M${fmt(m[0] + ux * s)},${fmt(m[1] + uy * s)}L${fmt(m[0] - ux * s - uy * s * 0.8)},${fmt(m[1] - uy * s + ux * s * 0.8)}L${fmt(m[0] - ux * s + uy * s * 0.8)},${fmt(m[1] - uy * s - ux * s * 0.8)}Z`} />)}
    </g>
  })

  /* ---------- Labels: fixed pixel size, placed without overlaps ---------- */
  const items: (LabelItem & { z: MapZone; lines: [string | null, string | null]; a: Priority | null; gate: string | null })[] = []
  if (show.labels) for (const { key: pk } of PLATES) for (const z of PLATE_ZONES[pk]) {
    const v = views[z.id]
    const a = alertOf(v)
    const label = zoneLabel(z, lang)
    const nums = [v?.waitMin != null ? `${Math.round(v.waitMin)} min` : null, v?.people != null ? `${v.people} ${tx.people}` : null].filter(Boolean).join(' · ') || null
    const gate = label.kind === 'gate' ? label.number : null
    const small = !!gate && z.id.startsWith('G_GATE_DOOR')
    // Apron doors under the gates: their stairs marker already says where they are.
    if (small && !a && !nums) continue
    if (!gate && !label.text && !nums && !a) continue
    if (z.kind === 'wc' && !a && !nums) continue
    const name = gate ? null : label.text || null
    const chipW = a ? NAME * 0.72 + 3 + textWidth(String(a), NAME) + 6 : 0
    const nameW = name ? textWidth(name, NAME) + chipW : 0
    const numW = nums ? textWidth(nums, NUM) : 0
    const gw = gate ? (gate.length > 1 ? 1.35 : 1) * GATE + (a ? chipW : 0) : 0
    const w = (Math.max(nameW, numW, gw) + 8) * u
    const h = ((gate ? GATE + 2 : name ? NAME * 1.25 : 0) + (nums ? NUM * 1.25 : 0) + 4) * u
    const [cx, cy] = P(z.level, toPx(z.centre[0], z.centre[1]))
    const priority = (selected === z.id ? 5000 : 0) + (a ? 4000 - a * 300 : 0) + (nums ? 600 : 0) + (gate && !small ? 500 : 0) + Math.min(400, z.area_m2 / 3) - (z.level === 'X' ? 300 : 0)
    items.push({ id: z.id, x: cx, y: cy, w, h, priority, force: !!a || selected === z.id, z, lines: [name, nums], a, gate })
  }
  const placed = placeLabels(items, 3 * u)
  const byId = new Map(items.map(it => [it.id, it]))
  const labelEls = placed.map(pl => {
    const it = byId.get(pl.id)!
    const [name, nums] = it.lines
    const s = u
    const cls = `t2-label${it.a ? ` a-${it.a}` : ''}${it.z.level === 'X' ? ' ext' : ''}${selected === it.id ? ' sel' : ''}`
    const top = pl.y - pl.h / 2 + 2 * s
    /** Priority mark: drawn shape (■ ▲ ●) plus the number; `x` is its left edge, `y` the text baseline. */
    const chipWidth = (size: number) => it.a ? size * 0.72 + 3 * s + textWidth(String(it.a), size) : 0
    const chip = (left: number, y: number, size: number) => {
      if (!it.a) return null
      const k = size * 0.72, cy = y - size * 0.36
      const shape = it.a === 1 ? <rect x={fmt(left)} y={fmt(cy - k / 2)} width={fmt(k)} height={fmt(k)} />
        : it.a === 2 ? <path d={`M${fmt(left + k / 2)},${fmt(cy - k * 0.6)}L${fmt(left + k * 1.05)},${fmt(cy + k * 0.45)}L${fmt(left - k * 0.05)},${fmt(cy + k * 0.45)}Z`} />
          : <circle cx={fmt(left + k / 2)} cy={fmt(cy)} r={fmt(k / 2)} />
      return <g className="chip">{shape}<text x={fmt(left + k + 3 * s)} y={fmt(y)} fontSize={fmt(size)}>{it.a}</text></g>
    }
    const chipW = it.a ? chipWidth(NAME * s) + 6 * s : 0
    if (it.gate) {
      const small = it.z.id.startsWith('G_GATE_DOOR')
      const gs = (small ? 18 : GATE) * s, gw = (it.gate.length > 1 ? 1.35 : 1) * gs
      const left = pl.x - (gw + chipW) / 2
      return <g key={pl.id} className={`${cls} gate${small ? ' small' : ''}`} pointerEvents="none">
        <rect x={fmt(left)} y={fmt(top)} width={fmt(gw)} height={fmt(gs)} rx={fmt(2 * s)} className="badge" />
        <text x={fmt(left + gw / 2)} y={fmt(top + gs * 0.72)} fontSize={fmt(gs * 0.66)} className="num">{it.gate}</text>
        {chip(left + gw + 6 * s, top + gs * 0.72, NAME * s)}
        {nums && <text x={fmt(pl.x)} y={fmt(top + gs + NUM * 1.1 * s)} fontSize={fmt(NUM * s)} className="nums">{nums}</text>}
      </g>
    }
    const nameY = top + NAME * s
    return <g key={pl.id} className={`${cls} text`} pointerEvents="none">
      {name && <>
        {chip(pl.x - (textWidth(name, NAME * s) + chipW) / 2, nameY, NAME * s)}
        <text x={fmt(pl.x + chipW / 2)} y={fmt(nameY)} fontSize={fmt(NAME * s)} className="name">{name}</text>
      </>}
      {nums && <text x={fmt(pl.x)} y={fmt((name ? nameY : top) + NUM * 1.2 * s)} fontSize={fmt(NUM * s)} className="nums">{nums}</text>}
    </g>
  })

  const iconEls = show.points ? POINTS.filter(p => ICONS.has(p.type)).map(p => <PointIcon key={p.id} p={p} at={P(p.level, p.px)} s={16 * u} />) : []

  const dotR = fmt(3.2 * u)
  const circle = (d: MapDot, k: number) => {
    const [x, y] = P(d.level, toPx(d.x, d.z))
    return <circle key={k} className={d.kind === 'staff' ? 'staff' : undefined} r={dotR} style={{ transform: `translate(${fmt(x)}px, ${fmt(y)}px)` }} />
  }
  const own = dots.filter(d => d.level === level)
  const other = dots.filter(d => d.level !== level)

  const routeD = route && route.length > 1 ? `M${route.map(p => P(level, fromLevel(p, level)).map(fmt).join(',')).join('L')}` : null
  const end = route && route.length ? P(level, fromLevel(route[route.length - 1]!, level)) : null

  /* Floor names on the left of each band, with a 1 px line between the floors. */
  const floorEls = PLATES.map(({ key: pk, i }) => {
    const on = i === activeIdx && level !== 'X'
    const name = levelNames[pk][lang]
    const s = u
    const clickable = !!onLevel && !on
    const x = Math.max(view[0], full[0]) + 24 * s
    const y = pk === 'U' ? Math.max(view[1], full[1]) + 24 * s : DIVIDER + 16 * s
    return <g key={pk} className={`t2-floor${on ? ' on' : ''}${clickable ? ' click' : ''}`} data-testid={`map-floor-${pk}`}
      onClick={clickable ? () => onLevel!(pk) : undefined} role={clickable ? 'button' : undefined} aria-label={clickable ? name : undefined}>
      <rect x={fmt(x)} y={fmt(y)} width={fmt(30 * s)} height={fmt(30 * s)} rx={fmt(2 * s)} className="tag" />
      <text x={fmt(x + 15 * s)} y={fmt(y + 21.5 * s)} fontSize={fmt(19 * s)} className="tag-t">{pk === 'U' ? '1' : 'P'}</text>
      <text x={fmt(x + 40 * s)} y={fmt(y + 21 * s)} fontSize={fmt(17 * s)} className="name">{name}</text>
    </g>
  })

  return <div className={`t2-wrap ${className ?? ''}`}>
    <svg ref={svgRef} className={`t2map interior${zoomed ? ' zoomed' : ''}`} viewBox={view.map(fmt).join(' ')}
      role="group" aria-label={`${frames.G.title} · ${frames.U.title}`} data-testid={`t2-map-${level}`}
      onPointerDown={e => { if (!zoomed || e.button !== 0) return; cancelAnimationFrame(anim.current); setHover(null); drag.current = { x: e.clientX, y: e.clientY, v: view, moved: false }; dragged.current = false }}
      onPointerMove={e => {
        const d = drag.current
        if (!d) return
        const r = svgRef.current!.getBoundingClientRect()
        const dx = e.clientX - d.x, dy = e.clientY - d.y
        if (!d.moved && Math.hypot(dx, dy) < 4) return
        if (!d.moved) { d.moved = true; dragged.current = true; (e.currentTarget as SVGSVGElement).setPointerCapture(e.pointerId) }
        setView(clampBox([d.v[0] - (dx / r.width) * d.v[2], d.v[1] - (dy / r.height) * d.v[3], d.v[2], d.v[3]], full))
      }}
      onPointerUp={() => { drag.current = null; setTimeout(() => { dragged.current = false }, 0) }}
      onDoubleClick={e => { const [x, y] = toSvg(e.clientX, e.clientY); zoomBy(view[2] < full[2] / 3 ? 2 : 0.5, x, y) }}>
      <defs>
        <pattern id="t2-steps" width={0.32 * M} height={10} patternUnits="userSpaceOnUse"><line x1={0} y1={0} x2={0} y2={10} className="p-step" /></pattern>
        <pattern id="t2-seats" width={0.6 * M} height={0.55 * M} patternUnits="userSpaceOnUse"><rect x={0.04 * M} y={0.04 * M} width={0.52 * M} height={0.47 * M} className="p-seat" /></pattern>
        <pattern id="t2-stalls" width={2.5 * M} height={5 * M} patternUnits="userSpaceOnUse"><path d={`M0,0V${5 * M}M0,0H${2.5 * M}`} className="p-stall" /></pattern>
        <pattern id="t2-closed" width={1.2 * M} height={1.2 * M} patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1={0} y1={0} x2={0} y2={1.2 * M} className="p-closed" /></pattern>
        <filter id="t2-blur" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation={1.6 * M} /></filter>
        {PLATES.flatMap(({ key: pk }) => PLATE_ZONES[pk]).map(z => <clipPath key={z.id} id={`t2c-${z.id}`}><path d={geoOf(z).d} clipRule="evenodd" /></clipPath>)}
      </defs>
      <rect x={fmt(full[0] - full[2])} y={fmt(full[1] - full[3])} width={fmt(full[2] * 3)} height={fmt(full[3] * 3)} className="t2-ground" />
      <line className="t2-divider" x1={fmt(full[0] - full[2])} x2={fmt(full[0] + full[2] * 2)} y1={fmt(DIVIDER)} y2={fmt(DIVIDER)} />
      {plateEls}
      <g className="t2-links" data-testid="map-links">{linkEls}</g>
      <g className="t2-ends" aria-hidden="true">{iconEls}</g>
      {routeD && <g className="t2-route" aria-label="Traseu">
        <path d={routeD} className="halo" strokeWidth={fmt(10 * u)} />
        <path d={routeD} className="line" strokeWidth={fmt(4 * u)} strokeDasharray={`${fmt(2 * u)} ${fmt(10 * u)}`} />
        {end && <circle cx={fmt(end[0])} cy={fmt(end[1])} r={fmt(7 * u)} className="end" />}
      </g>}
      {show.dots && other.length > 0 && <g className="t2-dots-other" aria-hidden="true">{other.map(circle)}</g>}
      {show.dots && <g className="t2-dots" aria-hidden="true" data-testid="map-dots">{own.map(circle)}</g>}
      {show.labels && <g className="t2-labels">{labelEls}</g>}
      <g className="t2-floors">{floorEls}</g>
      {show.pins && <g className="t2-pins">
        {markers.map(mk => {
          const [x, y] = P(level, fromLevel(mk.at, level))
          return <g key={mk.id} className="t2-pin" transform={`translate(${fmt(x)} ${fmt(y)}) scale(${fmt(1.3 * u)})`} data-testid="report-pin" role="img" aria-label={`Raport: ${mk.label}`}>
            <title>{mk.label}</title>
            <path d="M0 0 L-7 -13 A8 8 0 1 1 7 -13 Z" /><text y={-13} fontSize={11}>!</text>
          </g>
        })}
      </g>}
      {!zoomed && <>
        <g className="t2-north" transform={`translate(${fmt(view[0] + 25 * M + 90 * u)} ${fmt(view[1] + view[3] - 34 * u)})`} aria-hidden="true">
          <path d={`M0,${fmt(-16 * u)}L${fmt(8 * u)},${fmt(8 * u)}L0,${fmt(3 * u)}L${fmt(-8 * u)},${fmt(8 * u)}Z`} />
          <text x={fmt(16 * u)} y={fmt(6 * u)} fontSize={fmt(14 * u)}>N</text>
        </g>
        <g className="t2-scale" transform={`translate(${fmt(view[0] + 24 * u)} ${fmt(view[1] + view[3] - 24 * u)})`} aria-hidden="true">
          <path d={`M0,0H${25 * M}M0,${fmt(-5 * u)}V${fmt(5 * u)}M${25 * M},${fmt(-5 * u)}V${fmt(5 * u)}`} />
          <text x={fmt(25 * M + 8 * u)} y={fmt(5 * u)} fontSize={fmt(14 * u)}>25 m</text>
        </g></>}
    </svg>
    {describe && hover && (() => {
      const card = describe(hover.id)
      if (!card) return null
      return <div className={`t2-card${hover.x > hover.w - 260 ? ' left' : ''}${hover.y > hover.h - 160 ? ' up' : ''}`} style={{ left: hover.x, top: hover.y }} role="tooltip" data-testid="map-card">{card}</div>
    })()}
    <div className="t2-zoom" role="group" aria-label="Zoom">
      <button type="button" onClick={() => zoomBy(0.66)} aria-label="Mărește">+</button>
      <button type="button" onClick={() => zoomBy(1.5)} aria-label="Micșorează" disabled={!zoomed}>−</button>
      <button type="button" onClick={() => flyTo(full)} aria-label="Toată harta" disabled={!zoomed}>⤢</button>
    </div>
  </div>
}

/** Legend (D29): grey density ramp, priorities with shape and number, connectors, exterior edge. */
export function MapLegend({ lang = 'ro' }: { lang?: 'ro' | 'en' }) {
  const ro = lang === 'ro'
  return <ul className="t2-legend">
    <li><span className="ramp">{[0, 1, 2, 3, 4].map(s => <i key={s} className={`sw dn-${s}`} />)}</span>{ro ? 'Densitate, 0 → peste 2 pers./m²' : 'Density, 0 → over 2 ppl/m²'}</li>
    <li><i className="pr a-1">{SHAPE[1]}1</i>{ro ? 'Pericol' : 'Danger'}</li>
    <li><i className="pr a-2">{SHAPE[2]}2</i>{ro ? 'Peste țintă' : 'Over target'}</li>
    <li><i className="pr a-3">{SHAPE[3]}3</i>{ro ? 'Aproape de țintă' : 'Near target'}</li>
    <li><i className="ln up" />{ro ? 'Spre etaj: scări, escalator, lift' : 'To upper floor: stairs, escalator, lift'}</li>
    <li><i className="sw ext" />{ro ? 'Exterior' : 'Outside'}</li>
  </ul>
}
