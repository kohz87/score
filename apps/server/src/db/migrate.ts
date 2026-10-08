import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { DatabaseSync } from 'node:sqlite'
import type { ScoreDb } from './database.ts'
import { resetEpoch } from './epoch.ts'

const AppliedMigrationSchema = z.object({
  version: z.number().int().positive(),
  name: z.string().min(1),
  checksum: z.string().regex(/^[a-f0-9]{64}$/),
  applied_at: z.iso.datetime(),
})

interface Migration {
  version: number
  name: string
  checksum: string
  sql: string
}

function loadMigrations(dir: string): Migration[] {
  const migrations = readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .map((name) => {
      const match = /^(\d{4})_(.+)\.sql$/.exec(name)
      if (!match) throw new Error(`Invalid migration filename: ${name}`)
      const content = readFileSync(join(dir, name))
      return {
        version: Number(match[1]),
        name,
        sql: content.toString('utf8'),
        checksum: createHash('sha256').update(content).digest('hex'),
      }
    })
    .sort((left, right) => left.version - right.version)

  const versions = new Set<number>()
  for (const migration of migrations) {
    if (versions.has(migration.version)) {
      throw new Error(`Duplicate migration number: ${migration.version}`)
    }
    versions.add(migration.version)
  }
  // Parallel tasks reserve numbers before their migrations land, so numbering can have gaps.
  if (migrations[0]?.version !== 1) throw new Error('Missing migration number: 1')
  return migrations
}

function appliedMigrations(sqlite: DatabaseSync, migrations: Migration[]): number {
  const table = sqlite
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'schema_migrations'")
    .get()
  if (table === undefined) return 0
  z.object({ name: z.literal('schema_migrations') }).parse(table)
  const applied = z
    .array(AppliedMigrationSchema)
    .parse(
      sqlite
        .prepare(
          'SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version',
        )
        .all(),
    )
  for (const [index, row] of applied.entries()) {
    const migration = migrations.find((migration) => migration.version === row.version)
    if (!migration) {
      throw new Error(`Database is from a newer Score: unknown applied migration ${row.version}`)
    }
    if (row.version !== migrations[index]?.version)
      throw new Error(`Missing applied migration number: ${migrations[index]?.version}`)
    if (row.name !== migration.name || row.checksum !== migration.checksum) {
      throw new Error(`Applied migration changed: ${migration.name}`)
    }
  }
  return applied.length
}

export function migrate(db: ScoreDb, dir: string): void {
  const migrations = loadMigrations(dir)
  const applied = db.read((sqlite) => appliedMigrations(sqlite, migrations))
  if (migrations.length === 0) throw new Error('Missing migration number: 1')
  for (const migration of migrations.slice(applied)) {
    db.tx((sqlite) => {
      // Recheck under the writer lock in case another process migrated since the initial read.
      if (appliedMigrations(sqlite, migrations) > migrations.indexOf(migration)) return
      sqlite.exec(migration.sql)
      if (migration.version === 1) {
        resetEpoch(db)
        sqlite
          .prepare("INSERT INTO meta (key, value) VALUES ('created_at', ?)")
          .run(new Date().toISOString())
      }
      sqlite
        .prepare(
          'INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)',
        )
        .run(migration.version, migration.name, migration.checksum, new Date().toISOString())
    })
  }
}
