import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { migrate, openDatabase, type ScoreDb } from '../../src/db/index.ts'
import { createIngest, type Ingest } from '../../src/hub/ingest.ts'
import { projectTask, readProjectedTask, summaryDetail } from '../../src/domain/tasks.ts'

let home: string
let db: ScoreDb
let ingest: Ingest
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'score-task-projection-'))
  db = openDatabase(join(home, 'score.db'))
  migrate(db, fileURLToPath(new URL('../../migrations/', import.meta.url)))
  ingest = createIngest(db)
})
afterEach(async () => {
  await ingest.close()
  db.close()
  rmSync(home, { recursive: true, force: true })
})
const task = summaryDetail({
  id: 'task',
  title: 'New task',
  key: 'T-1',
  column: 'planned',
  hermesStatus: 'todo',
  assignee: 'builder',
  reviewer: null,
  roomId: null,
  badge: null,
  progress: null,
  elapsedSec: null,
  note: null,
  updatedAt: '2026-01-01T00:00:00.000Z',
})

test('a stale task observation cannot regress the projection; a new database incarnation can reset it', async () => {
  await ingest.submit({
    source: 'test',
    identity: 'new',
    apply: ({ sqlite }) => {
      projectTask(sqlite, { ...task, title: 'New version' }, 20, 'first')
      return []
    },
  })
  await ingest.submit({
    source: 'test',
    identity: 'old',
    apply: ({ sqlite }) => {
      expect(projectTask(sqlite, task, 10, 'first')).toBe(false)
      return []
    },
  })
  expect(readProjectedTask(db.sqlite, task.id)!.title).toBe('New version')
  await ingest.submit({
    source: 'test',
    identity: 'reset',
    apply: ({ sqlite }) => {
      projectTask(sqlite, task, 1, 'replacement')
      return []
    },
  })
  expect(readProjectedTask(db.sqlite, task.id)!.title).toBe('New task')
})

test('an invalid stream draft rolls back the task projection with its ingest key', async () => {
  await expect(
    ingest.submit({
      source: 'test',
      identity: 'bad',
      apply: ({ sqlite }) => {
        projectTask(sqlite, task)
        return [
          { type: 'task.upserted', data: { ...task, column: 'invalid' } },
        ] as unknown as ReturnType<Parameters<Ingest['submit']>[0]['apply']>
      },
    }),
  ).rejects.toThrow()
  expect(readProjectedTask(db.sqlite, task.id)).toBeUndefined()
  expect(
    db.sqlite.prepare("SELECT * FROM ingest_keys WHERE identity = 'bad'").get(),
  ).toBeUndefined()
})
