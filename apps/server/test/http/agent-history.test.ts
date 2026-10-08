import { AgentChannelsResponseSchema, AgentHistoryPageSchema } from '@score/contract'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { buildApp } from '../../src/app.ts'
import { loadConfig } from '../../src/config.ts'
import { FakePort } from '../../src/hermes/fake/fake-port.ts'
import { LiveAgentTabs } from '../../src/hermes/live/agent-tabs.ts'
import { setup } from '../hermes/live/gateway/helpers.ts'

let env: ReturnType<typeof setup>
let app: ReturnType<typeof buildApp>
beforeEach(() => {
  env = setup()
  app = buildApp({
    config: loadConfig({ SCORE_MODE: 'fake' }),
    logger: false,
    port: new FakePort(1, { db: env.db }, false),
    db: env.db,
    ingest: env.ingest,
  })
})
afterEach(async () => {
  await app.close()
  await env.ingest.close()
  env.db.close()
  rmSync(env.home, { recursive: true, force: true })
})
const get = (url: string) => app.inject({ method: 'GET', url })

function seed() {
  const sqlite = env.db.sqlite
  const at = (n: number) => new Date(Date.parse('2026-10-01T00:00:00Z') + n * 60_000).toISOString()
  const run = (id: string, profile: string, status: string, n: number, cost: number | null) =>
    sqlite
      .prepare(
        `INSERT INTO runs (id, profile, origin, status, model, started_at, ended_at, cost_usd, updated_at)
         VALUES (?, ?, 'kanban', ?, 'fixture-model', ?, ?, ?, ?)`,
      )
      .run(id, profile, status, at(n), status === 'running' ? null : at(n + 2), cost, at(n))
  run('r-done', 'builder', 'completed', 1, 0.25)
  run('r-fail', 'builder', 'failed', 2, null)
  run('r-stop', 'builder', 'cancelled', 3, null)
  run('r-wait', 'builder', 'waiting_for_approval', 4, null)
  run('r-live', 'builder', 'running', 5, null)
  run('r-other', 'reviewer', 'completed', 6, null)
  sqlite
    .prepare('INSERT INTO task_projections (id, detail) VALUES (?, ?)')
    .run('t-1', JSON.stringify({ title: 'Wire the stream', runIds: ['r-done'] }))
  sqlite
    .prepare(
      `INSERT INTO watch_frames (agent_id, seq, at, run_id, surface, payload, caption) VALUES ('builder', 7, ?, 'r-done', 'terminal', '{}', 'ls')`,
    )
    .run(at(1))
  sqlite
    .prepare(
      `INSERT INTO rooms (id, name, kind, members, created_at, updated_at) VALUES ('room', 'room', 'room', '[]', ?, ?)`,
    )
    .run(at(0), at(0))
  sqlite
    .prepare(
      `INSERT INTO messages (id, room_id, author_kind, "to", parts, refs, streaming, created_at, updated_at) VALUES ('m1', 'room', 'you', '[]', '[]', '[]', 0, ?, ?)`,
    )
    .run(at(0), at(0))
  sqlite
    .prepare(
      `INSERT INTO briefs (id, room_id, title, started_at, started_by) VALUES ('m1', 'room', 'Ship it', ?, 'you')`,
    )
    .run(at(0))
  sqlite
    .prepare(
      `INSERT INTO message_runs (message_id, run_id, room_id, agent_id, chain_id, hop, turn_id, parent_message_id, input, agents, state, created_at)
       VALUES ('reply', 'r-fail', 'room', 'builder', 'm1', 0, 'turn', 'm1', 'x', '[]', 'completed', ?)`,
    )
    .run(at(2))
}

test('history lists this agent runs newest first with outcome, duration, cost and links', async () => {
  seed()
  const page = AgentHistoryPageSchema.parse((await get('/api/agents/builder/history')).json())
  expect(page.nextCursor).toBeNull()
  expect(page.items.map((item) => [item.runId, item.outcome])).toEqual([
    ['r-live', 'running'],
    ['r-wait', 'waiting'],
    ['r-stop', 'stopped'],
    ['r-fail', 'failed'],
    ['r-done', 'completed'],
  ])
  const done = page.items.at(-1)!
  expect(done).toMatchObject({
    durationSec: 120,
    costUsd: 0.25,
    title: 'Wire the stream',
    task: { id: 't-1', title: 'Wire the stream' },
    brief: null,
    replaySeq: 7,
  })
  expect(page.items[0]).toMatchObject({ durationSec: null, title: 'Task run', replaySeq: null })
  expect(page.items[3]!.brief).toEqual({ id: 'm1', title: 'Ship it' })
})

test('a Kanban run finds its brief through the task link, not only through a message', async () => {
  seed()
  env.db.sqlite
    .prepare(
      "INSERT INTO brief_tasks (brief_id, task_id, origin, linked_at) VALUES ('m1', 't-1', 'assign', '2026-10-01T00:00:00.000Z')",
    )
    .run()
  const page = AgentHistoryPageSchema.parse((await get('/api/agents/builder/history')).json())
  const done = page.items.find((item) => item.runId === 'r-done')!
  expect(done.brief).toEqual({ id: 'm1', title: 'Ship it' })
  // The message link still wins for runs that have one, and unlinked runs stay unlinked.
  expect(page.items.find((item) => item.runId === 'r-fail')!.brief).toEqual({
    id: 'm1',
    title: 'Ship it',
  })
  expect(page.items.find((item) => item.runId === 'r-live')!.brief).toBeNull()
})

test('history filters by outcome and search, pages by 50, and rejects bad input', async () => {
  seed()
  const failed = AgentHistoryPageSchema.parse(
    (await get('/api/agents/builder/history?outcome=failed')).json(),
  )
  expect(failed.items.map((item) => item.runId)).toEqual(['r-fail'])
  const stopped = (await get('/api/agents/builder/history?outcome=stopped')).json()
  expect(stopped.items.map((item: { runId: string }) => item.runId)).toEqual(['r-stop'])
  const found = (await get('/api/agents/builder/history?q=wire')).json()
  expect(found.items.map((item: { runId: string }) => item.runId)).toEqual(['r-done'])
  expect((await get('/api/agents/builder/history?q=%25')).json().items).toEqual([])
  const sqlite = env.db.sqlite
  for (let n = 0; n < 55; n++)
    sqlite
      .prepare(
        `INSERT INTO runs (id, profile, origin, status, started_at, updated_at) VALUES (?, 'designer', 'score', 'completed', ?, ?)`,
      )
      .run(`d-${n}`, new Date(Date.UTC(2026, 9, 2, 0, n)).toISOString(), '2026-10-02T00:00:00.000Z')
  const first = (await get('/api/agents/designer/history')).json()
  expect(first.items).toHaveLength(50)
  expect(first.nextCursor).toBe('50')
  const second = (await get('/api/agents/designer/history?cursor=50')).json()
  expect(second.items).toHaveLength(5)
  expect(second.nextCursor).toBeNull()
  expect((await get('/api/agents/builder/history?outcome=bogus')).statusCode).toBe(400)
  expect((await get('/api/agents/builder/history?cursor=-1')).statusCode).toBe(400)
  expect((await get('/api/agents/nobody/history')).statusCode).toBe(404)
})

test('channels (fake) lists platforms with the agent connect command; unknown agents are 404', async () => {
  const body = AgentChannelsResponseSchema.parse((await get('/api/agents/builder/channels')).json())
  expect(body.items.map((item) => item.platform)).toEqual(['telegram', 'discord', 'slack'])
  expect(
    body.items.every((item) => item.connectCommand === 'hermes -p builder gateway setup'),
  ).toBe(true)
  expect((await get('/api/agents/nobody/channels')).statusCode).toBe(404)
})

test('live channels read the profile own gateway state and never run Hermes', () => {
  const home = mkdtempSync(join(tmpdir(), 'score-channels-'))
  try {
    mkdirSync(join(home, 'profiles', 'builder'), { recursive: true })
    const profileHome = join(home, 'profiles', 'builder')
    writeFileSync(
      join(profileHome, 'gateway_state.json'),
      JSON.stringify({
        platforms: {
          telegram: { state: 'connected' },
          slack: { state: 'failed', error_code: 'auth_failed' },
        },
      }),
    )
    const runner = () => {
      throw new Error('channels must not run Hermes')
    }
    const tabs = new LiveAgentTabs(
      home,
      (profile) => (profile === 'builder' ? profileHome : null),
      () => {},
      runner as never,
    )
    const byPlatform = Object.fromEntries(
      tabs.listChannels('builder').items.map((item) => [item.platform, item]),
    )
    expect(byPlatform.telegram).toMatchObject({ status: 'connected', detail: null })
    expect(byPlatform.slack).toMatchObject({ status: 'disconnected', detail: 'auth_failed' })
    expect(byPlatform.discord).toMatchObject({ status: 'disconnected' })
    expect(byPlatform.slack!.connectCommand).toBe('hermes -p builder gateway setup')
    expect(() => tabs.listChannels('Not A Profile')).toThrow()
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
