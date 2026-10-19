import type { KnowledgeDocumentType } from '@score/contract'
import { bytesMatch } from './doc-types.ts'

// A file over MAX_READ_BYTES is stored as `too_large`, so its content is never read for indexing. It is still checked
// to be what its name says, from its start and (for DOCX) the zip directory at its end, with bounded positional reads.

export const START_BYTES = 64 * 1024
const EOCD_WINDOW = 22 + 0xffff
const MAX_DIRECTORY_BYTES = 8 * 1024 * 1024

export type RangeReader = (position: number, length: number) => Promise<Buffer>

/** Drops an incomplete UTF-8 sequence cut off at the end of a window. */
function wholeCharacters(bytes: Buffer): Buffer {
  let end = bytes.length
  for (let back = 0; back < 4 && end > 0; back += 1) {
    const byte = bytes[end - 1]!
    if (byte < 0x80) break
    end -= 1
    if (byte >= 0xc0) break
  }
  return bytes.subarray(0, end)
}

/** The central directory and end record of a zip, laid out after its 4-byte header so the usual sniffing can read it. */
async function zipSkeleton(size: number, head: Buffer, read: RangeReader): Promise<Buffer | null> {
  const windowStart = Math.max(0, size - EOCD_WINDOW)
  const tail = await read(windowStart, size - windowStart)
  for (let at = tail.length - 22; at >= 0; at -= 1) {
    if (tail.readUInt32LE(at) !== 0x06054b50) continue
    if (at + 22 + tail.readUInt16LE(at + 20) !== tail.length) continue
    const directorySize = tail.readUInt32LE(at + 12)
    const directoryOffset = tail.readUInt32LE(at + 16)
    if (directorySize > MAX_DIRECTORY_BYTES || directoryOffset + directorySize > windowStart + at)
      continue
    const directory = await read(directoryOffset, directorySize)
    if (directory.length !== directorySize) continue
    const end = Buffer.from(tail.subarray(at))
    end.writeUInt32LE(4, 16)
    return Buffer.concat([head.subarray(0, 4), directory, end])
  }
  return null
}

/** Whether a big file looks like its type, without reading it whole. */
export async function bigFileMatches(
  type: KnowledgeDocumentType,
  size: number,
  read: RangeReader,
): Promise<{ ok: boolean; head: Buffer }> {
  const head = await read(0, Math.min(size, START_BYTES))
  switch (type) {
    case 'pdf':
    case 'image':
    case 'zip':
      return { ok: bytesMatch(type, head), head }
    case 'csv':
    case 'json':
    case 'html':
      return { ok: bytesMatch(type, wholeCharacters(head)), head }
    case 'docx': {
      const skeleton = await zipSkeleton(size, head, read)
      return { ok: skeleton !== null && bytesMatch('docx', skeleton), head }
    }
  }
}
