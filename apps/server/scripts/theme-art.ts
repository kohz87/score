// Draws the pictures the built-in themes ship (PLAN 9.5). Made here, from maths: no stock art, nothing fetched.
// `pnpm --filter @score/server exec tsx scripts/theme-art.ts` rewrites apps/server/themes/*/assets/img; a test checks
// the files on disk are exactly what this script draws.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { crc32, deflateSync } from 'node:zlib'

export type Rgb = [number, number, number]

/** A plain 8-bit RGB PNG with the Sub filter (smooth pictures compress far better with it). */
export function encodePng(width: number, height: number, rgb: Uint8Array): Buffer {
  const stride = width * 3
  const rows = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y += 1) {
    const out = y * (stride + 1)
    rows[out] = 1
    for (let i = 0; i < stride; i += 1) {
      const left = i >= 3 ? rgb[y * stride + i - 3]! : 0
      rows[out + 1 + i] = (rgb[y * stride + i]! - left) & 255
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8)
    head.writeUInt32BE(data.length, 0)
    head.write(type, 4, 'ascii')
    const tail = Buffer.alloc(4)
    tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0)
    return Buffer.concat([head, data, tail])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 2
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const mix = (a: Rgb, b: Rgb, t: number): Rgb => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
]
const clamp01 = (n: number) => Math.min(1, Math.max(0, n))
const smooth = (t: number) => t * t * (3 - 2 * t)
// A 4 x 4 ordered dither, so the soft gradients don't band.
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]

export const HARBOUR = { width: 1280, height: 800 } as const

/** Harbour: a dusk sky over still water, a warm glow near the horizon, low hills. Mid-tones only, so glass cards read in both modes. */
export function renderHarbour(): Uint8Array {
  const { width, height } = HARBOUR
  const out = new Uint8Array(width * height * 3)
  const horizon = 0.58
  const top: Rgb = [46, 82, 128]
  const mid: Rgb = [92, 150, 178]
  const glow: Rgb = [244, 188, 138]
  const deep: Rgb = [22, 62, 92]
  const shallow: Rgb = [58, 120, 146]
  const hill: Rgb = [38, 78, 106]
  const sunX = 0.66
  for (let y = 0; y < height; y += 1) {
    const v = y / height
    for (let x = 0; x < width; x += 1) {
      const u = x / width
      let c: Rgb
      if (v < horizon) {
        c = mix(top, mid, smooth(clamp01(v / horizon)))
        const dx = (u - sunX) * (width / height)
        const dy = v - horizon
        const falloff = clamp01(1 - Math.hypot(dx, dy * 1.6) / 0.55)
        c = mix(c, glow, 0.62 * falloff * falloff)
      } else {
        const depth = clamp01((v - horizon) / (1 - horizon))
        c = mix(shallow, deep, smooth(depth))
        const ripple = Math.sin(v * 190 + Math.sin(u * 9) * 2.4) * 0.5 + 0.5
        c = mix(c, mix(c, mid, 0.5), 0.08 * ripple * (1 - depth))
        const streak = Math.exp(-(((u - sunX) / (0.05 + depth * 0.12)) ** 2))
        c = mix(c, glow, 0.5 * streak * (1 - depth) * (0.55 + 0.45 * ripple))
      }
      // Low hills along the horizon, soft at the edge.
      const ridge =
        horizon -
        0.05 -
        0.03 * Math.sin(u * 7.2 + 0.6) -
        0.018 * Math.sin(u * 15.5 + 2.1) -
        0.012 * Math.sin(u * 31 + 0.3)
      const fade = clamp01((v - ridge) / 0.006)
      // The glow lightens the hills nearest to it.
      const lit = 1 - 0.5 * Math.exp(-(((u - sunX) / 0.13) ** 2))
      if (v < horizon + 0.004) c = mix(c, hill, 0.62 * smooth(fade) * lit)
      const dither = (BAYER[(y % 4) * 4 + (x % 4)]! - 7.5) / 16
      const at = (y * width + x) * 3
      out[at] = Math.round(c[0] + dither)
      out[at + 1] = Math.round(c[1] + dither)
      out[at + 2] = Math.round(c[2] + dither)
    }
  }
  return out
}

export const harbourPng = () => encodePng(HARBOUR.width, HARBOUR.height, renderHarbour())

/** Every picture, by its path under apps/server/themes. */
export const themeArt: Record<string, () => Buffer> = {
  'harbour/assets/img/harbour.png': harbourPng,
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = fileURLToPath(new URL('../themes/', import.meta.url))
  for (const [path, draw] of Object.entries(themeArt)) {
    const file = join(root, path)
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, draw())
    console.log(`wrote ${path}`)
  }
}
