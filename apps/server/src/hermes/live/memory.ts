import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { redactBounded } from '../../redact.ts'
import type { MemoryItem } from '@score/contract'

// Built-in memory is two plain files in <profile>/memories/; entries are separated by a "§" line. They are
// opened read-only through a descriptor (no symlinks, size-capped). Hermes offers no CLI verb or gateway call to
// add or remove one entry, so Score does not write them (the port answers 501).
const MAX_BYTES = 256 * 1024
const FILES = [
  { name: 'MEMORY.md', prefix: 'm', source: 'Agent notes' },
  { name: 'USER.md', prefix: 'u', source: 'About you' },
] as const

function readFile(path: string): { text: string; mtime: Date } | null {
  try {
    const stat = fs.lstatSync(path)
    if (!stat.isFile() || stat.size > MAX_BYTES) return null
    const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    try {
      const buffer = Buffer.alloc(stat.size + 1)
      const length = fs.readSync(fd, buffer, 0, buffer.length, 0)
      if (length > stat.size) return null
      return { text: buffer.subarray(0, length).toString('utf8'), mtime: stat.mtime }
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return null
  }
}

/** All memory entries, reversed so the latest entry leads. */
export function readMemory(home: string): MemoryItem[] {
  const dir = join(home, 'memories')
  const items: MemoryItem[] = []
  for (const file of FILES) {
    const content = readFile(join(dir, file.name))
    if (!content) continue
    const at = content.mtime.toISOString()
    const seen = new Set<string>()
    const entries = content.text
      .split(/\r?\n§\r?\n/)
      .map((entry) => entry.trim())
      .filter(Boolean)
    for (const entry of entries) {
      const id = `${file.prefix}-${createHash('sha1').update(entry).digest('hex').slice(0, 12)}`
      if (seen.has(id)) continue
      seen.add(id)
      items.push({ id, text: redactBounded(entry, 2000), source: file.source, at })
    }
  }
  return items.reverse()
}
