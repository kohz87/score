import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { migrate, openDatabase, type ScoreDb } from '../../src/db/index.ts'

export const migrationsDir = fileURLToPath(new URL('../../migrations/', import.meta.url))

export function tempDir(prefix: string): { dir: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

export function openMigrated(dir: string, name = 'score.db'): ScoreDb {
  const db = openDatabase(join(dir, name))
  migrate(db, migrationsDir)
  return db
}
