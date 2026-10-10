import { createHash } from 'node:crypto'
import { afterEach, expect, test } from 'vitest'
import { runRecoveredObservation } from '../../src/hermes/live/translate.ts'
import {
  agent,
  definition,
  edge,
  end,
  endRun,
  node,
  rawNode,
  replaceAgent,
  replies,
  run,
  runIdOf,
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
const revision = (id: string) => run(h!, id).revision
const quiet = (): Promise<void> => h!.settle(1500)

test('retry lineage: a failed attempt with attempts left becomes a new step that replaces the old one', async () => {
  h = await wfHarness()
  const id = await start(
    h,
    definition(
      [agent('a', { retries: 1, instruction: '[fake:hold] A' }), end()],
      [edge('a', 'done')],
    ),
  )
  await h.until(() => runIdOf(h!, id, 'a') !== undefined)
  const first = node(h, id, 'a').stepId!
  await endRun(h, runIdOf(h, id, 'a')!, 'failed', 'broke')
  await h.until(() => node(h!, id, 'a').stepId !== first && node(h!, id, 'a').stepId !== null)
  const second = node(h, id, 'a').stepId!
  expect(run(h, id).steps.find((s) => s.id === second)!.replaces).toBe(first)
  expect(node(h, id, 'a').attemptsUsed).toBe(2)
  expect(node(h, id, 'a').lineage).toEqual([first, second])
  await h.until(() => run(h!, id).attempts.length === 2 && run(h!, id).attempts[1]!.runId !== null)
  // A new session per attempt.
  const sessions = run(h, id).attempts.map((x) => x.sessionId)
  expect(new Set(sessions).size).toBe(2)
  await endRun(h, run(h, id).attempts[1]!.runId!, 'completed', 'fine')
  await h.until(done(id))
  expect(node(h, id, 'a').state).toBe('succeeded')
})

test('retry exhaustion takes the failed route', async () => {
  h = await wfHarness()
  const id = await start(
    h,
    definition(
      [
        agent('a', { retries: 1, onFailure: 'route', instruction: '[fake:hold] A' }),
        agent('fix'),
        end(),
      ],
      [edge('a', 'done'), edge('a', 'fix', 'failed'), edge('fix', 'done')],
    ),
  )
  for (const n of [1, 2]) {
    await h.until(() => run(h!, id).attempts.filter((x) => x.runId !== null).length === n)
    await endRun(h, run(h, id).attempts[n - 1]!.runId!, 'failed', `broke ${n}`)
  }
  await h.until(done(id))
  expect(node(h, id, 'a').state).toBe('failed')
  expect(node(h, id, 'fix').state).toBe('succeeded')
})

test('A unknown → Abandon → Retry → B succeeds → end ⇒ finished_with_unresolved, graph reached the end', async () => {
  h = await wfHarness()
  const id = await start(
    h,
    definition(
      [agent('a', { retries: 1, instruction: '[fake:hold] A' }), end()],
      [edge('a', 'done')],
    ),
  )
  await h.until(() => runIdOf(h!, id, 'a') !== undefined)
  const old = run(h, id).attempts[0]!
  // `cancelled` is not termination evidence: the attempt is not confirmed ended.
  await endRun(h, old.runId!, 'cancelled')
  await h.until(() => run(h!, id).attempts[0]!.state === 'unknown')
  expect(run(h, id).needsYou.some((n) => n.kind === 'unknown')).toBe(true)
  await quiet()
  await h.orch.wfAbandon(id, {
    attemptIds: [old.id],
    orchestrationRevision: revision(id),
    acknowledge: true,
  })
  await h.until(() => node(h!, id, 'a').state === 'unresolved')
  await quiet()
  // Abandonment is administrative: no failed token came out of it, and the node offers Retry.
  expect(run(h, id).tokens.filter((t) => t.kind === 'failed')).toEqual([])
  expect(run(h, id).needsYou.find((n) => n.kind === 'retry')).toMatchObject({
    nodeId: 'a',
    attemptsLeft: 1,
  })
  await h.orch.wfResume(id, { orchestrationRevision: revision(id) })
  await quiet()
  // The Retry carries the node's own revision.
  await expect(
    h.orch.wfRetry(id, 'a', {
      expectedNodeRevision: 1,
      orchestrationRevision: revision(id),
      acknowledge: true,
    }),
  ).rejects.toMatchObject({ status: 409 })
  await h.orch.wfRetry(id, 'a', {
    expectedNodeRevision: node(h, id, 'a').revision,
    orchestrationRevision: revision(id),
    acknowledge: true,
  })
  await h.until(() => run(h!, id).attempts.length === 2 && run(h!, id).attempts[1]!.runId !== null)
  const replacement = run(h, id).attempts[1]!
  expect(run(h, id).steps.find((s) => s.id === replacement.stepId)!.replaces).toBe(old.stepId)
  await endRun(h, replacement.runId!, 'completed', 'ok')
  await h.until(done(id, 'finished_with_unresolved'))
  const detail = run(h, id)
  expect(detail.graphOutcome).toBe('reached_end')
  expect(detail.outcomeNote).toBe('Graph reached the end — 1 abandoned attempt not confirmed ended')
  // A late result of the abandoned attempt is recorded and never consumed.
  await endRun(h, old.runId!, 'completed', 'too late')
  await h.settle(2000)
  expect(node(h, id, 'a').output).toBe('ok')
})

test('Retry is refused for a node with no attempts left or one that is not unresolved', async () => {
  h = await wfHarness()
  const id = await start(
    h,
    definition([agent('a', { instruction: '[fake:hold] A' }), end()], [edge('a', 'done')]),
  )
  await h.until(() => runIdOf(h!, id, 'a') !== undefined)
  await expect(
    h.orch.wfRetry(id, 'a', {
      expectedNodeRevision: node(h, id, 'a').revision,
      orchestrationRevision: revision(id),
      acknowledge: true,
    }),
  ).rejects.toMatchObject({ code: 'not_retryable' })
})

test('recovered text on a node is shown but is not a result: the node stays running and nothing follows', async () => {
  h = await wfHarness()
  const id = await start(
    h,
    definition(
      [agent('a', { instruction: '[fake:hold] A' }), agent('b'), end()],
      [edge('a', 'b'), edge('b', 'done')],
    ),
  )
  await h.until(() => runIdOf(h!, id, 'a') !== undefined)
  const attempt = run(h, id).attempts[0]!
  await h.ingest.submit(
    runRecoveredObservation(
      { profile: 'builder', runId: attempt.runId!, credentialGeneration: 1 },
      'Recovered answer text',
    ),
  )
  await h.settle(5000)
  expect(run(h, id).attempts[0]!.state).toBe('unknown')
  expect(run(h, id).attempts[0]!.unknownReason).toBe('recovered_text_only')
  expect(node(h, id, 'a').state).toBe('running')
  expect(node(h, id, 'a').verdict).toBeNull()
  expect(node(h, id, 'b').state).toBe('waiting')
  expect(run(h, id).status).toBe('running')
  expect(h.rows('SELECT 1 FROM wf_results')).toHaveLength(0)
})

test('a consumer reads its producer through wf_consumed, frozen with the revision it saw', async () => {
  h = await wfHarness({ reply: replies({ a: 'ANSWER-FROM-A' }) })
  const id = await start(
    h,
    definition(
      [agent('a'), agent('b', { instruction: 'Review: {{nodes.a.output}}' }), end()],
      [edge('a', 'b'), edge('b', 'done')],
    ),
  )
  await h.until(done(id))
  const consumed = run(h, id).consumed
  expect(consumed).toEqual([
    expect.objectContaining({
      consumer: 'b',
      producer: 'a',
      kind: 'output',
      eligible: true,
      producerAttempt: 1,
    }),
  ])
  const bInput = h.rows<{ input: string }>(
    'SELECT input FROM orc_attempts WHERE step_id = ?',
    node(h, id, 'b').stepId!,
  )[0]!
  expect(bInput.input).toContain('ANSWER-FROM-A')
  expect(bInput.input).toContain('<<<RESULT a rev')
})

test('a consumer whose producer changed after it was claimed never sends (eligibility at send)', async () => {
  h = await wfHarness({ reply: replies({ a: 'first' }) })
  seedAgent(h, 'reviewer')
  // The consumer's agent is paused, so its step waits unsent while the producer's result is changed.
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
        agent('b', { agentId: 'reviewer', instruction: 'Review: {{nodes.a.output}}' }),
        end(),
      ],
      [edge('a', 'b'), edge('b', 'done')],
    ),
  )
  await h.until(() => node(h!, id, 'b').state === 'running')
  // Whatever happened to the producer's result after the consumer froze it, the send re-checks.
  h.db.sqlite
    .prepare("UPDATE wf_nodes SET output_revision = output_revision + 1 WHERE node_id = 'a'")
    .run()
  h.db.sqlite.prepare("DELETE FROM agent_pauses WHERE agent_id = 'reviewer'").run()
  await h.orch.admissionChanged()
  await h.settle(5000)
  const b = node(h, id, 'b')
  expect(b.state).toBe('unresolved')
  expect(b.reason).toContain('input_withdrawn')
  expect(
    run(h, id)
      .attempts.filter((x) => x.stepId === b.stepId)
      .every((x) => x.runId === null),
  ).toBe(true)
})

test('recovery withdraws an unsent consumer of a result that only ever ended on recovered text', async () => {
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
        agent('b', { agentId: 'reviewer', instruction: 'Review: {{nodes.a.output}} [fake:hold]' }),
        end(),
      ],
      [edge('a', 'b'), edge('b', 'done')],
    ),
  )
  // The consumer waits unsent; then the producer's attempt becomes "recovered only" (the upgrade state).
  await h.until(() => node(h!, id, 'b').state === 'running')
  h.db.sqlite
    .prepare(
      "UPDATE orc_attempts SET state = 'unknown', unknown_reason = 'recovered_text_only', evidence = NULL, terminated_at = NULL, settled = 0 WHERE step_id = ?",
    )
    .run(node(h, id, 'a').stepId!)
  await h.orch.recover()
  await h.settle(2000)
  const withdrawn = h.rows<{ withdrawn: number }>(
    'SELECT withdrawn FROM wf_consumed WHERE consumer = ?',
    'b',
  )
  expect(withdrawn).toEqual([{ withdrawn: 1 }])
  expect(rawNode(h, id, 'a')['state']).toBe('unresolved')
  expect(run(h, id).consumed[0]!.eligible).toBe(false)
  h.db.sqlite.prepare("DELETE FROM agent_pauses WHERE agent_id = 'reviewer'").run()
  await h.orch.admissionChanged()
  await h.settle(5000)
  expect(
    run(h, id).attempts.filter((x) => x.stepId !== node(h!, id, 'a').stepId && x.runId !== null),
  ).toHaveLength(0)
})

test('a replaced agent after Start and before assignment waits for a remap that names the exact payload', async () => {
  h = await wfHarness()
  seedAgent(h, 'builder')
  const { gate } = await import('./wf-harness.ts')
  const id = await start(
    h,
    definition([gate('g'), agent('a'), end()], [edge('g', 'a'), edge('a', 'done')]),
  )
  await h.until(() => node(h!, id, 'g').state === 'gate_open')
  replaceAgent(h, 'builder')
  const g = run(h, id).nodeGates[0]!
  await h.orch.wfGateDecision(id, g.id, {
    decision: 'approve',
    expectedRevision: g.revision,
    orchestrationRevision: revision(id),
  })
  await h.until(() => node(h!, id, 'a').waitingFor === 'remap')
  expect(node(h, id, 'a').stepId).toBeNull()
  const card = run(h, id).needsYou.find((n) => n.kind === 'remap')!
  expect(card).toMatchObject({ kind: 'remap', agentId: 'builder', nodeIds: ['a'] })
  if (card.kind !== 'remap') throw new Error('unreachable')
  const plan = card.plan[0]!
  expect(createHash('sha256').update(plan.payload).digest('hex')).toBe(plan.payloadHash)
  // A decision paired with another payload hash is refused and changes nothing.
  await expect(
    h.orch.wfRemap(id, {
      agentId: 'builder',
      frozenIncarnation: card.frozenIncarnation,
      currentIncarnation: card.currentIncarnation,
      orchestrationRevision: revision(id),
      acknowledge: true,
      plan: [{ nodeId: 'a', payloadHash: 'nope' }],
    }),
  ).rejects.toMatchObject({ code: 'stale_plan' })
  await h.orch.wfRemap(id, {
    agentId: 'builder',
    frozenIncarnation: card.frozenIncarnation,
    currentIncarnation: card.currentIncarnation,
    orchestrationRevision: revision(id),
    acknowledge: true,
    plan: [{ nodeId: 'a', payloadHash: plan.payloadHash }],
  })
  await h.until(done(id))
  const step = run(h, id).steps.find((s) => s.id === node(h!, id, 'a').stepId)!
  expect(h.rows('SELECT payload_hash FROM orc_steps WHERE id = ?', step.id)).toEqual([
    { payload_hash: plan.payloadHash },
  ])
})
