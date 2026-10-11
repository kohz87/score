import { crc32, deflateSync } from 'node:zlib'

/** A real PNG made from a pixel function, for specs that need a picture a browser can decode. */
export function makePng(
  width: number,
  height: number,
  pixel: (x: number, y: number) => [number, number, number],
): Buffer {
  const rows = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y += 1) {
    const base = y * (width * 3 + 1)
    rows[base] = 0
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = pixel(x, y)
      rows[base + 1 + x * 3] = r
      rows[base + 2 + x * 3] = g
      rows[base + 3 + x * 3] = b
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
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** A colourful gradient with a bright disc: obviously a picture in a screenshot. */
export const samplePng = (width: number, height: number) =>
  makePng(width, height, (x, y) => {
    const dx = x - width * 0.7
    const dy = y - height * 0.4
    if (dx * dx + dy * dy < (height * 0.22) ** 2) return [255, 214, 102]
    return [Math.round((x / width) * 120) + 40, Math.round((y / height) * 140) + 60, 200]
  })

/** Width and height from a PNG's IHDR chunk. */
export function pngSize(bytes: Buffer): { width: number; height: number } {
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}
