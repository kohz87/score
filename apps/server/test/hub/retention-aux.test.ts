import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { migrate, openDatabase, type ScoreDb } from '../../src/db/index.ts'
import { pruneAuxiliary } from '../../src/hub/retention-aux.ts'

let dir: string
let db: ScoreDb
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'score-retention-aux-'))
  db = openDatabase(join(dir, 'score.db'))
  migrate(db, fileURLToPath(new URL('../../migrations/', import.meta.url)))
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

// audit4-c 8: run_thinking and knowledge_agent_writes had no retention.
test('the hourly pass drops old reasoning text and stale knowledge write rows only', () => {
  const now = Date.parse('2026-10-09T12:00:00.000Z')
  const run = db.sqlite.prepare(
    `INSERT INTO runs (id, profile, origin, status, started_at, updated_at) VALUES (?, 'lead', 'score', 'completed', ?, ?)`,
  )
  run.run('old', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')
  run.run('new', '2026-10-08T00:00:00.000Z', '2026-10-08T00:00:00.000Z')
  const think = db.sqlite.prepare('INSERT INTO run_thinking (run_id, seq, text) VALUES (?, 1, ?)')
  think.run('old', 'ancient thoughts')
  think.run('new', 'fresh thoughts')
  const write = db.sqlite.prepare('INSERT INTO knowledge_agent_writes (agent_id, at) VALUES (?, ?)')
  write.run('lead', now - 25 * 3_600_000)
  write.run('lead', now - 3_600_000)
  expect(pruneAuxiliary(db, { now })).toEqual({ thinking: 1, knowledgeWrites: 1 })
  expect(db.sqlite.prepare('SELECT run_id FROM run_thinking').all()).toEqual([{ run_id: 'new' }])
  expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM knowledge_agent_writes').get()?.n).toBe(1)
  // The run itself stays.
  expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM runs').get()?.n).toBe(2)
})
