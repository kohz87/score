import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import type { ScoreDb } from '../db/index.ts'
import { HttpError } from '../errors.ts'
import { declaredMatches, sniffImage, type MediaType } from './sniff.ts'

export const MAX_MEDIA_BYTES = 8 * 1024 * 1024
export const DEFAULT_MEDIA_QUOTA_BYTES = 512 * 1024 * 1024
const UNUSED_TTL_MS = 30 * 24 * 60 * 60 * 1000
const ORPHAN_GRACE_MS = 10 * 60 * 1000

const RowSchema = z.object({
  id: z.string(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  content_type: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
  size: z.int().positive(),
  created_at: z.string(),
  last_used_at: z.string(),
  refs: z.int().nonnegative(),
})
const TotalSchema = z.object({ total: z.int().nonnegative() })
const SHA_FILE = /^[0-9a-f]{64}$/

export interface StoredMedia {
  mediaId: string
  contentType: MediaType
  size: number
}

export interface MediaStoreOptions {
  quotaBytes?: number
  maxItemBytes?: number
  clock?: () => number
}

// File names are always the server-computed sha256, and ids are looked up in the index first, so no request
// input ever becomes part of a filesystem path.
export class MediaStore {
  readonly quotaBytes: number
  readonly maxItemBytes: number
  private readonly clock: () => number

  constructor(
    private readonly db: ScoreDb,
    readonly dir: string,
    options: MediaStoreOptions = {},
  ) {
    this.quotaBytes = options.quotaBytes ?? DEFAULT_MEDIA_QUOTA_BYTES
    this.maxItemBytes = options.maxItemBytes ?? MAX_MEDIA_BYTES
    this.clock = options.clock ?? Date.now
  }

  private path(sha256: string): string {
    return join(this.dir, sha256)
  }

  private ensureDir(): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    chmodSync(this.dir, 0o700)
  }

  private writeFile(sha256: string, bytes: Uint8Array): void {
    this.ensureDir()
    const temp = join(this.dir, `.tmp-${randomUUID()}`)
    try {
      writeFileSync(temp, bytes, { mode: 0o600, flag: 'wx' })
      renameSync(temp, this.path(sha256))
    } catch (error) {
      removeFile(temp)
      throw error
    }
  }

  // Stores an image and returns its id; identical bytes return the existing id. Throws HttpError for
  // unsupported content (415), oversized items (413) and a full store of referenced items (507).
  store(bytes: Uint8Array, declaredType?: string): StoredMedia {
    if (bytes.length === 0) throw new HttpError(400, 'bad_request', 'The file is empty')
    if (bytes.length > this.maxItemBytes)
      throw new HttpError(413, 'payload_too_large', 'The file is larger than 8 MB')
    const type = sniffImage(bytes)
    if (!type || !declaredMatches(declaredType, type))
      throw new HttpError(415, 'unsupported_media_type', 'Only PNG, JPEG, WebP and GIF are allowed')
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const now = new Date(this.clock()).toISOString()
    let evicted: string[] = []
    const result = this.db.tx((sqlite) => {
      const found = sqlite.prepare('SELECT * FROM media WHERE sha256 = ?').get(sha256)
      if (found) {
        const row = RowSchema.parse(found)
        sqlite.prepare('UPDATE media SET last_used_at = ? WHERE id = ?').run(now, row.id)
        if (!existsSync(this.path(sha256))) this.writeFile(sha256, bytes)
        return { mediaId: row.id, contentType: row.content_type, size: row.size }
      }
      evicted = evictFor(sqlite, this.quotaBytes, bytes.length)
      const id = randomUUID()
      sqlite
        .prepare(
          'INSERT INTO media (id, sha256, content_type, size, created_at, last_used_at, refs) VALUES (?, ?, ?, ?, ?, ?, 0)',
        )
        .run(id, sha256, type, bytes.length, now, now)
      this.writeFile(sha256, bytes)
      return { mediaId: id, contentType: type, size: bytes.length }
    })
    for (const victim of evicted) removeFile(this.path(victim))
    return result
  }

  // Bytes and type for GET; null for unknown ids. Reading refreshes the LRU timestamp.
  read(id: string): { bytes: Buffer; contentType: MediaType; sha256: string } | null {
    if (!/^[0-9a-f-]{36}$/.test(id)) return null
    const found = this.db.sqlite.prepare('SELECT * FROM media WHERE id = ?').get(id)
    if (!found) return null
    const row = RowSchema.parse(found)
    let bytes: Buffer
    try {
      bytes = readFileSync(this.path(row.sha256))
    } catch {
      return null
    }
    this.db.sqlite
      .prepare('UPDATE media SET last_used_at = ? WHERE id = ?')
      .run(new Date(this.clock()).toISOString(), id)
    return { bytes, contentType: row.content_type, sha256: row.sha256 }
  }

  has(id: string): boolean {
    return this.db.sqlite.prepare('SELECT 1 FROM media WHERE id = ?').get(id) !== undefined
  }

  // Called inside the transaction that stores a message: a referenced item is never evicted.
  retain(sqlite: DatabaseSync, ids: readonly string[], now: string): void {
    for (const id of ids) {
      const changed = sqlite
        .prepare('UPDATE media SET refs = refs + 1, last_used_at = ? WHERE id = ?')
        .run(now, id).changes
      if (Number(changed) === 0) throw new HttpError(400, 'bad_request', 'Unknown attachment')
    }
  }

  totalBytes(): number {
    return totalOf(this.db.sqlite)
  }

  // Hourly cleanup: rows whose file vanished, unreferenced items unused for 30 days, anything over quota
  // (LRU, unreferenced only), and files or temp files that no row owns.
  sweep(): { removed: number; missing: number; orphans: number } {
    const nowMs = this.clock()
    const cutoff = new Date(nowMs - UNUSED_TTL_MS).toISOString()
    const removed: string[] = []
    let missing = 0
    this.db.tx((sqlite) => {
      for (const raw of sqlite.prepare('SELECT * FROM media').all()) {
        const row = RowSchema.parse(raw)
        if (!existsSync(this.path(row.sha256))) {
          sqlite.prepare('DELETE FROM media WHERE id = ?').run(row.id)
          missing += 1
        } else if (row.refs === 0 && row.last_used_at <= cutoff) {
          sqlite.prepare('DELETE FROM media WHERE id = ?').run(row.id)
          removed.push(row.sha256)
        }
      }
      removed.push(...evictFor(sqlite, this.quotaBytes, 0, false))
    })
    for (const sha of removed) removeFile(this.path(sha))
    return { removed: removed.length, missing, orphans: this.sweepOrphans(nowMs) }
  }

  private sweepOrphans(nowMs: number): number {
    if (!existsSync(this.dir)) return 0
    const known = new Set(
      z
        .array(z.object({ sha256: z.string() }))
        .parse(this.db.sqlite.prepare('SELECT sha256 FROM media').all())
        .map((row) => row.sha256),
    )
    let count = 0
    for (const name of readdirSync(this.dir)) {
      const candidate = SHA_FILE.test(name) ? !known.has(name) : name.startsWith('.tmp-')
      if (!candidate) continue
      try {
        if (nowMs - statSync(this.path(name)).mtimeMs < ORPHAN_GRACE_MS) continue
      } catch {
        continue
      }
      removeFile(this.path(name))
      count += 1
    }
    return count
  }
}

function totalOf(sqlite: DatabaseSync): number {
  return TotalSchema.parse(
    sqlite.prepare('SELECT COALESCE(SUM(size), 0) AS total FROM media').get(),
  ).total
}

// Deletes least-recently-used unreferenced rows until `incoming` more bytes fit; returns the freed shas so the
// caller unlinks them after commit. Throws (strict) when referenced items alone leave no room.
function evictFor(sqlite: DatabaseSync, quota: number, incoming: number, strict = true): string[] {
  const victims: string[] = []
  let total = totalOf(sqlite)
  if (total + incoming <= quota) return victims
  const candidates = z
    .array(RowSchema)
    .parse(
      sqlite
        .prepare('SELECT * FROM media WHERE refs = 0 ORDER BY last_used_at, created_at, id')
        .all(),
    )
  for (const row of candidates) {
    if (total + incoming <= quota) break
    sqlite.prepare('DELETE FROM media WHERE id = ?').run(row.id)
    victims.push(row.sha256)
    total -= row.size
  }
  if (strict && total + incoming > quota)
    throw new HttpError(507, 'media_quota_exceeded', 'Media storage is full')
  return victims
}

function removeFile(path: string): void {
  try {
    unlinkSync(path)
  } catch {
    // Already gone; a leftover is picked up by the next sweep.
  }
}
