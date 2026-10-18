// A small zip reader and writer for theme packages (PLAN 9.4), so the Customizer can show what an import holds
// before anything is sent, and can export a draft that isn't saved. Writing stores files uncompressed; reading
// handles stored and deflated entries (the browser's own DecompressionStream does the inflating). No dependency.

const crcTable = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

const utf8 = new TextEncoder()

/** 2000-01-01 00:00 in MS-DOS date and time: the same bytes every time, like the server's export. */
const DOS_DATE = ((2000 - 1980) << 9) | (1 << 5) | 1

/** Builds a zip of stored (uncompressed) entries, in the order given. */
export function writeZip(files: [string, Uint8Array][]): Uint8Array {
  const chunks: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0
  for (const [name, data] of files) {
    const nameBytes = utf8.encode(name)
    const crc = crc32(data)
    const local = new Uint8Array(30 + nameBytes.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(4, 20, true)
    lv.setUint16(6, 0x0800, true) // names are UTF-8
    lv.setUint16(8, 0, true) // stored
    lv.setUint16(10, 0, true)
    lv.setUint16(12, DOS_DATE, true)
    lv.setUint32(14, crc, true)
    lv.setUint32(18, data.length, true)
    lv.setUint32(22, data.length, true)
    lv.setUint16(26, nameBytes.length, true)
    local.set(nameBytes, 30)
    chunks.push(local, data)

    const entry = new Uint8Array(46 + nameBytes.length)
    const cv = new DataView(entry.buffer)
    cv.setUint32(0, 0x02014b50, true)
    cv.setUint16(4, 20, true)
    cv.setUint16(6, 20, true)
    cv.setUint16(8, 0x0800, true)
    cv.setUint16(10, 0, true)
    cv.setUint16(12, 0, true)
    cv.setUint16(14, DOS_DATE, true)
    cv.setUint32(16, crc, true)
    cv.setUint32(20, data.length, true)
    cv.setUint32(24, data.length, true)
    cv.setUint16(28, nameBytes.length, true)
    cv.setUint32(42, offset, true)
    entry.set(nameBytes, 46)
    central.push(entry)
    offset += local.length + data.length
  }
  const centralSize = central.reduce((sum, item) => sum + item.length, 0)
  const end = new Uint8Array(22)
  const ev = new DataView(end.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, files.length, true)
  ev.setUint16(10, files.length, true)
  ev.setUint32(12, centralSize, true)
  ev.setUint32(16, offset, true)
  const all = [...chunks, ...central, end]
  const out = new Uint8Array(all.reduce((sum, item) => sum + item.length, 0))
  let at = 0
  for (const item of all) {
    out.set(item, at)
    at += item.length
  }
  return out
}

export class ZipError extends Error {}

export type ZipLimits = { entries: number; fileBytes: number; totalBytes: number }
const DEFAULT_LIMITS: ZipLimits = {
  entries: 60,
  fileBytes: 8 * 1024 * 1024,
  totalBytes: 20 * 1024 * 1024,
}

async function inflate(data: Uint8Array, limit: number): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined')
    throw new ZipError('This browser can’t open compressed zip files.')
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(data)
      controller.close()
    },
  })
  const stream = source.pipeThrough(
    new DecompressionStream('deflate-raw') as ReadableWritablePair<Uint8Array, Uint8Array>,
  )
  const reader = stream.getReader()
  const parts: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > limit) {
      void reader.cancel()
      throw new ZipError('A file in the zip is larger than it says it is.')
    }
    parts.push(value)
  }
  const out = new Uint8Array(total)
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

/**
 * The files of a zip by name. Folders are skipped. Anything odd (a path that leaves the folder, too many files, a size
 * that lies) throws a ZipError with a plain message; the server checks again when the file is sent.
 */
export async function readZip(
  bytes: Uint8Array,
  limits: ZipLimits = DEFAULT_LIMITS,
): Promise<Map<string, Uint8Array>> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let end = -1
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 0xffff); at--) {
    if (view.getUint32(at, true) === 0x06054b50) {
      end = at
      break
    }
  }
  if (end < 0) throw new ZipError('That isn’t a zip file.')
  // Anything after the end record could hide a second one that another reader would pick instead.
  if (end + 22 + view.getUint16(end + 20, true) !== bytes.length)
    throw new ZipError('That zip file couldn’t be read.')
  const count = view.getUint16(end + 10, true)
  if (count > limits.entries) throw new ZipError('The zip holds more files than a theme can.')
  let at = view.getUint32(end + 16, true)
  const decoder = new TextDecoder('utf-8')
  const files = new Map<string, Uint8Array>()
  // Every name seen, folders included and case ignored: the server refuses such a package, so the preview must too.
  const seen = new Set<string>()
  const ranges: [number, number][] = []
  let total = 0
  for (let index = 0; index < count; index++) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== 0x02014b50)
      throw new ZipError('That zip file couldn’t be read.')
    const flags = view.getUint16(at + 8, true)
    const method = view.getUint16(at + 10, true)
    const packed = view.getUint32(at + 20, true)
    const size = view.getUint32(at + 24, true)
    const nameLength = view.getUint16(at + 28, true)
    const extraLength = view.getUint16(at + 30, true)
    const commentLength = view.getUint16(at + 32, true)
    const local = view.getUint32(at + 42, true)
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength))
    const nameBytes = bytes.subarray(at + 46, at + 46 + nameLength)
    const crc = view.getUint32(at + 16, true)
    at += 46 + nameLength + extraLength + commentLength
    if (flags & 1) throw new ZipError('That zip file is encrypted.')
    const key = name.replace(/\/$/, '').toLowerCase()
    if (seen.has(key)) throw new ZipError(`“${name.slice(0, 60)}” appears twice.`)
    seen.add(key)
    // The server reads the local headers: they must say what the central directory says (gate finding #1).
    if (local + 30 > bytes.length || view.getUint32(local, true) !== 0x04034b50)
      throw new ZipError('That zip file couldn’t be read.')
    const localName = bytes.subarray(local + 30, local + 30 + view.getUint16(local + 26, true))
    const localFlags = view.getUint16(local + 6, true)
    const sameSizes =
      (localFlags & 8) !== 0 ||
      (view.getUint32(local + 14, true) === crc &&
        view.getUint32(local + 18, true) === packed &&
        view.getUint32(local + 22, true) === size)
    if (
      localName.length !== nameBytes.length ||
      localName.some((byte, i) => byte !== nameBytes[i]) ||
      view.getUint16(local + 8, true) !== method ||
      (localFlags & 0x801) !== (flags & 0x801) ||
      !sameSizes
    )
      throw new ZipError(`“${name.slice(0, 60)}”: the zip’s headers don’t match each other.`)
    const dataStart = local + 30 + localName.length + view.getUint16(local + 28, true)
    ranges.push([local, dataStart + packed])
    if (name.endsWith('/')) continue
    if (
      name.includes('\\') ||
      name.startsWith('/') ||
      name.split('/').some((part) => part === '..' || part === '.' || part === '')
    )
      throw new ZipError(`“${name.slice(0, 60)}” isn’t a safe file name.`)
    if (size > limits.fileBytes) throw new ZipError(`“${name.slice(0, 60)}” is too large.`)
    total += size
    if (total > limits.totalBytes)
      throw new ZipError('The zip unpacks to more than a theme can hold.')
    const raw = bytes.subarray(dataStart, dataStart + packed)
    if (raw.length !== packed) throw new ZipError('That zip file is cut short.')
    let data: Uint8Array
    if (method === 0) data = raw
    else if (method === 8) data = await inflate(raw, size)
    else throw new ZipError('That zip file uses a method Score can’t read.')
    if (data.length !== size) throw new ZipError(`“${name.slice(0, 60)}” doesn’t match its size.`)
    files.set(name, data)
  }
  // Two entries sharing stored bytes would let one file stand in for another.
  ranges.sort((a, b) => a[0] - b[0])
  for (let i = 1; i < ranges.length; i++)
    if (ranges[i]![0] < ranges[i - 1]![1]) throw new ZipError('That zip file couldn’t be read.')
  return files
}
