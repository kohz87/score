import { afterEach, expect, test } from 'vitest'
import { HttpError } from '../../src/errors.ts'
import { notDispatched } from '../../src/hermes/port.ts'
import {
  agent,
  definition,
  edge,
  end,
  finishNode,
  node,
  run,
  runIdOf,
  start,
  wfHarness,
  type Harness,
} from './wf-harness.ts'

let h: Harness | undefined
afterEach(async () => {
  await h?.close()
  h = undefined
})
const done =
  (id: string, status = 'succeeded') =>
  (): boolean =>
    run(h!, id).status === status
const simple = () => definition([agent('a'), end()], [edge('a', 'done')])
const stored = (id: string) =>
  h!.rows<{ stored_bytes: number; reserve_bytes: number }>(
    'SELECT stored_bytes, reserve_bytes FROM orchestrations WHERE id = ?',
    id,
  )[0]!

test('a prolonged adapter outage adds no rows and no stored bytes: the unsent attempt is reused', async () => {
  h = await wfHarness()
  const original = h.port.startRun.bind(h.port)
  let refusing = true
  h.port.startRun = async (req) => {
    if (refusing) throw notDispatched(new HttpError(503, 'hermes_unavailable', 'down'))
    return original(req)
  }
  const id = await start(h, simple())
  await h.until(
    () => (h!.rows<{ n: number }>('SELECT refused_total AS n FROM orc_attempts')[0]?.n ?? 0) >= 3,
  )
  const base = stored(id).stored_bytes
  const counts = () => ({
    attempts: h!.rows<{ n: number }>('SELECT COUNT(*) AS n FROM orc_attempts')[0]!.n,
    steps: h!.rows<{ n: number }>('SELECT COUNT(*) AS n FROM orc_steps')[0]!.n,
    messageRuns: h!.rows<{ n: number }>('SELECT COUNT(*) AS n FROM message_runs')[0]!.n,
    history: h!.rows<{ n: number }>('SELECT COUNT(*) AS n FROM orc_history')[0]!.n,
  })
  const before = counts()
  for (let i = 0; i < 12; i++) {
    await h.orch.agentReady('builder')
    await h.settle(2000)
  }
  expect(
    h.rows<{ n: number }>('SELECT refused_total AS n FROM orc_attempts')[0]!.n,
  ).toBeGreaterThanOrEqual(10)
  expect(counts()).toEqual(before)
  expect(stored(id).stored_bytes).toBe(base)
  refusing = false
  await h.orch.agentReady('builder')
  await h.until(done(id))
})

test('500 Pause/Resume cycles keep the control history at 200 records, folded into a counter', async () => {
  h = await wfHarness()
  const id = await start(
    h,
    definition([agent('a', { instruction: '[fake:hold] A' }), end()], [edge('a', 'done')]),
  )
  await h.until(() => runIdOf(h!, id, 'a') !== undefined)
  // The executor's own sweeps change the revision between a read and the decision; a page just reloads and retries.
  const decide = async (fn: (revision: number) => Promise<unknown>): Promise<void> => {
    for (let tries = 0; tries < 20; tries++) {
      try {
        await fn(run(h!, id).revision)
        return
      } catch (error) {
        if (!(error instanceof HttpError) || error.code !== 'conflict') throw error
      }
    }
    throw new Error('revision never settled')
  }
  for (let i = 0; i < 500; i++) {
    await decide((r) => h!.orch.wfPause(id, { orchestrationRevision: r }))
    await decide((r) => h!.orch.wfResume(id, { orchestrationRevision: r }))
  }
  const control = h.rows<{ n: number }>(
    "SELECT COUNT(*) AS n FROM orc_history WHERE orchestration_id = ? AND kind IN ('paused','resumed','limits_changed')",
    id,
  )[0]!.n
  expect(control).toBeLessThanOrEqual(200)
  const inventory = run(h, id).storage
  expect(inventory.compactedControlRecords).toBeGreaterThanOrEqual(800)
  expect(inventory.items.find((i) => i.kind === 'control_history')!.rows).toBeLessThan(260)
  // The journaled transitions are the proof; compaction of DB history never touches them.
  const read = h.journal.readOwn()
  if (!read.ok) throw new Error(read.reason)
  expect(read.entries.filter((e) => e.kind === 'transition' && e.what === 'pause').length).toBe(500)
}, 120_000)

test('quota saturation never blocks result acceptance or Stop', async () => {
  h = await wfHarness()
  const id = await start(
    h,
    definition(
      [agent('a', { instruction: '[fake:hold] A' }), agent('b'), end()],
      [edge('a', 'b'), edge('b', 'done')],
    ),
  )
  await h.until(() => runIdOf(h!, id, 'a') !== undefined)
  // The run has used more than its whole allowance.
  h.db.sqlite
    .prepare('UPDATE orchestrations SET stored_bytes = reserve_bytes + 1000000 WHERE id = ?')
    .run(id)
  await finishNode(h, id, 'a', 'completed', 'result of a')
  await h.until(() => node(h!, id, 'a').state === 'succeeded')
  expect(node(h, id, 'a').output).toBe('result of a')
  // The next node cannot be stored any more: it fails with a reason, and Stop still works.
  await h.until(
    () =>
      ['failed', 'stopping', 'stopped'].includes(run(h!, id).status) ||
      node(h!, id, 'b').state === 'failed',
  )
  expect(node(h, id, 'b').reason).toContain('quota')
  await h.orch.wfStop(id).catch(() => undefined)
  await h.until(() => ['failed', 'stopped'].includes(run(h!, id).status))
})

test('the inventory covers every row a run keeps, and pruning deletes them together', async () => {
  h = await wfHarness()
  const id = await start(h, simple())
  await h.until(done(id))
  const inventory = run(h, id).storage
  const rows = (kind: string) => inventory.items.find((i) => i.kind === kind)!.rows
  expect(rows('orchestration_rows')).toBeGreaterThan(1)
  expect(rows('workflow_rows')).toBeGreaterThan(0)
  expect(rows('receipts')).toBeGreaterThan(0)
  expect(rows('room_messages')).toBeGreaterThan(0)
  expect(rows('message_runs')).toBe(1)
  expect(rows('attempt_runs')).toBe(1)
  // (The fake adapter has no dispatch intents; the live one adds one per attempt, charged and pruned the same way.)
  expect(rows('intents')).toBe(0)
  expect(inventory.storedBytes).toBeGreaterThan(0)
  // Ninety days later the run and everything it left behind go in one transaction; a tombstone remains.
  const old = new Date(h.scheduler.now() - 100 * 24 * 3600 * 1000).toISOString()
  h.db.sqlite
    .prepare('UPDATE orchestrations SET ended_at = ?, updated_at = ? WHERE id = ?')
    .run(old, old, id)
  const result = h.orch.maintenance()
  expect(result.pruned).toBe(1)
  for (const table of [
    'orchestrations',
    'orc_steps',
    'orc_attempts',
    'wf_runs',
    'wf_nodes',
    'wf_tokens',
    'wf_steps',
    'wf_commands',
    'wf_results',
    'message_runs',
    'runs',
    'tool_calls',
    'command_intents',
  ])
    expect(h.rows<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)[0]!.n, table).toBe(0)
  expect(h.rows("SELECT kind FROM orc_history WHERE kind = 'pruned'")).toHaveLength(1)
  expect(
    h.rows<{ n: number }>("SELECT COUNT(*) AS n FROM messages WHERE id NOT LIKE 'orc-goal:%'")[0]!
      .n,
  ).toBe(0)
})

test('a run that is still draining is never pruned', async () => {
  h = await wfHarness()
  const id = await start(
    h,
    definition([agent('a', { instruction: '[fake:hold] A' }), end()], [edge('a', 'done')]),
  )
  await h.until(() => runIdOf(h!, id, 'a') !== undefined)
  await h.orch.wfStop(id)
  const old = new Date(h.scheduler.now() - 100 * 24 * 3600 * 1000).toISOString()
  h.db.sqlite
    .prepare('UPDATE orchestrations SET ended_at = ?, updated_at = ?, status = ? WHERE id = ?')
    .run(old, old, 'finished_with_unresolved', id)
  expect(h.orch.maintenance().pruned).toBe(0)
})

// Codex review: observation rows are charged and bounded, thinking is in the inventory, history is released
test('observed tool and thinking rows are charged to the run and stop at its allowance', async () => {
  h = await wfHarness()
  const { chargeObservation } = await import('../../src/domain/orchestration/ops.ts')
  const id = await start(
    h,
    definition([agent('a', { instruction: '[fake:hold] A' }), end()], [edge('a', 'done')]),
  )
  await h.until(() => runIdOf(h!, id, 'a') !== undefined)
  const runId = runIdOf(h, id, 'a')!
  const base = stored(id).stored_bytes
  expect(chargeObservation(h.db.sqlite, runId, 1000)).toBe(true)
  expect(stored(id).stored_bytes).toBe(base + 1000)
  let accepted = 0
  for (let i = 0; i < 10_000; i++) {
    if (!chargeObservation(h.db.sqlite, runId, 10_000)) break
    accepted++
  }
  const s = stored(id)
  expect(accepted).toBeLessThan(10_000)
  // The protected reserve for Stop and obligation evidence is never spent on observations.
  expect(s.stored_bytes).toBeLessThanOrEqual(s.reserve_bytes - 256 * 1024)
  // A run that is not an orchestration attempt is not charged (and not bounded here).
  expect(chargeObservation(h.db.sqlite, 'some-other-run', 5_000_000)).toBe(true)
})

test('thinking rows are part of the inventory and pruning releases the whole history but its tombstone', async () => {
  h = await wfHarness()
  const id = await start(h, simple())
  await h.until(done(id))
  const runId = h.rows<{ id: string }>('SELECT id FROM runs')[0]!.id
  h.db.sqlite
    .prepare("INSERT INTO run_thinking (run_id, seq, text) VALUES (?, 1, 'thinking about it')")
    .run(runId)
  expect(run(h, id).storage.items.find((i) => i.kind === 'thinking')).toMatchObject({ rows: 1 })
  expect(
    h.rows<{ n: number }>(
      'SELECT COUNT(*) AS n FROM orc_history WHERE orchestration_id = ?',
      id,
    )[0]!.n,
  ).toBeGreaterThan(3)
  const old = new Date(h.scheduler.now() - 100 * 24 * 3600 * 1000).toISOString()
  h.db.sqlite
    .prepare('UPDATE orchestrations SET ended_at = ?, updated_at = ? WHERE id = ?')
    .run(old, old, id)
  expect(h.orch.maintenance().pruned).toBe(1)
  expect(h.rows('SELECT kind FROM orc_history WHERE orchestration_id = ?', id)).toEqual([
    { kind: 'pruned' },
  ])
  expect(h.rows('SELECT 1 FROM run_thinking')).toHaveLength(0)
})

// round 2 (M): the actual translator charges what a tool completion retains
test('through the live translator, tool starts and completions with multibyte previews are charged for what they retain', async () => {
  h = await wfHarness()
  const { translateRunEvent } = await import('../../src/hermes/live/translate.ts')
  const id = await start(
    h,
    definition([agent('a', { instruction: '[fake:hold] A' }), end()], [edge('a', 'done')]),
  )
  await h.until(() => runIdOf(h!, id, 'a') !== undefined)
  await h.settle(1500)
  const runId = runIdOf(h, id, 'a')!
  h.db.sqlite.prepare('UPDATE runs SET credential_generation = 1 WHERE id = ?').run(runId)
  const before = stored(id).stored_bytes
  const context = { profile: 'builder', runId, credentialGeneration: 1 }
  for (let i = 0; i < 20; i++) {
    const at = 1_791_290_877 + i
    await h.ingest.submit(
      translateRunEvent(
        context,
        {
          event: 'tool.started',
          run_id: runId,
          seq: 10 + 2 * i,
          timestamp: at,
          tool: 'terminal',
          preview: '日'.repeat(1500),
        },
        { unknownEvents: 0 },
      ),
    )
    await h.ingest.submit(
      translateRunEvent(
        context,
        {
          event: 'tool.completed',
          run_id: runId,
          seq: 11 + 2 * i,
          timestamp: at + 0.5,
          tool: 'terminal',
          duration: 0.1,
          error: false,
          preview: '日'.repeat(1500),
        },
        { unknownEvents: 0 },
      ),
    )
  }
  const retained = h.rows<{ n: number }>(
    "SELECT COALESCE(SUM(LENGTH(CAST(preview AS BLOB)) + LENGTH(CAST(COALESCE(result_preview, '') AS BLOB))), 0) AS n FROM tool_calls WHERE run_id = ?",
    runId,
  )[0]!.n
  expect(retained).toBeGreaterThan(20 * 2000)
  expect(stored(id).stored_bytes - before).toBeGreaterThanOrEqual(retained)
})
