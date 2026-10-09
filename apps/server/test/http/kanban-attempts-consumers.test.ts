import {
  AgentHistoryPageSchema,
  AttemptDetailSchema,
  BriefFlowSchema,
  FlowNodeDetailSchema,
  NowSnapshotSchema,
  ReportsSchema,
  StreamEventSchema,
  type TaskDetail,
} from '@score/contract'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { buildApp } from '../../src/app.ts'
import { loadConfig } from '../../src/config.ts'
import { migrate, openDatabase, type ScoreDb } from '../../src/db/index.ts'
import { createBrief } from '../../src/domain/briefs.ts'
import { attemptUpdates } from '../../src/domain/kanban-attempts.ts'
import { insertRoom } from '../../src/domain/rooms.ts'
import { computeReports } from '../../src/domain/reports.ts'
import { rewriteReceipts } from '../../src/domain/legacy-links.ts'
import { projectTask } from '../../src/domain/tasks.ts'
import { HttpError } from '../../src/errors.ts'
import { decodeReceipt, encodeReceipt } from '../../src/receipt-codec.ts'
import { createHermesPort, type HermesPort } from '../../src/hermes/index.ts'
import { createIngest, type Ingest } from '../../src/hub/ingest.ts'
import { FakeScheduler } from '../hermes/fake-scheduler.ts'
import { seedAttempt, seedHistory, withFlag } from '../helpers/kanban-attempts-seed.ts'

const NOW = Date.parse('2026-10-09T12:00:00.000Z')
const sec = (iso: string) => Math.floor(Date.parse(iso) / 1000)
const at = (hhmm: string) => sec(`2026-10-09T${hhmm}:00.000Z`)
const iso = (hhmm: string) => `2026-10-09T${hhmm}:00.000Z`

let dir: string
let db: ScoreDb
let ingest: Ingest
let port: HermesPort
let scheduler: FakeScheduler
let app: ReturnType<typeof buildApp>
let headers: { 'x-score-client': string; cookie: string }

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
  const paired = await app.inject({
    method: 'POST',
    url: '/api/session/pair',
    headers: { 'x-score-client': 'web' },
    payload: { token: app.pairing.createToken() },
  })
  headers = {
    'x-score-client': 'web',
    cookie: paired.headers['set-cookie']!.toString().split(';')[0]!,
  }
})
afterEach(async () => {
  withFlag(false)
  await port.stop()
  await app.close()
  await ingest.close()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

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
function seedWorld(options: { attempts?: boolean } = {}): void {
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

const body = async (url: string) => {
  const response = await app.inject({ method: 'GET', url })
  return { status: response.statusCode, text: response.body }
}
const WINDOW = `from=${iso('08:30')}&to=${iso('13:00')}`
const consumerUrls = [
  `/api/now?${WINDOW}`,
  '/api/reports?range=today&tz=UTC',
  '/api/reports?range=7d&tz=UTC',
  '/api/reports/export.csv?range=30d&tz=UTC',
  '/api/agents/builder/history',
  '/api/briefs/brief-1/flow',
  '/api/flow/nodes/task:t-done',
]

describe('with attempts off, every existing response is what it was without any attempt', () => {
  test('attempt rows (even a live history) change none of the consumer responses, byte for byte', async () => {
    seedWorld({ attempts: false })
    // The first reads settle lazily seeded state (agents, demo history): compare settled responses only.
    await Promise.all(consumerUrls.map(body))
    const before = await Promise.all(consumerUrls.map(body))
    expect(before.map((r) => r.status)).toEqual(consumerUrls.map(() => 200))
    // Add attempts to the same database.
    db.tx((sqlite) => {
      const rows: Parameters<typeof seedAttempt>[1][] = [
        { attempt: 1, task: 't-done', start: at('10:00'), end: at('10:30') },
        {
          attempt: 5,
          task: 't-open',
          profile: null,
          role: null,
          start: at('11:00'),
          end: at('11:10'),
        },
        {
          attempt: 6,
          task: 't-open',
          profile: null,
          role: null,
          evidence: 'partial',
          start: at('11:50'),
        },
      ]
      for (const row of rows) seedAttempt(sqlite, row)
    })
    const after = await Promise.all(consumerUrls.map(body))
    expect(after).toEqual(before)
    // The attempt detail route does not exist either.
    expect((await body('/api/attempts/kr_00000000-0000-4000-8000-000000000001')).status).toBe(404)
  })

  test('Now keeps its old shape: no unattributed lane, no attempt fields, checks carry a verdict', async () => {
    seedWorld()
    const now = NowSnapshotSchema.parse(JSON.parse((await body(`/api/now?${WINDOW}`)).text))
    expect(now.unattributed).toBeUndefined()
    expect(now.lanes.flatMap((lane) => lane.blocks)).toEqual([])
    for (const item of now.madeToday)
      for (const check of item.checks) expect(['passed', 'unknown']).toContain(check.verdict)
  })
})

describe('Now', () => {
  test('attempt blocks sit in their agent lane; unknown agents get the Unattributed lane; boundaries end the block', async () => {
    seedWorld()
    withFlag(true)
    const now = NowSnapshotSchema.parse(JSON.parse((await body(`/api/now?${WINDOW}`)).text))
    const builder = now.lanes.find((lane) => lane.agent.id === 'builder')!
    const ids = builder.blocks.map((block) => block.attemptId)
    // Copies and the closed lineage's attempt are not in the builder's lane twice; partial ones are marked.
    expect(ids).toHaveLength(new Set(ids).size)
    const first = builder.blocks.find((block) => block.order?.[1] === 1)!
    expect(first).toMatchObject({
      runId: null,
      state: 'done',
      provenance: 'proven',
      taskId: 't-done',
      label: 'Done work',
      end: iso('10:30'),
    })
    expect(builder.blocks.find((block) => block.order?.[1] === 7)?.provenance).toBe('partial')
    // The observation boundary is where the block ends; the attempt did not end there.
    const boundary = builder.blocks.find((block) => block.order?.[1] === 8)!
    expect(boundary).toMatchObject({
      state: 'done',
      end: iso('11:45'),
      observationEndedAt: iso('11:45'),
    })
    // The reviewer role comes from the stored claim role: a review label, and the rejection is a block too.
    const reviewer = now.lanes.find((lane) => lane.agent.id === 'reviewer')!
    expect(reviewer.blocks.map((block) => block.label)).toEqual([
      'Review: Done work',
      'Review: Done work',
    ])
    // Unattributed lane, ordered by (start, upstream id); the open observed one is still working.
    const lane = now.unattributed!.blocks
    expect(lane.map((block) => block.order![1])).toEqual([5, 6])
    expect(lane.map((block) => block.state)).toEqual(['done', 'working'])
    expect(lane[1]!.provenance).toBe('partial')
    // The unattributed attempt does not make an agent "working".
    expect(now.headline.working).toBe(0)
  })

  test('hand-offs to and from the Unattributed lane carry a null agent; attempts from an earlier board are unlinked', async () => {
    seedWorld()
    withFlag(true)
    const now = NowSnapshotSchema.parse(JSON.parse((await body(`/api/now?${WINDOW}`)).text))
    const toUnknown = now.handoffs.find((handoff) => handoff.to.agentId === null)
    expect(toUnknown?.from.agentId).toBe('builder')
    expect(toUnknown?.kind).toBe('handoff')
    const old = now.lanes.flatMap((lane) => lane.blocks).find((block) => block.order?.[1] === 10)
    expect(old).toMatchObject({ taskId: null })
  })

  test('review checks are exact: a rejection is changes_requested, only the last reviewer attempt of a done task passed', async () => {
    seedWorld()
    withFlag(true)
    const now = NowSnapshotSchema.parse(JSON.parse((await body(`/api/now?${WINDOW}`)).text))
    const item = now.madeToday.find((entry) => entry.title === 'Done work')!
    expect(item.checks.map((check) => check.verdict)).toEqual(['changes_requested', 'passed'])
    expect(item.checks.every((check) => check.agentId === 'reviewer')).toBe(true)
  })

  test('a completed review followed by more work is unknown, never passed', async () => {
    seedWorld()
    db.tx((sqlite) =>
      seedAttempt(sqlite, { attempt: 11, task: 't-done', start: at('11:50'), end: at('11:55') }),
    )
    withFlag(true)
    const now = NowSnapshotSchema.parse(JSON.parse((await body(`/api/now?${WINDOW}`)).text))
    const item = now.madeToday.find((entry) => entry.title === 'Done work')!
    expect(item.checks.map((check) => check.verdict)).toEqual(['changes_requested', 'unknown'])
  })
})

describe('Flow', () => {
  test('stats count attempts, their cost is unknown, and a step lists its attempts with tools not observed', async () => {
    seedWorld()
    withFlag(true)
    const flow = BriefFlowSchema.parse(JSON.parse((await body('/api/briefs/brief-1/flow')).text))
    expect(flow.stats.attempts).toBe(8)
    expect(flow.stats.spendUsd).toBeNull()
    const detail = FlowNodeDetailSchema.parse(
      JSON.parse((await body('/api/flow/nodes/task:t-done')).text),
    )
    expect(detail.tools).toBeNull()
    expect(detail.attempts!.map((attempt) => attempt.order[1])).toEqual([1, 2, 3, 4])
    expect(detail.attempts![1]).toMatchObject({ status: 'changes_requested', role: 'reviewer' })
    expect(
      detail.attempts!.every((attempt) => attempt.model === null && attempt.tools === null),
    ).toBe(true)
  })

  test('with attempts off the same step reports an empty tool list and no attempts', async () => {
    seedWorld()
    const detail = FlowNodeDetailSchema.parse(
      JSON.parse((await body('/api/flow/nodes/task:t-done')).text),
    )
    expect(detail.tools).toEqual([])
    expect(detail.attempts).toBeUndefined()
    const flow = BriefFlowSchema.parse(JSON.parse((await body('/api/briefs/brief-1/flow')).text))
    expect(flow.stats.attempts).toBeUndefined()
  })
})

describe('Reports', () => {
  test('attempts count as runs; partial ones are never working time; unknown agents get their own bucket', async () => {
    seedWorld()
    const off = ReportsSchema.parse(
      JSON.parse((await body('/api/reports?range=today&tz=UTC')).text),
    )
    expect(off.unattributed).toBeUndefined()
    withFlag(true)
    const report = ReportsSchema.parse(
      JSON.parse((await body('/api/reports?range=today&tz=UTC')).text),
    )
    const builder = report.byAgent.find((row) => row.agentId === 'builder')!
    const baseline = off.byAgent.find((row) => row.agentId === 'builder')?.runs ?? 0
    // Attempts 1, 3, 7, 8 and 10 (the earlier board's) are the builder's; the ancestral copy is excluded.
    expect(builder.runs - baseline).toBe(5)
    expect(report.byAgent.find((row) => row.agentId === 'reviewer')!.runs).toBe(2)
    // Unattributed: attempt 5 (proven, 10 minutes) and 6 (partial, still observed; never working time).
    expect(report.unattributed).toEqual({ runs: 2, workingSec: 600 })
    expect(report.totals.runs - off.totals.runs).toBe(7)
    // The trend counts the attributed attempts too (and not the unattributed ones).
    expect(report.trend.at(-1)!.runs - off.trend.at(-1)!.runs).toBe(7)
  })

  test('the CSV counts attempts per agent and adds an Unattributed row', async () => {
    seedWorld()
    withFlag(true)
    const csv = (await body('/api/reports/export.csv?range=today&tz=UTC')).text
    const rows = csv.trim().split('\r\n')
    expect(rows.at(-1)).toBe('Unattributed,,2,,,')
    expect(rows.some((row) => row.startsWith('Builder,') || row.startsWith('builder,'))).toBe(true)
  })
})

describe('Team history', () => {
  test('attempts are listed under their agent with their outcome; an earlier board has no task link', async () => {
    seedWorld()
    withFlag(true)
    const page = AgentHistoryPageSchema.parse(
      JSON.parse((await body('/api/agents/builder/history')).text),
    )
    const attempts = page.items.filter((item) => item.attempt)
    // Newest first; the ancestral copy (9) is not listed twice.
    expect(attempts.map((item) => item.attempt!.order[1])).toEqual([8, 10, 3, 1, 7])
    const byNumber = new Map(attempts.map((item) => [item.attempt!.order[1], item]))
    expect(byNumber.get(1)).toMatchObject({
      origin: 'kanban',
      outcome: 'completed',
      title: 'Done work',
      task: { id: 't-done', title: 'Done work' },
      brief: { id: 'brief-1' },
      replaySeq: null,
      durationSec: 1800,
    })
    // From an earlier copy of the board the task is not linked; the row still opens its attempt.
    expect(byNumber.get(10)).toMatchObject({ task: null, brief: null })
    // Not observed to the end: not a "running" or "completed" row.
    expect(byNumber.get(8)!.outcome).toBe('unknown')
    // Newest first.
    const times = page.items.map((item) => Date.parse(item.startedAt))
    expect([...times].sort((a, b) => b - a)).toEqual(times)
    const reviewer = AgentHistoryPageSchema.parse(
      JSON.parse((await body('/api/agents/reviewer/history')).text),
    )
    expect(reviewer.items.map((item) => item.attempt?.status)).toEqual([
      'completed',
      'changes_requested',
    ])
  })

  test('outcome and text filters apply to attempts', async () => {
    seedWorld()
    withFlag(true)
    const failed = AgentHistoryPageSchema.parse(
      JSON.parse((await body('/api/agents/reviewer/history?outcome=failed')).text),
    )
    expect(failed.items).toEqual([])
    const found = AgentHistoryPageSchema.parse(
      JSON.parse((await body('/api/agents/reviewer/history?q=done%20work')).text),
    )
    expect(found.items).toHaveLength(2)
  })
})

describe('Attempt detail', () => {
  test('returns the summary and the frozen task snapshot, also from an earlier board; unknown ids are 404', async () => {
    seedWorld()
    withFlag(true)
    const current = AttemptDetailSchema.parse(
      JSON.parse((await body('/api/attempts/kr_00000000-0000-4000-8000-000000000001')).text),
    )
    expect(current.task).toEqual({ taskId: 't-done', historyId: 'kh_test', current: true })
    expect(current.taskSnapshot?.title).toBe('Snapshot of t-done')
    const old = AttemptDetailSchema.parse(
      JSON.parse((await body('/api/attempts/kr_00000000-0000-4000-8000-000000000010')).text),
    )
    expect(old.task).toEqual({ taskId: 't-gone', historyId: 'kh_old', current: false })
    expect((await body('/api/attempts/kr_nope')).status).toBe(404)
    expect((await body('/api/attempts/not-an-attempt')).status).toBe(400)
  })
})

describe('Stop', () => {
  test('a Kanban attempt is refused with the existing 501 before any profile lookup', async () => {
    seedWorld()
    // The agent does not exist: a profile lookup would fail differently.
    await expect(port.stopRun({ agentId: 'nobody', runId: 'kr_anything' })).rejects.toMatchObject({
      status: 501,
      code: 'unsupported',
    })
    await expect(port.stopRun({ agentId: 'nobody', runId: 'kr_anything' })).rejects.toBeInstanceOf(
      HttpError,
    )
  })

  test('a step with an attempt that is still observed running answers 501 instead of "nothing is running"', async () => {
    seedWorld()
    withFlag(true)
    const response = await app.inject({
      method: 'POST',
      url: '/api/flow/nodes/task:t-open/stop',
      headers,
      payload: {},
    })
    expect(response.statusCode).toBe(501)
    expect(response.json().error.code).toBe('unsupported')
    withFlag(false)
    const off = await app.inject({
      method: 'POST',
      url: '/api/flow/nodes/task:t-open/stop',
      headers,
      payload: {},
    })
    expect(off.statusCode).toBe(409)
  })
})

describe('attempt.updated', () => {
  test('is built from the committed row and validates against the stream contract', () => {
    seedWorld()
    const drafts = attemptUpdates(db.sqlite, [
      'kr_00000000-0000-4000-8000-000000000004',
      'kr_00000000-0000-4000-8000-000000000004',
      'kr_unknown',
    ])
    expect(drafts).toHaveLength(1)
    const event = StreamEventSchema.parse({ seq: 1, ts: iso('12:00'), ...drafts[0] })
    expect(event.type).toBe('attempt.updated')
  })
})

describe('report arithmetic with attempts', () => {
  const base = {
    range: 'today' as const,
    now: Date.parse('2026-10-09T12:00:00.000Z'),
    tz: 'UTC',
    agentIds: ['builder'],
    runs: [],
    approvals: [],
    facts: { tasks: [], spendUsd: { builder: 0 } },
  }
  test('unknown-agent working time covers proven attempts only and stops at the observation boundary', () => {
    const report = computeReports({
      ...base,
      attempts: [
        { agentId: null, startedAt: iso('11:00'), endedAt: iso('11:10'), evidence: 'proven' },
        // Observation ended at 11:45: 5 proven minutes, not 20.
        { agentId: null, startedAt: iso('11:40'), endedAt: iso('11:45'), evidence: 'proven' },
        // Still running but never proven: a run, not working time.
        { agentId: null, startedAt: iso('11:50'), endedAt: null, evidence: 'partial' },
      ],
    })
    expect(report.unattributed).toEqual({ runs: 3, workingSec: 900 })
    // The bucket is separate from every agent total.
    expect(report.totals.runs).toBe(0)
    expect(report.byAgent.map((row) => row.runs)).toEqual([0])
  })
  test('an agent attempt is a run; only a proven one is working time', () => {
    const proven = computeReports({
      ...base,
      attempts: [
        { agentId: 'builder', startedAt: iso('10:00'), endedAt: iso('10:30'), evidence: 'proven' },
      ],
    })
    const partial = computeReports({
      ...base,
      attempts: [
        { agentId: 'builder', startedAt: iso('10:00'), endedAt: iso('10:30'), evidence: 'partial' },
      ],
    })
    expect(proven.byAgent[0]!.runs).toBe(1)
    expect(partial.byAgent[0]!.runs).toBe(1)
    expect(proven.timeSplit[0]!.workingPct).toBe(100)
    expect(partial.timeSplit[0]!.workingPct).toBe(0)
  })
  test('without attempts the report has no unattributed bucket', () => {
    expect(computeReports(base).unattributed).toBeUndefined()
  })
})

describe('legacy numeric run links', () => {
  const TASK = 'task-pagination-0'
  async function world(): Promise<{ mapped: string }> {
    await port.start(ingest)
    await scheduler.advance(700 * 18)
    db.tx((sqlite) => {
      seedHistory(sqlite)
      projectTask(sqlite, taskDetail(TASK, { runIds: ['12', '13', '14', '15', 'gw-run'] }))
    })
    const mapped = seedAttempt(db.sqlite, {
      attempt: 12,
      task: TASK,
      start: at('10:00'),
      end: at('10:30'),
    })
    const insert = db.sqlite.prepare(
      `INSERT INTO kanban_upgrade_links (task_id, legacy_id, saved_evidence, status, attempt_key, reason, snapshotted_at)
       VALUES (?, ?, '{"claims":[]}', ?, ?, ?, '2026-10-01T00:00:00.000Z')`,
    )
    insert.run(TASK, '12', 'mapped', mapped, null)
    insert.run(TASK, '13', 'unresolved', null, 'no_affirmative_evidence')
    insert.run(TASK, '14', 'pending', null, null)
    return { mapped }
  }

  test('the served task has mapped ids, unresolved links and no numeric id; attempts off serves it as stored', async () => {
    const { mapped } = await world()
    // 15 is a numeric id first seen after the upgrade: it maps through the followed lineage when Score has it.
    const fresh = seedAttempt(db.sqlite, {
      attempt: 15,
      task: TASK,
      start: at('11:00'),
      end: at('11:10'),
    })
    withFlag(true)
    const on = (await app.inject(`/api/tasks/${TASK}`)).json()
    expect([...on.runIds].sort()).toEqual([fresh, mapped, 'gw-run'].sort())
    expect(on.unresolvedRunLinks).toEqual([
      { legacyId: '13', reason: 'no_affirmative_evidence' },
      { legacyId: '14', reason: 'not_yet_resolved' },
    ])
    withFlag(false)
    const off = (await app.inject(`/api/tasks/${TASK}`)).json()
    expect(off.runIds).toEqual(['12', '13', '14', '15', 'gw-run'])
    expect('unresolvedRunLinks' in off).toBe(false)
  })

  test('a stored receipt is rewritten and keeps its status, so the mutation cannot run again', async () => {
    const { mapped } = await world()
    const receipt = db.sqlite.prepare(
      `INSERT INTO request_receipts (key, route, body_sha256, status, response, created_at)
       VALUES (?, ?, 'h', 200, ?, '2026-10-09T11:00:00.000Z')`,
    )
    const detail = taskDetail(TASK, { runIds: ['12', '13', 'gw-run'] })
    receipt.run('plain', `/api/tasks/${TASK}`, JSON.stringify(detail))
    // The largest answer a task route stores (512 KB).
    receipt.run(
      'big',
      `/api/tasks/${TASK}`,
      JSON.stringify({ ...detail, body: 'z'.repeat(400_000) }),
    )
    // Another task, and a route that is not a task route, are left alone.
    receipt.run('other-task', '/api/tasks/t-other', JSON.stringify({ ...detail, id: 't-other' }))
    receipt.run('other-route', '/api/rooms', JSON.stringify(detail))
    withFlag(true)
    expect(rewriteReceipts(db.sqlite, [TASK])).toBe(2)
    const read = (key: string) =>
      db.sqlite.prepare('SELECT status, response FROM request_receipts WHERE key = ?').get(key) as {
        status: number
        response: string
      }
    for (const key of ['plain', 'big']) {
      const row = read(key)
      expect(row.status).toBe(200)
      const response = decodeReceipt(row.response, 1_000_000) as TaskDetail & {
        unresolvedRunLinks: unknown[]
      }
      expect([...response.runIds].sort()).toEqual([mapped, 'gw-run'].sort())
      expect(response.unresolvedRunLinks).toHaveLength(2)
    }
    for (const key of ['other-task', 'other-route'])
      expect((decodeReceipt(read(key).response, 1_000_000) as TaskDetail).runIds).toEqual([
        '12',
        '13',
        'gw-run',
      ])
    // A second pass has nothing left to change.
    expect(rewriteReceipts(db.sqlite, [TASK])).toBe(0)
  })

  test('replaying the same request after the rewrite returns the new ids and does not run the mutation again', async () => {
    const { mapped } = await world()
    const patch = vi.spyOn(port, 'patchTask')
    const request = {
      method: 'PATCH' as const,
      url: `/api/tasks/${TASK}`,
      headers: { ...headers, 'idempotency-key': 'patch-1' },
      payload: { title: 'Renamed once' },
    }
    const first = await app.inject(request)
    expect(first.statusCode).toBe(200)
    expect(patch).toHaveBeenCalledTimes(1)
    // The stored answer carries legacy ids, as a receipt written before the upgrade would.
    const stored = JSON.parse(first.body) as TaskDetail
    db.sqlite
      .prepare("UPDATE request_receipts SET response = ? WHERE key = 'patch-1'")
      .run(JSON.stringify({ ...stored, runIds: ['12'] }))
    withFlag(true)
    expect(rewriteReceipts(db.sqlite, [TASK])).toBe(1)
    const replay = await app.inject(request)
    expect(replay.statusCode).toBe(200)
    expect((replay.json() as TaskDetail).runIds).toEqual([mapped])
    expect(patch).toHaveBeenCalledTimes(1)
  })

  test('the receipt codec round-trips an answer larger than the table accepts', () => {
    const answer = JSON.stringify({ text: 'q'.repeat(200_000) })
    const stored = encodeReceipt(answer, '/api/rooms')
    expect(stored).toContain('scoreReceiptGzip')
    expect(JSON.stringify(decodeReceipt(stored, 1_000_000))).toBe(answer)
  })
})
