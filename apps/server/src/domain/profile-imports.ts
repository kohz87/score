import { randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { PROFILE_IMPORT_MAX_BYTES, ProfileImportUploadIdSchema } from '@score/contract'
import { HttpError } from '../errors.ts'

const STALE_MS = 24 * 60 * 60 * 1000

/** Uploaded profile archives: private (0700 dir, 0600 files) under Score's home, addressed only by a random id. */
export class ProfileImportStore {
  readonly directory: string
  constructor(
    scoreHome: string,
    private readonly now = Date.now,
  ) {
    this.directory = join(resolve(scoreHome), 'profile-imports')
  }
  private ensureDirectory() {
    try {
      mkdirSync(this.directory, { mode: 0o700, recursive: true })
    } catch {
      /* checked below */
    }
    const info = lstatSync(this.directory)
    if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)
      throw new HttpError(409, 'conflict', 'Score’s home folder must be private to your user.')
  }
  /** Path for a validated upload id; never built from anything else the client sends. */
  pathFor(uploadId: string): string {
    return join(this.directory, `${ProfileImportUploadIdSchema.parse(uploadId)}.tar.gz`)
  }
  save(bytes: Buffer): string {
    if (bytes.length === 0 || bytes.length > PROFILE_IMPORT_MAX_BYTES)
      throw new HttpError(
        413,
        'payload_too_large',
        'The archive must be between 1 byte and 200 MB.',
      )
    this.ensureDirectory()
    const id = randomUUID()
    const fd = openSync(
      this.pathFor(id),
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    )
    try {
      for (let at = 0; at < bytes.length;) at += writeSync(fd, bytes, at)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    return id
  }
  exists(uploadId: string): boolean {
    try {
      return lstatSync(this.pathFor(uploadId)).isFile()
    } catch {
      return false
    }
  }
  remove(uploadId: string): void {
    try {
      unlinkSync(this.pathFor(uploadId))
    } catch {
      /* already gone */
    }
  }
  /** Drops uploads nobody started an import from; `keep` holds ids an unfinished operation still needs. */
  sweep(keep: ReadonlySet<string>): void {
    let names: string[]
    try {
      names = readdirSync(this.directory)
    } catch {
      return
    }
    for (const name of names) {
      const id = name.replace(/\.tar\.gz$/, '')
      if (keep.has(id) || !ProfileImportUploadIdSchema.safeParse(id).success) continue
      try {
        const info = lstatSync(join(this.directory, name))
        if (this.now() - info.mtimeMs > STALE_MS) unlinkSync(join(this.directory, name))
      } catch {
        /* raced with a removal */
      }
    }
  }
}
