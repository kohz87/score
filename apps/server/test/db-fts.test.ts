import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { migrate, openDatabase, type ScoreDb } from '../src/db/index.ts'
import { ensureMessageFts } from '../src/db/fts.ts'

let dir: string
let db: ScoreDb
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'score-fts-'))
  db = openDatabase(join(dir, 'score.db'))
  migrate(db, fileURLToPath(new URL('../migrations/', import.meta.url)))
  db.sqlite
    .prepare(
      `INSERT INTO rooms (id, name, kind, members, created_at, updated_at) VALUES ('r', '#r', 'room', '[]', 't', 't')`,
    )
    .run()
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})
const say = (id: string, text: string) =>
  db.sqlite
    .prepare(
      `INSERT INTO messages (id, room_id, author_kind, "to", parts, refs, streaming, created_at, updated_at)
       VALUES (?, 'r', 'you', '[]', ?, '[]', 0, '2026-10-09T00:00:00.000Z', '2026-10-09T00:00:00.000Z')`,
    )
    .run(id, JSON.stringify([{ kind: 'text', text }]))
const hits = (q: string) =>
  db.sqlite
    .prepare(
      `SELECT m.id FROM message_fts JOIN messages m ON m.rowid = message_fts.rowid WHERE message_fts MATCH ? ORDER BY m.id`,
    )
    .all(q)
    .map((row) => row.id)

// audit4-c 9: the index is keyed on messages.rowid, which a manual VACUUM may renumber.
test('startup rebuilds message_fts when it no longer matches the messages', () => {
  say('a', 'alpha apple')
  say('b', 'bravo banana')
  say('c', 'charlie cherry')
  expect(ensureMessageFts(db.sqlite)).toBe(false)
  // Simulate renumbered rowids: delete a message row without its trigger and shift another.
  db.sqlite.exec('DROP TRIGGER message_fts_delete')
  db.sqlite.exec("DELETE FROM messages WHERE id = 'a'")
  db.sqlite.exec("UPDATE messages SET rowid = 1 WHERE id = 'c'")
  expect(hits('cherry')).not.toEqual(['c'])
  expect(ensureMessageFts(db.sqlite)).toBe(true)
  expect(hits('cherry')).toEqual(['c'])
  expect(hits('banana')).toEqual(['b'])
  expect(hits('apple')).toEqual([])
  expect(ensureMessageFts(db.sqlite)).toBe(false)
})
