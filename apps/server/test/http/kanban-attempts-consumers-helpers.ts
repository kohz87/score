import type { TaskDetail } from '@score/contract'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach } from 'vitest'
import { buildApp } from '../../src/app.ts'
import { loadConfig } from '../../src/config.ts'
import { migrate, openDatabase, type ScoreDb } from '../../src/db/index.ts'
import { createBrief } from '../../src/domain/briefs.ts'
import { insertRoom } from '../../src/domain/rooms.ts'
import { projectTask } from '../../src/domain/tasks.ts'
import { createHermesPort, type HermesPort } from '../../src/hermes/index.ts'
import { createIngest, type Ingest } from '../../src/hub/ingest.ts'
import { FakeScheduler } from '../hermes/fake-scheduler.ts'
import { seedAttempt, seedHistory, withFlag } from '../helpers/kanban-attempts-seed.ts'

const NOW = Date.parse('2026-10-09T12:00:00.000Z')
const sec = (iso: string) => Math.floor(Date.parse(iso) / 1000)
export const at = (hhmm: string) => sec(`2026-10-09T${hhmm}:00.000Z`)
export const iso = (hhmm: string) => `2026-10-09T${hhmm}:00.000Z`

let dir: string
export let db: ScoreDb
let ingest: Ingest
export let port: HermesPort
let scheduler: FakeScheduler
let app: ReturnType<typeof buildApp>

export function setupKanbanAttemptsConsumersTest() {
  beforeEach(async () => {
    withFlag(false)
    dir = mkdtempSync(join(tmpdir(), 'score-attempts-'))
    db = openDatabase(join(dir, 'score.db'))
    migrate(db, fileURLToPath(new URL('../../migrations/', import.meta.url)))
    ingest = createIngest(db, { clock: () => NOW })
    scheduler = new FakeScheduler()
    port = createHermesPort(loadConfig({ SCORE_MODE: 'fake', SCORE_FAKE_LOOP: 'false' }), {
      db,
      scheduler,
    })
    app = buildApp({
      config: loadConfig({ SCORE_MODE: 'fake' }),
      logger: false,
      db,
      ingest,
      port,
      clock: () => NOW,
    })
  })
  afterEach(async () => {
    withFlag(false)
    await port.stop()
    await app.close()
    await ingest.close()
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })
}

function taskDetail(id: string, overrides: Partial<TaskDetail> = {}): TaskDetail {
  return {
    id,
    key: id.toUpperCase(),
    title: `Task ${id}`,
    column: 'done',
    hermesStatus: 'done',
    assignee: 'builder',
    reviewer: 'reviewer',
    roomId: null,
    badge: null,
    progress: null,
    elapsedSec: null,
    note: null,
    updatedAt: iso('11:45'),
    body: '',
    createdBy: 'lead',
    steps: [],
    activity: [],
    pendingApproval: null,
    dependsOn: [],
    blocks: [],
    runIds: [],
    completedAt: iso('11:45'),
    ...overrides,
  }
}

/** One active lineage, an earlier closed one, two tasks and the attempts every consumer is checked against. */
export function seedWorld(options: { attempts?: boolean } = {}): void {
  // A brief's id is its root message; the consumers under test never read the message.
  db.sqlite.exec('PRAGMA foreign_keys = OFF')
  db.tx((sqlite) => {
    seedHistory(sqlite)
    seedHistory(sqlite, { history: 'kh_old', state: 'closed' })
    projectTask(sqlite, taskDetail('t-done', { title: 'Done work' }))
    projectTask(
      sqlite,
      taskDetail('t-open', {
        title: 'Open work',
        column: 'working',
        hermesStatus: 'running',
        completedAt: null,
      }),
    )
    insertRoom(
      sqlite,
      { id: 'room-1', name: 'Room', kind: 'room', leadAgentId: 'lead', members: ['lead'] },
      iso('09:00'),
    )
    createBrief(
      sqlite,
      {
        id: 'brief-1',
        roomId: 'room-1',
        text: 'Ship the work',
        startedAt: iso('09:30'),
        tasks: [
          { taskId: 't-done', origin: 'assign' },
          { taskId: 't-open', origin: 'assign' },
        ],
      },
      iso('09:30'),
    )
    if (options.attempts === false) return
    // Same-second rejection, retry and approval with a null role in between (the lead's fixture, v4 §6).
    seedAttempt(sqlite, {
      attempt: 1,
      task: 't-done',
      start: at('10:00'),
      end: at('10:30'),
      copiedFrom: 'kr_00000000-0000-4000-8000-000000000009',
    })
    seedAttempt(sqlite, {
      attempt: 2,
      task: 't-done',
      profile: 'reviewer',
      role: 'reviewer',
      status: 'changes_requested',
      start: at('10:40'),
      end: at('10:50'),
    })
    seedAttempt(sqlite, { attempt: 3, task: 't-done', start: at('11:00'), end: at('11:20') })
    seedAttempt(sqlite, {
      attempt: 4,
      task: 't-done',
      profile: 'reviewer',
      role: 'reviewer',
      start: at('11:30'),
      end: at('11:40'),
    })
    // Unknown agent: one closed and proven, one partial and still observed.
    seedAttempt(sqlite, {
      attempt: 5,
      task: 't-open',
      profile: null,
      role: null,
      start: at('11:00'),
      end: at('11:10'),
    })
    seedAttempt(sqlite, {
      attempt: 6,
      task: 't-open',
      profile: null,
      role: null,
      evidence: 'partial',
      start: at('11:50'),
    })
    // Provenance unknown: a run for the agent, never working time.
    seedAttempt(sqlite, {
      attempt: 7,
      task: 't-open',
      evidence: 'partial',
      start: at('09:00'),
      end: at('09:05'),
    })
    // Observation ended before the attempt did: a boundary, not an end.
    seedAttempt(sqlite, {
      attempt: 8,
      task: 't-open',
      start: at('11:40'),
      observationEndedAt: iso('11:45'),
    })
    // The ancestral row attempt 1 was copied from (a restore): aggregates count the attempt once, through its newest row.
    seedAttempt(sqlite, {
      attempt: 9,
      task: 't-done',
      history: 'kh_old',
      start: at('10:00'),
      end: at('10:30'),
      firstSeen: '2026-09-30T00:00:00.000Z',
    })
    // From an earlier copy of the board: displayed, but its task is not the current one.
    seedAttempt(sqlite, {
      attempt: 10,
      task: 't-gone',
      history: 'kh_old',
      start: at('11:05'),
      end: at('11:06'),
    })
  })
  db.sqlite.exec('PRAGMA foreign_keys = ON')
}

export const body = async (url: string) => {
  const response = await app.inject({ method: 'GET', url })
  return { status: response.statusCode, text: response.body }
}
export const WINDOW = `from=${iso('08:30')}&to=${iso('13:00')}`
export const consumerUrls = [
  `/api/now?${WINDOW}`,
  '/api/reports?range=today&tz=UTC',
  '/api/reports?range=7d&tz=UTC',
  '/api/reports/export.csv?range=30d&tz=UTC',
  '/api/agents/builder/history',
]
