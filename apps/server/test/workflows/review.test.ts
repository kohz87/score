import { afterEach, expect, test } from 'vitest'
import { WorkflowRunSnapshotSchema } from '@score/contract'
import {
  agent,
  branch,
  decide,
  finishNode,
  definition,
  edge,
  end,
  gate,
  join,
  node,
  replies,
  run,
  seedAgent,
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
const aged = (id: string) => {
  const old = new Date(h!.scheduler.now() - 100 * 24 * 3600 * 1000).toISOString()
  h!.db.sqlite
    .prepare('UPDATE orchestrations SET ended_at = ?, updated_at = ? WHERE id = ?')
    .run(old, old, id)
}

// Codex 7.1a review, high 1
test('pruning deletes only what the run owned: a message added after release survives', async () => {
  h = await wfHarness()
  const id = await start(h, simple())
  await h.until(done(id))
  const room = h.rows<{ room_id: string }>(
    'SELECT room_id FROM orchestrations WHERE id = ?',
    id,
  )[0]!.room_id
  const at = new Date(h.scheduler.now()).toISOString()
  h.db.sqlite
    .prepare(
      `INSERT INTO messages (id, room_id, author_kind, "to", parts, refs, streaming, created_at, updated_at) VALUES ('later', ?, 'you', '[]', '[{"kind":"text","text":"hi"}]', '[]', 0, ?, ?)`,
    )
    .run(room, at, at)
  // A brief hangs on it too (an FK reference that would make a blanket delete fail).
  h.db.sqlite
    .prepare(
      "INSERT INTO briefs (id, room_id, title, started_at, started_by) VALUES ('later', ?, 't', ?, 'you')",
    )
    .run(room, at)
  aged(id)
  expect(h.orch.maintenance().pruned).toBe(1)
  expect(h.rows('SELECT id FROM messages WHERE id = ?', 'later')).toHaveLength(1)
  expect(h.rows('SELECT 1 FROM messages WHERE id LIKE ?', 'reply:%')).toHaveLength(0)
})

// medium: pruning must keep "used"
test('a version stays used after its last run is pruned, so the workflow still cannot be deleted', async () => {
  h = await wfHarness()
  const id = await start(h, simple())
  await h.until(done(id))
  const wf = h.rows<{ workflow_id: string }>(
    'SELECT workflow_id FROM wf_runs WHERE orchestration_id = ?',
    id,
  )[0]!.workflow_id
  aged(id)
  expect(h.orch.maintenance().pruned).toBe(1)
  const { getWorkflow, deleteWorkflow } = await import('../../src/domain/workflows/definitions.ts')
  expect(getWorkflow(h.db.sqlite, wf).versions[0]!.used).toBe(true)
  expect(() => deleteWorkflow(h!.db.sqlite, wf)).toThrow(/has runs/i)
})

// medium: gate-only workflow
test('a workflow made only of a gate and an end starts and finishes', async () => {
  h = await wfHarness()
  const id = await start(h, definition([gate('g'), end()], [edge('g', 'done')]))
  await h.until(() => node(h!, id, 'g').state === 'gate_open')
  await decide(h, id, 'g', 'approve')
  await h.until(done(id))
})

// medium: skipped-node defaults
test('a default for a skipped producer yields a snapshot that satisfies the contract', async () => {
  h = await wfHarness({
    reply: replies({ review: 'ok\n```score-verdict\n{"verdict":"passed","reason":"ok"}\n```' }),
  })
  const id = await start(
    h,
    definition(
      [
        agent('review'),
        branch('route', 'review', [{ id: 'pass', when: { kind: 'verdict', is: 'passed' } }]),
        agent('ship'),
        agent('rework'),
        join('merge'),
        agent('report', { instruction: 'Rework was: {{nodes.rework.output|default:"no rework"}}' }),
        end(),
      ],
      [
        edge('review', 'route'),
        edge('route', 'ship', 'pass'),
        edge('route', 'rework', 'default'),
        edge('ship', 'merge'),
        edge('rework', 'merge'),
        edge('merge', 'report'),
        edge('report', 'done'),
      ],
    ),
  )
  await h.until(done(id))
  const c = run(h, id).consumed.find((x) => x.producer === 'rework')!
  expect(c).toMatchObject({ kind: 'default', producerAttempt: 0, eligible: true })
  expect(() => WorkflowRunSnapshotSchema.parse(h!.orch.workflowSnapshot(id))).not.toThrow()
})

// medium: unknown-spend continue
test("unknown spend 'continue' is honoured by planning, claim and send; 'pause' still pauses; revoking works", async () => {
  h = await wfHarness({ orchestrator: { spend: () => ({ usd: null, complete: false }) } })
  const chain = () =>
    definition([agent('a'), agent('b'), end()], [edge('a', 'b'), edge('b', 'done')])
  const go = await start(h, chain(), { budgetUsd: 50, unknownSpend: 'continue' })
  await h.until(done(go))
  const held = await start(h, chain(), { budgetUsd: 50, unknownSpend: 'pause' })
  await h.until(() => node(h!, held, 'b').waitingFor === 'unknown_spend')
  await h.settle(8000)
  expect(node(h, held, 'b').state).not.toBe('succeeded')
  expect(['running', 'paused']).toContain(run(h, held).status)
  // Revoking the acceptance later stops a 'continue' run at the next admission.
  const slow = await start(
    h,
    definition(
      [agent('a', { instruction: '[fake:hold] A' }), agent('b'), end()],
      [edge('a', 'b'), edge('b', 'done')],
    ),
    {
      budgetUsd: 50,
      unknownSpend: 'continue',
    },
  )
  await h.settle(2000)
  await h.orch.wfLimits(slow, {
    acceptUnknownSpend: false,
    orchestrationRevision: run(h, slow).revision,
  })
  expect(
    h.rows('SELECT accepted_unknown_spend AS a FROM orchestrations WHERE id = ?', slow),
  ).toEqual([{ a: 0 }])
})

// high 2: withdrawn graph evidence
const withdrawProducer = async (id: string, nodeId: string) => {
  h!.db.sqlite
    .prepare(
      "UPDATE orc_attempts SET state = 'unknown', unknown_reason = 'recovered_text_only', evidence = NULL, terminated_at = NULL, settled = 0 WHERE step_id = ?",
    )
    .run(node(h!, id, nodeId).stepId!)
  await h!.orch.recover()
  await h!.settle(2000)
}

test('an unsent successor with no template reference is retired when its producer is withdrawn', async () => {
  h = await wfHarness({ reply: replies({ a: 'accepted' }) })
  seedAgent(h, 'reviewer')
  h.db.sqlite
    .prepare(
      "INSERT INTO agent_pauses (agent_id, paused_at) VALUES ('reviewer', '2026-01-01T00:00:00.000Z')",
    )
    .run()
  const id = await start(
    h,
    definition(
      [
        agent('a'),
        agent('b', { agentId: 'reviewer', instruction: 'Do b without looking at a' }),
        end(),
      ],
      [edge('a', 'b'), edge('b', 'done')],
    ),
  )
  await h.until(() => node(h!, id, 'b').state === 'running')
  // Readiness evidence is recorded even without a template reference.
  expect(run(h, id).consumed.map((c) => [c.consumer, c.producer, c.eligible])).toEqual([
    ['b', 'a', true],
  ])
  await withdrawProducer(id, 'a')
  h.db.sqlite.prepare("DELETE FROM agent_pauses WHERE agent_id = 'reviewer'").run()
  await h.orch.admissionChanged()
  await h.settle(5000)
  const b = run(h, id).steps.find((s) => s.id === node(h!, id, 'b').stepId)!
  expect(b.status).toBe('blocked')
  expect(run(h, id).attempts.filter((x) => x.stepId === b.id && x.runId !== null)).toHaveLength(0)
  expect(node(h, id, 'b').state).toBe('unresolved')
})

test('an open node gate that displays a withdrawn result is withdrawn and cannot be approved', async () => {
  h = await wfHarness({ reply: replies({ a: 'accepted' }) })
  const id = await start(
    h,
    definition([agent('a'), gate('g'), end()], [edge('a', 'g'), edge('g', 'done')]),
  )
  await h.until(() => node(h!, id, 'g').state === 'gate_open')
  const g = run(h, id).nodeGates[0]!
  await withdrawProducer(id, 'a')
  expect(run(h, id).nodeGates.find((x) => x.id === g.id)!.status).toBe('withdrawn')
  expect(node(h, id, 'g').state).not.toBe('gate_open')
  await expect(
    h.orch.wfGateDecision(id, g.id, {
      decision: 'approve',
      expectedRevision: g.revision,
      orchestrationRevision: run(h, id).revision,
    }),
  ).rejects.toMatchObject({ status: 409 })
  expect(run(h, id).status).toBe('running')
})

test('a node gate cannot be approved when the producer it displays changed after it opened', async () => {
  h = await wfHarness({ reply: replies({ a: 'accepted' }) })
  const id = await start(
    h,
    definition([agent('a'), gate('g'), end()], [edge('a', 'g'), edge('g', 'done')]),
  )
  await h.until(() => node(h!, id, 'g').state === 'gate_open')
  const g = run(h, id).nodeGates[0]!
  h.db.sqlite
    .prepare("UPDATE wf_nodes SET output_revision = output_revision + 1 WHERE node_id = 'a'")
    .run()
  await expect(
    h.orch.wfGateDecision(id, g.id, {
      decision: 'approve',
      expectedRevision: g.revision,
      orchestrationRevision: run(h, id).revision,
    }),
  ).rejects.toMatchObject({ code: 'conflict' })
})

// round 2 (H): withdrawal before the consumer has a step
test('a ready-but-waiting consumer is not assigned while its supporting producer is unresolved, and is after it is resolved again', async () => {
  h = await wfHarness()
  seedAgent(h, 'reviewer')
  const id = await start(
    h,
    definition(
      [
        agent('a', { retries: 1, instruction: '[fake:hold] A' }),
        agent('b', { agentId: 'reviewer', instruction: 'Do b without looking at a' }),
        end(),
      ],
      [edge('a', 'b'), edge('b', 'done')],
    ),
  )
  await h.until(() => node(h!, id, 'a').stepId !== null && run(h!, id).attempts[0]?.runId != null)
  const { replaceAgent } = await import('./wf-harness.ts')
  replaceAgent(h, 'reviewer')
  await finishNode(h, id, 'a', 'completed', 'A result')
  await h.until(() => node(h!, id, 'b').waitingFor === 'remap')
  expect(node(h, id, 'b').stepId).toBeNull()
  // A's result is withdrawn while B is ready but has no step yet (its run only ever ended on recovered text).
  h.db.sqlite
    .prepare("UPDATE runs SET terminal_source = 'recovered' WHERE id = ?")
    .run(run(h, id).attempts[0]!.runId!)
  await withdrawProducer(id, 'a')
  expect(node(h, id, 'a').state).toBe('unresolved')
  const card = run(h, id).needsYou.find((n) => n.kind === 'remap')
  if (card?.kind !== 'remap') throw new Error('no card')
  await h.orch.wfRemap(id, {
    agentId: 'reviewer',
    frozenIncarnation: card.frozenIncarnation,
    currentIncarnation: card.currentIncarnation,
    orchestrationRevision: run(h, id).revision,
    acknowledge: true,
    plan: card.plan.map((p) => ({ nodeId: p.nodeId, payloadHash: p.payloadHash })),
  })
  await h.orch.agentReady('reviewer')
  await h.settle(6000)
  expect(node(h, id, 'b').stepId).toBeNull()
  // Abandon, Resume, Retry A: only then does B get a step, with A in its provenance.
  await h.orch.wfAbandon(id, {
    attemptIds: [run(h, id).attempts[0]!.id],
    orchestrationRevision: run(h, id).revision,
    acknowledge: true,
  })
  await h.settle(2000)
  await h.orch.wfResume(id, { orchestrationRevision: run(h, id).revision })
  await h.settle(2000)
  expect(node(h, id, 'b').stepId).toBeNull()
  await h.orch.wfRetry(id, 'a', {
    expectedNodeRevision: node(h, id, 'a').revision,
    orchestrationRevision: run(h, id).revision,
    acknowledge: true,
  })
  await h.until(() => run(h!, id).attempts.length === 2 && run(h!, id).attempts[1]!.runId != null)
  await finishNode(h, id, 'a', 'completed', 'A again')
  await h.until(() => node(h!, id, 'b').stepId !== null)
  expect(
    run(h, id)
      .consumed.filter((c) => c.consumer === 'b')
      .map((c) => [c.producer, c.eligible]),
  ).toEqual([['a', true]])
})

// round 2 (M): pruning with a post-release summary that references the run's reply
test('a later summary referencing a run reply keeps that reply; the other runs are still pruned independently', async () => {
  h = await wfHarness()
  const first = await start(h, simple())
  await h.until(done(first))
  const second = await start(h, simple())
  await h.until(done(second))
  const room = h.rows<{ room_id: string }>(
    'SELECT room_id FROM orchestrations WHERE id = ?',
    first,
  )[0]!.room_id
  const reply = h.rows<{ message_id: string }>(
    'SELECT a.message_id FROM orc_attempts a WHERE a.orchestration_id = ?',
    first,
  )[0]!.message_id
  const at = new Date(h.scheduler.now()).toISOString()
  const goal = h.rows<{ brief_id: string }>(
    'SELECT brief_id FROM orchestrations WHERE id = ?',
    first,
  )[0]!.brief_id
  h.db.sqlite
    .prepare(
      `INSERT INTO messages (id, room_id, author_kind, author_agent_id, "to", parts, refs, streaming, created_at, updated_at) VALUES ('sum-1', ?, 'agent', 'lead', '[]', '[]', '[]', 0, ?, ?)`,
    )
    .run(room, at, at)
  h.db.sqlite
    .prepare(
      `INSERT INTO message_runs (message_id, room_id, agent_id, chain_id, hop, turn_id, parent_message_id, input, agents, created_at)
       VALUES ('sum-1', ?, 'lead', ?, 0, 'sum-turn', ?, 'summarise', '["lead"]', ?)`,
    )
    .run(room, reply, reply, at)
  void goal
  // The second run's prune is made to fail; the first must still go.
  h.db.sqlite.exec(
    `CREATE TRIGGER boom BEFORE DELETE ON orchestrations WHEN old.id = '${second}' BEGIN SELECT RAISE(ABORT, 'boom'); END`,
  )
  aged(first)
  aged(second)
  const result = h.orch.maintenance()
  expect(result.pruned).toBe(1)
  expect(h.rows('SELECT 1 FROM orchestrations WHERE id = ?', first)).toHaveLength(0)
  expect(h.rows('SELECT 1 FROM orchestrations WHERE id = ?', second)).toHaveLength(1)
  // The reply the summary hangs on is preserved, with the summary.
  expect(h.rows('SELECT 1 FROM messages WHERE id = ?', reply)).toHaveLength(1)
  expect(h.rows("SELECT 1 FROM message_runs WHERE message_id = 'sum-1'")).toHaveLength(1)
})
