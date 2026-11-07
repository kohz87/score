import { createHash } from 'node:crypto'
import { assertAllowedSegments } from './policy.ts'

export const RAW_TYPES: Record<string, { type: string; magic: (head: Buffer) => boolean }> = {
  '.png': {
    type: 'image/png',
    magic: (b) => b.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])),
  },
  '.jpg': { type: 'image/jpeg', magic: (b) => b[0] === 0xff && b[1] === 0xd8 },
  '.jpeg': { type: 'image/jpeg', magic: (b) => b[0] === 0xff && b[1] === 0xd8 },
  '.gif': { type: 'image/gif', magic: (b) => b.subarray(0, 3).toString('latin1') === 'GIF' },
  '.webp': {
    type: 'image/webp',
    magic: (b) =>
      b.subarray(0, 4).toString('latin1') === 'RIFF' &&
      b.subarray(8, 12).toString('latin1') === 'WEBP',
  },
  '.pdf': { type: 'application/pdf', magic: (b) => b.subarray(0, 4).toString('latin1') === '%PDF' },
}

export function etagOf(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 32)
}

// Blocked names are never listed. `.git` itself is listed (its internals are not reachable).
export function isBlockedEntry(name: string): boolean {
  try {
    assertAllowedSegments([name], 'list')
    return false
  } catch {
    return true
  }
}

export function decodeText(bytes: Buffer): string | null {
  // The same rule as write(): a NUL anywhere makes the file binary.
  if (bytes.includes(0)) return null
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}
