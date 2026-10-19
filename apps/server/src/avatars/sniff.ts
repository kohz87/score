// What an imported agent picture is, read from its bytes (PLAN 10.2): the type and the pixel size come from the file's
// own headers, never from the client's claim, and must agree with the file name's extension. Only PNG, JPEG and still
// WebP pass; SVG (script), animated images and everything else are refused with a reason a person can act on.

export const AVATAR_MAX_BYTES = 2 * 1024 * 1024
export const AVATAR_MIN_SIDE = 32
export const AVATAR_MAX_SIDE = 2048

export type AvatarExt = 'png' | 'jpg' | 'webp'
export const AVATAR_TYPES: Record<AvatarExt, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
}

export type AvatarSniff =
  { ok: true; ext: AvatarExt; width: number; height: number } | { ok: false; reasons: string[] }

interface Header {
  ext: AvatarExt
  width: number
  height: number
}
type Parsed = Header | { reason: string }

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const ascii = (bytes: Buffer, at: number, length: number) =>
  bytes.toString('latin1', at, at + length)

function png(bytes: Buffer): Parsed {
  // The first chunk is IHDR (13 bytes of data); chunks follow until the first IDAT, where an animation would have
  // declared itself with `acTL`.
  if (bytes.length < 33 || bytes.readUInt32BE(8) !== 13 || ascii(bytes, 12, 4) !== 'IHDR')
    return { reason: 'This PNG is damaged.' }
  const width = bytes.readUInt32BE(16)
  const height = bytes.readUInt32BE(20)
  let at = 33
  while (at + 8 <= bytes.length) {
    const type = ascii(bytes, at + 4, 4)
    if (type === 'acTL') return { reason: 'Animated pictures aren’t supported. Use a still image.' }
    if (type === 'IDAT' || type === 'IEND') break
    at += 12 + bytes.readUInt32BE(at)
  }
  return { ext: 'png', width, height }
}

// SOF0 (baseline), SOF1 (extended sequential) and SOF2 (progressive) are what cameras, editors and the web produce.
const JPEG_SOF = new Set([0xc0, 0xc1, 0xc2])
function jpeg(bytes: Buffer): Parsed {
  let at = 2
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) return { reason: 'This JPEG is damaged.' }
    const marker = bytes[at + 1]!
    // Fill bytes between segments, and markers that carry no length.
    if (marker === 0xff) {
      at += 1
      continue
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      at += 2
      continue
    }
    if (marker === 0xd9 || marker === 0xda) break
    const length = bytes.readUInt16BE(at + 2)
    if (JPEG_SOF.has(marker)) {
      if (length < 8 || at + 9 > bytes.length) break
      return { ext: 'jpg', width: bytes.readUInt16BE(at + 7), height: bytes.readUInt16BE(at + 5) }
    }
    if (marker >= 0xc3 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
      return { reason: 'This kind of JPEG isn’t supported. Save it as a standard JPEG or PNG.' }
    at += 2 + length
  }
  return { reason: 'This JPEG is damaged.' }
}

function webp(bytes: Buffer): Parsed {
  const damaged = { reason: 'This WebP is damaged.' }
  if (bytes.length < 21 || bytes.readUInt32LE(4) + 8 > bytes.length) return damaged
  const kind = ascii(bytes, 12, 4)
  if (kind === 'VP8X') {
    if (bytes.length < 30) return damaged
    if (bytes[20]! & 0x02)
      return { reason: 'Animated pictures aren’t supported. Use a still image.' }
    return {
      ext: 'webp',
      width: bytes.readUIntLE(24, 3) + 1,
      height: bytes.readUIntLE(27, 3) + 1,
    }
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
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return jpeg(bytes)
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return webp(bytes)
  return null
}

const EXTENSIONS: Record<string, AvatarExt> = {
  png: 'png',
  jpg: 'jpg',
  jpeg: 'jpg',
  webp: 'webp',
}
const NAMES: Record<AvatarExt, string> = { png: 'PNG', jpg: 'JPEG', webp: 'WebP' }

/** Every reason the picture can't be used, or its type and size. `filename` is only compared, never trusted. */
export function sniffAvatar(bytes: Buffer, filename: string): AvatarSniff {
  const reasons: string[] = []
  if (bytes.length === 0) return { ok: false, reasons: ['That file is empty.'] }
  if (bytes.length > AVATAR_MAX_BYTES)
    reasons.push(
      `The picture is ${(bytes.length / (1024 * 1024)).toFixed(1)} MB. Pictures can be up to 2 MB.`,
    )
  const claimed = EXTENSIONS[/\.([A-Za-z0-9]+)$/.exec(filename)?.[1]?.toLowerCase() ?? '']
  const parsed = header(bytes)
  if (!parsed) {
    const svg =
      /\.svg$/i.test(filename) ||
      /^\s*(?:<\?xml|<svg|<!doctype svg)/i.test(bytes.toString('utf8', 0, 256))
    reasons.push(
      svg
        ? 'SVG pictures aren’t supported. Use a PNG, JPEG or WebP.'
        : 'That isn’t a PNG, JPEG or WebP picture.',
    )
    return { ok: false, reasons }
  }
  if ('reason' in parsed) {
    reasons.push(parsed.reason)
    return { ok: false, reasons }
  }
  if (claimed !== parsed.ext)
    reasons.push(
      `The file name ends in a different type than the picture is (it is a ${NAMES[parsed.ext]}). Rename it to .${parsed.ext === 'jpg' ? 'jpg' : parsed.ext}.`,
    )
  if (
    Math.min(parsed.width, parsed.height) < AVATAR_MIN_SIDE ||
    Math.max(parsed.width, parsed.height) > AVATAR_MAX_SIDE
  )
    reasons.push(
      `The picture is ${parsed.width} × ${parsed.height} pixels. Each side must be between ${AVATAR_MIN_SIDE} and ${AVATAR_MAX_SIDE} pixels.`,
    )
  return reasons.length ? { ok: false, reasons } : { ok: true, ...parsed }
}
