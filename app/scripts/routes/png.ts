/**
 * Small PNG toolkit for the route pictures: decode Chromium's RGB(A) screenshots, reduce them to a
 * palette and write an indexed PNG. The maps are flat greys plus a few colours, so a palette keeps them small.
 */
import { deflateSync, inflateSync } from 'node:zlib'

export interface Rgba { width: number; height: number; data: Uint8Array }

const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

export function decodePng(buf: Buffer): Rgba {
  if (!buf.subarray(0, 8).equals(SIG)) throw new Error('Not a PNG')
  let width = 0, height = 0, depth = 0, type = 0
  const idat: Buffer[] = []
  for (let o = 8; o < buf.length;) {
    const len = buf.readUInt32BE(o), kind = buf.toString('ascii', o + 4, o + 8), body = buf.subarray(o + 8, o + 8 + len)
    if (kind === 'IHDR') { width = body.readUInt32BE(0); height = body.readUInt32BE(4); depth = body[8]!; type = body[9]!; if (body[12]) throw new Error('Interlaced PNG') }
    else if (kind === 'IDAT') idat.push(body)
    else if (kind === 'IEND') break
    o += 12 + len
  }
  if (depth !== 8 || (type !== 2 && type !== 6)) throw new Error(`Unsupported PNG (type ${type}, depth ${depth})`)
  const bpp = type === 6 ? 4 : 3, stride = width * bpp
  const raw = inflateSync(Buffer.concat(idat))
  const px = new Uint8Array(stride * height)
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)]!, src = y * (stride + 1) + 1, row = y * stride, up = row - stride
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[row + x - bpp]! : 0, b = y ? px[up + x]! : 0, c = x >= bpp && y ? px[up + x - bpp]! : 0
      let v = raw[src + x]!
      if (f === 1) v += a
      else if (f === 2) v += b
      else if (f === 3) v += (a + b) >> 1
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c }
      px[row + x] = v & 255
    }
  }
  const data = new Uint8Array(width * height * 4)
  for (let i = 0, j = 0; i < width * height; i++, j += bpp) { data[i * 4] = px[j]!; data[i * 4 + 1] = px[j + 1]!; data[i * 4 + 2] = px[j + 2]!; data[i * 4 + 3] = bpp === 4 ? px[j + 3]! : 255 }
  return { width, height, data }
}

/**
 * Palette of the `size` most frequent colours; every pixel takes the nearest one. `keep` colours are
 * always in it when present, so a small but meaningful mark (the red P1 square) never turns grey.
 */
export function quantize(img: Rgba, size = 64, keep: number[] = []): { palette: number[]; index: Uint8Array } {
  const n = img.width * img.height, d = img.data
  const count = new Map<number, number>()
  for (let i = 0; i < n; i++) { const c = (d[i * 4]! << 16) | (d[i * 4 + 1]! << 8) | d[i * 4 + 2]!; count.set(c, (count.get(c) ?? 0) + 1) }
  // Most frequent first, skipping near-duplicates so antialiasing does not crowd out real colours.
  const sorted = [...count.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c)
  const palette: number[] = keep.filter(c => count.has(c))
  const dist = (a: number, b: number) => { const dr = (a >> 16) - (b >> 16), dg = ((a >> 8) & 255) - ((b >> 8) & 255), db = (a & 255) - (b & 255); return dr * dr * 3 + dg * dg * 4 + db * db * 2 }
  for (const c of sorted) { if (palette.length >= size) break; if (palette.every(p => dist(p, c) > 40)) palette.push(c) }
  const near = new Map<number, number>()
  const index = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    const c = (d[i * 4]! << 16) | (d[i * 4 + 1]! << 8) | d[i * 4 + 2]!
    let k = near.get(c)
    if (k === undefined) { k = 0; let best = Infinity; for (let j = 0; j < palette.length; j++) { const e = dist(palette[j]!, c); if (e < best) { best = e; k = j } } near.set(c, k) }
    index[i] = k
  }
  return { palette, index }
}

const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c })
const crc32 = (b: Buffer) => { let c = -1; for (const x of b) c = CRC[(c ^ x) & 255]! ^ (c >>> 8); return (c ^ -1) >>> 0 }
const chunk = (kind: string, body: Buffer) => {
  const head = Buffer.alloc(8); head.writeUInt32BE(body.length, 0); head.write(kind, 4, 'ascii')
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0)
  return Buffer.concat([head, body, crc])
}

/** Indexed (palette) PNG: 4 bits per pixel up to 16 colours, else 8; filter none or up per row; maximum deflate. */
export function encodeIndexed(width: number, height: number, palette: number[], index: Uint8Array): Buffer {
  if (palette.length <= 16) return encodeIndexed4(width, height, palette, index)
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 3
  const plte = Buffer.alloc(palette.length * 3)
  palette.forEach((c, i) => { plte[i * 3] = c >> 16; plte[i * 3 + 1] = (c >> 8) & 255; plte[i * 3 + 2] = c & 255 })
  const raw = Buffer.alloc((width + 1) * height)
  for (let y = 0; y < height; y++) {
    const o = y * (width + 1), row = y * width
    // Filter "up" turns repeated rows into zeros; pick it when it gives more zeros than none.
    let zerosUp = 0, zerosNone = 0
    for (let x = 0; x < width; x++) { if (index[row + x] === 0) zerosNone++; if (y && index[row + x] === index[row - width + x]) zerosUp++ }
    const up = y > 0 && zerosUp > zerosNone
    raw[o] = up ? 2 : 0
    for (let x = 0; x < width; x++) raw[o + 1 + x] = up ? (index[row + x]! - index[row - width + x]!) & 255 : index[row + x]!
  }
  return Buffer.concat([SIG, chunk('IHDR', ihdr), chunk('PLTE', plte), chunk('IDAT', deflateSync(raw, { level: 9, memLevel: 9 })), chunk('IEND', Buffer.alloc(0))])
}

function encodeIndexed4(width: number, height: number, palette: number[], index: Uint8Array): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 4; ihdr[9] = 3
  const plte = Buffer.alloc(palette.length * 3)
  palette.forEach((c, i) => { plte[i * 3] = c >> 16; plte[i * 3 + 1] = (c >> 8) & 255; plte[i * 3 + 2] = c & 255 })
  const stride = Math.ceil(width / 2)
  const packed = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) packed[y * stride + (x >> 1)]! |= index[y * width + x]! << (x & 1 ? 0 : 4)
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    const o = y * (stride + 1), row = y * stride
    let same = 0
    if (y) for (let x = 0; x < stride; x++) if (packed[row + x] === packed[row - stride + x]) same++
    const up = y > 0 && same > stride * 0.6
    raw[o] = up ? 2 : 0
    for (let x = 0; x < stride; x++) raw[o + 1 + x] = up ? (packed[row + x]! - packed[row - stride + x]!) & 255 : packed[row + x]!
  }
  return Buffer.concat([SIG, chunk('IHDR', ihdr), chunk('PLTE', plte), chunk('IDAT', deflateSync(raw, { level: 9, memLevel: 9 })), chunk('IEND', Buffer.alloc(0))])
}

export const toIndexedPng = (png: Buffer, colours = 64, keep: number[] = []) => {
  const img = decodePng(png)
  const { palette, index } = quantize(img, colours, keep)
  return encodeIndexed(img.width, img.height, palette, index)
}
