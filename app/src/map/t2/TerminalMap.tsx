import { useEffect, useRef, useState, type ReactNode } from 'react'
import { frames, points, worldToPx, zones, type Level, type MapPoint, type MapZone, type Pt } from './data'
import { fmt, frameOf, inRing, ringPath } from './geometry'
import { zoneDetail } from './details'
import { placeName, zoneLabel } from './labels'
import './t2map.css'

/**
 * Detailed T2 map for one level, drawn from Marius's zones.json / points.json.
 * Under it, the Unity top-down render (public/map/base_<floor>.jpg) when `base` is on.
 * Zones without data stay neutral; never invent numbers here.
 */
export type ZoneState = 'normal' | 'near' | 'full'
export interface ZoneView { state?: ZoneState | null; people?: number | null; waitMin?: number | null; closed?: boolean }
export interface MapDot { x: number; z: number; level: Level }

interface Props {
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
  /** data-testid prefix for zones (`t2-zone-` by default). */
  testIdPrefix?: string
}

/** Content box of a floor (zones + points), padded, so the drawing fills the panel instead of the Unity frame. */
const boundsCache = new Map<Level, [number, number, number, number]>()
function contentBox(level: Level): [number, number, number, number] {
  const hit = boundsCache.get(level)
  if (hit) return hit
  const fr = frames[level]
  const xs: number[] = [], ys: number[] = []
  for (const z of zones) if (z.level === level) for (const r of z.polygons_px) for (const [x, y] of r.outer) { xs.push(x); ys.push(y) }
  const pad = fr.width * 0.025
  let x0 = Math.max(0, Math.min(...xs) - pad), x1 = Math.min(fr.width, Math.max(...xs) + pad)
  const y0 = Math.max(0, Math.min(...ys) - pad), y1 = Math.min(fr.height, Math.max(...ys) + pad)
  // Never narrower than 2.2:1 so the floor tabs keep a steady height.
  const minW = (y1 - y0) * 2.2
  if (x1 - x0 < minW) { const c = (x0 + x1) / 2; x0 = Math.max(0, c - minW / 2); x1 = Math.min(fr.width, x0 + minW) }
  const box: [number, number, number, number] = [x0, y0, x1 - x0, y1 - y0]
  boundsCache.set(level, box)
  return box
}

/** T2 ground floor drawn into the exterior frame, so the outside map shows the building it surrounds. */
type WorldRing = { outer: [number, number][] }
const terminalFootprint = zones.filter(z => z.level === 'G' && !z.id.startsWith('G_GATE_DOOR'))
  .flatMap(z => ((z as unknown as { polygons_world: WorldRing[] }).polygons_world ?? []).map(r =>
    `M${r.outer.map(([x, y]) => worldToPx(x, y, 'X').map(fmt).join(',')).join('L')}Z`))
const footLabel = (() => {
  const c = zones.find(z => z.id === 'G_CENTER')!.centre
  return worldToPx(c[0], c[1] + 4, 'X').map(fmt) as [number, number]
})()

const pointsIn = (z: MapZone) => points.filter(p => p.level === z.level && z.polygons_px.some(r => inRing(p.px, r)))
const detailCache = new Map<string, { frame: ReturnType<typeof frameOf>; pts: MapPoint[] }>()
function zoneGeo(z: MapZone) {
  let g = detailCache.get(z.id)
  if (!g) { g = { frame: frameOf(z.polygons_px[0]!.outer), pts: pointsIn(z) }; detailCache.set(z.id, g) }
  return g
}

function PointIcon({ p, s, cameras }: { p: MapPoint; s: number; cameras: boolean }) {
  const [x, y] = p.px
  const t = `translate(${fmt(x)} ${fmt(y)})`
  const label = p.name.split(' / ')[0]
  switch (p.type) {
    case 'door': return <g transform={t} className="i-door"><title>{label}</title>
      <rect x={-s * 0.5} y={-s * 0.5} width={s} height={s} rx={s * 0.18} />
      <path d={`M${-s * 0.22},${s * 0.3}V${-s * 0.3}H${s * 0.22}V${s * 0.3}M${s * 0.08},0h.01`} /></g>
    case 'emergency_exit': return <g transform={t} className="i-exit"><title>{label}</title>
      <rect x={-s * 0.6} y={-s * 0.45} width={s * 1.2} height={s * 0.9} rx={s * 0.15} />
      <path d={`M${-s * 0.32},0H${s * 0.3}M${s * 0.08},${-s * 0.22}L${s * 0.3},0L${s * 0.08},${s * 0.22}`} /></g>
    case 'stairs': return <g transform={t} className="i-vert"><title>Scări</title><circle r={s * 0.55} />
      <path d={`M${-s * 0.3},${s * 0.25}h${s * 0.2}v${-s * 0.18}h${s * 0.2}v${-s * 0.18}h${s * 0.2}`} /></g>
    case 'escalator': return <g transform={t} className="i-vert"><title>Escalator</title><circle r={s * 0.55} />
      <path d={`M${-s * 0.28},${s * 0.24}L${s * 0.24},${-s * 0.24}M${s * 0.02},${-s * 0.26}h${s * 0.24}v${s * 0.24}`} /></g>
    case 'lift': return <g transform={t} className="i-vert"><title>Lift</title><circle r={s * 0.55} />
      <path className="fill" d={`M0,${-s * 0.32}l${s * 0.18},${s * 0.22}h${-s * 0.36}ZM0,${s * 0.32}l${s * 0.18},${-s * 0.22}h${-s * 0.36}Z`} /></g>
    case 'information': return <g transform={t} className="i-info"><title>Informații</title><circle r={s * 0.6} />
      <text y={s * 0.24} fontSize={s * 0.75}>i</text></g>
    case 'vending': return null
    case 'atm': case 'wc': return <g transform={t} className="i-tag"><title>{p.type === 'atm' ? `ATM ${p.name}` : p.type === 'wc' ? 'Toalete' : 'Automat'}</title>
      <rect x={-s * 0.6} y={-s * 0.38} width={s * 1.2} height={s * 0.76} rx={s * 0.15} />
      <text y={s * 0.17} fontSize={s * 0.42}>{p.type === 'atm' ? 'ATM' : p.type === 'wc' ? 'WC' : '▪'}</text></g>
    case 'shop': case 'cafe': case 'office': if (p.type === 'cafe' || !/^[A-ZĂÂÎȘȚ]/.test(label ?? '') || p.level !== 'G') return <g transform={t} className="i-pill"><title>{p.name}</title><circle r={s * 0.22} /></g>
      return <g transform={t} className="i-pill"><title>{p.name}</title>
      <circle r={s * 0.22} /><text x={s * 0.4} y={s * 0.15} fontSize={s * 0.45}>{label}</text></g>
    case 'self_checkin': return <g transform={t} className="i-kiosk"><title>Self check-in</title>
      <rect x={-s * 0.22} y={-s * 0.3} width={s * 0.44} height={s * 0.6} rx={s * 0.08} /></g>
    case 'flight_screen': return null
    case 'flight_screen_unused': return <g transform={t} className="i-fids"><title>Ecran zboruri</title>
      <rect x={-s * 0.35} y={-s * 0.1} width={s * 0.7} height={s * 0.2} rx={s * 0.05} /></g>
    case 'passport_booth': return <g transform={t} className="i-booth"><title>Control pașapoarte</title>
      <rect x={-s * 0.5} y={-s * 0.35} width={s} height={s * 0.7} rx={s * 0.1} /></g>
    case 'camera': {
      if (!cameras) return null
      const yaw = ((p.yaw ?? 0) * Math.PI) / 180, half = (((p.hfov ?? 60) / 2) * Math.PI) / 180, r = s * 2.6
      const a = [Math.sin(yaw - half) * r, -Math.cos(yaw - half) * r], b = [Math.sin(yaw + half) * r, -Math.cos(yaw + half) * r]
      return <g transform={t} className="i-cam"><title>{`Cameră: ${p.name}`}</title>
        <path className="cone" d={`M0,0L${fmt(a[0]!)},${fmt(a[1]!)}A${fmt(r)},${fmt(r)} 0 0 1 ${fmt(b[0]!)},${fmt(b[1]!)}Z`} />
        <circle r={s * 0.2} /></g>
    }
    default: return null
  }
}

export function TerminalMap({ level, views = {}, selected = null, highlight = [], onZone, dots = [], route, cameras = false, base = false, lang = 'ro', className, markers = [], testIdPrefix = 't2-zone-' }: Props) {
  const fr = frames[level]
  const m = fr.ppm
  const fs = contentBox(level)[2] / 95
  const icon = Math.max(contentBox(level)[2] / 120, 1.6 * m)
  const here = zones.filter(z => z.level === level)
  const interior = level !== 'X'
  const lit = new Set(highlight)
  type Box = [number, number, number, number]
  const full: Box = contentBox(level)
  // The view belongs to one floor; switching floors shows the whole new floor.
  const [zoom, setZoom] = useState<{ level: Level; v: Box }>({ level, v: full })
  const view = zoom.level === level ? zoom.v : full
  const setView = (next: Box | ((v: Box) => Box)) => setZoom(z => {
    const cur = z.level === level ? z.v : full
    return { level, v: typeof next === 'function' ? next(cur) : next }
  })
  const svgRef = useRef<SVGSVGElement>(null)
  const drag = useRef<{ x: number; y: number; v: [number, number, number, number]; moved: boolean } | null>(null)
  const dragged = useRef(false)
  const click = (id: string) => { if (!dragged.current) onZone?.(id) }
  const zoomBy = (k: number, cx?: number, cy?: number) => setView(([x, y, w, h]) => {
    const nw = Math.min(full[2], Math.max(full[2] / 8, w * k)), nh = nw * (full[3] / full[2])
    const px = cx ?? x + w / 2, py = cy ?? y + h / 2
    const nx = px - ((px - x) * nw) / w, ny = py - ((py - y) * nh) / h
    return [Math.min(Math.max(nx, full[0]), full[0] + full[2] - nw), Math.min(Math.max(ny, full[1]), full[1] + full[3] - nh), nw, nh]
  })
  const toSvg = (clientX: number, clientY: number): Pt => {
    const r = svgRef.current!.getBoundingClientRect()
    return [view[0] + ((clientX - r.left) / r.width) * view[2], view[1] + ((clientY - r.top) / r.height) * view[3]]
  }
  // Pinch / ctrl+wheel zooms; a plain wheel keeps scrolling the page.
  useEffect(() => {
    const el = svgRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      const r = el.getBoundingClientRect()
      setZoom(z => {
        const b = contentBox(level)
        const v: Box = z.level === level ? z.v : b
        const cx = v[0] + ((e.clientX - r.left) / r.width) * v[2], cy = v[1] + ((e.clientY - r.top) / r.height) * v[3]
        const k = Math.exp(e.deltaY * 0.01)
        const nw = Math.min(b[2], Math.max(b[2] / 8, v[2] * k)), nh = nw * (b[3] / b[2])
        const nx = cx - ((cx - v[0]) * nw) / v[2], ny = cy - ((cy - v[1]) * nh) / v[3]
        return { level, v: [Math.min(Math.max(nx, b[0]), b[0] + b[2] - nw), Math.min(Math.max(ny, b[1]), b[1] + b[3] - nh), nw, nh] }
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [level, fr.width, fr.height])
  const zoomed = view[2] < full[2] - 1

  const zoneEls: ReactNode[] = []
  const labels: ReactNode[] = []
  for (const z of here) {
    const v = views[z.id]
    const state = v?.state ?? null
    const { frame: f, pts } = zoneGeo(z)
    const d = z.polygons_px.map(ringPath).join('')
    const cls = ['t2-zone', `k-${z.kind}`, state ? `s-${state}` : 's-none', z.approx ? 'approx' : '', selected === z.id ? 'sel' : '', lit.has(z.id) ? 'lit' : '', v?.closed ? 'closed' : '', onZone ? 'click' : ''].filter(Boolean).join(' ')
    zoneEls.push(<g key={z.id} className={cls} data-zone={z.id} data-testid={`${testIdPrefix}${z.id}`} aria-pressed={onZone ? selected === z.id : undefined}
      role={onZone ? 'button' : undefined} tabIndex={onZone ? 0 : undefined} aria-label={placeName(z, lang)}
      onClick={onZone ? () => click(z.id) : undefined}
      onKeyDown={onZone ? e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); click(z.id) } } : undefined}>
      <title>{`${placeName(z, lang)}${z.approx ? (lang === 'en' ? ' (approximate)' : ' (aproximativ)') : ''}`}</title>
      <path className="fill" d={d} fillRule="evenodd" />
      <g clipPath={`url(#t2c-${z.id})`} className="detail">
        <g transform={`translate(${fmt(f.cx)} ${fmt(f.cy)}) rotate(${fmt(f.angle)})`}>{zoneDetail({ zone: z, f, m, pts, base })}</g>
      </g>
      <path className="edge" d={d} fillRule="evenodd" />
      {v?.closed && <path className="cross" d={d} fillRule="evenodd" />}
    </g>)

    const [lx, ly] = worldToPx(z.centre[0], z.centre[1], level)
    const label = zoneLabel(z, lang)
    const count = v?.people != null ? `${v.people} pers.` : null
    const wait = v?.waitMin != null ? `${Math.round(v.waitMin)} min` : null
    const nums = [count, wait].filter(Boolean).join(' · ')
    const sc = state ? `s-${state}` : 's-none'
    if (label.kind === 'gate') {
      const r = fs * (label.small ? 0.55 : 0.85)
      labels.push(<g key={z.id} className={`t2-label gate ${sc}${label.small ? ' small' : ''}`} transform={`translate(${fmt(lx)} ${fmt(ly)})`} pointerEvents="none">
        <rect x={-r * (label.number.length > 1 ? 1.35 : 1)} y={-r} width={r * (label.number.length > 1 ? 2.7 : 2)} height={r * 2} rx={r * 0.45} className="badge" />
        <text y={r * 0.36} fontSize={r * 1.05} className="num">{label.number}</text>
        {nums && <text y={r + fs * 0.75} fontSize={fs * 0.55} className="nums">{nums}</text>}
      </g>)
    } else if (label.text && z.kind !== 'wc') {
      const small = z.area_m2 < (level === 'X' ? 140 : 60)
      const size = fs * (small ? 0.5 : z.area_m2 > 450 ? 0.78 : 0.64)
      labels.push(<g key={z.id} className={`t2-label text ${sc}`} transform={`translate(${fmt(lx)} ${fmt(ly)})`} pointerEvents="none">
        <text y={size * 0.35} fontSize={size} className="name">{label.text}</text>
        {nums && <text y={size * 0.35 + fs * 0.62} fontSize={fs * 0.5} className="nums">{nums}</text>}
      </g>)
    }
  }

  const routeD = route && route.length > 1 ? `M${route.map(p => `${fmt(p[0])},${fmt(p[1])}`).join('L')}` : null
  const end = route?.[route.length - 1]

  return <div className={`t2-wrap ${className ?? ''}`}>
  <svg ref={svgRef} className={`t2map ${interior ? 'interior' : 'exterior'}${zoomed ? ' zoomed' : ''}`} viewBox={view.map(fmt).join(' ')}
    role="group" aria-label={fr.title} data-testid={`t2-map-${level}`}
    onPointerDown={e => { if (!zoomed || e.button !== 0) return; drag.current = { x: e.clientX, y: e.clientY, v: view, moved: false }; dragged.current = false }}
    onPointerMove={e => {
      const d = drag.current
      if (!d) return
      const r = svgRef.current!.getBoundingClientRect()
      const dx = e.clientX - d.x, dy = e.clientY - d.y
      if (!d.moved && Math.hypot(dx, dy) < 4) return
      if (!d.moved) { d.moved = true; dragged.current = true; (e.currentTarget as SVGSVGElement).setPointerCapture(e.pointerId) }
      const nx = d.v[0] - (dx / r.width) * d.v[2], ny = d.v[1] - (dy / r.height) * d.v[3]
      setView([Math.min(Math.max(nx, full[0]), full[0] + full[2] - d.v[2]), Math.min(Math.max(ny, full[1]), full[1] + full[3] - d.v[3]), d.v[2], d.v[3]])
    }}
    onPointerUp={() => { drag.current = null; setTimeout(() => { dragged.current = false }, 0) }}
    onDoubleClick={e => { const [x, y] = toSvg(e.clientX, e.clientY); zoomBy(zoomed ? 1 / 0.5 : 0.5, x, y) }}>
    <defs>
      <pattern id={`t2-tiles-${m}`} width={1.2 * m} height={1.2 * m} patternUnits="userSpaceOnUse">
        <path d={`M${1.2 * m},0V${1.2 * m}H0`} className="p-tile" />
      </pattern>
      <pattern id={`t2-steps-${m}`} width={0.32 * m} height={10} patternUnits="userSpaceOnUse">
        <line x1={0} y1={0} x2={0} y2={10} className="p-step" />
      </pattern>
      <pattern id={`t2-seats-${m}`} width={0.6 * m} height={0.55 * m} patternUnits="userSpaceOnUse">
        <rect x={0.04 * m} y={0.04 * m} width={0.52 * m} height={0.47 * m} rx={0.1 * m} className="p-seat" />
      </pattern>
      <pattern id={`t2-stalls-${m}`} width={2.5 * m} height={5 * m} patternUnits="userSpaceOnUse">
        <path d={`M0,0V${5 * m}M0,0H${2.5 * m}`} className="p-stall" />
      </pattern>
      <pattern id={`t2-hatch-${m}`} width={1.2 * m} height={1.2 * m} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
        <line x1={0} y1={0} x2={0} y2={1.2 * m} className="p-hatch" />
      </pattern>
      {here.map(z => <clipPath key={z.id} id={`t2c-${z.id}`}><path d={z.polygons_px.map(ringPath).join('')} clipRule="evenodd" /></clipPath>)}
    </defs>
    <style>{`.t2map .d-seat{fill:url(#t2-seats-${m})}.t2map .d-steps{fill:url(#t2-steps-${m})}.t2map .d-stalls{fill:url(#t2-stalls-${m})}.t2map.interior .t2-zone .fill{--tile:url(#t2-tiles-${m})}.t2map .t2-zone.approx .detail{--hatch:url(#t2-hatch-${m})}`}</style>
    <rect width={fr.width} height={fr.height} className="t2-ground" />
    {base && <image href={`/map/base_${fr.key}.jpg`} width={fr.width} height={fr.height} className="t2-base" preserveAspectRatio="none" />}
    {interior && <g className="t2-shell" aria-hidden="true">
      {here.map(z => <path key={z.id} d={z.polygons_px.map(ringPath).join('')} fillRule="evenodd" strokeWidth={0.9 * m} />)}
    </g>}
    {level === 'U' && <g className="t2-ghost" aria-hidden="true">
      {/* Outline first, then fill on top: only the outer edge of the ground floor shows. */}
      {zones.filter(z => z.level === 'G').map(z => <path key={`o${z.id}`} className="out" d={z.polygons_px.map(ringPath).join('')} fillRule="evenodd" />)}
      {zones.filter(z => z.level === 'G').map(z => <path key={z.id} className="in" d={z.polygons_px.map(ringPath).join('')} fillRule="evenodd" />)}
    </g>}
    {level === 'X' && <g className="t2-building" aria-hidden="true">
      {terminalFootprint.map((d, i) => <path key={`o${i}`} className="out" d={d} />)}
      {terminalFootprint.map((d, i) => <path key={i} className="in" d={d} />)}
      <text x={footLabel[0]} y={footLabel[1]} fontSize={fs * 0.9}>Terminal T2</text>
    </g>}
    <g className="t2-zones">{zoneEls}</g>
    <g className="t2-points" aria-hidden="true">
      {points.filter(p => p.level === level).map(p => <PointIcon key={p.id} p={p} s={icon} cameras={cameras} />)}
    </g>
    {routeD && <g className="t2-route" aria-label="Traseu">
      <path d={routeD} className="halo" strokeWidth={1.6 * m} />
      <path d={routeD} className="line" strokeWidth={0.7 * m} />
      {end && <circle cx={end[0]} cy={end[1]} r={1.1 * m} className="end" />}
    </g>}
    <g className="t2-dots" aria-hidden="true">
      {dots.filter(d => d.level === level).map((d, i) => { const [x, y] = worldToPx(d.x, d.z, level); return <circle key={i} cx={fmt(x)} cy={fmt(y)} r={fmt(Math.max(0.6 * m, 2.6))} /> })}
    </g>
    <g className="t2-labels">{labels}</g>
    <g className="t2-pins">
      {markers.map(mk => <g key={mk.id} className="t2-pin" transform={`translate(${fmt(mk.at[0])} ${fmt(mk.at[1])}) scale(${fmt(fs / 10)})`} data-testid="report-pin" role="img" aria-label={`Raport: ${mk.label}`}>
        <title>{mk.label}</title>
        <path d="M0 0 L-7 -13 A8 8 0 1 1 7 -13 Z" /><circle cy={-17} r={3} />
      </g>)}
    </g>
    {!zoomed && <><g className="t2-north" transform={`translate(${view[0] + view[2] - fs * 2} ${view[1] + fs * 2.2})`} aria-hidden="true">
      <path d={`M0,${-fs * 1.2}L${fs * 0.55},${fs * 0.5}L0,${fs * 0.15}L${-fs * 0.55},${fs * 0.5}Z`} /><text y={fs * 1.6} fontSize={fs * 0.8}>N</text>
    </g>
    <g className="t2-scale" transform={`translate(${view[0] + fs * 1.2} ${view[1] + view[3] - fs * 1.2})`} aria-hidden="true">
      <path d={`M0,0H${25 * m}M0,${-fs * 0.3}V${fs * 0.3}M${25 * m},${-fs * 0.3}V${fs * 0.3}`} /><text x={25 * m + fs * 0.4} y={fs * 0.3} fontSize={fs * 0.8}>25 m</text>
    </g></>}
  </svg>
  <div className="t2-zoom" role="group" aria-label="Zoom">
    <button type="button" onClick={() => zoomBy(0.66)} aria-label="Mărește">+</button>
    <button type="button" onClick={() => zoomBy(1.5)} aria-label="Micșorează" disabled={!zoomed}>−</button>
    <button type="button" onClick={() => setView(full)} aria-label="Toată harta" disabled={!zoomed}>⤢</button>
  </div>
  </div>
}

/** Legend: zone states plus the icons drawn on the map. */
export function MapLegend({ lang = 'ro' }: { lang?: 'ro' | 'en' }) {
  const ro = lang === 'ro'
  const items: [string, string][] = [
    ['s-normal', 'Normal'], ['s-near', ro ? 'Ocupat' : 'Busy'], ['s-full', ro ? 'Plin' : 'Full'], ['s-none', ro ? 'Fără date' : 'No data'],
    ['approx', ro ? 'Poziție aproximativă' : 'Approximate'],
  ]
  const icons: [string, string][] = [['i-door', ro ? 'Ușă' : 'Door'], ['i-exit', ro ? 'Ieșire urgență' : 'Emergency exit'], ['i-vert', ro ? 'Scări / lift' : 'Stairs / lift'], ['i-info', ro ? 'Informații' : 'Information']]
  return <ul className="t2-legend">
    {items.map(([c, t]) => <li key={c}><i className={`sw ${c}`} />{t}</li>)}
    {icons.map(([c, t]) => <li key={c}><i className={`ic ${c}`} />{t}</li>)}
  </ul>
}
