import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { migrate, openDatabase, type ScoreDb } from '../../src/db/index.ts'

let dir = ''
let db: ScoreDb | undefined
afterEach(() => {
  db?.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('migration 0030 creates the index tables, the FTS table and the default settings row', () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'score-kn-mig-'))
  db = openDatabase(path.join(dir, 'score.db'))
  migrate(db, new URL('../../migrations/', import.meta.url).pathname)
  const names = (
    db.sqlite
      .prepare(
        "SELECT name FROM sqlite_schema WHERE name LIKE 'knowledge_%' AND name NOT LIKE 'knowledge_fts_%'",
      )
      .all() as Array<{ name: string }>
  )
    .map((row) => row.name)
    .sort()
  expect(names).toEqual(
    expect.arrayContaining([
      'knowledge_fts',
      'knowledge_links',
      'knowledge_notes',
      'knowledge_settings',
    ]),
  )
  expect(db.sqlite.prepare('SELECT id, agent_access FROM knowledge_settings').all()).toEqual([
    { id: 1, agent_access: 1 },
  ])
  // FTS5 works: rows are keyed by rowid, path is stored but not tokenised.
  db.sqlite
    .prepare('INSERT INTO knowledge_fts (rowid, path, title, body) VALUES (1, ?, ?, ?)')
    .run('n.md', 'Title', 'the quick fox')
  expect(
    db.sqlite.prepare("SELECT path FROM knowledge_fts WHERE knowledge_fts MATCH 'quick'").all(),
  ).toEqual([{ path: 'n.md' }])
  expect(
    db.sqlite.prepare("SELECT path FROM knowledge_fts WHERE knowledge_fts MATCH 'n'").all(),
  ).toEqual([])
  expect(() =>
    db!.sqlite.prepare('INSERT INTO knowledge_settings (id, agent_access) VALUES (2, 1)').run(),
  ).toThrow()
})
