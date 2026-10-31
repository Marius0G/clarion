import type { ReactNode } from 'react'
import type { MapPoint, MapZone } from './data'
import type { LocalFrame } from './geometry'
import { fmt } from './geometry'

/**
 * Furniture drawn inside each zone, in the zone's local frame (long side on x, metres * m).
 * Everything is clipped to the zone polygon by the caller, so generators may overshoot.
 */
interface Ctx { zone: MapZone; f: LocalFrame; m: number; pts: MapPoint[]; base: boolean }

/** Carousel centres measured on Marius's Unity render (base_parter), pixels; the zone polygons are approximate. */
const CAROUSELS: Record<string, { at: [number, number]; len: number; wid: number }> = {
  G_RECLAIM_1: { at: [1234, 516], len: 13, wid: 5.2 },
  G_RECLAIM_2: { at: [1457, 582], len: 13, wid: 5.2 },
}
const R = (x: number, y: number, w: number, h: number, cls: string, rx = 0, key?: string | number) =>
  <rect key={key} x={fmt(x)} y={fmt(y)} width={fmt(Math.max(w, 0))} height={fmt(Math.max(h, 0))} rx={rx} className={cls} />

/** Back-to-back seat rows filling a box, leaving aisles. */
function seatRows(x0: number, y0: number, w: number, h: number, m: number, key: string) {
  const out: ReactNode[] = []
  const pair = 1.1 * m, pitch = 2.9 * m, block = 9 * m, gap = 1.4 * m
  for (let y = y0 + 0.9 * m, r = 0; y + pair <= y0 + h - 0.6 * m; y += pitch, r++)
    for (let x = x0 + 0.8 * m, b = 0; x < x0 + w - 1.5 * m; x += block + gap, b++) {
      const len = Math.min(block, x0 + w - 0.8 * m - x)
      if (len < 1.5 * m) continue
      out.push(R(x, y, len, pair / 2, 'd-seat', 1, `${key}${r}a${b}`), R(x, y + pair / 2, len, pair / 2, 'd-seat', 1, `${key}${r}b${b}`))
    }
  return out
}

/** Retractable-belt serpentine queue. */
function serpentine({ f, m }: Ctx, entryLeft = true) {
  const out: ReactNode[] = []
  const pad = 0.8 * m, lane = 1.25 * m, turn = 1.5 * m
  const x0 = -f.w / 2 + pad, x1 = f.w / 2 - pad
  const ys: number[] = []
  for (let y = -f.h / 2 + pad + lane; y <= f.h / 2 - pad - 0.2 * m; y += lane) ys.push(y)
  ys.forEach((y, i) => {
    const a = i % 2 === (entryLeft ? 0 : 1) ? x0 + turn : x0, b = i % 2 === (entryLeft ? 0 : 1) ? x1 : x1 - turn
    out.push(<line key={`l${i}`} x1={fmt(a)} y1={fmt(y)} x2={fmt(b)} y2={fmt(y)} className="d-belt" />)
    for (let x = a; x <= b + 1; x += 2.2 * m) out.push(<circle key={`p${i}-${x}`} cx={fmt(x)} cy={fmt(y)} r={fmt(0.14 * m)} className="d-post" />)
  })
  return out
}

function checkInDesks({ f, m, pts }: Ctx) {
  const desks = pts.filter(p => p.type === 'checkin_desk').map(p => ({ p, at: f.toLocal(p.px) }))
  const back = desks.length ? Math.min(...desks.map(d => d.at[1])) : -f.h / 2
  return [
    R(-f.w / 2, -f.h / 2, f.w, Math.max(0.5 * m, back - 0.9 * m + f.h / 2), 'd-wallband', 0, 'band'),
    ...desks.flatMap(({ p, at: [x, y] }) => [
      R(x - 1.25 * m, y - 1.25 * m, 2.5 * m, 0.7 * m, 'd-belt-box', 1.5, `b${p.id}`),
      R(x - 0.85 * m, y - 0.5 * m, 1.7 * m, 0.9 * m, 'd-counter', 2, `c${p.id}`),
      <text key={`t${p.id}`} x={fmt(x)} y={fmt(y + 0.25 * m)} className="d-desk-no" fontSize={fmt(0.62 * m)}>{p.id.replace(/\D+/g, '')}</text>,
    ]),
  ]
}

function securityLanes({ f, m, pts }: Ctx) {
  const lanes = pts.filter(p => p.type === 'security_lane').map(p => f.toLocal(p.px)[0]).sort((a, b) => a - b)
  const xs = lanes.length ? lanes : [-0.3, -0.1, 0.1, 0.3].map(t => t * f.w)
  const y0 = -f.h / 2 + 1 * m, len = f.h - 2 * m
  return xs.flatMap((x, i) => [
    R(x - 1.3 * m, y0, 0.9 * m, len * 0.42, 'd-table', 1, `dv${i}`),
    R(x - 0.35 * m, y0, 0.7 * m, len, 'd-belt-box', 1, `bt${i}`),
    R(x - 0.9 * m, y0 + len * 0.3, 1.8 * m, 2.2 * m, 'd-xray', 2, `xr${i}`),
    <path key={`ar${i}`} d={`M${fmt(x + 0.7 * m)},${fmt(y0 + len * 0.62)}h${fmt(1.4 * m)}M${fmt(x + 0.7 * m)},${fmt(y0 + len * 0.62)}v${fmt(0.9 * m)}M${fmt(x + 2.1 * m)},${fmt(y0 + len * 0.62)}v${fmt(0.9 * m)}`} className="d-arch" />,
    R(x - 1.3 * m, y0 + len * 0.72, 0.9 * m, len * 0.28, 'd-table', 1, `rc${i}`),
    <text key={`n${i}`} x={fmt(x)} y={fmt(y0 - 0.25 * m)} className="d-desk-no" fontSize={fmt(0.7 * m)}>{i + 1}</text>,
  ])
}

function reclaim({ zone, f, m }: Ctx) {
  const known = CAROUSELS[zone.id]
  const [cx, cy] = known ? f.toLocal(known.at) : [0, 0]
  const len = known ? known.len * m : Math.min(f.w * 0.62, 34 * m), wid = known ? known.wid * m : Math.min(5 * m, f.h * 0.35)
  return [
    R(cx - len / 2, cy - wid / 2, len, wid, 'd-carousel', wid / 2, 'c'),
    R(cx - len / 2 + 0.8 * m, cy - wid / 2 + 0.8 * m, len - 1.6 * m, wid - 1.6 * m, 'd-carousel-in', wid / 2 - 0.8 * m, 'ci'),
    R(cx + len / 2 - wid / 2 - 0.6 * m, -f.h / 2, 1.2 * m, cy - wid / 2 + f.h / 2, 'd-belt-box', 0, 'feed'),
    ...Array.from({ length: 6 }, (_, i) => R(f.w / 2 - 2.6 * m, -f.h / 2 + 1.4 * m + i * 1.1 * m, 1.6 * m, 0.8 * m, 'd-trolley', 1.5, `t${i}`)),
  ]
}

function gate({ zone, f, m }: Ctx) {
  const desk = 3.6 * m
  const no = zone.id.replace(/\D+/g, '')
  return [
    R(-f.w / 2 + 0.7 * m, -1.6 * m, 1.2 * m, 3.2 * m, 'd-counter', 2, 'desk'),
    <path key="door" d={`M${fmt(-f.w / 2)},${fmt(-2.2 * m)}v${fmt(4.4 * m)}`} className="d-gate-door" />,
    ...seatRows(-f.w / 2 + desk, -f.h / 2, f.w - desk, f.h, m, 's'),
    <text key="big" x={fmt(desk / 2)} y={fmt(f.h * 0.18)} className="d-watermark" fontSize={fmt(Math.min(f.h * 0.6, 9 * m))}>{no}</text>,
  ]
}

function stairs({ zone, f, m }: Ctx) {
  const escal = zone.id.includes('ESCALATOR')
  const out: ReactNode[] = [R(-f.w / 2, -f.h / 2, f.w, f.h, 'd-steps', 0, 'st'),
    <line key="h1" x1={fmt(-f.w / 2)} y1={fmt(-f.h / 2 + 0.15 * m)} x2={fmt(f.w / 2)} y2={fmt(-f.h / 2 + 0.15 * m)} className="d-rail" />,
    <line key="h2" x1={fmt(-f.w / 2)} y1={fmt(f.h / 2 - 0.15 * m)} x2={fmt(f.w / 2)} y2={fmt(f.h / 2 - 0.15 * m)} className="d-rail" />]
  if (escal && f.h > 3 * m) {
    const band = Math.min(1.4 * m, f.h / 3)
    out.push(R(-f.w / 2, -band / 2, f.w, band, 'd-escalator', 0, 'esc'),
      <path key="arr" d={`M${fmt(-f.w * 0.15)},0h${fmt(f.w * 0.3)}m${fmt(-0.9 * m)},${fmt(-0.5 * m)}l${fmt(0.9 * m)},${fmt(0.5 * m)}l${fmt(-0.9 * m)},${fmt(0.5 * m)}`} className="d-arrow" />)
  }
  return out
}

function shops({ zone, f, m }: Ctx) {
  if (zone.id.includes('CAFE')) {
    const out: ReactNode[] = [R(-f.w / 2, -f.h / 2, f.w, 1.1 * m, 'd-counter', 2, 'bar')]
    let i = 0
    for (let y = -f.h / 2 + 3 * m; y < f.h / 2 - 0.8 * m; y += 2.6 * m)
      for (let x = -f.w / 2 + 1.6 * m; x < f.w / 2 - 0.8 * m; x += 2.6 * m, i++)
        out.push(<g key={i}>
          <circle cx={fmt(x)} cy={fmt(y)} r={fmt(0.45 * m)} className="d-table" />
          {[0, 1, 2, 3].map(k => <circle key={k} cx={fmt(x + Math.cos(k * Math.PI / 2) * 0.8 * m)} cy={fmt(y + Math.sin(k * Math.PI / 2) * 0.8 * m)} r={fmt(0.2 * m)} className="d-chair" />)}
        </g>)
    return out
  }
  const out: ReactNode[] = []
  for (let y = -f.h / 2 + 1.6 * m, i = 0; y < f.h / 2 - 2.4 * m; y += 2.4 * m, i++)
    out.push(R(-f.w / 2 + 1.5 * m, y, f.w - 6 * m, 0.6 * m, 'd-shelf', 1, i))
  out.push(R(f.w / 2 - 3.2 * m, -1 * m, 1.2 * m, 2 * m, 'd-counter', 2, 'till'))
  return out
}

function wc({ f, m }: Ctx) {
  const out: ReactNode[] = []
  const n = Math.max(2, Math.floor(f.w / (1.3 * m)))
  for (let i = 1; i < n; i++) out.push(<line key={i} x1={fmt(-f.w / 2 + i * f.w / n)} y1={fmt(-f.h / 2)} x2={fmt(-f.w / 2 + i * f.w / n)} y2={fmt(-f.h / 2 + f.h * 0.55)} className="d-partition" />)
  return out
}

function waiting({ zone, f, m }: Ctx) {
  if (zone.id === 'X_BUS_221') return [R(-f.w / 2 + 1 * m, -f.h / 2 + 0.5 * m, Math.min(8 * m, f.w * 0.5), 1.6 * m, 'd-shelter', 2, 'sh'),
    R(-f.w / 2 + 1 * m, f.h / 2 - 3.2 * m, Math.min(12 * m, f.w - 2 * m), 2.6 * m, 'd-vehicle', 4, 'bus')]
  return seatRows(-f.w * 0.3, -f.h / 2 + f.h * 0.25, f.w * 0.6, f.h * 0.5, m, 'w')
}

function kerb({ zone, f, m, base }: Ctx) {
  const out: ReactNode[] = [<line key="k" x1={fmt(-f.w / 2)} y1={fmt(-f.h / 2 + 0.3 * m)} x2={fmt(f.w / 2)} y2={fmt(-f.h / 2 + 0.3 * m)} className="d-kerb" />,
    <line key="c" x1={fmt(-f.w / 2)} y1={fmt(f.h * 0.15)} x2={fmt(f.w / 2)} y2={fmt(f.h * 0.15)} className="d-lane" />]
  const cars = zone.id === 'X_KERB_ARRIVALS' || zone.id === 'X_BOLT' || zone.id === 'X_TAXI_RANK'
  if (cars && !base) for (let x = -f.w / 2 + 1.5 * m, i = 0; x < f.w / 2 - 5 * m && i < 8; x += 7 * m, i++)
    out.push(R(x, -f.h / 2 + 1 * m, 4.6 * m, 1.9 * m, zone.id === 'X_TAXI_RANK' ? 'd-taxi' : 'd-vehicle', 4, `v${i}`))
  return out
}

function parking({ f, m, base }: Ctx) {
  const out: ReactNode[] = []
  if (base) return out // the Unity render already shows the real bays and cars
  for (let y = -f.h / 2 + 1 * m, i = 0; y < f.h / 2; y += 16 * m, i++)
    out.push(R(-f.w / 2, y, f.w, 5 * m, 'd-stalls', 0, `a${i}`), R(-f.w / 2, y + 5 * m, f.w, 5 * m, 'd-stalls', 0, `b${i}`),
      <line key={`l${i}`} x1={fmt(-f.w / 2)} y1={fmt(y + 13 * m)} x2={fmt(f.w / 2)} y2={fmt(y + 13 * m)} className="d-lane" />)
  return out
}

function assembly({ f, m }: Ctx) {
  const r = Math.min(f.w, f.h) * 0.28
  return [<circle key="r" cx={0} cy={0} r={fmt(r)} className="d-assembly" />,
    <path key="p" d={`M${fmt(-r * 0.45)},${fmt(r * 0.35)}L0,${fmt(-r * 0.5)}L${fmt(r * 0.45)},${fmt(r * 0.35)}M${fmt(-r * 0.25)},${fmt(r * 0.02)}h${fmt(r * 0.5)}`} className="d-assembly-a" strokeWidth={fmt(0.5 * m)} />]
}

function circulation({ zone, f, m }: Ctx) {
  if (zone.id === 'X_FORECOURT') return [<line key="c" x1={fmt(-f.w / 2)} y1={0} x2={fmt(f.w / 2)} y2={0} className="d-lane" />]
  if (zone.id === 'G_ARRIVALS_EXIT' || zone.id === 'G_ARRIVALS_PASSPORT')
    return [<path key="a" d={`M${fmt(-f.w * 0.25)},0h${fmt(f.w * 0.5)}m${fmt(-0.8 * m)},${fmt(-0.6 * m)}l${fmt(0.8 * m)},${fmt(0.6 * m)}l${fmt(-0.8 * m)},${fmt(0.6 * m)}`} className="d-arrow" />]
  return []
}

export function zoneDetail(ctx: Ctx): ReactNode[] {
  const { zone } = ctx
  if (zone.id === 'G_CHECKIN_DESKS') return checkInDesks(ctx)
  if (zone.id === 'U_SECURITY') return securityLanes(ctx)
  if (zone.id === 'G_INFO') return []
  switch (zone.kind) {
    case 'queue': return zone.id === 'X_TAXI_RANK' ? [...serpentine(ctx), ...kerb(ctx)] : [...serpentine(ctx, zone.id !== 'G_CHECKIN_QUEUE'), ...(zone.id === 'G_ARRIVALS_PASSPORT' ? circulation(ctx) : [])]
    case 'reclaim': return reclaim(ctx)
    case 'gate': return gate(ctx)
    case 'stairs': return stairs(ctx)
    case 'shops': return shops(ctx)
    case 'wc': return wc(ctx)
    case 'waiting': return waiting(ctx)
    case 'kerb': return kerb(ctx)
    case 'parking': return parking(ctx)
    case 'assembly': return assembly(ctx)
    case 'circulation': return circulation(ctx)
    default: return []
  }
}
