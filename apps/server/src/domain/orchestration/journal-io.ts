import { createHash } from 'node:crypto'
import { fsyncSync, writeSync } from 'node:fs'
import type { JournalEntry } from './journal-entry.ts'

/** The two syscalls whose results decide durability; a seam so tests can inject short writes and sync failures. */
export interface JournalIo {
  writeSync(fd: number, buffer: Buffer, offset: number, length: number): number
  fsyncSync(fd: number): void
}
export const nodeIo: JournalIo = {
  writeSync: (fd, buffer, offset, length) => writeSync(fd, buffer, offset, length),
  fsyncSync: (fd) => fsyncSync(fd),
}

/**
 * Writes the whole buffer or throws. `writeSync` may write fewer bytes than asked; a record that is only partly on disk
 * must never count as written, because recovery discards an unterminated last line as "never effective".
 */
export function writeAll(io: JournalIo, fd: number, data: Buffer): void {
  let offset = 0
  while (offset < data.length) {
    const written = io.writeSync(fd, data, offset, data.length - offset)
    if (!Number.isInteger(written) || written <= 0)
      throw new Error('Execution journal write made no progress')
    offset += written
  }
}

/** A launch receipt folder that holds files, and when its newest file changed. */
export interface LaunchFolder {
  id: string
  mtimeMs: number
}

export type JournalRead =
  | { ok: true; entries: JournalEntry[]; bytes: number }
  | { ok: false; reason: string; bytes: number }

export const checksum = (payload: string): string =>
  createHash('sha256').update(payload).digest('hex').slice(0, 16)

/** One journal line (record + checksum + newline), exactly as the writers produce it. */
export function journalLine(entry: JournalEntry): Buffer {
  return Buffer.from(`${JSON.stringify({ ...entry, c: checksum(JSON.stringify(entry)) })}\n`)
}
