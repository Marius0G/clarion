// Camera feeds (SPEC-v2 contract, vision → backend): the latest `camera.frame` per camera, kept in memory only.
// The JPEG already has vision's detection boxes drawn; the worker never decodes it, it only checks it is a JPEG.

export const CAMS_MAX = 4;
/** No time gate: vision paces each camera (camera_feed.SEND_FPS, about 5 a second). A Durable Object's clock does not move
 * between messages handled in one burst, so any gap rule here dropped every other frame. */
export const FRAME_MIN_MS = 0;
/** Contract: each JPEG ≤ ~120 KB. Allow some headroom before refusing. */
export const JPEG_MAX_BYTES = 200_000;
/** A camera silent this long gives its slot to a new one. */
const EVICT_AFTER_MS = 30_000;
const CAMERA_ID = /^[a-z0-9_]{1,64}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export interface CameraMeta {
  camera: string; zone: string | null; simTime: number; w: number; h: number;
  /** People detected in this picture: not the zone's `waiting` from flow.report. */
  count: number; detector: 'yolo' | 'simulated';
}
interface Frame extends CameraMeta { jpeg: Uint8Array; base64: string; at: number }

const finite = (v: unknown, min: number, max: number) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;

/** Validates `camera.frame` data. Throws with a reason, like every other contract message. */
export function cameraFrame(d: any): CameraMeta & { base64: string; jpeg: Uint8Array } {
  if (!d || typeof d !== 'object' || Array.isArray(d)) throw new Error('Invalid camera.frame');
  if (typeof d.camera !== 'string' || !CAMERA_ID.test(d.camera)) throw new Error('Invalid camera.frame camera');
  if (d.zone !== null && d.zone !== undefined && (typeof d.zone !== 'string' || !d.zone || d.zone.length > 64)) throw new Error('Invalid camera.frame zone');
  if (!finite(d.simTime, 0, 1e9) || !finite(d.w, 1, 4096) || !finite(d.h, 1, 4096) || !Number.isInteger(d.w) || !Number.isInteger(d.h))
    throw new Error('Invalid camera.frame size or simTime');
  if (!finite(d.count, 0, 10000) || !Number.isInteger(d.count)) throw new Error('Invalid camera.frame count');
  if (d.detector !== 'yolo' && d.detector !== 'simulated') throw new Error('Invalid camera.frame detector');
  if (typeof d.jpeg !== 'string' || !d.jpeg || d.jpeg.length > Math.ceil(JPEG_MAX_BYTES / 3) * 4 || d.jpeg.length % 4 !== 0 || !BASE64.test(d.jpeg))
    throw new Error('Invalid camera.frame jpeg: base64, at most 200 KB');
  const raw = atob(d.jpeg);
  const jpeg = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) jpeg[i] = raw.charCodeAt(i);
  if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error('Invalid camera.frame jpeg: not a JPEG');
  return { camera: d.camera, zone: d.zone ?? null, simTime: d.simTime, w: d.w, h: d.h, count: d.count, detector: d.detector, base64: d.jpeg, jpeg };
}

export class CameraFeeds {
  private frames = new Map<string, Frame>();
  /** Keeps the frame; returns it for forwarding, or null when it came too soon after the camera's previous one. */
  accept(data: unknown, now = Date.now()): (CameraMeta & { jpeg: string }) | null {
    const f = cameraFrame(data);
    const previous = this.frames.get(f.camera);
    if (previous && now - previous.at < FRAME_MIN_MS) return null;
    if (!previous && this.frames.size >= CAMS_MAX) {
      const oldest = [...this.frames.values()].sort((a, b) => a.at - b.at)[0]!;
      if (now - oldest.at < EVICT_AFTER_MS) throw new Error(`At most ${CAMS_MAX} cameras`);
      this.frames.delete(oldest.camera);
    }
    this.frames.set(f.camera, { ...f, at: now });
    const { base64, jpeg: _bytes, ...meta } = f;
    return { ...meta, jpeg: base64 };
  }
  /** GET /cams: one row per camera, `age` in real seconds since its last frame. */
  list(now = Date.now()) {
    return [...this.frames.values()].sort((a, b) => a.camera.localeCompare(b.camera)).map(f => ({
      camera: f.camera, zone: f.zone, simTime: f.simTime, count: f.count, detector: f.detector, w: f.w, h: f.h,
      age: Math.max(0, Math.round((now - f.at) / 100) / 10),
    }));
  }
  /** GET /cams/<camera>.jpg */
  jpeg(camera: string) { return this.frames.get(camera)?.jpeg; }
  meta(camera: string) { return this.frames.get(camera); }
  clear() { const n = this.frames.size; this.frames.clear(); return n; }
}
