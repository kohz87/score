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

// Each format is walked to its end with bounds checks, so a header that only claims a size isn't taken for an image:
// the chunks, blocks and frames it needs must be there and fit inside the file. Nothing is decoded.

function png(bytes: Buffer): Parsed {
  const damaged = { reason: 'This PNG is damaged or incomplete.' }
  // Chunks: IHDR (13 bytes) first, at least one IDAT, IEND last and exactly at the end of the file. An animation's
  // `acTL` has to come before the first IDAT.
  let at = 8
  let first = true
  let data = false
  let ended = false
  let width = 0
  let height = 0
  while (at < bytes.length && !ended) {
    if (at + 12 > bytes.length) return damaged
    const length = bytes.readUInt32BE(at)
    const type = ascii(bytes, at + 4, 4)
    const end = at + 12 + length
    if (length > 0x7fffffff || !/^[A-Za-z]{4}$/.test(type) || end > bytes.length) return damaged
    if (first) {
      if (type !== 'IHDR' || length !== 13) return damaged
      width = bytes.readUInt32BE(at + 8)
      height = bytes.readUInt32BE(at + 12)
      first = false
    } else if (type === 'IHDR') return damaged
    if (type === 'acTL' && data) return damaged
    if (type === 'IDAT') data = true
    if (type === 'IEND') {
      if (length !== 0 || end !== bytes.length) return damaged
      ended = true
    }
    at = end
  }
  return data && ended && !first ? { ext: 'png', width, height } : damaged
}

function gif(bytes: Buffer): Parsed {
  const damaged = { reason: 'This GIF is damaged or incomplete.' }
  if (bytes.length < 14) return damaged
  // Header, logical screen (width and height little-endian), optional global colour table.
  const width = bytes.readUInt16LE(6)
  const height = bytes.readUInt16LE(8)
  let at = 13
  if (bytes[10]! & 0x80) at += 3 * 2 ** ((bytes[10]! & 7) + 1)
  // Sub-blocks: a length byte and that many bytes, ended by a zero length. Returns how many held data, or null.
  const subBlocks = (): number | null => {
    let held = 0
    for (;;) {
      if (at >= bytes.length) return null
      const size = bytes[at]!
      at += 1
      if (size === 0) return held
      at += size
      if (at > bytes.length) return null
      held += 1
    }
  }
  let images = 0
  for (;;) {
    if (at >= bytes.length) return damaged
    const block = bytes[at]!
    if (block === 0x3b) {
      // The trailer ends the file.
      return at === bytes.length - 1 && images > 0 ? { ext: 'gif', width, height } : damaged
    }
    if (block === 0x21) {
      at += 2
      if (at >= bytes.length || subBlocks() === null) return damaged
    } else if (block === 0x2c) {
      if (at + 10 > bytes.length) return damaged
      const packed = bytes[at + 9]!
      at += 10
      if (packed & 0x80) at += 3 * 2 ** ((packed & 7) + 1)
      if (at >= bytes.length || bytes[at]! < 2 || bytes[at]! > 8) return damaged
      at += 1
      // An image without any data is not an image.
      if (!subBlocks()) return damaged
      images += 1
    } else return damaged
  }
}

interface Chunk {
  id: string
  at: number
  size: number
}
/** The chunks of a RIFF payload between `from` and `to`, each inside it; null when one doesn't fit. */
function riffChunks(bytes: Buffer, from: number, to: number): Chunk[] | null {
  const chunks: Chunk[] = []
  let at = from
  while (at < to) {
    if (at + 8 > to) return null
    const size = bytes.readUInt32LE(at + 4)
    const end = at + 8 + size
    if (end > to) return null
    chunks.push({ id: ascii(bytes, at, 4), at: at + 8, size })
    // Chunks are padded to an even size; a missing pad on the very last one is tolerated.
    at = end + (size & 1)
    if (at > to && end !== to) return null
  }
  return chunks
}
/** A VP8 or VP8L chunk with at least the header that gives the picture its size. */
function hasImage(bytes: Buffer, chunks: Chunk[]): boolean {
  return chunks.some(
    (chunk) =>
      (chunk.id === 'VP8 ' &&
        chunk.size >= 10 &&
        bytes[chunk.at + 3] === 0x9d &&
        bytes[chunk.at + 4] === 0x01 &&
        bytes[chunk.at + 5] === 0x2a) ||
      (chunk.id === 'VP8L' && chunk.size >= 5 && bytes[chunk.at] === 0x2f),
  )
}

function webp(bytes: Buffer): Parsed {
  const damaged = { reason: 'This WebP is damaged or incomplete.' }
  // The RIFF size must be the file's, and every chunk must fit inside it.
  if (bytes.length < 20 || bytes.readUInt32LE(4) + 8 !== bytes.length) return damaged
  const chunks = riffChunks(bytes, 12, bytes.length)
  const first = chunks?.[0]
  if (!chunks || !first) return damaged
  if (first.id === 'VP8L' || first.id === 'VP8 ') {
    if (!hasImage(bytes, [first])) return damaged
    if (first.id === 'VP8L') {
      const bits = bytes.readUInt32LE(first.at + 1)
      return { ext: 'webp', width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }
    }
    return {
      ext: 'webp',
      width: bytes.readUInt16LE(first.at + 6) & 0x3fff,
      height: bytes.readUInt16LE(first.at + 8) & 0x3fff,
    }
  }
  if (first.id !== 'VP8X' || first.size < 10) return damaged
  const size = {
    ext: 'webp' as const,
    width: bytes.readUIntLE(first.at + 4, 3) + 1,
    height: bytes.readUIntLE(first.at + 7, 3) + 1,
  }
  const rest = chunks.slice(1)
  const frames = rest.filter((chunk) => chunk.id === 'ANMF')
  if (!(bytes[first.at]! & 0x02)) {
    // A still: its image is a chunk of its own; frames and an animation header without the flag are not allowed.
    return hasImage(bytes, rest) &&
      frames.length === 0 &&
      !rest.some((chunk) => chunk.id === 'ANIM')
      ? size
      : damaged
  }
  // An animation: ANIM first, then frames that each hold image data; no still image beside them.
  const anim = rest.findIndex((chunk) => chunk.id === 'ANIM')
  const firstFrame = rest.findIndex((chunk) => chunk.id === 'ANMF')
  if (anim < 0 || rest[anim]!.size < 6 || firstFrame < 0 || anim > firstFrame) return damaged
  if (hasImage(bytes, rest)) return damaged
  for (const frame of frames) {
    if (frame.size < 16 + 8) return damaged
    const inner = riffChunks(bytes, frame.at + 16, frame.at + frame.size)
    if (!inner || !hasImage(bytes, inner)) return damaged
  }
  return size
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
