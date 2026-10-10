import { afterEach, expect, test } from 'vitest'
import { byTurn } from '../../src/hermes/fake/fake-lead.ts'
import { runRecoveredObservation } from '../../src/hermes/live/translate.ts'
import { attemptOf, harness, type Harness } from './harness.ts'

let h: Harness
afterEach(async () => {
  await h?.close()
  h = undefined as never
})
const status = (id: string) => h.orch.summary(id).status
const detail = (id: string) => h.orch.snapshot(id).orchestration

test('fix-i 1: a sibling that turns unknown while an earlier dispatch awaits its reply stops the next send', async () => {
  h = await harness({
    lead: {
      script: byTurn({
        1: async (t) => {
          await t.call('orch.assign', { agent: 'builder', instruction: '[fake:hold] first' })
          await t.call('orch.assign', { agent: 'reviewer', instruction: 'GATE second' })
          await t.call('orch.assign', { agent: 'builder', instruction: 'third' })
        },
      }),
    },
  })
  // The second dispatch waits for its reply; meanwhile the first run is reported as recovered text only.
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  const start = h.port.startRun.bind(h.port)
  h.port.startRun = async (req) => {
    if (req.input.includes('GATE second')) await gate
    return start(req)
  }
  const id = await h.create({ gatePolicy: 'none', maxConcurrentSteps: 3 })
  await h.until(() => attemptOf(h, id, 'step', 's1').some((a) => a.state === 'running'))
  await h.until(() => attemptOf(h, id, 'step', 's3').length === 1)
  const first = attemptOf(h, id, 'step', 's1')[0]!
  await h.ingest.submit(
    runRecoveredObservation(
      { profile: 'builder', runId: first.runId!, credentialGeneration: 1 },
      'Recovered answer text',
    ),
  )
  release()
  await h.settle(5000)
  expect(attemptOf(h, id, 'step', 's1')[0]!.state).toBe('unknown')
  expect(attemptOf(h, id, 'step', 's3')[0]!.state).toBe('created')
  expect(attemptOf(h, id, 'step', 's3')[0]!.runId).toBeNull()
  expect(status(id)).not.toBe('succeeded')
})

// ------------------------------------------------------------------ item 3: remap keeps a manual Pause

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'

test('fix-i 3: replacement pause -> manual Pause -> remap leaves the run paused with no new lead attempt; Resume restores', async () => {
  h = await harness({
    lead: {
      script: byTurn({
        1: async (t) => {
          await t.call('orch.ask', { question: 'ready?' })
        },
      }),
    },
  })
  h.db.sqlite
    .prepare(
      "INSERT INTO agent_lifecycle (agent_id, incarnation_id, state) VALUES ('lead', ?, 'ready')",
    )
    .run(A)
  const id = await h.create()
  await h.until(() => detail(id).inquiries.length === 1)
  await h.until(() => attemptOf(h, id, 'lead')[0]!.state === 'terminated')
  h.db.sqlite
    .prepare("UPDATE agent_lifecycle SET incarnation_id = ? WHERE agent_id = 'lead'")
    .run(B)
  await h.orch.inquiryAnswer(id, 'q1', {
    answer: 'yes',
    expectedRevision: 1,
    orchestrationRevision: detail(id).revision,
  })
  await h.until(() => status(id) === 'paused')
  expect(h.orch.summary(id).pauseReason).toBe('agent_unavailable')
  await h.orch.pause(id, { orchestrationRevision: detail(id).revision })
  await h.orch.remap(id, {
    agentId: 'lead',
    frozenIncarnation: A,
    currentIncarnation: B,
    orchestrationRevision: detail(id).revision,
    acknowledge: true,
  })
  await h.settle(5000)
  expect(status(id)).toBe('paused')
  expect(h.orch.summary(id).pauseReason).not.toBe('agent_unavailable')
  expect(h.rows('SELECT manual_paused_at FROM orchestrations WHERE id = ?', id)[0]).not.toEqual({
    manual_paused_at: null,
  })
  expect(attemptOf(h, id, 'lead')).toHaveLength(1)
  // Restore: Resume ends the hold and the lead gets its turn.
  await h.orch.resume(id, { orchestrationRevision: detail(id).revision })
  await h.until(() => attemptOf(h, id, 'lead').length === 2)
  expect(status(id)).not.toBe('paused')
})
