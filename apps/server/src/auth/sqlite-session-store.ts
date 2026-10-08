import { z } from 'zod'
import type { ScoreDb } from '../db/index.ts'
import { RemoteSessionSchema, type RemoteSession, type SessionStore } from './session-store.ts'

const SessionRowSchema = z.object({ expires_at: z.number().int() })

export class SqliteSessionStore implements SessionStore {
  createRemote(session: RemoteSession): void {
    const value = RemoteSessionSchema.parse(session)
    this.db.sqlite
      .prepare(
        'INSERT INTO remote_sessions (hash, id, label, address, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        value.hash,
        value.id,
        value.label,
        value.address,
        value.createdAt,
        value.lastSeenAt,
        value.expiresAt,
      )
  }

  getRemote(hash: string): RemoteSession | undefined {
    const row = this.db.sqlite
      .prepare(
        'SELECT hash, id, label, address, created_at AS createdAt, last_seen_at AS lastSeenAt, expires_at AS expiresAt FROM remote_sessions WHERE hash = ?',
      )
      .get(hash)
    return row === undefined ? undefined : RemoteSessionSchema.parse(row)
  }

  listRemote(): RemoteSession[] {
    return this.db.sqlite
      .prepare(
        'SELECT hash, id, label, address, created_at AS createdAt, last_seen_at AS lastSeenAt, expires_at AS expiresAt FROM remote_sessions ORDER BY created_at DESC',
      )
      .all()
      .map((row) => RemoteSessionSchema.parse(row))
  }

  touchRemote(hash: string, now: number, address: string): void {
    this.db.sqlite
      .prepare('UPDATE remote_sessions SET last_seen_at = ?, address = ? WHERE hash = ?')
      .run(now, address, hash)
  }

  renewRemote(hash: string, now: number, expiresAt: number): void {
    this.db.sqlite
      .prepare('UPDATE remote_sessions SET last_seen_at = ?, expires_at = ? WHERE hash = ?')
      .run(now, expiresAt, hash)
  }

  revokeRemote(hash: string): void {
    this.db.sqlite.prepare('DELETE FROM remote_sessions WHERE hash = ?').run(hash)
  }
  constructor(
    private readonly db: ScoreDb,
    private readonly clock: () => number = Date.now,
  ) {
    this.prune(this.clock())
  }

  create(hash: string, expiresAt: number): void {
    this.db.sqlite
      .prepare(
        'INSERT INTO sessions (hash, expires_at, created_at) VALUES (?, ?, ?) ON CONFLICT (hash) DO UPDATE SET expires_at = excluded.expires_at, created_at = excluded.created_at',
      )
      .run(hash, expiresAt, new Date(this.clock()).toISOString())
  }

  has(hash: string, now: number): boolean {
    const row = this.db.sqlite.prepare('SELECT expires_at FROM sessions WHERE hash = ?').get(hash)
    if (row !== undefined && SessionRowSchema.parse(row).expires_at > now) return true
    this.prune(now)
    return false
  }

  revoke(hash: string): void {
    this.db.sqlite.prepare('DELETE FROM sessions WHERE hash = ?').run(hash)
  }

  private prune(now: number): void {
    this.db.sqlite.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now)
  }
}
