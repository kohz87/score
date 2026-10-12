// An exclusive inter-process lock that is a real OS lock (7.7a v4 review #3). It is an open SQLite connection holding
// `BEGIN EXCLUSIVE` on a permanent sidecar file (`<dir>/lock.sqlite`): SQLite takes a POSIX file lock for it and the
// kernel drops that lock when the process dies, however it dies. So there is no stale-lock logic, nothing is ever
// stolen, and the sidecar is created once and never renamed, rewritten or deleted (a lock-file protocol that renames or
// unlinks its own file has an interleaving where two holders enter, finding 3). Node built-ins only, and only syntax
// Node can strip, so `scripts/set-password.mjs` can import it as it is.
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export const LOCK_FILE_NAME = 'lock.sqlite'
export const DEFAULT_LOCK_WAIT_MS = 10_000
const POLL_MS = 25

export class OsLockTimeoutError extends Error {
  readonly code = 'ELOCKED'
  constructor(readonly file: string) {
    super(`Timed out waiting for the lock ${file}.`)
  }
}

function isBusy(error: unknown): boolean {
  const e = error as { errcode?: number; message?: string }
  return (
    e.errcode === 5 || e.errcode === 6 || /database is locked|SQLITE_BUSY/i.test(e.message ?? '')
  )
}

// Async holders in one process queue behind each other here: a second connection waiting on SQLite would otherwise
// poll against a holder that is suspended at an `await` of its own. Keyed by the sidecar path.
const queues = new Map<string, Promise<unknown>>()

export class OsLock {
  readonly file: string
  private db: DatabaseSync | undefined
  private depth = 0

  constructor(readonly dir: string) {
    this.file = join(resolve(dir), LOCK_FILE_NAME)
  }

  private connection(): DatabaseSync {
    if (!this.db) {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 })
      this.db = new DatabaseSync(this.file)
    }
    return this.db
  }

  /** Synchronous: blocks this thread while another process holds the lock (SQLite's busy handler sleeps). Reentrant
   * on one instance. Use only for short critical sections that never await. */
  runSync<T>(fn: () => T, waitMs = DEFAULT_LOCK_WAIT_MS): T {
    if (this.depth > 0) {
      this.depth++
      try {
        return fn()
      } finally {
        this.depth--
      }
    }
    const db = this.connection()
    db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(waitMs))}`)
    try {
      db.exec('BEGIN EXCLUSIVE')
    } catch (error) {
      if (isBusy(error)) throw new OsLockTimeoutError(this.file)
      throw error
    }
    this.depth = 1
    try {
      return fn()
    } finally {
      this.depth = 0
      try {
        db.exec('ROLLBACK') // nothing was written: ends the transaction and drops the file lock
      } catch {
        this.close() // closing the connection releases the lock too
      }
    }
  }

  /** Asynchronous: waits without blocking the event loop (polls), and may hold the lock across awaits. */
  async run<T>(fn: () => T | Promise<T>, waitMs = DEFAULT_LOCK_WAIT_MS): Promise<T> {
    const deadline = Date.now() + waitMs
    const previous = queues.get(this.file) ?? Promise.resolve()
    const mine = previous.catch(() => undefined).then(() => this.runAfterQueue(fn, deadline))
    const tail = mine.catch(() => undefined)
    queues.set(this.file, tail)
    try {
      return await mine
    } finally {
      if (queues.get(this.file) === tail) queues.delete(this.file)
    }
  }

  private async runAfterQueue<T>(fn: () => T | Promise<T>, deadline: number): Promise<T> {
    const db = this.connection()
    db.exec('PRAGMA busy_timeout = 0')
    for (;;) {
      try {
        db.exec('BEGIN EXCLUSIVE')
        break
      } catch (error) {
        if (!isBusy(error)) throw error
        if (Date.now() >= deadline) throw new OsLockTimeoutError(this.file)
        await new Promise((resolveWait) => setTimeout(resolveWait, POLL_MS))
      }
    }
    try {
      return await fn()
    } finally {
      try {
        db.exec('ROLLBACK')
      } catch {
        this.close()
      }
    }
  }

  close(): void {
    try {
      this.db?.close()
    } catch {
      // already closed
    }
    this.db = undefined
    this.depth = 0
  }
}

// One shared connection per sidecar for the async users in a process (the password store).
const shared = new Map<string, OsLock>()
export function sharedOsLock(dir: string): OsLock {
  const key = join(resolve(dir), LOCK_FILE_NAME)
  let lock = shared.get(key)
  if (!lock) {
    lock = new OsLock(dir)
    shared.set(key, lock)
  }
  return lock
}
