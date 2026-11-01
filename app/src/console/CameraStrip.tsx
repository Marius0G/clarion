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

/**
 * "Camere" (contract camera.frame): the latest frame of up to four cameras, with vision's boxes drawn.
 * Hover highlights the camera's zone on the map; click enlarges it over the map. Renders nothing without feeds.
 */
export function CameraStrip({ zoneName, onHover }: { zoneName: (id: string) => string; onHover?: (zone: string | null) => void }) {
  const feeds = useCams()
  const [open, setOpen] = useState<string | null>(null)
  useEffect(() => {
    if (!open) return
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(null) }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [open])
  if (!feeds.length) return null
  const big = feeds.find(f => f.camera === open)
  return <section className="ops-cams" aria-label="Camere" data-testid="cameras">
    <h2>Camere</h2>
    <div className="ops-cam-grid">
      {feeds.map(f => <button key={f.camera} className={`ops-cam${f.age > CAM_STALE_S ? ' stale' : ''}`} data-testid={`cam-${f.camera}`}
        onClick={() => setOpen(f.camera)} onMouseEnter={() => onHover?.(f.zone)} onMouseLeave={() => onHover?.(null)}
        aria-label={`${cameraName(f.camera)}: mărește`}>
        <img src={f.url} alt="" width={f.w} height={f.h} />
        <b>{cameraName(f.camera)}</b>
        <small>{cameraLine(f, true)}</small>
      </button>)}
    </div>
    {big && <div className="ops-cam-big" role="dialog" aria-label={cameraName(big.camera)} data-testid="camera-big" onClick={() => setOpen(null)}>
      <figure>
        <img src={big.url} alt={`Cadru ${cameraName(big.camera)}`} />
        <figcaption><b>{cameraName(big.camera)}</b>{big.zone && ` · ${zoneName(big.zone)}`} · {cameraLine(big)}</figcaption>
      </figure>
      <button className="ops-ghost" aria-label="Închide camera">×</button>
    </div>}
  </section>
}
