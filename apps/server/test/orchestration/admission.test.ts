import { afterEach, expect, test } from 'vitest'
import { Orchestrator } from '../../src/domain/orchestration/executor.ts'
import { byTurn } from '../../src/hermes/fake/fake-lead.ts'
import { attemptOf, harness, type Harness } from './harness.ts'

let h: Harness
afterEach(async () => {
  await h?.close()
  h = undefined as never
})
const status = (id: string) => h.orch.summary(id).status
const detail = (id: string) => h.orch.snapshot(id).orchestration
const INCARNATION = '22222222-2222-4222-8222-222222222222'

test('a step agent that was replaced after the assignment blocks the step instead of running it', async () => {
  h = await harness({
    lead: {
      script: byTurn({
        1: async (t) => {
          await t.call('orch.assign', { agent: 'builder', instruction: 'x' })
        },
      }),
    },
  })
  const id = await h.create({ gatePolicy: 'every-step' })
  await h.until(() => detail(id).gates.length === 1)
  h.db.sqlite
    .prepare(
      "INSERT INTO agent_lifecycle (agent_id, incarnation_id, state) VALUES ('builder', ?, 'ready')",
    )
    .run(INCARNATION)
  const d = detail(id)
  await h.orch.gateDecision(id, 'g1', {
    decision: 'approve',
    expectedRevision: 1,
    orchestrationRevision: d.revision,
  })
  await h.until(() => detail(id).stepsList[0]!.status === 'blocked')
  expect(detail(id).stepsList[0]!.disposition).toContain('agent_unavailable')
  expect(attemptOf(h, id, 'step')).toHaveLength(0)
})

test('an agent that is not ready waits: the step stays queued and runs once the agent is ready again', async () => {
  h = await harness({
    lead: {
      script: byTurn({
        1: async (t) => {
          await t.call('orch.assign', { agent: 'builder', instruction: 'x' })
        },
      }),
    },
  })
  h.db.sqlite
    .prepare(
      "INSERT INTO agent_lifecycle (agent_id, incarnation_id, state) VALUES ('builder', ?, 'ready')",
    )
    .run(INCARNATION)
  const id = await h.create({ gatePolicy: 'every-step' })
  await h.until(() => detail(id).gates.length === 1)
  h.db.sqlite
    .prepare("UPDATE agent_lifecycle SET state = 'needs_attention' WHERE agent_id = 'builder'")
    .run()
  const d = detail(id)
  await h.orch.gateDecision(id, 'g1', {
    decision: 'approve',
    expectedRevision: 1,
    orchestrationRevision: d.revision,
  })
  await h.settle(3000)
  // Same incarnation, only not ready: nothing runs and nothing is decided about the step.
  expect(attemptOf(h, id, 'step')).toHaveLength(0)
  expect(detail(id).stepsList[0]!.status).toBe('queued')
  h.db.sqlite.prepare("UPDATE agent_lifecycle SET state = 'ready' WHERE agent_id = 'builder'").run()
  await h.until(() => detail(id).stepsList[0]!.status === 'succeeded')
})

test('a paused agent and a paused team hold admission without changing the run', async () => {
  h = await harness({
    lead: {
      script: byTurn({
        1: async (t) => {
          await t.call('orch.assign', { agent: 'builder', instruction: 'x' })
        },
      }),
    },
  })
  h.db.sqlite
    .prepare(
      "INSERT INTO agent_pauses (agent_id, paused_at) VALUES ('builder', '2026-01-01T00:00:00.000Z')",
    )
    .run()
  const id = await h.create({ gatePolicy: 'none' })
  await h.until(() => detail(id).stepsList.length === 1)
  await h.settle(3000)
  expect(detail(id).stepsList[0]!.status).toBe('queued')
  expect(status(id)).toBe('running')
  h.db.sqlite.prepare('DELETE FROM agent_pauses').run()
  h.db.sqlite
    .prepare("UPDATE team_state SET paused_at = '2026-01-01T00:00:00.000Z' WHERE id = 1")
    .run()
  await h.settle(3000)
  expect(attemptOf(h, id, 'step')).toHaveLength(0)
  h.db.sqlite.prepare('UPDATE team_state SET paused_at = NULL WHERE id = 1').run()
  await h.until(() => detail(id).stepsList[0]!.status === 'succeeded')
})

test('a lead agent that was replaced pauses the run (agent_unavailable)', async () => {
  h = await harness({ lead: { script: async () => 'idle' } })
  const id = await h.create()
  await h.until(() => status(id) === 'paused')
  h.db.sqlite
    .prepare(
      "INSERT INTO agent_lifecycle (agent_id, incarnation_id, state) VALUES ('lead', ?, 'ready')",
    )
    .run(INCARNATION)
  h.db.sqlite
    .prepare(
      "INSERT INTO orc_causes (orchestration_id, kind, at) VALUES (?, 'inquiry_answered', '2026-01-01T00:00:00.000Z')",
    )
    .run(id)
  h.db.sqlite
    .prepare("UPDATE orchestrations SET status = 'running', pause_reason = NULL WHERE id = ?")
    .run(id)
  await h.settle(1000)
  expect(status(id)).toBe('paused')
  expect(h.orch.summary(id).pauseReason).toBe('agent_unavailable')
  expect(attemptOf(h, id, 'lead')).toHaveLength(1)
})

function liveLike(overrides: { mcpAvailable: boolean; enabled: boolean; token: boolean }) {
  const port = {
    mode: 'live' as const,
    startRun: h.port.startRun.bind(h.port),
    stopRun: h.port.stopRun.bind(h.port),
    listAgents: async () =>
      (await h.port.listAgents()).map((a) => ({ ...a, served: a.id !== 'designer' })),
  }
  if (overrides.enabled) h.access.patch('lead', { enabled: true })
  if (overrides.token) h.access.issueToken('lead')
  return new Orchestrator({
    db: h.db,
    ingest: h.ingest,
    port,
    access: h.access,
    fence: h.fence,
    mcpAvailable: overrides.mcpAvailable,
  })
}

test('preflight on a live adapter explains what is missing: listener, MCP access, token; tool readiness is unknown, never ok', async () => {
  h = await harness()
  const check = (p: Awaited<ReturnType<Orchestrator['preflight']>>, id: string) =>
    p.checks.find((c) => c.id === id)!
  const missing = await liveLike({ mcpAvailable: false, enabled: false, token: false }).preflight(
    'lead',
    ['builder'],
  )
  expect(missing.ok).toBe(false)
  expect(check(missing, 'listener').status).toBe('fail')
  expect(check(missing, 'listener').message).toContain('remote mode')
  expect(check(missing, 'lead_mcp_access').status).toBe('fail')
  expect(check(missing, 'lead_mcp_token').status).toBe('fail')
  expect(check(missing, 'tool_readiness').status).toBe('unknown')
  const ready = await liveLike({ mcpAvailable: true, enabled: true, token: true }).preflight(
    'lead',
    ['builder'],
  )
  expect(ready.ok).toBe(true)
  // The writes switch is not required (v3.1).
  expect(h.access.get('lead').writesEnabled).toBe(false)
  expect(check(ready, 'tool_readiness').status).toBe('unknown')
  // An agent Hermes does not serve fails the check.
  const unserved = await liveLike({ mcpAvailable: true, enabled: true, token: true }).preflight(
    'lead',
    ['designer'],
  )
  expect(check(unserved, 'allowed_agents').status).toBe('fail')
})

test('daily maintenance compacts reconciled journal entries, keeps unresolved ones and prunes old finished runs', async () => {
  h = await harness()
  const id = await h.create({ gatePolicy: 'none' })
  await h.until(() => status(id) === 'succeeded')
  const before = h.journal.readOwn()
  expect(before.ok && before.entries.length).toBeGreaterThanOrEqual(6)
  // An unresolved admission stays: add an entry for an attempt the database knows as unknown.
  h.journal.append({
    kind: 'send_started',
    attemptId: 'orc-ghost',
    orchestrationId: id,
    attemptKind: 'step',
    agentId: 'builder',
    generation: 0,
  })
  const result = h.orch.maintenance()
  expect(result.journal.dropped).toBeGreaterThanOrEqual(3)
  const after = h.journal.readOwn()
  expect(
    after.ok && after.entries.filter((e) => e.kind === 'send_started').map((e) => e.attemptId),
  ).toEqual(['orc-ghost'])
  expect(after.ok && after.entries.some((e) => e.kind === 'tombstone')).toBe(true)
  expect(result.pruned).toBe(0)
  // Past the retention a finished, released run is removed (a tombstone stays in the history).
  h.db.sqlite.prepare("UPDATE orchestrations SET ended_at = '2020-01-01T00:00:00.000Z'").run()
  expect(h.orch.maintenance().pruned).toBe(1)
  expect(h.rows('SELECT 1 FROM orchestrations')).toHaveLength(0)
  expect(h.rows('SELECT 1 FROM orc_attempts')).toHaveLength(0)
  expect(h.rows("SELECT 1 FROM orc_history WHERE kind = 'pruned'")).toHaveLength(1)
  // Pruned runs leave tombstones in the journal; they are not a doubt at the next start.
  const { GlobalFenceStore } = await import('../../src/domain/orchestration/fence.ts')
  expect(new GlobalFenceStore(h.db, h.journal).startupCheck().fenced).toBe(false)
})

test('the journal size alarm shows in the fence view and in the preflight', async () => {
  const { ExecutionJournal } = await import('../../src/domain/orchestration/journal.ts')
  const { GlobalFenceStore } = await import('../../src/domain/orchestration/fence.ts')
  h = await harness()
  const small = new ExecutionJournal(`${h.dir}/small-journal`, 'scope', undefined, 300)
  const store = new GlobalFenceStore(h.db, small)
  expect(store.view().journal.sizeAlarm).toBe(false)
  for (let i = 0; i < 4; i++) small.append({ kind: 'reconciled', attemptId: `a${i}` })
  expect(store.view().journal.sizeAlarm).toBe(true)
  const alarmed = new Orchestrator({
    db: h.db,
    ingest: h.ingest,
    port: h.port,
    access: h.access,
    fence: store,
  })
  const preflight = await alarmed.preflight('lead', ['builder'])
  expect(preflight.checks.find((c) => c.id === 'journal')!.status).toBe('fail')
})

test('tool readiness: a lead whose Hermes lists old MCP tools fails with a reload instruction; a full list passes', async () => {
  h = await harness()
  h.access.patch('lead', { enabled: true })
  h.access.issueToken('lead')
  const make = (tools: string[] | null) =>
    new Orchestrator({
      db: h.db,
      ingest: h.ingest,
      port: {
        mode: 'live' as const,
        startRun: h.port.startRun.bind(h.port),
        stopRun: h.port.stopRun.bind(h.port),
        listAgents: async () => (await h.port.listAgents()).map((a) => ({ ...a, served: true })),
        mcpTools: async () => tools,
      },
      access: h.access,
      fence: h.fence,
      mcpAvailable: true,
    })
  const readiness = async (tools: string[] | null) =>
    (await make(tools).preflight('lead', ['builder'])).checks.find(
      (c) => c.id === 'tool_readiness',
    )!
  const old = await readiness(['rooms.list', 'orch.plan', 'orch.note'])
  expect(old.status).toBe('fail')
  expect(old.message).toContain('Reload MCP')
  expect(old.message).toContain('orch.assign')
  expect((await readiness(h.port.fakeMcpTools)).status).toBe('ok')
  expect((await readiness(null)).status).toBe('unknown')
  expect((await readiness(null)).message).toContain('reload MCP')
})
