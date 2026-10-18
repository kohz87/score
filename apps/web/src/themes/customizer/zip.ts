// A small zip reader and writer for theme packages (PLAN 9.4), so the Customizer can show what an import holds
// before anything is sent, and can export a draft that isn't saved. Writing stores files uncompressed; reading
// handles stored and deflated entries (the browser's own DecompressionStream does the inflating). No dependency.

import { readZipDirectory, ThemePackageError, type ZipEntryInfo } from '@score/contract'

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

/** A plain sentence for the person: the shared rules' messages, with a full stop. */
const sentence = (message: string) => (/[.!?]$/.test(message) ? message : `${message}.`)

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
 * The entries of a zip as the shared package rules read them (the same code the server runs): the central directory
 * against the local headers, names, extra fields, flags, symlink metadata. Nothing is inflated.
 */
export function listZip(bytes: Uint8Array): ZipEntryInfo[] {
  try {
    return readZipDirectory(bytes)
  } catch (error) {
    if (error instanceof ThemePackageError) throw new ZipError(sentence(error.message))
    throw error
  }
}

/** Inflates the files of already-listed entries (folders skipped), judging real bytes against the declared sizes. */
export async function extractZip(
  bytes: Uint8Array,
  entries: readonly ZipEntryInfo[],
  limits: Pick<ZipLimits, 'fileBytes' | 'totalBytes'> = DEFAULT_LIMITS,
): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>()
  let total = 0
  for (const entry of entries) {
    if (entry.isDir) continue
    if (entry.size > limits.fileBytes)
      throw new ZipError(`“${entry.name.slice(0, 60)}” is too large.`)
    total += entry.size
    if (total > limits.totalBytes)
      throw new ZipError('The zip unpacks to more than a theme can hold.')
    const raw = bytes.subarray(entry.dataStart, entry.dataStart + entry.packed)
    if (raw.length !== entry.packed) throw new ZipError('That zip file is cut short.')
    const data = entry.method === 0 ? raw : await inflate(raw, entry.size)
    if (data.length !== entry.size)
      throw new ZipError(`“${entry.name.slice(0, 60)}” doesn’t match its size.`)
    files.set(entry.name, data)
  }
  return files
}

/**
 * The files of a zip by name. Folders are skipped. Anything odd (a path that leaves the folder, too many files, a size
 * that lies) throws a ZipError with a plain message; the server checks again when the file is sent.
 */
export async function readZip(
  bytes: Uint8Array,
  limits: ZipLimits = DEFAULT_LIMITS,
): Promise<Map<string, Uint8Array>> {
  const entries = listZip(bytes)
  if (entries.length > limits.entries)
    throw new ZipError('The zip holds more files than a theme can.')
  for (const { name, isDir } of entries) {
    if (isDir) continue
    if (
      name.startsWith('/') ||
      name.includes('\\') ||
      name.split('/').some((part) => part === '..' || part === '.' || part === '')
    )
      throw new ZipError(`“${name.slice(0, 60)}” isn’t a safe file name.`)
  }
  const seen = new Set<string>()
  for (const { name } of entries) {
    const key = name.replace(/\/$/, '').toLowerCase()
    if (seen.has(key)) throw new ZipError(`“${name.slice(0, 60)}” appears twice.`)
    seen.add(key)
  }
  return extractZip(bytes, entries, limits)
}
