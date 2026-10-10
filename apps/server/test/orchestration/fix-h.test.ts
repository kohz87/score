import { afterEach, expect, test } from 'vitest'
import { byTurn } from '../../src/hermes/fake/fake-lead.ts'
import { runRecoveredObservation } from '../../src/hermes/live/translate.ts'
import { attemptOf, harness, type Harness } from './harness.ts'

let h: Harness
afterEach(async () => {
  await h?.close()
})
const status = (id: string) => h.orch.summary(id).status
const detail = (id: string) => h.orch.snapshot(id).orchestration

test('fix-h 1: a run recovered from session text (404 + matching reply) shows its text but is not termination evidence', async () => {
  h = await harness({
    lead: {
      script: byTurn({
        1: async (t) => {
          await t.call('orch.assign', { agent: 'builder', instruction: '[fake:hold] write it' })
          await t.call('orch.assign', { agent: 'reviewer', instruction: 'check it', after: ['s1'] })
        },
      }),
    },
  })
  const id = await h.create({ gatePolicy: 'none' })
  await h.until(() => attemptOf(h, id, 'step', 's1').some((a) => a.state === 'running'))
  const attempt = attemptOf(h, id, 'step', 's1')[0]!
  // Hermes forgot the run; the live follower found a matching assistant reply in the session history.
  await h.ingest.submit(
    runRecoveredObservation(
      { profile: 'builder', runId: attempt.runId!, credentialGeneration: 1 },
      'Recovered answer text',
    ),
  )
  expect(
    h.rows<{ status: string; terminal_source: string }>(
      'SELECT status, terminal_source FROM runs WHERE id = ?',
      attempt.runId!,
    ),
  ).toEqual([{ status: 'completed', terminal_source: 'recovered' }])
  await h.settle(5000)
  const after = attemptOf(h, id, 'step', 's1')[0]!
  expect(after.state).toBe('unknown')
  expect(after.unknownReason).toBe('recovered_text_only')
  const d = detail(id)
  expect(d.stepsList.find((s) => s.id === 's1')!.status).toBe('unknown')
  expect(d.unconfirmed).toEqual([after.id])
  // No successor was admitted and the result was not accepted.
  expect(attemptOf(h, id, 'step', 's2')).toHaveLength(0)
  expect(
    h.rows('SELECT result FROM orc_steps WHERE id = ? AND result IS NOT NULL', 's1'),
  ).toHaveLength(0)
  expect(status(id)).not.toBe('succeeded')
  // The person still sees the text (chat behaviour is unchanged).
  expect(
    h.rows<{ output: string }>('SELECT output FROM runs WHERE id = ?', attempt.runId!)[0]!.output,
  ).toBe('Recovered answer text')
})
