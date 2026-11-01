import { useEffect, useRef, useState } from 'react'
import { backend } from './config'

/**
 * Camera feeds (SPEC-v2 contract): a row of GET /cams. `count` is the people detected in that picture,
 * not the zone's `waiting` from flow.report. `age` is real seconds since the worker got the frame.
 */
export interface CameraRow { camera: string; zone: string | null; simTime: number; count: number; detector: 'yolo' | 'simulated'; w: number; h: number; age: number }
export interface CameraFeed extends CameraRow { url: string }

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
/** Well-formed rows only, at most four (the contract's limit); anything else (404, old backend) gives none. */
export function cameraRows(body: unknown): CameraRow[] {
  if (!Array.isArray(body)) return []
  return body.filter((r): r is CameraRow => !!r && typeof r === 'object' && typeof r.camera === 'string' && /^[a-z0-9_]{1,64}$/.test(r.camera) &&
    (r.zone === null || typeof r.zone === 'string') && ['simTime', 'count', 'w', 'h', 'age'].every(k => finite(r[k])) &&
    (r.detector === 'yolo' || r.detector === 'simulated')).slice(0, 4)
}

/** A picture the socket brought this recently is fresh enough: the poll skips its HTTP fetch. */
const LIVE_FRESH_MS = 1500

const headers = (): Record<string, string> => backend.token ? { Authorization: `Bearer ${backend.token}` } : {}

/** Polls GET /cams and fetches a camera's JPEG only when it has a newer frame. Empty without feeds or on any error. */
export function useCams(intervalMs = 1000, focus: string | null = null): CameraFeed[] {
  const [feeds, setFeeds] = useState<CameraFeed[]>([])
  // The enlarged camera is polled twice as often (vision sends up to 2 frames/s); the others stay at one fetch a second.
  const focused = useRef(focus)
  useEffect(() => { focused.current = focus }, [focus])
  useEffect(() => {
    let alive = true, timer: ReturnType<typeof setTimeout> | undefined
    const images = new Map<string, { simTime: number; age: number; url: string; at: number; live?: boolean }>()
    let rows: CameraRow[] = []
    let pending = 0
    const drop = (camera: string) => { const img = images.get(camera); if (img) URL.revokeObjectURL(img.url); images.delete(camera) }
    const load = async () => {
      try {
        const response = await fetch(`${backend.http}/cams`, { headers: headers() })
        rows = response.ok ? cameraRows(await response.json()) : []
        await Promise.all(rows.map(async row => {
          const seen = images.get(row.camera)
          // A newer frame: another sim time, or younger than the one we hold.
          if (seen && seen.simTime === row.simTime && row.age >= seen.age) { seen.age = row.age; return }
          // The socket already brought a fresh picture: no HTTP fetch (the socket is how the monitors stay fluid).
          if (seen?.live && Date.now() - seen.at < LIVE_FRESH_MS) return
          if (seen && row.camera !== focused.current && Date.now() - seen.at < intervalMs - 100) return
          const image = await fetch(`${backend.http}/cams/${row.camera}.jpg`, { headers: headers() })
          if (!image.ok) return
          const url = URL.createObjectURL(await image.blob())
          drop(row.camera)
          images.set(row.camera, { simTime: row.simTime, age: row.age, url, at: Date.now() })
        }))
        for (const camera of [...images.keys()]) if (!rows.some(r => r.camera === camera)) drop(camera)
        if (alive) publish()
      } catch {
        if (alive) setFeeds([])
      }
      if (alive) timer = setTimeout(load, focused.current ? Math.min(intervalMs, 500) : intervalMs)
    }
    const publish = () => setFeeds(rows.flatMap(row => { const img = images.get(row.camera); return img ? [{ ...row, url: img.url }] : [] }))
    // camera.frame pushed by the backend to every console socket (worker index.ts cameraFrame): each picture as it comes,
    // up to ~10 a second per camera, while GET /cams above keeps the rows (zone, age) once a second.
    let socket: WebSocket | undefined, retry: ReturnType<typeof setTimeout> | undefined, backoff = 1000
    const connect = () => {
      if (!alive || !backend.token || typeof WebSocket === 'undefined' || import.meta.env.MODE === 'test') return
      try { socket = new WebSocket(backend.ws) } catch { return }
      socket.onopen = () => { backoff = 1000 }
      socket.onmessage = event => {
        if (typeof event.data !== 'string' || !event.data.includes('"camera.frame"')) return
        try {
          const { type, data: d } = JSON.parse(event.data)
          if (type !== 'camera.frame' || !d || typeof d.camera !== 'string' || typeof d.jpeg !== 'string') return
          const raw = atob(d.jpeg), bytes = new Uint8Array(raw.length)
          for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
          const url = URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' }))
          drop(d.camera)
          images.set(d.camera, { simTime: d.simTime, age: 0, url, at: Date.now(), live: true })
          rows = rows.map(r => r.camera === d.camera ? { ...r, simTime: d.simTime, count: Number.isInteger(d.count) ? d.count : r.count, age: 0 } : r)
          if (!pending) pending = requestAnimationFrame(() => { pending = 0; if (alive) publish() })
        } catch { /* A malformed frame is skipped; the next one replaces it. */ }
      }
      socket.onclose = () => { socket = undefined; if (alive) { retry = setTimeout(connect, backoff); backoff = Math.min(backoff * 2, 8000) } }
    }
    connect()
    load()
    return () => {
      alive = false; clearTimeout(timer); clearTimeout(retry); if (pending) cancelAnimationFrame(pending)
      if (socket) { socket.onclose = null; socket.close() }
      for (const camera of [...images.keys()]) drop(camera)
    }
  }, [intervalMs])
  return feeds
}
