import {
  constants,
  closeSync,
  fsyncSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
} from 'node:fs'
import { userInfo } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { HttpError } from '../../errors.ts'

export const failure = (message: string) => new HttpError(409, 'conflict', message)
export function stat(path: string) {
  try {
    return lstatSync(path)
  } catch {
    return null
  }
}
export function identity(path: string): string | null {
  const value = stat(path)
  return value?.isDirectory() ? `${value.dev}:${value.ino}:${value.birthtimeMs}` : null
}
/**
 * 3.7.4: the first folder in a profile that Hermes (running as this user) can't empty — one another user owns that still
 * holds entries (Hermes' Docker sandbox writes as root), or one this user can't list. A foreign *file* in a folder this
 * user owns is fine: unlinking needs the folder, not the file. Bounded; symlinks are not followed; names only.
 */
export function foreignOwned(home: string, uid = process.getuid?.(), limit = 50000): string | null {
  if (uid === undefined) return null
  const queue = [home]
  let seen = 0
  while (queue.length > 0 && seen < limit) {
    const dir = queue.shift()!
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return dir === home ? null : dir
    }
    if (dir !== home && entries.length > 0 && stat(dir)?.uid !== uid) return dir
    for (const entry of entries) {
      seen += 1
      const path = join(dir, entry.name)
      if (stat(path)?.isDirectory()) queue.push(path)
    }
  }
  return null
}

/** What to tell the person when a profile folder holds files only another user can delete. */
export function foreignOwnedMessage(home: string, path: string): string {
  const user = userInfo().username
  // The example comes from folder names the sandbox chose: shown as plain text, without control characters, bounded.
  const example = [...relative(home, path)]
    .filter((char) => char.charCodeAt(0) > 0x1f && char.charCodeAt(0) !== 0x7f)
    .join('')
    .slice(0, 120)
  const quoted = `'${home.replace(/'/g, `'\\''`)}'`
  return `Some files in this agent's folder belong to another user (for example ${example}, made by its Docker sandbox), so Hermes can't delete them. On the Score machine run: sudo chown -R ${user}: ${quoted} — then try again.`
}

function privateDirectory(path: string) {
  mkdirSync(path, { mode: 0o700 })
  syncPath(dirname(path))
}
// Reading cached bytes doesn't prove durability: sync the file or directory itself.
function syncPath(path: string, flags = constants.O_RDONLY) {
  const fd = openSync(path, flags | constants.O_NOFOLLOW)
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}
export function syncBackup(path: string) {
  syncPath(path)
  syncPath(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY)
}
export function ensurePrivateDirectory(path: string) {
  if (!stat(path)) privateDirectory(path)
  const value = lstatSync(path)
  if (!value.isDirectory() || value.uid !== process.getuid?.() || (value.mode & 0o077) !== 0)
    throw failure('Score’s home folder must be private to your user and contain no symbolic links.')
}

/** Verify gzip CRC, tar headers, entry bounds and the profile root without extracting or logging contents. */
export function verifyProfileArchive(path: string, name: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const value = fstatSync(fd)
    if (
      !value.isFile() ||
      value.uid !== process.getuid?.() ||
      (value.mode & 0o077) !== 0 ||
      value.size > 256 * 1024 * 1024
    )
      throw failure('Couldn’t verify the private export.')
    const data = gunzipSync(readFileSync(fd), { maxOutputLength: 512 * 1024 * 1024 })
    let entries = 0
    // GNU tar (what Hermes writes) puts names over 100 bytes in a ././@LongLink record ("L") before the entry.
    let longName: string | undefined
    for (let offset = 0; offset + 512 <= data.length;) {
      const header = data.subarray(offset, offset + 512)
      if (header.every((byte) => byte === 0)) {
        if (
          !entries ||
          data.length - offset < 1024 ||
          !data.subarray(offset).every((byte) => byte === 0)
        )
          throw failure('The export archive is incomplete.')
        return
      }
      const text = (start: number, end: number) =>
        header.subarray(start, end).toString().split('\0')[0]!.trim()
      const checksum = Number.parseInt(text(148, 156), 8)
      const total = header.reduce(
        (sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte),
        0,
      )
      const size = Number.parseInt(text(124, 136) || '0', 8)
      if (
        checksum !== total ||
        !Number.isSafeInteger(size) ||
        size < 0 ||
        offset + 512 + size > data.length
      )
        throw failure('The export archive is corrupt.')
      const type = text(156, 157)
      if (type === 'L' || type === 'K') {
        // "K" is a long link target; Score never extracts the archive, so only "L" names are checked.
        if (type === 'L')
          longName = data
            .subarray(offset + 512, offset + 512 + size)
            .toString()
            .split('\0')[0]!
        offset += 512 + Math.ceil(size / 512) * 512
        continue
      }
      // The prefix field exists only in POSIX ustar headers; GNU headers use those bytes for timestamps.
      const ustar = header.subarray(257, 263).toString() === 'ustar\0'
      const entry =
        longName ?? [ustar ? text(345, 500) : '', text(0, 100)].filter(Boolean).join('/')
      longName = undefined
      // Python tarfile may prepend a PAX extended header for timestamps; it carries no extracted entry.
      if (
        !['x', 'g'].includes(type) &&
        ((!entry.startsWith(`${name}/`) && entry !== name) ||
          entry.split('/').includes('..') ||
          entry.startsWith('/'))
      )
        throw failure('The export archive has an unexpected layout.')
      entries++
      offset += 512 + Math.ceil(size / 512) * 512
    }
    throw failure('The export archive is incomplete.')
  } finally {
    closeSync(fd)
  }
}
