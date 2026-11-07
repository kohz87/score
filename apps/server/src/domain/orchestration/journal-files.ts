import { existsSync, readFileSync, truncateSync, openSync, closeSync } from 'node:fs'
import { EntrySchema, type JournalEntry } from './journal-entry.ts'
import { checksum, type JournalIo, type JournalRead } from './journal-io.ts'

export function parse(file: string): JournalRead {
  if (!existsSync(file)) return { ok: true, entries: [], bytes: 0 }
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch (error) {
    return { ok: false, reason: `unreadable: ${String(error)}`, bytes: 0 }
  }
  const bytes = Buffer.byteLength(raw)
  const lines = raw.split('\n')
  // A last line without its newline was never completely written, so its effect had not started: dropping the final
  // element handles both the empty string after a trailing newline and a torn tail.
  const complete = lines.slice(0, -1)
  const entries: JournalEntry[] = []
  let last = 0
  for (const [index, line] of complete.entries()) {
    try {
      const object = JSON.parse(line) as Record<string, unknown>
      const { c, ...body } = object
      if (typeof c !== 'string' || c !== checksum(JSON.stringify(body)))
        return { ok: false, reason: `line ${index + 1} fails its checksum`, bytes }
      const entry = EntrySchema.parse(body)
      if (entry.n <= last)
        return { ok: false, reason: `line ${index + 1} is out of sequence`, bytes }
      last = entry.n
      entries.push(entry)
    } catch {
      return { ok: false, reason: `line ${index + 1} is not a journal entry`, bytes }
    }
  }
  return { ok: true, entries, bytes }
}

/** Cuts an unterminated last line (never effective: its writer did not return) and makes the cut durable. */
export function repairTail(file: string, io: JournalIo): void {
  if (!existsSync(file)) return
  const raw = readFileSync(file, 'utf8')
  if (raw.length === 0 || raw.endsWith('\n')) return
  const keep = raw.lastIndexOf('\n') + 1
  truncateSync(file, Buffer.byteLength(raw.slice(0, keep)))
  const fd = openSync(file, 'r+')
  try {
    io.fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/** The newest entry number in the file, read from its tail. */
export function tailN(file: string): number {
  try {
    const raw = readFileSync(file, 'utf8')
    const lines = raw.split('\n').filter(Boolean)
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const n = (JSON.parse(lines[i]!) as { n?: unknown }).n
        if (typeof n === 'number') return n
      } catch {
        // a torn last line
      }
    }
  } catch {
    // no file yet
  }
  return 0
}

/** Errors propagate: a name that may not survive a crash is not a witness. */
export function syncDirectory(dir: string, io: JournalIo): void {
  const fd = openSync(dir, 'r')
  try {
    io.fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}
