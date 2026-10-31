/**
 * Marius's T2 map package (docs/contract/map, copied here so Vite can bundle it).
 * World metres: x east, z north, level G (parter) / U (etaj 1) / X (exterior).
 * Pixels per floor image: px = (x - x0) * ppm, py = (z1 - z) * ppm.
 */
import zonesJson from './zones.json' with { type: 'json' }
import pointsJson from './points.json' with { type: 'json' }

export type Level = 'G' | 'U' | 'X'
export type Pt = [number, number]
export interface Ring { outer: Pt[]; holes: Pt[][] }

export interface MapZone {
  id: string; code: string; name_ro: string; name_en: string
  level: Level; kind: string; side: 'landside' | 'airside'; approx: boolean
  area_m2: number; centre: Pt; polygons_px: Ring[]; metrics: string[]
}
export interface MapPoint {
  id: string; type: string; name: string; level: Level
  x: number; z: number; px: Pt; approx?: boolean
  evacuation_exit?: boolean; links_to?: string; one_way?: boolean
  yaw?: number; hfov?: number; width_m?: number
}
export interface Frame {
  key: 'parter' | 'etaj1' | 'exterior'; level: Level; title: string
  x0: number; x1: number; z0: number; z1: number
  ppm: number; width: number; height: number; base: string
}

type RawFrame = { level: string; title: string; x0: number; x1: number; z0: number; z1: number; pixels_per_metre: number; width_px: number; height_px: number; base_image: string }
const rawFrames = (zonesJson as unknown as { frames: Record<string, RawFrame> }).frames

export const frames = Object.fromEntries(Object.entries(rawFrames).map(([key, f]) => [f.level, {
  key, level: f.level, title: f.title, x0: f.x0, x1: f.x1, z0: f.z0, z1: f.z1,
  ppm: f.pixels_per_metre, width: f.width_px, height: f.height_px, base: f.base_image,
}])) as Record<Level, Frame>

export const zones = (zonesJson as unknown as { zones: MapZone[] }).zones
export const points = (pointsJson as unknown as { points: MapPoint[] }).points
export const levels: Level[] = ['G', 'U', 'X']
export const levelNames: Record<Level, { ro: string; en: string }> = {
  G: { ro: 'Parter', en: 'Ground floor' },
  U: { ro: 'Etaj 1', en: 'Upper floor' },
  X: { ro: 'Exterior', en: 'Outside' },
}

export function worldToPx(x: number, z: number, level: Level): Pt {
  const f = frames[level]
  return [(x - f.x0) * f.ppm, (f.z1 - z) * f.ppm]
}

export const zoneById = new Map(zones.map(z => [z.id, z]))
