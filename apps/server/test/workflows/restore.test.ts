import { copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { GlobalFenceStore } from '../../src/domain/orchestration/fence.ts'
import {
  agent,
  definition,
  edge,
  end,
  finishNode,
  gate,
  node,
  replaceAgent,
  run,
  runIdOf,
  seedAgent,
  start,
  wfHarness,
  decide,
  type Harness,
} from './wf-harness.ts'
import { openMigrated } from '../orchestration/harness-db.ts'

// The v3.2 restore tests, once more with a workflow run (it is an orchestration, so the same protection covers it).

let h: Harness | undefined
afterEach(async () => {
  await h?.close()
  h = undefined
})
const startup = () => {
  const store = new GlobalFenceStore(h!.db, h!.journal, () => h!.scheduler.now())
  return { store, check: store.startupCheck() }
}
const done =
  (id: string, status = 'succeeded') =>
  (): boolean =>
    run(h!, id).status === status
const hold = () =>
  definition([agent('a', { instruction: '[fake:hold] A' }), end()], [edge('a', 'done')])

test('a database-only restore fences: the workflow run the old database never saw is listed', async () => {
  h = await wfHarness()
  h.db.sqlite.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  copyFileSync(join(h.dir, 'score.db'), join(h.dir, 'restored.db'))
  const id = await start(h, definition([agent('a'), end()], [edge('a', 'done')]))
  await h.until(done(id))
  const restored = openMigrated(h.dir, 'restored.db')
  const store = new GlobalFenceStore(restored, h.journal)
  expect(store.startupCheck()).toMatchObject({ fenced: true, reasons: ['journal_mismatch'] })
  expect(store.view().items.map((i) => i.kind)).toContain('attempt')
  restored.close()
})

test('an honest database after a workflow run is not fenced, also after compaction', async () => {
  h = await wfHarness()
  const id = await start(h, definition([agent('a'), end()], [edge('a', 'done')]))
  await h.until(done(id))
  expect(startup().check.fenced).toBe(false)
  h.orch.maintenance()
  expect(startup().check.fenced).toBe(false)
})

test('compaction leaves tombstones, so an older database is still detected for a finished workflow run', async () => {
  h = await wfHarness()
  h.db.sqlite.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  copyFileSync(join(h.dir, 'score.db'), join(h.dir, 'restored.db'))
  const id = await start(h, definition([agent('a'), end()], [edge('a', 'done')]))
  await h.until(done(id))
  h.orch.maintenance()
  const restored = openMigrated(h.dir, 'restored.db')
  expect(new GlobalFenceStore(restored, h.journal).startupCheck().fenced).toBe(true)
  restored.close()
})

test('a rolled-back lower budget, a lost manual Pause, a lost remap and a lost abandonment are each detected', async () => {
  h = await wfHarness()
  seedAgent(h, 'builder')
  const id = await start(h, hold(), { budgetUsd: 50 })
  await h.until(() => runIdOf(h!, id, 'a') !== undefined)
  await h.settle(1500)
  expect(startup().check.fenced).toBe(false)

  await h.orch.wfLimits(id, { budgetUsd: 5, orchestrationRevision: run(h, id).revision })
  expect(startup().check.fenced).toBe(false)
  h.db.sqlite.prepare('UPDATE orchestrations SET budget_usd = 50 WHERE id = ?').run(id)
  expect(startup().check.fenced).toBe(true)
  h.db.sqlite.prepare('UPDATE orchestrations SET budget_usd = 5 WHERE id = ?').run(id)
  h.fence.lift(h.fence.view().revision, 'checked')

  await h.settle(1500)
  await h.orch.wfPause(id, { orchestrationRevision: run(h, id).revision })
  expect(startup().check.fenced).toBe(false)
  h.db.sqlite
    .prepare(
      "UPDATE orchestrations SET manual_paused_at = NULL, status = 'running', pause_reason = NULL WHERE id = ?",
    )
    .run(id)
  expect(startup().check.fenced).toBe(true)
})

test('a workflow remap that the database lost is detected; the honest one is not', async () => {
  h = await wfHarness()
  seedAgent(h, 'builder')
  const id = await start(
    h,
    definition(
      [gate('g'), agent('a', { instruction: '[fake:hold] A' }), end()],
      [edge('g', 'a'), edge('a', 'done')],
    ),
  )
  await h.until(() => node(h!, id, 'g').state === 'gate_open')
  replaceAgent(h, 'builder')
  await decide(h, id, 'g', 'approve')
  await h.until(() => node(h!, id, 'a').waitingFor === 'remap')
  const card = run(h, id).needsYou.find((n) => n.kind === 'remap')
  if (card?.kind !== 'remap') throw new Error('no remap card')
  await h.orch.wfRemap(id, {
    agentId: 'builder',
    frozenIncarnation: card.frozenIncarnation,
    currentIncarnation: card.currentIncarnation,
    orchestrationRevision: run(h, id).revision,
    acknowledge: true,
    plan: card.plan.map((p) => ({ nodeId: p.nodeId, payloadHash: p.payloadHash })),
  })
  expect(startup().check.fenced).toBe(false)
  h.db.sqlite
    .prepare("UPDATE orc_agent_map SET incarnation = ? WHERE agent_id = 'builder'")
    .run(card.frozenIncarnation)
  expect(startup().check.fenced).toBe(true)
})

test('a lost abandonment is detected', async () => {
  h = await wfHarness()
  const id = await start(h, hold())
  await h.until(() => runIdOf(h!, id, 'a') !== undefined)
  await finishNode(h, id, 'a', 'cancelled')
  await h.until(() => run(h!, id).attempts[0]!.state === 'unknown')
  await h.orch.wfAbandon(id, {
    attemptIds: [run(h, id).attempts[0]!.id],
    orchestrationRevision: run(h, id).revision,
    acknowledge: true,
  })
  expect(startup().check.fenced).toBe(false)
  h.db.sqlite.prepare("UPDATE orc_attempts SET abandoned_at = NULL, state = 'unknown'").run()
  expect(startup().check.fenced).toBe(true)
})
