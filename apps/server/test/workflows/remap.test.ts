import { afterEach, expect, test } from 'vitest'
import {
  agent,
  decide,
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
  B,
  type Harness,
} from './wf-harness.ts'
import { Orchestrator } from '../../src/domain/orchestration/executor.ts'
import { GlobalFenceStore } from '../../src/domain/orchestration/fence.ts'

const startup = () => {
  const store = new GlobalFenceStore(h!.db, h!.journal, () => h!.scheduler.now())
  return { store, check: store.startupCheck() }
}

let h: Harness | undefined
afterEach(async () => {
  await h?.close()
  h = undefined
})
const done =
  (id: string, status = 'succeeded') =>
  (): boolean =>
    run(h!, id).status === status

function remapCard(harness: Harness, id: string) {
  const card = run(harness, id).needsYou.find((n) => n.kind === 'remap')
  if (card?.kind !== 'remap') throw new Error('no remap card')
  return card
}
const decision = (harness: Harness, id: string, card: ReturnType<typeof remapCard>) => ({
  agentId: card.agentId,
  frozenIncarnation: card.frozenIncarnation,
  currentIncarnation: card.currentIncarnation,
  orchestrationRevision: run(harness, id).revision,
  acknowledge: true as const,
  plan: card.plan.map((p) => ({ nodeId: p.nodeId, payloadHash: p.payloadHash })),
})

test('remap after approval: the unsent step is retired as remapped, its gate withdrawn, and the new payload needs its own approval', async () => {
  h = await wfHarness()
  seedAgent(h, 'builder')
  // The agent is paused so the approved step stays unsent while it is replaced.
  h.db.sqlite
    .prepare(
      "INSERT INTO agent_pauses (agent_id, paused_at) VALUES ('builder', '2026-01-01T00:00:00.000Z')",
    )
    .run()
  const id = await start(h, definition([agent('a'), end()], [edge('a', 'done')]), {
    gatePolicy: 'every-step',
  })
  await h.until(() => node(h!, id, 'a').state === 'gate_open')
  const first = node(h, id, 'a').stepId!
  await decide(h, id, 'a', 'approve')
  await h.settle(1500)
  replaceAgent(h, 'builder')
  await h.until(() => run(h!, id).needsYou.some((n) => n.kind === 'remap'))
  const card = remapCard(h, id)
  expect(card.nodeIds).toEqual(['a'])
  await h.orch.wfRemap(id, decision(h, id, card))
  // The old step is gone for good; the node got a fresh step (not a logical retry) waiting for a new approval.
  await h.until(() => node(h!, id, 'a').state === 'gate_open' && node(h!, id, 'a').stepId !== first)
  const old = run(h, id).steps.find((s) => s.id === first)!
  expect(old.status).toBe('not_started')
  expect(old.disposition).toBe('remapped')
  expect(run(h, id).assignmentGates.find((g) => g.stepId === first)!.status).toBe('withdrawn')
  expect(node(h, id, 'a').attemptsUsed).toBe(1)
  expect(node(h, id, 'a').lineage).toHaveLength(2)
  expect(run(h, id).steps.find((s) => s.id === node(h!, id, 'a').stepId)!.replaces).toBe(first)
  expect(run(h, id).agentMap[0]).toMatchObject({ incarnation: B, status: 'current' })
  h.db.sqlite.prepare("DELETE FROM agent_pauses WHERE agent_id = 'builder'").run()
  await decide(h, id, 'a', 'approve')
  await h.orch.admissionChanged()
  await h.until(done(id))
})

test('under gates-only the remap decision is the approval: the node continues without another gate', async () => {
  h = await wfHarness()
  seedAgent(h, 'builder')
  const id = await start(
    h,
    definition([gate('g'), agent('a'), end()], [edge('g', 'a'), edge('a', 'done')]),
  )
  await h.until(() => node(h!, id, 'g').state === 'gate_open')
  replaceAgent(h, 'builder')
  await decide(h, id, 'g', 'approve')
  await h.until(() => node(h!, id, 'a').waitingFor === 'remap')
  await h.orch.wfRemap(id, decision(h, id, remapCard(h, id)))
  await h.until(done(id))
  expect(run(h, id).assignmentGates).toHaveLength(0)
})

test('crash around the remap transaction: a rolled-back remap changes nothing and the same decision then applies once', async () => {
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
  const card = remapCard(h, id)
  const snapshot = () => ({
    map: h!.rows('SELECT incarnation FROM orc_agent_map'),
    steps: h!.rows('SELECT id, status FROM orc_steps'),
    nodes: h!.rows('SELECT node_id, state, remaps FROM wf_nodes'),
  })
  const before = snapshot()
  // The transaction dies after the remap was journaled (journal first, database second): nothing is applied.
  h.db.sqlite.exec(
    "CREATE TRIGGER crash BEFORE UPDATE ON wf_nodes BEGIN SELECT RAISE(ABORT, 'crash'); END",
  )
  await h.orch.wfRemap(id, decision(h, id, card)).catch(() => undefined)
  h.db.sqlite.exec('DROP TRIGGER crash')
  expect(snapshot()).toEqual(before)
  expect(run(h, id).needsYou.some((n) => n.kind === 'remap')).toBe(true)
  // The journal is ahead of the database, which the next start turns into a fence and a listed doubt.
  const check = startup().check
  expect(check.fenced).toBe(true)
  h.fence.lift(h.fence.view().revision, 'reviewed')
  await h.orch.wfRemap(id, decision(h, id, remapCard(h, id)))
  await h.until(() => runIdOf(h!, id, 'a') !== undefined)
  expect(h.rows('SELECT incarnation FROM orc_agent_map')).toEqual([{ incarnation: B }])
  expect(snapshot().steps).toHaveLength(1)
  expect(run(h, id).steps).toHaveLength(1)
})

test('possibly-sent work keeps its attempt and obligations; the remap applies to later work only', async () => {
  h = await wfHarness()
  seedAgent(h, 'builder')
  const id = await start(
    h,
    definition(
      [agent('a', { instruction: '[fake:hold] A' }), agent('b'), end()],
      [edge('a', 'b'), edge('b', 'done')],
    ),
  )
  await h.until(() => runIdOf(h!, id, 'a') !== undefined)
  replaceAgent(h, 'builder')
  await h.until(() => run(h!, id).needsYou.some((n) => n.kind === 'remap'))
  const card = remapCard(h, id)
  // a was sent, so there is nothing to re-create; b has no step yet and shows as later work only after a ends.
  expect(card.plan.map((p) => p.nodeId)).toEqual([])
  await h.orch.wfRemap(id, decision(h, id, card))
  expect(node(h, id, 'a').stepId).toBe('s1')
  expect(run(h, id).attempts[0]!.state).toBe('running')
  await finishNode(h, id, 'a', 'completed', 'a done')
  await h.until(done(id))
  expect(run(h, id).steps.find((s) => s.id === node(h!, id, 'b').stepId)!.status).toBe('succeeded')
})

test('a remap decision needs the exact incarnations and the exact payloads, and a node is remapped at most twice', async () => {
  h = await wfHarness()
  seedAgent(h, 'builder')
  const id = await start(
    h,
    definition([gate('g'), agent('a'), end()], [edge('g', 'a'), edge('a', 'done')]),
  )
  await h.until(() => node(h!, id, 'g').state === 'gate_open')
  replaceAgent(h, 'builder')
  await decide(h, id, 'g', 'approve')
  await h.until(() => node(h!, id, 'a').waitingFor === 'remap')
  const card = remapCard(h, id)
  await expect(
    h.orch.wfRemap(id, { ...decision(h, id, card), frozenIncarnation: 'other' }),
  ).rejects.toMatchObject({ code: 'conflict' })
  await expect(h.orch.wfRemap(id, { ...decision(h, id, card), plan: [] })).rejects.toMatchObject({
    code: 'stale_plan',
  })
  h.db.sqlite.prepare("UPDATE wf_nodes SET remaps = 2 WHERE node_id = 'a'").run()
  await expect(h.orch.wfRemap(id, decision(h, id, card))).rejects.toMatchObject({
    code: 'conflict',
  })
})

test('a legacy run gets its mapping backfilled from the incarnation its attempts recorded, journaled', async () => {
  h = await wfHarness()
  seedAgent(h, 'builder')
  const id = await h.create({ gatePolicy: 'none' })
  await h.until(() => h!.rows('SELECT 1 FROM orc_attempts WHERE kind = ?', 'lead').length > 0)
  // What 0049 produced for a run whose agent had been replaced before the upgrade: the map holds the current
  // incarnation although the run's own attempts recorded another.
  h.db.sqlite
    .prepare(
      "INSERT INTO orc_attempts (id, orchestration_id, kind, step_id, n, agent_id, agent_incarnation, session_id, turn_id, message_id, state, input, created_at, updated_at) VALUES ('legacy-a', ?, 'step', NULL, 1, 'builder', ?, 's', 't-legacy', 'm-legacy', 'terminated', '', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
    )
    .run(id, '33333333-3333-4333-8333-333333333333')
  h.db.sqlite
    .prepare(
      "UPDATE orc_agent_map SET incarnation = ?, updated_at = (SELECT created_at FROM orchestrations WHERE id = ?) WHERE agent_id = 'builder'",
    )
    .run(B, id)
  await h.orch.close()
  const next = new Orchestrator({
    db: h.db,
    ingest: h.ingest,
    port: h.port,
    access: h.access,
    fence: h.fence,
    clock: () => h!.scheduler.now(),
  })
  h.orch = next
  await next.recover()
  expect(h.rows('SELECT incarnation FROM orc_agent_map WHERE agent_id = ?', 'builder')).toEqual([
    { incarnation: '33333333-3333-4333-8333-333333333333' },
  ])
  const read = h.journal.readOwn()
  if (!read.ok) throw new Error(read.reason)
  expect(read.entries.some((e) => e.kind === 'remap' && e.agentId === 'builder')).toBe(true)
  // The replacement now shows up as a Remap card instead of being adopted silently.
  expect(next.snapshot(id).orchestration.needsYou.some((n) => n.kind === 'remap')).toBe(true)
  // Idempotent.
  await next.recover()
  expect(h.rows('SELECT incarnation FROM orc_agent_map WHERE agent_id = ?', 'builder')).toEqual([
    { incarnation: '33333333-3333-4333-8333-333333333333' },
  ])
  await next.close()
})
