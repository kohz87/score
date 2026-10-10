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
