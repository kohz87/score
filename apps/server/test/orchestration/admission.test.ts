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
  expect(check(ready, 'tool_readiness').message).toContain("hasn't asked Score for its tools")
  // 3.7.8: what Score's MCP server last handed the lead decides. An old list fails with "Reload MCP"; a full one passes.
  const live = liveLike({ mcpAvailable: true, enabled: true, token: true })
  h.access.recordListed('lead', ['rooms.list', 'orch.plan', 'orch.assign'])
  const old = await live.preflight('lead', ['builder'])
  expect(check(old, 'tool_readiness').status).toBe('fail')
  expect(check(old, 'tool_readiness').message).toMatch(
    /last handed a tool list without orch\.cancel.*Reload MCP/,
  )
  h.access.recordListed('lead', [
    'orch.plan',
    'orch.assign',
    'orch.cancel',
    'orch.ask',
    'orch.requestApproval',
    'orch.note',
    'orch.finish',
    'orch.receipt',
  ])
  const full = await live.preflight('lead', ['builder'])
  expect(check(full, 'tool_readiness').status).toBe('ok')
  // A new key means a new connection: the old list no longer counts.
  h.access.issueToken('lead')
  expect(h.access.listed('lead')).toBeNull()
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

test('fix-l: a room summary that points at a lead note does not block pruning; the note stays with its references', async () => {
  h = await harness({
    lead: {
      script: byTurn({
        1: async (t) => {
          await t.call('orch.note', { text: 'a lead note' }, 'n1')
          await t.call('orch.finish', { outcome: 'success', summary: 'done' })
        },
      }),
    },
  })
  const id = await h.create({ gatePolicy: 'none' })
  await h.until(() => status(id) === 'succeeded')
  const note = h.rows("SELECT id, room_id FROM messages WHERE id LIKE 'orc-note:%'") as {
    id: string
    room_id: string
  }[]
  expect(note).toHaveLength(1)
  // A post-release summary whose boundary is the lead note (what reserveMessageRun writes).
  h.db.sqlite
    .prepare(
      `INSERT INTO message_runs (message_id, room_id, agent_id, chain_id, hop, turn_id, parent_message_id, input, agents, state, created_at, purpose)
       VALUES ('sum-1', ?1, 'lead', ?2, 0, 'turn-sum-1', ?2, 'Summarise', '["lead"]', 'completed', '2026-10-10T00:00:00.000Z', 'summary')`,
    )
    .run(note[0]!.room_id, note[0]!.id)
  h.db.sqlite.prepare("UPDATE orchestrations SET ended_at = '2020-01-01T00:00:00.000Z'").run()
  h.db.sqlite
    .prepare("UPDATE message_runs SET orchestration_attempt_id = NULL WHERE message_id = 'sum-1'")
    .run()
  expect(h.orch.maintenance().pruned).toBe(1)
  expect(h.rows('SELECT 1 FROM orchestrations')).toHaveLength(0)
  // Referenced data stays, like a referenced reply.
  expect(h.rows("SELECT 1 FROM messages WHERE id LIKE 'orc-note:%'")).toHaveLength(1)
})

test('fix-argon A1: compaction keeps a dispatch witness (a refused or closed generation) as a tombstone, so a restart is not frozen', async () => {
  const { GlobalFenceStore, unjournaledAttempts } =
    await import('../../src/domain/orchestration/fence.ts')
  h = await harness()
  const id = await h.create({ gatePolicy: 'none' })
  await h.until(() => status(id) === 'succeeded')
  const attempts = h.rows<{ id: string; dispatch_generation: number }>(
    'SELECT id, dispatch_generation FROM orc_attempts WHERE dispatch_generation > 0 ORDER BY id',
  )
  expect(attempts.length).toBeGreaterThanOrEqual(2)
  // One attempt ends refused-before-launch, another closed-before-launch: both fold into a witness and then drop.
  const [refused, closed] = [attempts[0]!, attempts[1]!]
  h.journal.append({
    kind: 'send_refused',
    attemptId: refused.id,
    orchestrationId: id,
    generation: refused.dispatch_generation,
  })
  h.journal.append({
    kind: 'send_closed',
    attemptId: closed.id,
    orchestrationId: id,
    generation: closed.dispatch_generation,
    cause: 'stop',
  })
  h.db.sqlite.prepare("UPDATE orc_attempts SET state = 'terminated'").run()
  h.orch.maintenance()
  const after = h.journal.readOwn()
  if (!after.ok) throw new Error('journal unreadable')
  expect(unjournaledAttempts(h.db.sqlite, after.entries, 'test-home')).toEqual([])
  const restart = new GlobalFenceStore(h.db, h.journal).startupCheck()
  expect(restart.reasons).not.toContain('journal_truncated')
  // A genuinely truncated journal still freezes.
  const { writeFileSync } = await import('node:fs')
  const { JOURNAL_FILE } = await import('../../src/domain/orchestration/journal.ts')
  writeFileSync(`${h.dir}/journal/${JOURNAL_FILE}`, '')
  const rows = unjournaledAttempts(h.db.sqlite, [], 'test-home')
  expect(rows.length).toBeGreaterThan(0)
})
