import { crc32, deflateSync } from 'node:zlib'

/** RGBX framebuffer → PNG (RGB, filter 0, zlib level 3). */
export function encodePng(width: number, height: number, rgbx: Uint8Array): Buffer {
  const stride = width * 3 + 1
  const raw = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++) {
    const row = y * stride
    let src = y * width * 4
    for (let x = 0; x < width; x++, src += 4) {
      const dst = row + 1 + x * 3
      raw[dst] = rgbx[src]!
      raw[dst + 1] = rgbx[src + 1]!
      raw[dst + 2] = rgbx[src + 2]!
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8)
    head.writeUInt32BE(data.length, 0)
    head.write(type, 4, 'latin1')
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0)
    return Buffer.concat([head, data, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 3 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
