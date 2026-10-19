import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import fs from 'node:fs/promises'
import { mkdirSync, readdirSync, rmSync } from 'node:fs'
import path from 'node:path'

export const STAGING_MAX_ENTRIES = 8
export const STAGING_MAX_BYTES = 256 * 1024 * 1024
export const STAGING_TTL_MS = 30 * 60 * 1000

interface Entry {
  id: string
  path: string
  size: number
  expires: number
}

/**
 * Zips kept between the preview and Keep/Unzip (PLAN 10.3), so a big file is sent once. Files live under random ids
 * only (never a client path); metadata is in memory, so anything left on disk by a previous run is deleted at start.
 */
export class ZipStaging {
  private readonly entries = new Map<string, Entry>()
  private ready = false

  constructor(
    private readonly dir: string,
    private readonly clock: () => number = Date.now,
    private readonly maxBytes: number = STAGING_MAX_BYTES,
  ) {
    try {
      for (const name of readdirSync(dir))
        rmSync(path.join(dir, name), { recursive: true, force: true })
    } catch {
      // No folder yet.
    }
  }

  private ensureDir(): void {
    if (this.ready) return
    mkdirSync(this.dir, { recursive: true, mode: 0o700 })
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

  /** Keeps `bytes` for `target`; null when it can't be kept (too large, or the disk refused). */
  async put(target: string, bytes: Buffer): Promise<{ id: string; expiresAt: string } | null> {
    if (bytes.length > this.maxBytes) return null
    try {
      await this.sweep()
      this.ensureDir()
      while (
        this.entries.size >= STAGING_MAX_ENTRIES ||
        (this.entries.size > 0 && this.total() + bytes.length > this.maxBytes)
      )
        await this.drop(this.entries.values().next().value!)
      const id = randomBytes(24).toString('base64url')
      const tmp = path.join(this.dir, `${id}.tmp`)
      await fs.writeFile(tmp, bytes, { mode: 0o600, flag: 'wx' })
      await fs.rename(tmp, path.join(this.dir, id))
      const expires = this.clock() + STAGING_TTL_MS
      this.entries.set(id, { id, path: target, size: bytes.length, expires })
      return { id, expiresAt: new Date(expires).toISOString() }
    } catch {
      return null
    }
  }

  /** The staged bytes: 'gone' for unknown, expired or unreadable; 'mismatch' for another path. Stays staged. */
  async read(id: string, target: string): Promise<Buffer | 'gone' | 'mismatch'> {
    await this.sweep()
    const entry = this.entries.get(id)
    if (!entry) return 'gone'
    if (entry.path !== target) return 'mismatch'
    try {
      const handle = await fs.open(
        path.join(this.dir, id),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      )
      try {
        const stat = await handle.stat()
        if (!stat.isFile() || stat.size !== entry.size) throw new Error('changed')
        return await handle.readFile()
      } finally {
        await handle.close()
      }
    } catch {
      await this.drop(entry)
      return 'gone'
    }
  }

  async remove(id: string): Promise<void> {
    const entry = this.entries.get(id)
    if (entry) await this.drop(entry)
  }
}
