import { z } from 'zod'
import type { ScoreDb } from '../db/index.ts'
import type { SessionStore } from './session-store.ts'

const SessionRowSchema = z.object({ expires_at: z.number().int() })

export class SqliteSessionStore implements SessionStore {
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
