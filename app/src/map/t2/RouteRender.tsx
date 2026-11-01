import { useEffect, useState, type ReactNode } from 'react'
import type { Level, Pt } from './data'
import { fmt } from './geometry'
import { textWidth } from './layout'
import { MAP_BOX, MAP_DIVIDER, TerminalMap, worldAt } from './TerminalMap'
import { routeBox, type RouteSpec } from './routeSpec'
import { pad, type Box } from './stack'
import './routeRender.css'

/**
 * /harta/ruta: render-only page for the route pictures sent on WhatsApp (scripts/routes/render.ts).
 * The script calls `window.__route(spec)` and screenshots `#route-card` once `body[data-ready]` names the spec.
 */
declare global { interface Window { __route?: (spec: RouteSpec) => void } }

const WIDTH = 1080
const plateOf = (l: Level) => (l === 'U' ? 1 : 0)
const minutes = (sec: number) => Math.max(1, Math.round(sec / 60))
const VIA: Record<string, string> = { escalator: 'cu escalatorul', stairs: 'pe scări', lift: 'cu liftul' }
const viaOf = (id: string) => (['escalator', 'stairs', 'lift'] as const).find(k => id.startsWith(k) || id.includes(`_${k}`))

/** Split the path where it changes floor: one run per plate, never a line between the plates. */
function runs(spec: RouteSpec) {
  const out: { level: Level; pts: Pt[]; ids: string[] }[] = []
  for (const n of spec.path) {
    const last = out[out.length - 1]
    const p = worldAt(n.level, n.x, n.z)
    if (last && plateOf(last.level) === plateOf(n.level)) { last.pts.push(p); last.ids.push(n.id) }
    else out.push({ level: n.level, pts: [p], ids: [n.id] })
  }
  return out
}

/** Flat label box with text, anchored by its bottom centre. */
function Tag({ at, text, u, dark = false, dy = 0, right = false, avoid = [] }: { at: Pt; text: string; u: number; dark?: boolean; dy?: number; right?: boolean; avoid?: Box[] }) {
  const size = 18 * u, w = textWidth(text, size) + 22 * u, h = size + 16 * u
  // Bottom centre by default; `right`: vertically centred, starting at `at`.
  const x = right ? at[0] : at[0] - w / 2
  let y = (right ? at[1] - h / 2 : at[1] - h) + dy
  // Place step labels below the start marker when their real label boxes intersect.
  for (const [ax, ay, aw, ah] of avoid)
    if (x < ax + aw && x + w > ax && y < ay + ah && y + h > ay) y = ay + ah + 8 * u
  return <g className={`r-tag${dark ? ' dark' : ''}`}>
    <rect x={fmt(x)} y={fmt(y)} width={fmt(w)} height={fmt(h)} rx={fmt(2 * u)} />
    <text x={fmt(x + w / 2)} y={fmt(y + h / 2 + size * 0.35)} fontSize={fmt(size)}>{text}</text>
  </g>
}

function Overlay({ spec, u }: { spec: RouteSpec; u: number }) {
  const parts = runs(spec)
  const els: ReactNode[] = []
  const first = parts[0]!.pts[0]!
  const startWidth = textWidth('Ești aici', 18 * u) + 22 * u
  // One bounding box includes both the origin tag and its circular marker.
  const startBox: Box = [first[0] - startWidth / 2 - 2 * u, first[1] - 54 * u, startWidth + 4 * u, 70 * u]
  parts.forEach((r, k) => {
    const d = `M${r.pts.map(p => p.map(fmt).join(',')).join('L')}`
    els.push(<path key={`h${k}`} className="r-halo" d={d} strokeWidth={fmt(15 * u)} />, <path key={`l${k}`} className="r-line" d={d} strokeWidth={fmt(8 * u)} />)
    // Direction: a white chevron in the middle of each long segment.
    for (let i = 1; i < r.pts.length; i++) {
      const [a, b] = [r.pts[i - 1]!, r.pts[i]!]
      const len = Math.hypot(b[0] - a[0], b[1] - a[1])
      if (len < 70 * u) continue
      const ux = (b[0] - a[0]) / len, uy = (b[1] - a[1]) / len, m: Pt = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], s = 4.5 * u
      els.push(<path key={`c${k}-${i}`} className="r-chev" d={`M${fmt(m[0] - ux * s - uy * s)},${fmt(m[1] - uy * s + ux * s)}L${fmt(m[0] + ux * s)},${fmt(m[1] + uy * s)}L${fmt(m[0] - ux * s + uy * s)},${fmt(m[1] - uy * s - ux * s)}`} strokeWidth={fmt(2.4 * u)} />)
    }
  })
  // Floor changes: a marker where the passenger leaves one floor and where he arrives on the other.
  for (let k = 1; k < parts.length; k++) {
    const leave = parts[k - 1]!, arrive = parts[k]!
    const up = plateOf(arrive.level) > plateOf(leave.level)
    const via = viaOf(leave.ids[leave.ids.length - 1]!) ?? viaOf(arrive.ids[0]!)
    const floor = up ? 'etaj 1' : 'parter'
    for (const [p, text, side] of [[leave.pts[leave.pts.length - 1]!, `${up ? 'Urci' : 'Cobori'} la ${floor}${via ? ` ${VIA[via]}` : ''}`, false], [arrive.pts[0]!, up ? 'Etaj 1' : 'Parter', true]] as const) {
      const s = 13 * u
      els.push(<g key={`f${k}-${text}`} className="r-floor">
        <rect x={fmt(p[0] - s)} y={fmt(p[1] - s)} width={fmt(2 * s)} height={fmt(2 * s)} rx={fmt(2 * u)} />
        <path d={up ? `M${fmt(p[0])},${fmt(p[1] - s * 0.6)}L${fmt(p[0] + s * 0.55)},${fmt(p[1] + s * 0.05)}M${fmt(p[0])},${fmt(p[1] - s * 0.6)}L${fmt(p[0] - s * 0.55)},${fmt(p[1] + s * 0.05)}M${fmt(p[0])},${fmt(p[1] - s * 0.6)}V${fmt(p[1] + s * 0.6)}`
          : `M${fmt(p[0])},${fmt(p[1] + s * 0.6)}L${fmt(p[0] + s * 0.55)},${fmt(p[1] - s * 0.05)}M${fmt(p[0])},${fmt(p[1] + s * 0.6)}L${fmt(p[0] - s * 0.55)},${fmt(p[1] - s * 0.05)}M${fmt(p[0])},${fmt(p[1] + s * 0.6)}V${fmt(p[1] - s * 0.6)}`} strokeWidth={fmt(2.6 * u)} />
        {side ? <Tag at={[p[0] + s + 8 * u, p[1]]} text={text} u={u} right avoid={[startBox]} /> : <Tag at={[p[0], p[1] - s - 6 * u]} text={text} u={u} avoid={[startBox]} />}
      </g>)
    }
  }
  const lastRun = parts[parts.length - 1]!
  const end = lastRun.pts[lastRun.pts.length - 1]!
  els.push(<g key="start" className="r-start">
    <circle cx={fmt(first[0])} cy={fmt(first[1])} r={fmt(13 * u)} className="ring" />
    <circle cx={fmt(first[0])} cy={fmt(first[1])} r={fmt(5 * u)} className="dot" />
    <Tag at={[first[0], first[1] - 18 * u]} text="Ești aici" u={u} dark />
  </g>)
  if (spec.kind === 'evac' && spec.assembly) {
    // Exit door, then the direction to the assembly point outside.
    const a = worldAt('X', spec.assembly.x, spec.assembly.z)
    const len = Math.hypot(a[0] - end[0], a[1] - end[1]) || 1
    const L = 90 * u, ux = (a[0] - end[0]) / len, uy = (a[1] - end[1]) / len
    const tip: Pt = [end[0] + ux * L, end[1] + uy * L], s = 12 * u
    els.push(<g key="exit" className="r-exit">
      <path className="r-out" d={`M${fmt(end[0])},${fmt(end[1])}L${fmt(tip[0] - ux * s)},${fmt(tip[1] - uy * s)}`} strokeWidth={fmt(7 * u)} strokeDasharray={`${fmt(10 * u)} ${fmt(7 * u)}`} />
      <path className="r-head" d={`M${fmt(tip[0])},${fmt(tip[1])}L${fmt(tip[0] - ux * s * 1.6 - uy * s)},${fmt(tip[1] - uy * s * 1.6 + ux * s)}L${fmt(tip[0] - ux * s * 1.6 + uy * s)},${fmt(tip[1] - uy * s * 1.6 - ux * s)}Z`} />
      <rect x={fmt(end[0] - 13 * u)} y={fmt(end[1] - 13 * u)} width={fmt(26 * u)} height={fmt(26 * u)} rx={fmt(2 * u)} className="r-door" />
      <path d={`M${fmt(end[0] - 6 * u)},${fmt(end[1])}H${fmt(end[0] + 6 * u)}M${fmt(end[0] + 1 * u)},${fmt(end[1] - 5 * u)}L${fmt(end[0] + 6 * u)},${fmt(end[1])}L${fmt(end[0] + 1 * u)},${fmt(end[1] + 5 * u)}`} className="r-door-a" strokeWidth={fmt(2.4 * u)} />
      <Tag at={[tip[0] + ux * 14 * u, tip[1] + uy * 14 * u + (uy > 0 ? 50 * u : 0)]} text={spec.assembly.name} u={u} dark />
    </g>)
  } else {
    const pole = 42 * u
    els.push(<g key="end" className="r-end">
      <path d={`M${fmt(end[0])},${fmt(end[1])}V${fmt(end[1] - pole)}`} className="pole" strokeWidth={fmt(3 * u)} />
      <path d={`M${fmt(end[0])},${fmt(end[1] - pole)}h${fmt(26 * u)}l${fmt(-7 * u)},${fmt(9 * u)}l${fmt(7 * u)},${fmt(9 * u)}h${fmt(-26 * u)}Z`} className="flag" />
      <circle cx={fmt(end[0])} cy={fmt(end[1])} r={fmt(5 * u)} className="foot" />
      <Tag at={[end[0], end[1] - pole - 8 * u]} text={spec.to} u={u} dark avoid={[startBox]} />
    </g>)
  }
  return <>{els}</>
}

export default function RouteRender() {
  const [spec, setSpec] = useState<RouteSpec | null>(null)
  useEffect(() => { window.__route = s => setSpec(s) }, [])
  useEffect(() => {
    if (!spec) return
    let live = true
    void document.fonts.ready.then(() => requestAnimationFrame(() => setTimeout(() => { if (live) document.body.dataset.ready = spec.id }, 80)))
    return () => { live = false }
  }, [spec])
  if (!spec) return <div id="route-card" />
  const pts = spec.path.map(n => worldAt(n.level, n.x, n.z))
  if (spec.assembly) {
    const e = pts[pts.length - 1]!, a = worldAt('X', spec.assembly.x, spec.assembly.z), len = Math.hypot(a[0] - e[0], a[1] - e[1]) || 1
    pts.push([e[0] + (a[0] - e[0]) / len * 200, e[1] + (a[1] - e[1]) / len * 200])
  }
  // Room above the map's top edge for the tags of points on the top row (gates).
  const view = routeBox(pts, pad(MAP_BOX, 0, 240, 0, 0))
  const floors = spec.path.some(n => n.level === 'U') && spec.path.some(n => n.level !== 'U')
  const up = spec.path.findIndex(n => n.level === 'U') > spec.path.findIndex(n => n.level !== 'U')
  const lastZone = spec.toZone ?? null
  const evac = spec.kind === 'evac'
  // Floor names for the plates in the crop (the map's own sit at the full map's edges).
  const showsUpper = view[1] < MAP_DIVIDER, showsGround = view[1] + view[3] > MAP_DIVIDER
  const unit = view[2] / WIDTH
  return <div id="route-card" className={`route-card${evac ? ' evac' : ''}`} data-id={spec.id}>
    <header>
      {evac ? <h1><i className="p1" aria-hidden="true" />Evacuare · {spec.from}</h1> : <h1>{spec.from} <span className="arrow">→</span> {spec.to}</h1>}
      <p>{evac
        ? <>{spec.caption ?? spec.to} · <b>≈ {minutes(spec.walkSec)} min</b></>
        : <><b>≈ {minutes(spec.walkSec)} min pe jos</b>{floors ? <> · {up ? 'urci la etaj 1' : 'cobori la parter'}</> : null}</>}</p>
    </header>
    <TerminalMap level={spec.path[spec.path.length - 1]!.level === 'U' ? 'U' : 'G'} view={view} selected={lastZone} highlight={spec.fromZone ? [spec.fromZone] : []}
      layers={{ dots: false, pins: false }} testIdPrefix="r-zone-"
      overlay={() => <>
        <Overlay spec={spec} u={unit} />
        {showsUpper && <FloorName at={[view[0] + 16 * unit, view[1] + 16 * unit]} text="Etaj 1" tag="1" u={unit} />}
        {showsGround && <FloorName at={[view[0] + 16 * unit, Math.max(view[1], MAP_DIVIDER) + 16 * unit]} text="Parter" tag="P" u={unit} />}
      </>} />
  </div>
}

function FloorName({ at, text, tag, u }: { at: Pt; text: string; tag: string; u: number }) {
  const s = 30 * u
  return <g className="r-floorname">
    <rect x={fmt(at[0])} y={fmt(at[1])} width={fmt(s)} height={fmt(s)} rx={fmt(2 * u)} />
    <text x={fmt(at[0] + s / 2)} y={fmt(at[1] + s * 0.72)} fontSize={fmt(19 * u)} className="t">{tag}</text>
    <text x={fmt(at[0] + s + 10 * u)} y={fmt(at[1] + s * 0.7)} fontSize={fmt(18 * u)} className="n">{text}</text>
  </g>
}

