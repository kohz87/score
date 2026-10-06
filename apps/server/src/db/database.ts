import { chmodSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export class ScoreDb {
  constructor(readonly sqlite: DatabaseSync) {}

  tx<T>(fn: (sqlite: DatabaseSync) => T): T {
    return this.transaction('IMMEDIATE', fn)
  }

  read<T>(fn: (sqlite: DatabaseSync) => T): T {
    return this.transaction('DEFERRED', fn)
  }

  close(): void {
    this.sqlite.close()
  }

  private transaction<T>(mode: 'IMMEDIATE' | 'DEFERRED', fn: (sqlite: DatabaseSync) => T): T {
    if (this.sqlite.isTransaction) throw new Error('Nested transactions are not supported')
    this.sqlite.exec(`BEGIN ${mode}`)
    try {
      const result = fn(this.sqlite)
      if (
        result !== null &&
        (typeof result === 'object' || typeof result === 'function') &&
        'then' in result &&
        typeof result.then === 'function'
      ) {
        throw new Error('Database transaction callbacks must be synchronous')
      }
      this.sqlite.exec('COMMIT')
      return result
    } catch (error) {
      if (this.sqlite.isTransaction) this.sqlite.exec('ROLLBACK')
      throw error
    }
  }
}

// mkdirSync's mode only applies to directories it creates, and SQLite creates the -wal/-shm
// side files (which hold the same data) with the process umask, so tighten both explicitly.
function restrictDirectory(dir: string): void {
  const stats = statSync(dir)
  if (stats.uid === process.getuid?.() && (stats.mode & 0o077) !== 0) chmodSync(dir, 0o700)
}

export function openDatabase(path: string): ScoreDb {
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  restrictDirectory(dir)
  const sqlite = new DatabaseSync(path)
  try {
    sqlite.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
    `)
    for (const file of [path, `${path}-wal`, `${path}-shm`]) {
      if (existsSync(file)) chmodSync(file, 0o600)
    }
    return new ScoreDb(sqlite)
  } catch (error) {
    sqlite.close()
    throw error
  }
}
