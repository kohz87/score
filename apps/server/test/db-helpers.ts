import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach } from 'vitest'
import { openDatabase, type ScoreDb } from '../src/db/index.ts'

export const migrationDir = fileURLToPath(new URL('../migrations/', import.meta.url))
export let dir: string
export const connections: (ScoreDb | DatabaseSync)[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'score-test-'))
})

afterEach(() => {
  for (const connection of connections.splice(0)) connection.close()
  rmSync(dir, { recursive: true, force: true })
})

export function open(): ScoreDb {
  const db = openDatabase(join(dir, 'home', 'score.db'))
  connections.push(db)
  return db
}

export function copyMigrations(): string {
  const copy = join(dir, 'migrations')
  mkdirSync(copy)
  cpSync(join(migrationDir, '0001_infra.sql'), join(copy, '0001_infra.sql'))
  return copy
}

export function insertEvent(sqlite: DatabaseSync, type: string): void {
  sqlite
    .prepare('INSERT INTO events (ts, type, data) VALUES (?, ?, ?)')
    .run(new Date().toISOString(), type, '{}')
}
