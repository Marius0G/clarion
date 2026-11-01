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

const headers = (): Record<string, string> => backend.token ? { Authorization: `Bearer ${backend.token}` } : {}

/** Polls GET /cams and fetches a camera's JPEG only when it has a newer frame. Empty without feeds or on any error. */
export function useCams(intervalMs = 1000, focus: string | null = null): CameraFeed[] {
  const [feeds, setFeeds] = useState<CameraFeed[]>([])
  // The enlarged camera is polled twice as often (vision sends up to 2 frames/s); the others stay at one fetch a second.
  const focused = useRef(focus)
  useEffect(() => { focused.current = focus }, [focus])
  useEffect(() => {
    let alive = true, timer: ReturnType<typeof setTimeout> | undefined
    const images = new Map<string, { simTime: number; age: number; url: string; at: number }>()
    const drop = (camera: string) => { const img = images.get(camera); if (img) URL.revokeObjectURL(img.url); images.delete(camera) }
    const load = async () => {
      try {
        const response = await fetch(`${backend.http}/cams`, { headers: headers() })
        const rows = response.ok ? cameraRows(await response.json()) : []
        await Promise.all(rows.map(async row => {
          const seen = images.get(row.camera)
          // A newer frame: another sim time, or younger than the one we hold.
          if (seen && seen.simTime === row.simTime && row.age >= seen.age) { seen.age = row.age; return }
          if (seen && row.camera !== focused.current && Date.now() - seen.at < intervalMs - 100) return
          const image = await fetch(`${backend.http}/cams/${row.camera}.jpg`, { headers: headers() })
          if (!image.ok) return
          const url = URL.createObjectURL(await image.blob())
          drop(row.camera)
          images.set(row.camera, { simTime: row.simTime, age: row.age, url, at: Date.now() })
        }))
        for (const camera of [...images.keys()]) if (!rows.some(r => r.camera === camera)) drop(camera)
        if (alive) setFeeds(rows.flatMap(row => { const img = images.get(row.camera); return img ? [{ ...row, url: img.url }] : [] }))
      } catch {
        if (alive) setFeeds([])
      }
      if (alive) timer = setTimeout(load, focused.current ? Math.min(intervalMs, 500) : intervalMs)
    }
    load()
    return () => { alive = false; clearTimeout(timer); for (const camera of [...images.keys()]) drop(camera) }
  }, [intervalMs])
  return feeds
}
