// Gate finding #1 (Phase 9): a zip lists every file twice, in the central directory and in a local header before its
// data. A previewing reader and the installing reader may take different lists, so a package whose two lists disagree
// could show one theme and install another. Everything here is judged from the raw bytes, before JSZip reads them:
// the two lists must agree on name, method, flags that change how the name is read, and sizes; names are unique (case is judged by the
// layout check in package.ts); and the stored data of two files never overlaps.

import { extraFieldProblem } from '@score/contract'

export class ZipStructureError extends Error {}

const EOCD = 0x06054b50
const CENTRAL = 0x02014b50
const LOCAL = 0x04034b50

const mismatch = (name: string) =>
  new ZipStructureError(`${name.slice(0, 60)}: the zip’s headers don’t match each other`)

export interface ZipEntryInfo {
  name: string
  localOffset: number
}

/** Throws `ZipStructureError` unless the central directory and the local headers describe the same files. */
export function checkZipStructure(bytes: Buffer): ZipEntryInfo[] {
  let end = -1
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 0xffff); at -= 1) {
    if (bytes.readUInt32LE(at) === EOCD) {
      end = at
      break
    }
  }
  if (end < 0) throw new ZipStructureError('That zip file couldn’t be read')
  // A comment that stops short of the end could hide a second end record; readers could pick different ones.
  if (end + 22 + bytes.readUInt16LE(end + 20) !== bytes.length)
    throw new ZipStructureError('That zip file has data after its end record')
  const disk = bytes.readUInt16LE(end + 4)
  const centralDisk = bytes.readUInt16LE(end + 6)
  const onDisk = bytes.readUInt16LE(end + 8)
  const count = bytes.readUInt16LE(end + 10)
  const centralSize = bytes.readUInt32LE(end + 12)
  const centralStart = bytes.readUInt32LE(end + 16)
  if (disk !== 0 || centralDisk !== 0 || onDisk !== count)
    throw new ZipStructureError('Zips in several parts are not allowed')
  if (count === 0xffff || centralStart === 0xffffffff || centralSize === 0xffffffff)
    throw new ZipStructureError('Zip64 packages are not allowed')
  if (centralStart + centralSize !== end)
    throw new ZipStructureError('That zip file has data between its files and its file list')

  const entries: ZipEntryInfo[] = []
  const names = new Set<string>()
  const ranges: [number, number, string][] = []
  let at = centralStart
  for (let index = 0; index < count; index += 1) {
    if (at + 46 > end || bytes.readUInt32LE(at) !== CENTRAL)
      throw new ZipStructureError('That zip file couldn’t be read')
    const flags = bytes.readUInt16LE(at + 8)
    const method = bytes.readUInt16LE(at + 10)
    const crc = bytes.readUInt32LE(at + 16)
    const packed = bytes.readUInt32LE(at + 20)
    const size = bytes.readUInt32LE(at + 24)
    const nameLength = bytes.readUInt16LE(at + 28)
    const extraLength = bytes.readUInt16LE(at + 30)
    const commentLength = bytes.readUInt16LE(at + 32)
    const localOffset = bytes.readUInt32LE(at + 42)
    const nameBytes = bytes.subarray(at + 46, at + 46 + nameLength)
    const name = nameBytes.toString('utf8')
    const next = at + 46 + nameLength + extraLength + commentLength
    if (next > end) throw new ZipStructureError('That zip file couldn’t be read')
    // Re-gate finding 1: an extra field that gives the entry another name is read by JSZip but not by this check.
    const centralExtra = extraFieldProblem(
      bytes.subarray(at + 46 + nameLength, at + 46 + nameLength + extraLength),
    )
    if (centralExtra) throw new ZipStructureError(`${name.slice(0, 60)}: ${centralExtra}`)
    at = next

    const key = name.replace(/\/$/, '')
    if (names.has(key))
      throw new ZipStructureError(`${name.slice(0, 60)}: appears twice in the zip (duplicate name)`)
    names.add(key)

    if (localOffset + 30 > centralStart || bytes.readUInt32LE(localOffset) !== LOCAL)
      throw new ZipStructureError('That zip file couldn’t be read')
    const localFlags = bytes.readUInt16LE(localOffset + 6)
    const localMethod = bytes.readUInt16LE(localOffset + 8)
    const localNameLength = bytes.readUInt16LE(localOffset + 26)
    const localExtraLength = bytes.readUInt16LE(localOffset + 28)
    const localName = bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength)
    if (!localName.equals(nameBytes)) throw mismatch(name)
    if (localMethod !== method || (localFlags & 0x801) !== (flags & 0x801)) throw mismatch(name)
    // With a data descriptor (bit 3) the local header's crc and sizes are zero; otherwise they must match.
    if ((localFlags & 8) === 0) {
      if (
        bytes.readUInt32LE(localOffset + 14) !== crc ||
        bytes.readUInt32LE(localOffset + 18) !== packed ||
        bytes.readUInt32LE(localOffset + 22) !== size
      )
        throw mismatch(name)
    }
    const localExtra = extraFieldProblem(
      bytes.subarray(
        localOffset + 30 + localNameLength,
        localOffset + 30 + localNameLength + localExtraLength,
      ),
    )
    if (localExtra) throw new ZipStructureError(`${name.slice(0, 60)}: ${localExtra}`)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const dataEnd = dataStart + packed
    if (dataEnd > centralStart) throw new ZipStructureError('That zip file is cut short')
    ranges.push([localOffset, dataEnd, name])
    entries.push({ name, localOffset })
  }
  if (at !== end) throw new ZipStructureError('That zip file couldn’t be read')

  ranges.sort((a, b) => a[0] - b[0])
  for (let i = 1; i < ranges.length; i += 1)
    if (ranges[i]![0] < ranges[i - 1]![1]) throw mismatch(ranges[i]![2])
  return entries
}
