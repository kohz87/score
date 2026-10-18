// A hand-written zip builder for tests: every header field a reader judges can be set on its own, so a package can
// be crafted whose local headers, central directory and extra fields disagree. Stored entries only. Pure.

export interface ZipSpec {
  /** Name in the central directory. */
  name: string
  /** Name in the local header (defaults to `name`). */
  localName?: string
  data?: Uint8Array | string
  centralExtra?: Uint8Array
  localExtra?: Uint8Array
  /** General-purpose flags of the central entry / of the local header (default 0x800: UTF-8 names). */
  flags?: number
  localFlags?: number
  /** Unix mode in the external attributes (0o120777 is a symlink); the entry is then marked as made on Unix. */
  unixMode?: number
  /** Low bits of the external attributes (MS-DOS style): 0x10 marks a directory, 0x20 an ordinary archived file. */
  dosAttributes?: number
  /** Written into the local header instead of the real size. */
  localSize?: number
  /** Method written into the local header instead of 0 (stored). */
  localMethod?: number
}

const text = new TextEncoder()
const bytesOf = (data: Uint8Array | string | undefined) =>
  typeof data === 'string' ? text.encode(data) : (data ?? new Uint8Array())

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let k = 0; k < 8; k += 1) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
  }
  return (crc ^ 0xffffffff) >>> 0
}

/** An Info-ZIP Unicode Path extra field (0x7075): readers that honour it show `unicodeName` instead of the header's. */
export function unicodePathExtra(headerName: string, unicodeName: string): Uint8Array {
  const name = text.encode(unicodeName)
  const out = new Uint8Array(9 + name.length)
  const view = new DataView(out.buffer)
  view.setUint16(0, 0x7075, true)
  view.setUint16(2, 5 + name.length, true)
  view.setUint8(4, 1)
  view.setUint32(5, crc32(text.encode(headerName)), true)
  out.set(name, 9)
  return out
}

/** An extra field that renames nothing: Info-ZIP Unicode Comment (0x6375). */
export function unicodeCommentExtra(comment: string): Uint8Array {
  const body = text.encode(comment)
  const out = new Uint8Array(9 + body.length)
  const view = new DataView(out.buffer)
  view.setUint16(0, 0x6375, true)
  view.setUint16(2, 5 + body.length, true)
  view.setUint8(4, 1)
  view.setUint32(5, crc32(body), true)
  out.set(body, 9)
  return out
}

export function buildZip(entries: ZipSpec[]): Uint8Array {
  const parts: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0
  for (const entry of entries) {
    const data = bytesOf(entry.data)
    const centralName = text.encode(entry.name)
    const localName = text.encode(entry.localName ?? entry.name)
    const localExtra = entry.localExtra ?? new Uint8Array()
    const centralExtra = entry.centralExtra ?? new Uint8Array()
    const crc = crc32(data)
    const local = new Uint8Array(30 + localName.length + localExtra.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(4, 20, true)
    lv.setUint16(6, entry.localFlags ?? entry.flags ?? 0x800, true)
    lv.setUint16(8, entry.localMethod ?? 0, true)
    lv.setUint32(14, crc, true)
    lv.setUint32(18, entry.localSize ?? data.length, true)
    lv.setUint32(22, entry.localSize ?? data.length, true)
    lv.setUint16(26, localName.length, true)
    lv.setUint16(28, localExtra.length, true)
    local.set(localName, 30)
    local.set(localExtra, 30 + localName.length)
    const head = new Uint8Array(46 + centralName.length + centralExtra.length)
    const hv = new DataView(head.buffer)
    hv.setUint32(0, 0x02014b50, true)
    hv.setUint16(4, entry.unixMode === undefined ? 20 : (3 << 8) | 20, true)
    hv.setUint16(6, 20, true)
    hv.setUint16(8, entry.flags ?? 0x800, true)
    hv.setUint32(16, crc, true)
    hv.setUint32(20, data.length, true)
    hv.setUint32(24, data.length, true)
    hv.setUint16(28, centralName.length, true)
    hv.setUint16(30, centralExtra.length, true)
    const external = ((entry.unixMode ?? 0) << 16) | (entry.dosAttributes ?? 0)
    if (external !== 0) hv.setUint32(38, external >>> 0, true)
    hv.setUint32(42, offset, true)
    head.set(centralName, 46)
    head.set(centralExtra, 46 + centralName.length)
    parts.push(local, data)
    central.push(head)
    offset += local.length + data.length
  }
  const centralSize = central.reduce((sum, item) => sum + item.length, 0)
  const end = new Uint8Array(22)
  const ev = new DataView(end.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, entries.length, true)
  ev.setUint16(10, entries.length, true)
  ev.setUint32(12, centralSize, true)
  ev.setUint32(16, offset, true)
  const all = [...parts, ...central, end]
  const out = new Uint8Array(all.reduce((sum, item) => sum + item.length, 0))
  let at = 0
  for (const item of all) {
    out.set(item, at)
    at += item.length
  }
  return out
}
