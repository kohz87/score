import { deflateSync } from 'node:zlib'

// Generated, neutral test pictures: a flat grey square, never real artwork.
const CRC = new Uint32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
function crc32(bytes: Buffer): number {
  let c = 0xffffffff
  for (const byte of bytes) c = CRC[(c ^ byte) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
export function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'latin1')
  const tail = Buffer.alloc(4)
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0)
  return Buffer.concat([head, data, tail])
}
/** A real, decodable greyscale PNG. `extra` chunks go between IHDR and IDAT (e.g. `acTL` for an animation). */
export function pngImage(width: number, height: number, extra: Buffer[] = []): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 0 // greyscale
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width, 0x80)])
  const raw = Buffer.concat(Array.from({ length: height }, () => row))
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    ...extra,
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}
/** JPEG headers with the given size (SOF0 or SOF2); enough for the header checks, not a decodable picture. */
export function jpegImage(width: number, height: number, sof = 0xc0): Buffer {
  const app0 = Buffer.from([
    0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0,
  ])
  const frame = Buffer.alloc(19)
  frame.set([0xff, sof, 0, 17, 8])
  frame.writeUInt16BE(height, 5)
  frame.writeUInt16BE(width, 7)
  frame.set([3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1], 9)
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, frame, Buffer.from([0xff, 0xd9])])
}
function riff(chunk: string, body: Buffer): Buffer {
  const size = Buffer.alloc(4)
  size.writeUInt32LE(body.length, 0)
  const data = Buffer.concat([Buffer.from(chunk, 'latin1'), size, body])
  const total = Buffer.alloc(4)
  total.writeUInt32LE(data.length + 4, 0)
  return Buffer.concat([Buffer.from('RIFF', 'latin1'), total, Buffer.from('WEBP', 'latin1'), data])
}
export function webpImage(
  width: number,
  height: number,
  kind: 'VP8 ' | 'VP8L' | 'VP8X' = 'VP8L',
  options: { animated?: boolean } = {},
): Buffer {
  if (kind === 'VP8X') {
    const body = Buffer.alloc(10)
    body[0] = options.animated ? 0x02 : 0
    body.writeUIntLE(width - 1, 4, 3)
    body.writeUIntLE(height - 1, 7, 3)
    return riff('VP8X', body)
  }
  if (kind === 'VP8L') {
    const body = Buffer.alloc(16)
    body[0] = 0x2f
    body.writeUInt32LE((width - 1) | ((height - 1) << 14), 1)
    return riff('VP8L', body)
  }
  const body = Buffer.alloc(16)
  body.set([0x10, 0, 0, 0x9d, 0x01, 0x2a])
  body.writeUInt16LE(width, 6)
  body.writeUInt16LE(height, 8)
  return riff('VP8 ', body)
}
