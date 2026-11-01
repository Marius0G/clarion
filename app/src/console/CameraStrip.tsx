import { useEffect, useState } from 'react'
import { useCams, type CameraFeed } from '../backend/cams'
import './cams.css'

/** A frame older than this is shown as lost, not as live. */
export const CAM_STALE_S = 10
const NAMES: Record<string, string> = {
  cctv_security_queue: 'Coada de securitate', cctv_checkin_overview: 'Check-in, toate cozile',
  cctv_hall_east: 'Hol check-in', cctv_upper_4: 'Securitate, etaj',
}
export const cameraName = (camera: string) => NAMES[camera] ?? camera.replace(/^cctv_/, '').replace(/_/g, ' ')
export const cameraAge = (age: number) => age > CAM_STALE_S ? `fără cadru de ${Math.round(age)} s` : age < 2 ? 'acum' : `acum ${Math.round(age)} s`
/** Honest about the detector: the simulated one is not YOLO (vision README). */
export const cameraLine = (f: Pick<CameraFeed, 'count' | 'detector' | 'age'>, short = false) =>
  `${f.count} în cadru · ${f.detector === 'yolo' ? 'YOLO' : short ? 'simulat' : 'detector simulat'} · ${cameraAge(f.age)}`
const persons = (n: number) => `${n} ${n === 1 ? 'persoană' : 'persoane'}`
const wait = (v: number | null | undefined) => v == null ? '—' : `${Math.round(v)} min`

/**
 * Crossfades to each new JPEG once it has decoded (~120 ms), so a feed never blanks or jumps, at 1 or 10 frames a second.
 * Holds the last shown frame under the incoming one; the loaded <img> keeps its pixels after useCams revokes the old blob URL.
 */
function Frame({ url, w, h, alt = '' }: { url: string; w?: number; h?: number; alt?: string }) {
  const [frames, setFrames] = useState<{ url: string; ready: boolean }[]>([{ url, ready: true }])
  if (frames.at(-1)!.url !== url) setFrames(current => [...current.filter(f => f.ready).slice(-1), { url, ready: false }])
  const ready = (u: string) => setFrames(current => current.map(f => f.url === u ? { ...f, ready: true } : f))
  return <>{frames.map((f, i) => <img key={f.url} src={f.url} alt={i === frames.length - 1 ? alt : ''} width={w} height={h} className={f.ready ? 'on' : undefined}
    onLoad={() => ready(f.url)} onError={() => ready(f.url)} />)}</>
}

/** Live / lost badge: a pulsing dot while frames arrive, the frame's age next to it. */
function Live({ feed }: { feed: CameraFeed }) {
  const stale = feed.age > CAM_STALE_S
  return <span className={`ops-cam-live${stale ? ' lost' : ''}`}>
    <i className="ops-live-dot" aria-hidden="true" />{stale ? 'Semnal pierdut' : 'Live'}<em>{stale ? `${Math.round(feed.age)} s` : feed.age < 2 ? 'acum' : `${Math.round(feed.age)} s`}</em>
  </span>
}

/**
 * "Camere" (contract camera.frame): the latest frame of up to four cameras, with vision's boxes already drawn in the JPEG.
 * Hover highlights the camera's zone on the map; click enlarges it. Renders nothing without feeds.
 */
export function CameraStrip({ zoneName, zoneWait, onHover }: { zoneName: (id: string) => string; zoneWait?: (id: string) => number | null; onHover?: (zone: string | null) => void }) {
  const [open, setOpen] = useState<string | null>(null)
  const feeds = useCams(1000, open)
  useEffect(() => {
    if (!open) return
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(null) }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [open])
  if (!feeds.length) return null
  const big = feeds.find(f => f.camera === open)
  return <section className="ops-cams" aria-label="Camere" data-testid="cameras">
    <h2 className="ops-sr">Camere</h2>
    <div className="ops-cam-grid">
      {feeds.map((f, i) => <button key={f.camera} className={`ops-cam${f.age > CAM_STALE_S ? ' stale' : ''}`} data-testid={`cam-${f.camera}`}
        onClick={() => setOpen(f.camera)} onMouseEnter={() => onHover?.(f.zone)} onMouseLeave={() => onHover?.(null)}
        aria-label={`${cameraName(f.camera)}: mărește`}>
        <span className="ops-cam-frame">
          <Frame url={f.url} w={f.w} h={f.h} />
          <Live feed={f} />
          <span className="ops-cam-id">CAM {String(i + 1).padStart(2, '0')} · {f.detector === 'yolo' ? 'YOLO' : 'simulat'}</span>
        </span>
        <span className="ops-cam-meta">
          <b>{cameraName(f.camera)}</b>
          <small>{f.zone ? zoneName(f.zone) : 'Fără zonă'}</small>
          <span className="ops-cam-figs"><span><strong>{f.count}</strong> {f.count === 1 ? 'persoană' : 'persoane'}</span>{f.zone && zoneWait && <span><strong>{wait(zoneWait(f.zone))}</strong> așteptare</span>}</span>
        </span>
      </button>)}
    </div>
    {big && <div className="ops-cam-big" role="dialog" aria-label={cameraName(big.camera)} data-testid="camera-big" onClick={() => setOpen(null)}>
      <figure>
        <span className="ops-cam-frame">
          <Frame url={big.url} alt={`Cadru ${cameraName(big.camera)}`} />
          <Live feed={big} />
        </span>
        <figcaption><b>{cameraName(big.camera)}</b>{big.zone && <span>{zoneName(big.zone)}</span>}<span>{persons(big.count)}</span>{big.zone && zoneWait && <span>Așteptare {wait(zoneWait(big.zone))}</span>}<span>{cameraLine(big)}</span></figcaption>
      </figure>
      <button className="ops-ghost" aria-label="Închide camera">×</button>
    </div>}
  </section>
}
