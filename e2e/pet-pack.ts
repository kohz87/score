import { crc32, deflateSync } from 'node:zlib'

// Generated, neutral pet packs for specs (decisions 107–108): a flat-coloured round creature on a transparent
// background, never anyone's art. Animated PNG (APNG, extension .png) because it needs no encoder beyond zlib.

type Rgba = [number, number, number, number]

const chunk = (type: string, data: Buffer) => {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'ascii')
  const tail = Buffer.alloc(4)
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0)
  return Buffer.concat([head, data, tail])
}

function rows(width: number, height: number, pixel: (x: number, y: number) => Rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y += 1) {
    const base = y * (width * 4 + 1)
    for (let x = 0; x < width; x += 1) raw.set(pixel(x, y), base + 1 + x * 4)
  }
  return deflateSync(raw)
}

/** An animated PNG: every frame the full size, looping forever. */
export function makeApng(
  width: number,
  height: number,
  frames: ((x: number, y: number) => Rgba)[],
  delayMs = 120,
): Buffer {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 6 // RGBA
  const control = Buffer.alloc(8)
  control.writeUInt32BE(frames.length, 0)
  control.writeUInt32BE(0, 4) // loop forever
  const parts: Buffer[] = [
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('acTL', control),
  ]
  let sequence = 0
  frames.forEach((pixel, index) => {
    const fctl = Buffer.alloc(26)
    fctl.writeUInt32BE(sequence++, 0)
    fctl.writeUInt32BE(width, 4)
    fctl.writeUInt32BE(height, 8)
    fctl.writeUInt16BE(delayMs, 20)
    fctl.writeUInt16BE(1000, 22)
    parts.push(chunk('fcTL', fctl))
    const data = rows(width, height, pixel)
    if (index === 0) parts.push(chunk('IDAT', data))
    else {
      const seq = Buffer.alloc(4)
      seq.writeUInt32BE(sequence++, 0)
      parts.push(chunk('fdAT', Buffer.concat([seq, data])))
    }
  })
  parts.push(chunk('IEND', Buffer.alloc(0)))
  return Buffer.concat(parts)
}

const SIZE = { width: 96, height: 128 }

/** A round creature with two eyes, bobbing; `accent` marks the activity so the files differ. */
function creature(body: Rgba, accent: Rgba, bob: number, desk: boolean) {
  const cx = SIZE.width / 2
  const cy = 74 - bob
  return (x: number, y: number): Rgba => {
    if (desk && y > 100 && y < 112 && x > 10 && x < 86) return accent
    const eye = (ex: number) => Math.hypot(x - ex, y - (cy - 6)) < 4.5
    const inside = ((x - cx) / 30) ** 2 + ((y - cy) / 34) ** 2 < 1
    if (!inside) return [0, 0, 0, 0]
    if (eye(cx - 11) || eye(cx + 11)) return [24, 26, 40, 255]
    return y > cy + 22 ? accent : body
  }
}

export function activityPng(activity: string): Buffer {
  const palette: Record<string, [Rgba, Rgba]> = {
    idle: [
      [150, 196, 240, 255],
      [110, 160, 220, 255],
    ],
    work: [
      [150, 196, 240, 255],
      [240, 190, 90, 255],
    ],
    think: [
      [170, 150, 230, 255],
      [130, 110, 200, 255],
    ],
    needs: [
      [240, 150, 150, 255],
      [200, 90, 90, 255],
    ],
    sleep: [
      [130, 150, 190, 255],
      [100, 120, 160, 255],
    ],
    walk: [
      [150, 220, 190, 255],
      [100, 180, 150, 255],
    ],
    greet: [
      [240, 210, 150, 255],
      [220, 170, 90, 255],
    ],
    happy: [
      [250, 200, 220, 255],
      [230, 150, 180, 255],
    ],
  }
  const [body, accent] = palette[activity] ?? palette.idle!
  const frames = [0, 3, 5, 3].map((bob) => creature(body, accent, bob, activity === 'work'))
  return makeApng(SIZE.width, SIZE.height, frames)
}

export type PackFile = { name: string; mimeType: string; buffer: Buffer }

/** The files of a small pack: the named activities as animated PNGs, and a pet.json. */
export function packFiles(activities: string[], manifest?: object): PackFile[] {
  const files: PackFile[] = activities.map((activity) => ({
    name: `${activity}.png`,
    mimeType: 'image/png',
    buffer: activityPng(activity),
  }))
  if (manifest)
    files.push({
      name: 'pet.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(manifest)),
    })
  return files
}

/** A ZIP (stored, no compression) of files, with the shared top-level folder many zip tools add. */
export function zipOf(files: { name: string; buffer: Buffer }[]): Buffer {
  const local: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const file of files) {
    const name = Buffer.from(file.name)
    const crc = crc32(file.buffer)
    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt32LE(crc, 14)
    header.writeUInt32LE(file.buffer.length, 18)
    header.writeUInt32LE(file.buffer.length, 22)
    header.writeUInt16LE(name.length, 26)
    const entry = Buffer.concat([header, name, file.buffer])
    const dir = Buffer.alloc(46)
    dir.writeUInt32LE(0x02014b50, 0)
    dir.writeUInt16LE(20, 4)
    dir.writeUInt16LE(20, 6)
    dir.writeUInt32LE(crc, 16)
    dir.writeUInt32LE(file.buffer.length, 20)
    dir.writeUInt32LE(file.buffer.length, 24)
    dir.writeUInt16LE(name.length, 28)
    dir.writeUInt32LE(offset, 42)
    central.push(Buffer.concat([dir, name]))
    local.push(entry)
    offset += entry.length
  }
  const directory = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, directory, end])
}
