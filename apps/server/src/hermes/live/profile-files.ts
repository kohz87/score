import fs from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { HttpError } from '../../errors.ts'
import {
  AgentFileConflictError,
  AgentFileNameSchema,
  MAX_AGENT_FILE_BYTES,
  assertFileContent,
  decodeFileBytes,
  etagOf,
  type AgentFile,
  type AgentFileName,
} from '../agent-files.ts'

// The one place Score writes inside a Hermes profile (ARCHITECTURE D2.6): SOUL.md and AGENTS.md only,
// no symlinks, etag compare-and-swap, temp file + fsync + rename in the same directory.

interface Snapshot {
  bytes: Buffer
  mode: number | null
}
const refuse = (what: string) =>
  new HttpError(409, 'conflict', `Refusing to use a linked or unexpected ${what}`)

function resolveFile(home: string, file: AgentFileName): { dir: string; path: string } {
  const name = AgentFileNameSchema.parse(file)
  let dir: string
  try {
    if (!fs.lstatSync(home).isDirectory()) throw refuse('profile directory')
    dir = fs.realpathSync(home)
  } catch (error) {
    if (error instanceof HttpError) throw error
    throw new HttpError(404, 'not_found', 'Profile directory not found')
  }
  const path = join(dir, name)
  if (path !== join(dir, 'SOUL.md') && path !== join(dir, 'AGENTS.md')) throw refuse('file')
  return { dir, path }
}

function snapshot(path: string): Snapshot {
  let stat: fs.Stats
  try {
    stat = fs.lstatSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { bytes: Buffer.alloc(0), mode: null }
    throw error
  }
  if (!stat.isFile()) throw refuse('file')
  if (stat.size > MAX_AGENT_FILE_BYTES)
    throw new HttpError(413, 'payload_too_large', 'File is larger than 256 KB')
  const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  try {
    const buffer = Buffer.alloc(MAX_AGENT_FILE_BYTES + 1)
    const length = fs.readSync(fd, buffer, 0, buffer.length, 0)
    if (length > MAX_AGENT_FILE_BYTES)
      throw new HttpError(413, 'payload_too_large', 'File is larger than 256 KB')
    return { bytes: buffer.subarray(0, length), mode: fs.fstatSync(fd).mode & 0o777 }
  } finally {
    fs.closeSync(fd)
  }
}
const asFile = (snap: Snapshot): AgentFile => ({
  content: decodeFileBytes(snap.bytes),
  etag: etagOf(snap.bytes),
})

function syncDirectory(dir: string): void {
  const fd = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY)
  try {
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}

export class ProfileFiles {
  // Serializes writers per target so the compare-and-swap windows never interleave in this process.
  private readonly locks = new Map<string, Promise<unknown>>()

  /** `home` must come from the profiles reader (it already refuses symlinked profile directories). */
  read(home: string, file: AgentFileName): AgentFile {
    return asFile(snapshot(resolveFile(home, file).path))
  }

  async write(
    home: string,
    file: AgentFileName,
    content: string,
    etag: string,
  ): Promise<{ etag: string }> {
    assertFileContent(content)
    const { dir, path } = resolveFile(home, file)
    const previous = this.locks.get(path) ?? Promise.resolve()
    const run = previous.then(() => this.swap(dir, path, file, content, etag))
    const tail = run.then(
      () => undefined,
      () => undefined,
    )
    this.locks.set(path, tail)
    void tail.then(() => {
      if (this.locks.get(path) === tail) this.locks.delete(path)
    })
    return run
  }

  private swap(
    dir: string,
    path: string,
    file: AgentFileName,
    content: string,
    etag: string,
  ): { etag: string } {
    const before = snapshot(path)
    if (etagOf(before.bytes) !== etag) throw new AgentFileConflictError(asFile(before))
    const bytes = Buffer.from(content, 'utf8')
    const temp = join(dir, `.${file}.score-${randomBytes(6).toString('hex')}.tmp`)
    const fd = fs.openSync(
      temp,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o600,
    )
    try {
      try {
        // writeSync may write fewer bytes than asked; loop so a short write can't truncate the file.
        for (let offset = 0; offset < bytes.length;)
          offset += fs.writeSync(fd, bytes, offset, bytes.length - offset)
        fs.fchmodSync(fd, before.mode ?? 0o644)
        fs.fsyncSync(fd)
      } finally {
        fs.closeSync(fd)
      }
      // Compare-and-swap: re-read right before the rename so an outside editor's change is not lost.
      const latest = snapshot(path)
      if (etagOf(latest.bytes) !== etag) throw new AgentFileConflictError(asFile(latest))
      fs.renameSync(temp, path)
    } catch (error) {
      fs.rmSync(temp, { force: true })
      throw error
    }
    syncDirectory(dir)
    return { etag: etagOf(bytes) }
  }
}
