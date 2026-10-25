import { copyFileSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { ORCH_ACKNOWLEDGEMENT_TEXT } from '@score/contract'
import type { FastifyInstance } from 'fastify'
import { afterEach, expect, test } from 'vitest'
import { buildApp } from '../../src/app.ts'
import { loadConfig } from '../../src/config.ts'
import { migrate, openDatabase } from '../../src/db/index.ts'
import { migrationsDir, tempDir } from '../orchestration/harness-db.ts'
import {
  agent,
  definition,
  edge,
  end,
  incarnationOf,
  run,
  runIdOf,
  save,
  start,
  wfHarness,
  type Harness,
} from './wf-harness.ts'

// Every use of lead_agent_id / lead_incarnation is planner-aware (migration 0051 makes them NULL for a workflow run).

let h: Harness | undefined
let app: FastifyInstance | undefined
afterEach(async () => {
  await app?.close()
  await h?.close()
  h = undefined
  app = undefined
})
async function boot() {
  h = await wfHarness()
  app = buildApp({
    config: loadConfig({ SCORE_MODE: 'fake', SCORE_HOME: `${h.dir}/home` }),
    logger: false,
    db: h.db,
    ingest: h.ingest,
    port: h.port,
    clock: () => h!.scheduler.now(),
    orchestrator: h.orch,
  })
  const paired = await app.inject({
    method: 'POST',
    url: '/api/session/pair',
    headers: { 'x-score-client': 'web' },
    payload: { token: app.pairing.createToken() },
  })
  return {
    'x-score-client': 'web',
    cookie: paired.headers['set-cookie']!.toString().split(';')[0]!,
  }
}

test('a workflow run has no lead anywhere: row, map, room and listings', async () => {
  const headers = await boot()
  const id = await start(
    h!,
    definition([agent('a', { instruction: '[fake:hold] A' }), end()], [edge('a', 'done')]),
  )
  await h!.until(() => runIdOf(h!, id, 'a') !== undefined)
  expect(
    h!.rows('SELECT planner, lead_agent_id, lead_incarnation FROM orchestrations WHERE id = ?', id),
  ).toEqual([{ planner: 'workflow', lead_agent_id: null, lead_incarnation: null }])
  expect(h!.rows('SELECT role FROM orc_agent_map WHERE orchestration_id = ?', id)).toEqual([
    { role: 'agent' },
  ])
  expect(h!.rows('SELECT lead_agent_id FROM rooms WHERE id = ?', `room-${id}`)).toEqual([
    { lead_agent_id: null },
  ])
  expect(h!.orch.list().items).toEqual([])
  expect(
    (await app!.inject({ method: 'GET', url: '/api/orchestrations', headers })).json().items,
  ).toEqual([])
  // No lead attempt, no capability, no lead turn.
  expect(h!.rows("SELECT 1 FROM orc_attempts WHERE kind = 'lead'")).toHaveLength(0)
  expect(h!.rows('SELECT 1 FROM orc_capabilities')).toHaveLength(0)
  expect(h!.rows<{ n: number }>('SELECT lead_turns_used AS n FROM orchestrations')[0]!.n).toBe(0)
})

test('the orchestration controls cannot touch a workflow run: 404 and nothing changes', async () => {
  const headers = await boot()
  const id = await start(
    h!,
    definition([agent('a', { instruction: '[fake:hold] A' }), end()], [edge('a', 'done')]),
  )
  await h!.until(() => runIdOf(h!, id, 'a') !== undefined)
  const before = run(h!, id).revision
  for (const [path, body] of [
    ['stop', { orchestrationRevision: before }],
    ['pause', { orchestrationRevision: before }],
    ['resume', { orchestrationRevision: before }],
    ['limits', { budgetUsd: 1, orchestrationRevision: before }],
    ['waiver', { orchestrationRevision: before, acknowledge: true }],
    ['abandon', { attemptIds: ['x'], orchestrationRevision: before, acknowledge: true }],
    [
      'remap',
      {
        agentId: 'builder',
        frozenIncarnation: 'a',
        currentIncarnation: 'b',
        orchestrationRevision: before,
        acknowledge: true,
      },
    ],
    [
      'gates/g1/decision',
      { decision: 'approve', expectedRevision: 1, orchestrationRevision: before },
    ],
  ] as const) {
    const res = await app!.inject({
      method: 'POST',
      url: `/api/orchestrations/${id}/${path}`,
      headers,
      payload: body,
    })
    expect(res.statusCode, path).toBe(404)
  }
  await h!.settle(1500)
  expect(run(h!, id).status).toBe('running')
  expect(run(h!, id).budget.limitUsd).toBeNull()
})

test('the room and brief of a workflow run are owned like an orchestration, and say which planner', async () => {
  const headers = await boot()
  const id = await start(
    h!,
    definition([agent('a', { instruction: '[fake:hold] A' }), end()], [edge('a', 'done')]),
  )
  await h!.until(() => runIdOf(h!, id, 'a') !== undefined)
  const posted = await app!.inject({
    method: 'POST',
    url: `/api/rooms/room-${id}/messages`,
    headers,
    payload: { text: 'hello', to: [] },
  })
  expect(posted.statusCode).toBe(409)
  expect(posted.json().error.code).toBe('orchestration_owned')
  expect(posted.json().error.details).toMatchObject({
    orchestrationId: id,
    state: 'owned',
    planner: 'workflow',
  })
})

test('Pause and Resume on a workflow run are the workflow run controls', async () => {
  const headers = await boot()
  const id = await start(
    h!,
    definition([agent('a', { instruction: '[fake:hold] A' }), end()], [edge('a', 'done')]),
  )
  await h!.until(() => runIdOf(h!, id, 'a') !== undefined)
  await h!.settle(1500)
  expect(
    (
      await app!.inject({
        method: 'POST',
        url: `/api/workflow-runs/${id}/pause`,
        headers,
        payload: { orchestrationRevision: run(h!, id).revision },
      })
    ).statusCode,
  ).toBe(200)
  expect(run(h!, id).status).toBe('paused')
  await h!.settle(1500)
  expect(
    (
      await app!.inject({
        method: 'POST',
        url: `/api/workflow-runs/${id}/resume`,
        headers,
        payload: { orchestrationRevision: run(h!, id).revision },
      })
    ).statusCode,
  ).toBe(200)
  expect(run(h!, id).status).toBe('running')
})

test('the brief of a workflow run takes its status from the run', async () => {
  await boot()
  const statuses: string[] = []
  h!.ingest.onCommitted((events) => {
    for (const e of events)
      if (e.type === 'brief.upserted') statuses.push((e.data as { status: string }).status)
  })
  const id = await start(h!, definition([agent('a'), end()], [edge('a', 'done')]))
  await h!.until(() => run(h!, id).status === 'succeeded')
  expect(statuses[0]).toBe('running')
  expect(statuses.at(-1)).toBe('done')
})

test('a workflow cannot be started on a missing or replaced agent without the person seeing it', async () => {
  await boot()
  const wf = save(h!, definition([agent('a', { agentId: 'nobody' }), end()], [edge('a', 'done')]))
  await expect(
    h!.orch.createWorkflowRun({
      workflowId: wf,
      version: 1,
      inputs: {},
      agentMap: [{ agentId: 'nobody', incarnation: incarnationOf(h!, 'nobody') }],
      gatePolicy: 'gates-only',
      unknownSpend: 'pause',
      maxConcurrentSteps: 2,
      stepEstimateUsd: 0.5,
      acknowledgement: { text: ORCH_ACKNOWLEDGEMENT_TEXT },
    }),
  ).rejects.toMatchObject({ status: 409, code: 'preflight_failed' })
})

// ----------------------------------------------------------------------------------------------- migration 0051

test('0051 rebuilds orchestrations keeping rows, children and foreign keys, and adds the planner rule', () => {
  const tmp = tempDir('orc-0051-')
  try {
    const before = join(tmp.dir, 'before')
    mkdirSync(before)
    for (const name of readdirSync(migrationsDir))
      if (Number(name.slice(0, 4)) < 50) copyFileSync(join(migrationsDir, name), join(before, name))
    const db = openDatabase(join(tmp.dir, 'score.db'))
    migrate(db, before)
    const s = db.sqlite
    const at = '2026-10-10T10:00:00.000Z'
    s.exec('PRAGMA foreign_keys = OFF')
    s.prepare(
      "INSERT INTO rooms (id, name, kind, members, created_at, updated_at) VALUES ('r', 'room', 'room', '[]', ?, ?)",
    ).run(at, at)
    s.prepare(
      "INSERT INTO messages (id, room_id, author_kind, \"to\", parts, refs, streaming, created_at, updated_at) VALUES ('m', 'r', 'you', '[]', '[]', '[]', 0, ?, ?)",
    ).run(at, at)
    s.prepare(
      "INSERT INTO briefs (id, room_id, title, started_at, started_by) VALUES ('m', 'r', 't', ?, 'you')",
    ).run(at)
    s.prepare(
      `INSERT INTO orchestrations (id, title, goal, lead_agent_id, lead_incarnation, allowed_agents, room_id, brief_id, gate_policy,
         max_steps, max_lead_turns, max_concurrent_steps, lead_turn_estimate_usd, step_estimate_usd, status, acknowledgement, preflight, reserve_bytes, created_at, updated_at)
       VALUES ('orc-1', 't', 'g', 'lead', 'i', '["builder"]', 'r', 'm', 'none', 5, 5, 2, 1, 1, 'running', '{}', '{}', 0, ?, ?)`,
    ).run(at, at)
    s.prepare(
      `INSERT INTO orc_steps (orchestration_id, id, seq, agent_id, agent_incarnation, instruction, status, estimate_usd, created_in_attempt, created_at, updated_at)
       VALUES ('orc-1', 's1', 1, 'builder', 'i', 'x', 'queued', 1, 'a0', ?, ?)`,
    ).run(at, at)
    s.prepare(
      "INSERT INTO orc_agent_map (orchestration_id, agent_id, role, incarnation, updated_at) VALUES ('orc-1', 'lead', 'lead', 'i', ?)",
    ).run(at)
    s.prepare(
      `INSERT INTO orc_attempts (id, orchestration_id, kind, n, agent_id, agent_incarnation, session_id, turn_id, message_id, state, input, sent_at, created_at, updated_at)
       VALUES ('lead-1', 'orc-1', 'lead', 1, 'lead', 'i', 's', 't1', 'm1', 'running', '', ?, ?, ?)`,
    ).run(at, at, at)
    s.prepare(
      "INSERT INTO orc_capabilities (hash, attempt_id, generation, agent_id, agent_incarnation, created_at) VALUES ('h1', 'lead-1', 1, 'lead', 'i', ?)",
    ).run(at)
    s.exec('PRAGMA foreign_keys = ON')
    const existing = s.prepare('PRAGMA foreign_key_check').all().length
    migrate(db, migrationsDir)
    expect(s.prepare('PRAGMA foreign_key_check').all()).toHaveLength(existing)
    expect(
      s.prepare('SELECT id, planner, lead_agent_id, status FROM orchestrations').all(),
    ).toEqual([{ id: 'orc-1', planner: 'lead', lead_agent_id: 'lead', status: 'running' }])
    expect(s.prepare('SELECT COUNT(*) AS n FROM orc_steps').get()).toEqual({ n: 1 })
    expect(s.prepare('SELECT COUNT(*) AS n FROM orc_agent_map').get()).toEqual({ n: 1 })
    // The journaled generation of a lead attempt is its capability generation: the restore check stays consistent.
    expect(
      s.prepare("SELECT dispatch_generation AS g FROM orc_attempts WHERE id = 'lead-1'").get(),
    ).toEqual({ g: 1 })
    // The children still point at the rebuilt table, and enforcement is back on.
    expect(
      s.prepare('SELECT "table" AS t FROM pragma_foreign_key_list(\'orc_steps\')').all(),
    ).toContainEqual({ t: 'orchestrations' })
    expect(s.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 })
    expect(() =>
      s
        .prepare(
          "INSERT INTO orc_steps (orchestration_id, id, seq, agent_id, agent_incarnation, instruction, status, estimate_usd, created_in_attempt, created_at, updated_at) VALUES ('ghost', 's', 1, 'b', 'i', 'x', 'queued', 1, 'a', ?, ?)",
        )
        .run(at, at),
    ).toThrow()
    // The planner rule: a lead run needs its lead; a workflow run must not have one.
    const row = (planner: string, lead: string | null) =>
      s
        .prepare(
          `INSERT INTO orchestrations (id, title, goal, planner, lead_agent_id, lead_incarnation, allowed_agents, room_id, brief_id, gate_policy,
             max_steps, max_lead_turns, max_concurrent_steps, lead_turn_estimate_usd, step_estimate_usd, status, acknowledgement, preflight, reserve_bytes, created_at, updated_at)
           VALUES (?, 't', 'g', ?, ?, ?, '[]', 'r2', 'm2', 'none', 5, 0, 2, 1, 1, 'running', '{}', '{}', 0, ?, ?)`,
        )
        .run(`orc-${planner}-${lead}`, planner, lead, lead, at, at)
    s.prepare(
      "INSERT INTO rooms (id, name, kind, members, created_at, updated_at) VALUES ('r2', 'room2', 'room', '[]', ?, ?)",
    ).run(at, at)
    s.prepare(
      "INSERT INTO messages (id, room_id, author_kind, \"to\", parts, refs, streaming, created_at, updated_at) VALUES ('m2', 'r2', 'you', '[]', '[]', '[]', 0, ?, ?)",
    ).run(at, at)
    s.prepare(
      "INSERT INTO briefs (id, room_id, title, started_at, started_by) VALUES ('m2', 'r2', 't', ?, 'you')",
    ).run(at)
    expect(() => row('lead', null)).toThrow()
    expect(() => row('workflow', 'lead')).toThrow()
    expect(() => row('workflow', null)).not.toThrow()
    db.close()
  } finally {
    tmp.cleanup()
  }
})
