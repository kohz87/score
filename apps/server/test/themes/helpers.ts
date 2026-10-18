import JSZip from 'jszip'

export const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('png body'),
])
export const WOFF2 = Buffer.concat([Buffer.from('wOF2'), Buffer.from('font body')])
export const WEBP = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.from([1, 0, 0, 0]),
  Buffer.from('WEBPVP8 '),
])
export const AVIF = Buffer.concat([
  Buffer.from([0, 0, 0, 0x1c]),
  Buffer.from('ftypavif'),
  Buffer.from('....'),
])
export const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])
export const manifestJson = (extra: object = {}) =>
  JSON.stringify({ format: 1, id: 'seaside', name: 'Seaside', ...extra })

export type Entry = string | Buffer | { data: string | Buffer; unixPermissions?: number }
/** Builds a zip from raw names, so traversal and odd paths survive into the archive. */
export async function zipOf(
  entries: Record<string, Entry>,
  generate: { compression?: 'STORE' | 'DEFLATE' } = {},
): Promise<Buffer> {
  const zip = new JSZip()
  for (const [name, entry] of Object.entries(entries)) {
    const { data, unixPermissions } =
      typeof entry === 'string' || Buffer.isBuffer(entry) ? { data: entry } : entry
    zip.file(name, data, { ...(unixPermissions ? { unixPermissions } : {}), createFolders: false })
  }
  return zip.generateAsync({
    type: 'nodebuffer',
    platform: 'UNIX',
    compression: generate.compression ?? 'DEFLATE',
  })
}

export interface RawEntry {
  /** Name in the local header (defaults to `name`). */
  localName?: string
  /** Name in the central directory. */
  name: string
  data: string | Buffer
  /** Size written into the local header instead of the real one. */
  localSize?: number
  /** Method in the local header instead of 0 (stored). */
  localMethod?: number
}

/** A stored zip written by hand so the local headers and the central directory can disagree. */
export function rawZip(entries: RawEntry[]): Buffer {
  const chunks: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const data = Buffer.from(entry.data)
    const localName = Buffer.from(entry.localName ?? entry.name)
    const centralName = Buffer.from(entry.name)
    let crc = 0xffffffff
    for (const byte of data) {
      crc ^= byte
      for (let k = 0; k < 8; k += 1) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
    }
    crc = (crc ^ 0xffffffff) >>> 0
    const local = Buffer.alloc(30 + localName.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(entry.localMethod ?? 0, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(entry.localSize ?? data.length, 18)
    local.writeUInt32LE(entry.localSize ?? data.length, 22)
    local.writeUInt16LE(localName.length, 26)
    localName.copy(local, 30)
    const head = Buffer.alloc(46 + centralName.length)
    head.writeUInt32LE(0x02014b50, 0)
    head.writeUInt16LE(20, 4)
    head.writeUInt16LE(20, 6)
    head.writeUInt32LE(crc, 16)
    head.writeUInt32LE(data.length, 20)
    head.writeUInt32LE(data.length, 24)
    head.writeUInt16LE(centralName.length, 28)
    head.writeUInt32LE(offset, 42)
    centralName.copy(head, 46)
    chunks.push(local, data)
    central.push(head)
    offset += local.length + data.length
  }
  const size = central.reduce((sum, item) => sum + item.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(size, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...chunks, ...central, end])
}
