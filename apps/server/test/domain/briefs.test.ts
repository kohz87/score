import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { migrate, openDatabase, type ScoreDb } from '../../src/db/index.ts'
import {
  briefTitle,
  createBrief,
  deriveBriefStatus,
  listBriefs,
  readBriefRow,
} from '../../src/domain/briefs.ts'
import { insertRoom } from '../../src/domain/rooms.ts'
import { projectTask, summaryDetail } from '../../src/domain/tasks.ts'

let dir: string
let db: ScoreDb
const at = '2026-10-08T10:00:00.000Z'

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'score-briefs-domain-'))
  db = openDatabase(join(dir, 'score.db'))
  migrate(db, fileURLToPath(new URL('../../migrations/', import.meta.url)))
  db.tx((sqlite) => {
    insertRoom(
      sqlite,
      { id: 'room', name: '#r', kind: 'room', leadAgentId: 'lead', members: ['lead'] },
      at,
    )
    sqlite
      .prepare(
        `INSERT INTO messages (id, room_id, author_kind, "to", parts, refs, streaming, created_at, updated_at)
         VALUES ('m1', 'room', 'you', '[]', '[]', '[]', 0, ?, ?)`,
      )
      .run(at, at)
  })
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

function turn(state: string, runStatus: string | null, id = 'r1', hop = 0) {
  db.tx((sqlite) => {
    if (runStatus)
      sqlite
        .prepare(
          `INSERT INTO runs (id, profile, origin, status, started_at, updated_at) VALUES (?, 'lead', 'score', ?, ?, ?)`,
        )
        .run(id, runStatus, at, at)
    sqlite
      .prepare(
        `INSERT INTO message_runs (message_id, run_id, room_id, agent_id, chain_id, hop, turn_id, parent_message_id, input, agents, state, created_at)
         VALUES (?, ?, 'room', 'lead', 'm1', ?, ?, 'm1', 'x', '[]', ?, ?)`,
      )
      .run(`reply:${id}`, runStatus ? id : null, hop, `t-${id}`, state, at)
  })
}
function task(id: string, hermesStatus: string, column: string, runIds: string[] = []) {
  db.tx((sqlite) => {
    projectTask(sqlite, {
      ...summaryDetail({
        id,
        key: 'T-1',
        title: id,
        column: column as 'done',
        hermesStatus,
        assignee: 'builder',
        reviewer: null,
        roomId: 'room',
        badge: null,
        progress: null,
        elapsedSec: null,
        note: null,
        updatedAt: at,
      }),
      runIds,
    })
    sqlite
      .prepare(
        "INSERT INTO brief_tasks (brief_id, task_id, origin, linked_at) VALUES ('m1', ?, 'assign', ?)",
      )
      .run(id, at)
  })
}
const status = () => db.read((sqlite) => deriveBriefStatus(sqlite, readBriefRow(sqlite, 'm1')!))
const create = () =>
  db.tx((sqlite) => createBrief(sqlite, { id: 'm1', roomId: 'room', text: 'Hello' }, at))

test('status: running while a turn is pending, active or waiting', () => {
  create()
  turn('pending', null, 'a')
  expect(status()).toBe('running')
  turn('completed', 'waiting_for_approval', 'b', 1)
  expect(status()).toBe('running')
})

test('status: done when everything finished, failed when the last turn or a task failed', () => {
  create()
  turn('completed', 'completed', 'a')
  expect(status()).toBe('done')
  turn('completed', 'failed', 'b', 1)
  expect(status()).toBe('failed')
})

test('status: a failed earlier turn does not matter once a later one succeeded', () => {
  create()
  db.tx((sqlite) => {
    sqlite.prepare('UPDATE message_runs SET created_at = created_at').run()
  })
  turn('completed', 'failed', 'a')
  db.tx((sqlite) =>
    sqlite
      .prepare(
        `INSERT INTO runs (id, profile, origin, status, started_at, updated_at) VALUES ('b', 'lead', 'score', 'completed', ?, ?)`,
      )
      .run(at, at),
  )
  db.tx((sqlite) =>
    sqlite
      .prepare(
        `INSERT INTO message_runs (message_id, run_id, room_id, agent_id, chain_id, hop, turn_id, parent_message_id, input, agents, state, created_at)
         VALUES ('reply:b', 'b', 'room', 'lead', 'm1', 1, 't-b', 'm1', 'x', '[]', 'completed', ?)`,
      )
      .run('2026-10-08T10:00:01.000Z'),
  )
  expect(status()).toBe('done')
})

test('status: unfinished tasks keep a brief running, a failed task run fails it', () => {
  create()
  turn('completed', 'completed', 'a')
  task('t1', 'todo', 'planned')
  expect(status()).toBe('running')
  db.tx((sqlite) => {
    sqlite
      .prepare(
        `INSERT INTO runs (id, profile, origin, status, started_at, updated_at) VALUES ('k1', 'builder', 'kanban', 'failed', ?, ?)`,
      )
      .run(at, at)
    projectTask(sqlite, {
      ...summaryDetail({
        id: 't1',
        key: 'T-1',
        title: 't1',
        column: 'working',
        hermesStatus: 'archived',
        assignee: 'builder',
        reviewer: null,
        roomId: 'room',
        badge: null,
        progress: null,
        elapsedSec: null,
        note: null,
        updatedAt: at,
      }),
      runIds: ['k1'],
    })
  })
  expect(status()).toBe('failed')
  task('t2', 'done', 'done')
  expect(status()).toBe('failed')
})

test('status: paused beats everything and a finished task set is done', () => {
  create()
  turn('active', 'running', 'a')
  db.tx((sqlite) => sqlite.prepare("UPDATE briefs SET paused_at = ? WHERE id = 'm1'").run(at))
  expect(status()).toBe('paused')
  db.tx((sqlite) => {
    sqlite.prepare("UPDATE briefs SET paused_at = NULL WHERE id = 'm1'").run()
    sqlite.prepare("UPDATE runs SET status = 'completed'").run()
    sqlite.prepare("UPDATE message_runs SET state = 'completed'").run()
  })
  task('t1', 'done', 'done')
  expect(status()).toBe('done')
})

test('titles are the first non-empty line, redacted and capped', () => {
  expect(briefTitle('\n\n  First line  \nsecond')).toBe('First line')
  expect(briefTitle('x'.repeat(300))).toHaveLength(120)
  expect(briefTitle('use key sk-abcdefghijklmnopqrstuvwxyz0123456789 now')).not.toContain(
    'sk-abcdefghij',
  )
  expect(briefTitle('   ')).toBe('Untitled brief')
})

test('an old unfinished brief is still listed as active behind 500 newer finished ones', () => {
  db.tx((sqlite) => {
    const add = sqlite.prepare(
      `INSERT INTO messages (id, room_id, author_kind, "to", parts, refs, streaming, created_at, updated_at)
       VALUES (?, 'room', 'you', '[]', '[]', '[]', 0, ?, ?)`,
    )
    const brief = sqlite.prepare(
      "INSERT INTO briefs (id, room_id, title, started_at, started_by) VALUES (?, 'room', 'b', ?, 'you')",
    )
    for (let index = 0; index < 501; index += 1) {
      const id = `new${index}`
      const started = new Date(Date.parse(at) + 1000 * (index + 1)).toISOString()
      add.run(id, started, started)
      brief.run(id, started)
    }
    // The oldest one ('m1' from setup) is waiting on a task that has not finished.
    brief.run('m1', at)
    sqlite
      .prepare(
        "INSERT INTO brief_tasks (brief_id, task_id, origin, linked_at) VALUES ('m1', 't1', 'assign', ?)",
      )
      .run(at)
  })
  const active = listBriefs(db.sqlite, 'active', Date.parse(at) + 3_600_000)
  expect(active.map((entry) => entry.id)).toEqual(['m1'])
})
