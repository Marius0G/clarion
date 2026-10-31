import { useEffect, useRef, useState, type ReactNode } from 'react'
import { frames, points, worldToPx, zones, type Level, type MapPoint, type MapZone, type Pt } from './data'
import { fmt, frameOf, inRing, ringPath } from './geometry'
import { zoneDetail } from './details'
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
}

const shortName = (z: MapZone, lang: 'ro' | 'en') =>
  (lang === 'en' ? z.name_en : z.name_ro).replace(/\s*\*$/, '').replace(/\s*\(.*\)\s*$/, '')

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
    case 'atm': case 'wc': case 'vending': return <g transform={t} className="i-tag"><title>{p.type === 'atm' ? `ATM ${p.name}` : p.type === 'wc' ? 'Toalete' : 'Automat'}</title>
      <rect x={-s * 0.6} y={-s * 0.38} width={s * 1.2} height={s * 0.76} rx={s * 0.15} />
      <text y={s * 0.17} fontSize={s * 0.42}>{p.type === 'atm' ? 'ATM' : p.type === 'wc' ? 'WC' : '▪'}</text></g>
    case 'shop': case 'cafe': case 'office': if (p.type === 'cafe' || !/^[A-ZĂÂÎȘȚ]/.test(label ?? '') || p.level !== 'G') return <g transform={t} className="i-pill"><title>{p.name}</title><circle r={s * 0.22} /></g>
      return <g transform={t} className="i-pill"><title>{p.name}</title>
      <circle r={s * 0.22} /><text x={s * 0.4} y={s * 0.15} fontSize={s * 0.45}>{label}</text></g>
    case 'self_checkin': return <g transform={t} className="i-kiosk"><title>Self check-in</title>
      <rect x={-s * 0.22} y={-s * 0.3} width={s * 0.44} height={s * 0.6} rx={s * 0.08} /></g>
    case 'flight_screen': return <g transform={t} className="i-fids"><title>Ecran zboruri</title>
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

export function TerminalMap({ level, views = {}, selected = null, highlight = [], onZone, dots = [], route, cameras = false, base = true, lang = 'ro', className }: Props) {
  const fr = frames[level]
  const m = fr.ppm
  const fs = fr.width / 125
  const icon = Math.max(fr.width / 150, 1.6 * m)
  const here = zones.filter(z => z.level === level)
  const interior = level !== 'X'
  const lit = new Set(highlight)
  const [view, setView] = useState<[number, number, number, number]>([0, 0, fr.width, fr.height])
  useEffect(() => setView([0, 0, fr.width, fr.height]), [fr.width, fr.height])
  const svgRef = useRef<SVGSVGElement>(null)
  const drag = useRef<{ x: number; y: number; v: [number, number, number, number]; moved: boolean } | null>(null)
  const dragged = useRef(false)
  const click = (id: string) => { if (!dragged.current) onZone?.(id) }
  const zoomBy = (k: number, cx?: number, cy?: number) => setView(([x, y, w, h]) => {
    const nw = Math.min(fr.width, Math.max(fr.width / 8, w * k)), nh = nw * (fr.height / fr.width)
    const px = cx ?? x + w / 2, py = cy ?? y + h / 2
    const nx = px - ((px - x) * nw) / w, ny = py - ((py - y) * nh) / h
    return [Math.min(Math.max(nx, 0), fr.width - nw), Math.min(Math.max(ny, 0), fr.height - nh), nw, nh]
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
      setView(v => {
        const cx = v[0] + ((e.clientX - r.left) / r.width) * v[2], cy = v[1] + ((e.clientY - r.top) / r.height) * v[3]
        const k = Math.exp(e.deltaY * 0.01)
        const nw = Math.min(fr.width, Math.max(fr.width / 8, v[2] * k)), nh = nw * (fr.height / fr.width)
        const nx = cx - ((cx - v[0]) * nw) / v[2], ny = cy - ((cy - v[1]) * nh) / v[3]
        return [Math.min(Math.max(nx, 0), fr.width - nw), Math.min(Math.max(ny, 0), fr.height - nh), nw, nh]
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [fr.width, fr.height])
  const zoomed = view[2] < fr.width - 1

  const zoneEls: ReactNode[] = []
  const labels: ReactNode[] = []
  for (const z of here) {
    const v = views[z.id]
    const state = v?.state ?? null
    const { frame: f, pts } = zoneGeo(z)
    const d = z.polygons_px.map(ringPath).join('')
    const cls = ['t2-zone', `k-${z.kind}`, state ? `s-${state}` : 's-none', z.approx ? 'approx' : '', selected === z.id ? 'sel' : '', lit.has(z.id) ? 'lit' : '', v?.closed ? 'closed' : '', onZone ? 'click' : ''].filter(Boolean).join(' ')
    zoneEls.push(<g key={z.id} className={cls} data-zone={z.id} data-testid={`t2-zone-${z.id}`}
      role={onZone ? 'button' : undefined} tabIndex={onZone ? 0 : undefined} aria-label={`${z.code} ${shortName(z, lang)}`}
      onClick={onZone ? () => click(z.id) : undefined}
      onKeyDown={onZone ? e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); click(z.id) } } : undefined}>
      <title>{`${z.code} · ${shortName(z, lang)}${z.approx ? (lang === 'en' ? ' (approximate)' : ' (aproximativ)') : ''}`}</title>
      <path className="fill" d={d} fillRule="evenodd" />
      <g clipPath={`url(#t2c-${z.id})`} className="detail">
        <g transform={`translate(${fmt(f.cx)} ${fmt(f.cy)}) rotate(${fmt(f.angle)})`}>{zoneDetail({ zone: z, f, m, pts, base })}</g>
      </g>
      <path className="edge" d={d} fillRule="evenodd" />
      {v?.closed && <path className="cross" d={d} fillRule="evenodd" />}
    </g>)

    const [lx, ly] = worldToPx(z.centre[0], z.centre[1], level)
    const tiny = z.area_m2 < (level === 'X' ? 140 : 60)
    const count = v?.people != null ? `${v.people}` : null
    const wait = v?.waitMin != null ? `${Math.round(v.waitMin)} min` : null
    const name = tiny ? '' : shortName(z, lang)
    const bw = fs * (0.62 * z.code.length + 0.9)
    labels.push(<g key={z.id} className={`t2-label ${state ? `s-${state}` : 's-none'}`} transform={`translate(${fmt(lx)} ${fmt(ly)})`} pointerEvents="none">
      <rect x={-bw / 2} y={-fs * 0.95} width={bw} height={fs * 1.3} rx={fs * 0.3} className="badge" />
      <text y={fs * 0.05} fontSize={fs} className="code">{z.code}</text>
      {name && <text y={fs * 1.25} fontSize={fs * 0.62} className="name">{name}</text>}
      {(count || wait) && <text y={fs * (name ? 2.15 : 1.4)} fontSize={fs * 0.7} className="nums">{[count && `${count} pers.`, wait].filter(Boolean).join(' · ')}</text>}
    </g>)
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
      setView([Math.min(Math.max(nx, 0), fr.width - d.v[2]), Math.min(Math.max(ny, 0), fr.height - d.v[3]), d.v[2], d.v[3]])
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
    {interior && <g className="t2-tiles" aria-hidden="true">
      {here.map(z => <path key={z.id} d={z.polygons_px.map(ringPath).join('')} fillRule="evenodd" fill={`url(#t2-tiles-${m})`} />)}
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
      {dots.filter(d => d.level === level).map((d, i) => { const [x, y] = worldToPx(d.x, d.z, level); return <circle key={i} cx={fmt(x)} cy={fmt(y)} r={fmt(Math.max(0.35 * m, 2.2))} /> })}
    </g>
    <g className="t2-labels">{labels}</g>
    {!zoomed && <><g className="t2-north" transform={`translate(${fr.width - fs * 2} ${fs * 2.2})`} aria-hidden="true">
      <path d={`M0,${-fs * 1.2}L${fs * 0.55},${fs * 0.5}L0,${fs * 0.15}L${-fs * 0.55},${fs * 0.5}Z`} /><text y={fs * 1.6} fontSize={fs * 0.8}>N</text>
    </g>
    <g className="t2-scale" transform={`translate(${fs * 1.2} ${fr.height - fs * 1.2})`} aria-hidden="true">
      <path d={`M0,0H${25 * m}M0,${-fs * 0.3}V${fs * 0.3}M${25 * m},${-fs * 0.3}V${fs * 0.3}`} /><text x={25 * m + fs * 0.4} y={fs * 0.3} fontSize={fs * 0.8}>25 m</text>
    </g></>}
  </svg>
  <div className="t2-zoom" role="group" aria-label="Zoom">
    <button type="button" onClick={() => zoomBy(0.66)} aria-label="Mărește">+</button>
    <button type="button" onClick={() => zoomBy(1.5)} aria-label="Micșorează" disabled={!zoomed}>−</button>
    <button type="button" onClick={() => setView([0, 0, fr.width, fr.height])} aria-label="Toată harta" disabled={!zoomed}>⤢</button>
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
