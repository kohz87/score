import { listJobs } from '../src/domain/exchanges/store.ts'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test } from 'vitest'
import type { Message } from '@score/contract'
import { migrate, openDatabase, type ScoreDb } from '../src/db/index.ts'
import { defaultJobId } from '../src/domain/job-sessions.ts'
import {
  approvalMessage,
  attachRunMessage,
  completeRunMessage,
  failMessageRun,
  roomRunInput,
} from '../src/domain/message-runs.ts'
import {
  insertRoom,
  markRoomRead,
  messageFromRow,
  readRoom,
  storeMessage,
} from '../src/domain/rooms.ts'
import {
  requestSummary,
  shouldAutoSummarise,
  uncoveredTokens,
} from '../src/domain/room-summaries.ts'
import { markStaleSummaries, visibleSummaries } from '../src/domain/summary-stale.ts'
import { createVersion, markRunsRewound, rewindScope } from '../src/domain/versions.ts'

// PLAN 11.1b: a room can hold several jobs; every operation below is scoped to one job and leaves the other alone.
const at = (second: number) => new Date(Date.UTC(2026, 9, 24, 10, 0, second)).toISOString()
const ROOM = 'r1'
const SECOND_JOB = 'job_second'
let dir: string
let db: ScoreDb

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'score-job-scope-'))
  db = openDatabase(join(dir, 'score.db'))
  migrate(db, fileURLToPath(new URL('../migrations/', import.meta.url)))
  insertRoom(
    db.sqlite,
    {
      id: ROOM,
      name: '#release',
      kind: 'room',
      leadAgentId: 'lead',
      members: ['lead', 'builder', 'reviewer'],
    },
    at(0),
  )
  db.sqlite
    .prepare(
      "INSERT INTO jobs (id, room_id, title, session_scheme, created_at, updated_at) VALUES (?, ?, 'Side thread', 'job', ?, ?)",
    )
    .run(SECOND_JOB, ROOM, at(0), at(0))
  for (const agentId of ['lead', 'builder', 'reviewer'])
    db.sqlite
      .prepare(
        "INSERT INTO agent_lifecycle (agent_id, incarnation_id, state) VALUES (?, ?, 'ready')",
      )
      .run(agentId, randomUUID())
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const defaultJob = () => defaultJobId(db.sqlite, ROOM)!
function say(
  id: string,
  jobId: string,
  text: string,
  second: number,
  author: Message['author'] = { kind: 'you' },
) {
  const message: Message = {
    id,
    roomId: ROOM,
    jobId,
    author,
    to: [],
    parts: [{ kind: 'text', text }],
    refs: [],
    createdAt: at(second),
    streaming: false,
  }
  storeMessage(db.sqlite, message, at(second))
  return message
}
function addTurn(
  parentId: string,
  agentId: string,
  runId: string,
  state: 'completed' | 'failed' | 'pending' | 'active' = 'completed',
) {
  const parent = db.sqlite.prepare('SELECT created_at FROM messages WHERE id = ?').get(parentId) as
    { created_at: string } | undefined
  const createdAt = parent?.created_at ?? at(0)
  if (state !== 'pending')
    db.sqlite
      .prepare(
        "INSERT OR IGNORE INTO runs (id, profile, origin, status, started_at, updated_at) VALUES (?, ?, 'score', ?, ?, ?)",
      )
      .run(runId, agentId, state === 'active' ? 'running' : 'completed', createdAt, createdAt)
  db.sqlite
    .prepare(
      `INSERT INTO message_runs
       (message_id, run_id, room_id, agent_id, chain_id, hop, turn_id, parent_message_id, input, agents, state, created_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?, 'x', '[]', ?, ?)`,
    )
    .run(
      `reply:${runId}`,
      state === 'pending' ? null : runId,
      ROOM,
      agentId,
      parentId,
      `turn-${runId}`,
      parentId,
      state,
      createdAt,
    )
}
function storedMessage(id: string) {
  return messageFromRow(db.sqlite.prepare('SELECT * FROM messages WHERE id = ?').get(id))
}
function finishSummary(jobId: string, output: string, runId: string, second: number) {
  const turn = db.sqlite
    .prepare(
      "SELECT turn_id FROM message_runs WHERE job_id = ? AND purpose = 'summary' ORDER BY rowid DESC",
    )
    .get(jobId) as { turn_id: string }
  db.sqlite
    .prepare(
      "INSERT INTO runs (id, profile, origin, status, started_at, updated_at) VALUES (?, 'lead', 'score', 'completed', ?, ?)",
    )
    .run(runId, at(second), at(second))
  attachRunMessage(db.sqlite, turn.turn_id, runId, at(second))
  return completeRunMessage(db.sqlite, runId, at(second + 1), { output })
}

test("rewindScope counts only the anchor's job and uses that job's sessions", () => {
  const job = defaultJob()
  say('d-anchor', job, 'default anchor', 3)
  say('d-after', job, 'default after', 4)
  say('d-last', job, 'default last', 5)
  say('j-anchor', SECOND_JOB, 'second anchor', 3)
  say('j-after', SECOND_JOB, 'second after', 4)
  addTurn('d-anchor', 'builder', 'd-one')
  addTurn('d-after', 'builder', 'd-two')
  addTurn('j-anchor', 'builder', 'j-one')

  expect(rewindScope(db.sqlite, ROOM, storedMessage('d-anchor'))).toEqual({
    hiddenCount: 3,
    blocked: null,
    agents: [{ agentId: 'builder', turns: 2, sessionId: 'score-r1-builder' }],
  })
  expect(rewindScope(db.sqlite, ROOM, storedMessage('j-anchor'))).toEqual({
    hiddenCount: 2,
    blocked: null,
    agents: [
      {
        agentId: 'builder',
        turns: 1,
        sessionId: 'score-r1-job_second-builder',
      },
    ],
  })
})

test('createVersion hides the anchor and later messages in that job only', () => {
  const job = defaultJob()
  say('d-before', job, 'default before', 1)
  say('d-anchor', job, 'default anchor', 2)
  say('d-after', job, 'default after', 3)
  say('j-before', SECOND_JOB, 'second before', 1)
  say('j-anchor', SECOND_JOB, 'second anchor', 2)
  say('j-after', SECOND_JOB, 'second after', 3)

  const { version } = createVersion(
    db.sqlite,
    {
      roomId: ROOM,
      anchor: storedMessage('d-anchor'),
      mode: 'delete',
      scoreOnly: true,
      rewound: [],
      skipped: [],
    },
    at(10),
  )

  expect(version.hiddenCount).toBe(2)
  expect(
    db.sqlite
      .prepare(
        'SELECT id, job_id FROM messages WHERE deleted_at IS NOT NULL AND version_id = ? ORDER BY id',
      )
      .all(version.id),
  ).toEqual([
    { id: 'd-after', job_id: job },
    { id: 'd-anchor', job_id: job },
  ])
  expect(
    db.sqlite
      .prepare('SELECT id FROM messages WHERE room_id = ? AND deleted_at IS NULL ORDER BY id')
      .all(ROOM),
  ).toEqual([{ id: 'd-before' }, { id: 'j-after' }, { id: 'j-anchor' }, { id: 'j-before' }])
})

test("markRunsRewound marks only the named job's runs", () => {
  const job = defaultJob()
  say('d-anchor', job, 'default anchor', 2)
  say('j-anchor', SECOND_JOB, 'second anchor', 2)
  addTurn('d-anchor', 'builder', 'd-builder')
  addTurn('d-anchor', 'reviewer', 'd-reviewer')
  addTurn('j-anchor', 'builder', 'j-builder')

  markRunsRewound(db.sqlite, ROOM, job, 'builder', at(2), at(10))

  expect(
    db.sqlite
      .prepare('SELECT run_id, job_id, agent_id, rewound_at FROM message_runs ORDER BY run_id')
      .all(),
  ).toEqual([
    { run_id: 'd-builder', job_id: job, agent_id: 'builder', rewound_at: at(10) },
    { run_id: 'd-reviewer', job_id: job, agent_id: 'reviewer', rewound_at: null },
    { run_id: 'j-builder', job_id: SECOND_JOB, agent_id: 'builder', rewound_at: null },
  ])
})

test('requestSummary reads only its job and replaces only that job’s older summary', () => {
  const job = defaultJob()
  say('a1', job, 'default alpha one', 1)
  say('a2', job, 'default alpha two', 2)
  say('b1', SECOND_JOB, 'second beta one', 1)
  say('b2', SECOND_JOB, 'second beta two', 2)

  requestSummary(db.sqlite, ROOM, at(10), SECOND_JOB)
  const firstInput = (
    db.sqlite
      .prepare("SELECT admission_input FROM message_runs WHERE job_id = ? AND purpose = 'summary'")
      .get(SECOND_JOB) as { admission_input: string }
  ).admission_input
  expect(firstInput).toContain('second beta one')
  expect(firstInput).toContain('second beta two')
  expect(firstInput).not.toContain('default alpha')
  finishSummary(SECOND_JOB, 'Second summary one', 'summary-b1', 10)

  requestSummary(db.sqlite, ROOM, at(20), job)
  const defaultInput = (
    db.sqlite
      .prepare("SELECT admission_input FROM message_runs WHERE job_id = ? AND purpose = 'summary'")
      .get(job) as { admission_input: string }
  ).admission_input
  expect(defaultInput).toContain('default alpha one')
  expect(defaultInput).not.toContain('second beta')
  finishSummary(job, 'Default summary', 'summary-a1', 20)

  say('b3', SECOND_JOB, 'second beta three', 30)
  requestSummary(db.sqlite, ROOM, at(40), SECOND_JOB)
  const replacement = finishSummary(SECOND_JOB, 'Second summary two', 'summary-b2', 40)
  expect(replacement.some((draft) => draft.type === 'message.deleted')).toBe(true)

  expect(visibleSummaries(db.sqlite, ROOM, SECOND_JOB)).toMatchObject([
    { part: { kind: 'summary', text: 'Second summary two' } },
  ])
  expect(visibleSummaries(db.sqlite, ROOM, job)).toMatchObject([
    { part: { kind: 'summary', text: 'Default summary' } },
  ])
})

test('a summary is context only in its own job, with and without one', () => {
  const job = defaultJob()
  say('a1', job, 'default context only', 1)
  say('b1', SECOND_JOB, 'second context only', 1)

  expect(roomRunInput(db.sqlite, ROOM, 'ask', 'missing', job)).toContain(
    'you: default context only',
  )
  expect(roomRunInput(db.sqlite, ROOM, 'ask', 'missing', job)).not.toContain('second context only')
  expect(roomRunInput(db.sqlite, ROOM, 'ask', 'missing', SECOND_JOB)).toContain(
    'you: second context only',
  )
  expect(roomRunInput(db.sqlite, ROOM, 'ask', 'missing', SECOND_JOB)).not.toContain(
    'default context only',
  )

  requestSummary(db.sqlite, ROOM, at(10), job)
  finishSummary(job, 'Default summary only', 'summary-context', 10)
  say('a2', job, 'default tail only', 20)

  const withSummary = roomRunInput(db.sqlite, ROOM, 'ask', 'missing', job)
  expect(withSummary).toContain('Default summary only')
  expect(withSummary).toContain('you: default tail only')
  expect(withSummary).not.toContain('default context only')
  const otherJob = roomRunInput(db.sqlite, ROOM, 'ask', 'missing', SECOND_JOB)
  expect(otherJob).toContain('you: second context only')
  expect(otherJob).not.toContain('Default summary only')
})

test('markStaleSummaries marks stale summaries in either job', () => {
  const job = defaultJob()
  say('a1', job, 'default stale me', 1)
  say('a2', job, 'default covered', 2)
  say('b1', SECOND_JOB, 'second stale me', 1)
  say('b2', SECOND_JOB, 'second covered', 2)
  requestSummary(db.sqlite, ROOM, at(10), job)
  finishSummary(job, 'Default summary', 'stale-a', 10)
  requestSummary(db.sqlite, ROOM, at(20), SECOND_JOB)
  finishSummary(SECOND_JOB, 'Second summary', 'stale-b', 20)

  db.sqlite.prepare('UPDATE messages SET deleted_at = ? WHERE id = ?').run(at(30), 'a1')
  expect(markStaleSummaries(db.sqlite, ROOM, at(31))).toMatchObject([
    { type: 'message.updated', data: { roomId: ROOM } },
  ])
  expect(visibleSummaries(db.sqlite, ROOM, job)[0]?.part.stale).toBe(true)
  expect(visibleSummaries(db.sqlite, ROOM, SECOND_JOB)[0]?.part.stale).toBeUndefined()

  db.sqlite.prepare('UPDATE messages SET deleted_at = ? WHERE id = ?').run(at(40), 'b1')
  expect(markStaleSummaries(db.sqlite, ROOM, at(41))).toMatchObject([
    { type: 'message.updated', data: { roomId: ROOM } },
  ])
  expect(visibleSummaries(db.sqlite, ROOM, SECOND_JOB)[0]?.part.stale).toBe(true)
})

test('uncoveredTokens and shouldAutoSummarise count one job at a time', () => {
  const job = defaultJob()
  say('a1', job, 'a'.repeat(12_000), 1)
  say('b1', SECOND_JOB, 'b'.repeat(4_000), 1)
  db.sqlite
    .prepare('UPDATE rooms SET auto_summary = ? WHERE id = ?')
    .run(JSON.stringify({ enabled: true, thresholdTokens: 2000 }), ROOM)

  expect(uncoveredTokens(db.sqlite, ROOM, job)).toBe(3000)
  expect(uncoveredTokens(db.sqlite, ROOM, SECOND_JOB)).toBe(1000)
  expect(shouldAutoSummarise(db.sqlite, ROOM, job)).toBe(true)
  expect(shouldAutoSummarise(db.sqlite, ROOM, SECOND_JOB)).toBe(false)

  say('b2', SECOND_JOB, 'b'.repeat(9_000), 2)
  expect(uncoveredTokens(db.sqlite, ROOM, SECOND_JOB)).toBe(3250)
  expect(shouldAutoSummarise(db.sqlite, ROOM, SECOND_JOB)).toBe(true)
})

test('the room badge counts its default job; each job keeps its own unread (11.2 review)', () => {
  const job = defaultJob()
  const defaultMessage = say('d-agent', job, 'default reply', 1, {
    kind: 'agent',
    agentId: 'builder',
  })
  say('j-agent', SECOND_JOB, 'second reply', 2, {
    kind: 'agent',
    agentId: 'reviewer',
  })
  // The classic shell's badge: the default job only (it can't open the other one).
  expect(readRoom(db.sqlite, ROOM, at(3)).unread).toBe(1)
  const unread = (jobId: string) =>
    listJobs(db.sqlite, ROOM).find((item) => item.id === jobId)!.unread

  markRoomRead(db.sqlite, ROOM, at(4), defaultMessage)
  expect(db.sqlite.prepare('SELECT job_id FROM job_reads').all()).toEqual([{ job_id: job }])
  expect(readRoom(db.sqlite, ROOM, at(5)).unread).toBe(0)
  expect(unread(SECOND_JOB)).toBe(1)

  markRoomRead(db.sqlite, ROOM, at(6), storedMessage('j-agent'))
  expect(unread(SECOND_JOB)).toBe(0)
})

test('approval cards and failure notices land in their turn’s job', () => {
  const job = defaultJob()
  say('d-parent', job, 'default parent', 1)
  say('j-parent', SECOND_JOB, 'second parent', 1)
  addTurn('j-parent', 'builder', 'approval-run', 'active')
  db.sqlite
    .prepare(
      `INSERT INTO approvals (id, origin, stage, target_kind, run_id, request_id, profile, session_key, surface,
         command, description, pattern_keys, choices, phase, status, created_at, updated_at)
       VALUES ('approval-1', 'score-run', 'human', 'run_request', 'approval-run', 'req-1', 'builder',
         'approval-run', 'cli', 'rm', 'delete', '[]', '["once"]', 'human_pending', 'pending', ?, ?)`,
    )
    .run(at(2), at(2))

  const approval = approvalMessage(db.sqlite, 'approval-1', at(3))
  expect(approval[0]).toMatchObject({
    type: 'message.created',
    data: { id: 'approval:approval-1', jobId: SECOND_JOB },
  })

  addTurn('j-parent', 'builder', 'failure-run', 'pending')
  const failure = failMessageRun(db.sqlite, 'turn-failure-run', 'boom', at(4), 'It failed.')
  // The default room routes with exchanges now (11.11): settling the failed turn and storing the message each emit job.upserted.
  expect(failure.map((event) => event.type)).toEqual([
    'job.upserted',
    'message.created',
    'job.upserted',
  ])
  expect(failure[1]).toMatchObject({
    type: 'message.created',
    data: { id: 'reply:failure-run', jobId: SECOND_JOB },
  })
  expect(
    db.sqlite
      .prepare(
        "SELECT job_id FROM messages WHERE id IN ('approval:approval-1', 'reply:failure-run') ORDER BY id",
      )
      .all(),
  ).toEqual([{ job_id: SECOND_JOB }, { job_id: SECOND_JOB }])
})
