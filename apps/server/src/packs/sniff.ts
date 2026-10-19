// What an image of a pet pack is, read from its bytes (PLAN 10.2, decision 107): the type and the pixel size come from
// the file's own headers, never from a claim, and must agree with the file name's extension. PNG (also animated, APNG),
// GIF and WebP (also animated) pass; JPEG, SVG (script) and everything else are refused with a reason a person can act
// on. Nothing here decodes pixels, and nothing in a pack is ever run.

export const PACK_IMAGE_MAX_BYTES = 8 * 1024 * 1024
export const PACK_MIN_SIDE = 64
export const PACK_MAX_SIDE = 2048

export type PackExt = 'png' | 'gif' | 'webp'
export const PACK_TYPES: Record<PackExt, string> = {
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
}
export const PACK_EXTENSIONS: readonly PackExt[] = ['webp', 'png', 'gif']

export type PackImageSniff =
  { ok: true; ext: PackExt; width: number; height: number } | { ok: false; reasons: string[] }

type Parsed = { ext: PackExt; width: number; height: number } | { reason: string }

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const ascii = (bytes: Buffer, at: number, length: number) =>
  bytes.toString('latin1', at, at + length)

function png(bytes: Buffer): Parsed {
  // The first chunk is IHDR (13 bytes of data). An animation (`acTL`) is just more of the same file.
  if (bytes.length < 33 || bytes.readUInt32BE(8) !== 13 || ascii(bytes, 12, 4) !== 'IHDR')
    return { reason: 'This PNG is damaged.' }
  return { ext: 'png', width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

function gif(bytes: Buffer): Parsed {
  // "GIF87a" or "GIF89a", then the logical screen's width and height (little-endian).
  if (bytes.length < 13) return { reason: 'This GIF is damaged.' }
  return { ext: 'gif', width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) }
}

function webp(bytes: Buffer): Parsed {
  const damaged = { reason: 'This WebP is damaged.' }
  if (bytes.length < 21 || bytes.readUInt32LE(4) + 8 > bytes.length) return damaged
  const kind = ascii(bytes, 12, 4)
  if (kind === 'VP8X') {
    if (bytes.length < 30) return damaged
    return { ext: 'webp', width: bytes.readUIntLE(24, 3) + 1, height: bytes.readUIntLE(27, 3) + 1 }
  }
  if (kind === 'VP8L') {
    if (bytes.length < 25 || bytes[20] !== 0x2f) return damaged
    const bits = bytes.readUInt32LE(21)
    return { ext: 'webp', width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }
  }
  if (kind === 'VP8 ') {
    // 3-byte frame tag, then the start code 9d 01 2a, then 14-bit width and height.
    if (bytes.length < 30 || bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a)
      return damaged
    return {
      ext: 'webp',
      width: bytes.readUInt16LE(26) & 0x3fff,
      height: bytes.readUInt16LE(28) & 0x3fff,
    }
  }
  return damaged
}

function header(bytes: Buffer): Parsed | null {
  if (PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)) return png(bytes)
  if (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a') return gif(bytes)
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return webp(bytes)
  return null
}

const EXTENSIONS: Record<string, PackExt> = { png: 'png', gif: 'gif', webp: 'webp' }
const NAMES: Record<PackExt, string> = { png: 'PNG', gif: 'GIF', webp: 'WebP' }

/** Every reason the image can't be used, or its type and size. `filename` is only compared, never trusted. */
export function sniffPackImage(bytes: Buffer, filename: string): PackImageSniff {
  const reasons: string[] = []
  if (bytes.length === 0) return { ok: false, reasons: ['That file is empty.'] }
  if (bytes.length > PACK_IMAGE_MAX_BYTES)
    reasons.push(
      `The image is ${(bytes.length / (1024 * 1024)).toFixed(1)} MB. An image can be up to 8 MB.`,
    )
  const claimed = EXTENSIONS[/\.([A-Za-z0-9]+)$/.exec(filename)?.[1]?.toLowerCase() ?? '']
  const parsed = header(bytes)
  if (!parsed) {
    const svg =
      /\.svg$/i.test(filename) ||
      /^\s*(?:<\?xml|<svg|<!doctype svg)/i.test(bytes.toString('utf8', 0, 256))
    const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8
    reasons.push(
      svg
        ? 'SVG images aren’t supported. Use a PNG, GIF or WebP.'
        : jpeg
          ? 'JPEG images aren’t supported. Use a PNG, GIF or WebP.'
          : 'That isn’t a PNG, GIF or WebP image.',
    )
    return { ok: false, reasons }
  }
  if ('reason' in parsed) {
    reasons.push(parsed.reason)
    return { ok: false, reasons }
  }
  if (claimed !== parsed.ext)
    reasons.push(
      `The file name ends in a different type than the image is (it is a ${NAMES[parsed.ext]}). Rename it to .${parsed.ext}.`,
    )
  if (
    Math.min(parsed.width, parsed.height) < PACK_MIN_SIDE ||
    Math.max(parsed.width, parsed.height) > PACK_MAX_SIDE
  )
    reasons.push(
      `The image is ${parsed.width} × ${parsed.height} pixels. Each side must be between ${PACK_MIN_SIDE} and ${PACK_MAX_SIDE} pixels.`,
    )
  return reasons.length ? { ok: false, reasons } : { ok: true, ...parsed }
}
