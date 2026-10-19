import { randomBytes } from 'node:crypto'
import { constants, lstatSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'

export const STAGING_MAX_ENTRIES = 8
export const STAGING_MAX_BYTES = 1024 * 1024 * 1024
export const STAGING_TTL_MS = 30 * 60 * 1000

interface Entry {
  id: string
  path: string
  size: number
  expires: number
}

/** True when `dir` is missing or a real folder; a symlink or anything else is refused. */
function realFolderOrMissing(dir: string): boolean {
  try {
    const stat = lstatSync(dir)
    return stat.isDirectory() && !stat.isSymbolicLink()
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
  }
}

/**
 * Zips kept between the preview and Keep/Unzip (PLAN 10.3), so a big file is sent once. Files live under random ids
 * only (never a client path); metadata is in memory, so anything left on disk by a previous run is deleted at start.
 * Admission is serialised (the bounds hold under concurrent previews) and each stage is used by one request at a time.
 */
export class ZipStaging {
  private readonly entries = new Map<string, Entry>()
  private readonly inUse = new Map<string, Promise<unknown>>()
  private admission: Promise<unknown> = Promise.resolve()
  private ready = false
  /** A staging folder that is a symlink (or not a folder) is never emptied, written or read. */
  private readonly refused: boolean

  constructor(
    private readonly dir: string,
    private readonly clock: () => number = Date.now,
    private readonly maxBytes: number = STAGING_MAX_BYTES,
  ) {
    this.refused = !realFolderOrMissing(dir)
    if (this.refused) return
    try {
      // rmSync removes a symlinked entry itself, never what it points to.
      for (const name of readdirSync(dir))
        rmSync(path.join(dir, name), { recursive: true, force: true })
    } catch {
      // No folder yet.
    }
  }

  private ensureDir(): void {
    if (this.ready) return
    mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    if (!realFolderOrMissing(this.dir)) throw new Error('staging folder is not a real folder')
    this.ready = true
  }

  private async drop(entry: Entry): Promise<void> {
    this.entries.delete(entry.id)
    await fs.rm(path.join(this.dir, entry.id), { force: true })
  }

  private async sweep(): Promise<void> {
    const now = this.clock()
    for (const entry of [...this.entries.values()]) if (entry.expires <= now) await this.drop(entry)
  }

  private total(): number {
    let sum = 0
    for (const entry of this.entries.values()) sum += entry.size
    return sum
  }

  /** Keeps `bytes` for `target`; null when it can't be kept (too large, a refused folder, or the disk refused). */
  async put(target: string, bytes: Buffer): Promise<{ id: string; expiresAt: string } | null> {
    if (this.refused || bytes.length > this.maxBytes) return null
    const admit = this.admission.then(() => this.admit(target, bytes))
    this.admission = admit.catch(() => undefined)
    return admit
  }

  private async admit(
    target: string,
    bytes: Buffer,
  ): Promise<{ id: string; expiresAt: string } | null> {
    const id = randomBytes(24).toString('base64url')
    const tmp = path.join(this.dir, `${id}.tmp`)
    try {
      await this.sweep()
      this.ensureDir()
      while (
        this.entries.size >= STAGING_MAX_ENTRIES ||
        (this.entries.size > 0 && this.total() + bytes.length > this.maxBytes)
      )
        await this.drop(this.entries.values().next().value!)
      await fs.writeFile(tmp, bytes, { mode: 0o600, flag: 'wx' })
      await fs.rename(tmp, path.join(this.dir, id))
      const expires = this.clock() + STAGING_TTL_MS
      this.entries.set(id, { id, path: target, size: bytes.length, expires })
      return { id, expiresAt: new Date(expires).toISOString() }
    } catch {
      await fs.rm(tmp, { force: true }).catch(() => undefined)
      return null
    }
  }

  private async read(entry: Entry): Promise<Buffer | null> {
    try {
      const handle = await fs.open(
        path.join(this.dir, entry.id),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      )
      try {
        const stat = await handle.stat()
        if (!stat.isFile() || stat.size !== entry.size) return null
        return await handle.readFile()
      } finally {
        await handle.close()
      }
    } catch {
      return null
    }
  }

  /**
   * Hands the staged bytes to `save`, one request at a time per stage. When `save` succeeds the stage is used up; when
   * it throws (a `409 exists` the person will answer) the stage stays for the retry. 'gone' for unknown, expired, used or
   * unreadable; 'mismatch' for another path.
   */
  async use<T>(
    id: string,
    target: string,
    save: (bytes: Buffer) => Promise<T>,
  ): Promise<T | 'gone' | 'mismatch'> {
    const before = this.inUse.get(id) ?? Promise.resolve()
    const turn = before.then(async () => {
      await this.sweep()
      const entry = this.entries.get(id)
      if (!entry) return 'gone' as const
      if (entry.path !== target) return 'mismatch' as const
      const bytes = await this.read(entry)
      if (!bytes) {
        await this.drop(entry)
        return 'gone' as const
      }
      const result = await save(bytes)
      await this.drop(entry)
      return result
    })
    const settled = turn.catch(() => undefined)
    this.inUse.set(id, settled)
    void settled.then(() => {
      if (this.inUse.get(id) === settled) this.inUse.delete(id)
    })
    return turn
  }
}
