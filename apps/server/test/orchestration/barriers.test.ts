import type { OrchReceipt } from '@score/contract'
import { afterEach, expect, test } from 'vitest'
import { byTurn } from '../../src/hermes/fake/fake-lead.ts'
import { attemptOf, endRun, harness, type Harness } from './harness.ts'

let h: Harness
afterEach(async () => {
  await h?.close()
  h = undefined as never
})
const status = (id: string) => h.orch.summary(id).status
const detail = (id: string) => h.orch.snapshot(id).orchestration
const r = (value: unknown) => value as OrchReceipt

test('finish with queued work: admissions are fenced, queued steps are retired with a disposition, gates and questions are withdrawn, started steps drain', async () => {
  const out: OrchReceipt[] = []
  h = await harness({
    lead: {
      script: byTurn({
        1: async (t) => {
          await t.call('orch.assign', { agent: 'builder', instruction: '[fake:hold] long job' })
          await t.call('orch.assign', {
            agent: 'reviewer',
            instruction: 'queued behind it',
            after: ['s1'],
          })
          await t.call('orch.assign', {
            agent: 'reviewer',
            instruction: 'also queued',
            after: ['s1'],
          })
          await t.call('orch.ask', { question: 'Anything else?' })
          out.push(r(await t.call('orch.finish', { outcome: 'success', summary: 'done' })))
          out.push(r(await t.call('orch.assign', { agent: 'builder', instruction: 'too late' })))
        },
      }),
    },
  })
  const id = await h.create({ gatePolicy: 'none' })
  await h.until(
    () => detail(id).status === 'finishing' && attemptOf(h, id, 'lead')[0]!.state === 'terminated',
  )
  const d = detail(id)
  expect(out.map((o) => o.code ?? o.status)).toEqual(['ok', 'sealed'])
  expect(d.stepsList.map((s) => [s.id, s.status, s.disposition])).toEqual([
    ['s1', 'admitted', null],
    ['s2', 'not_started', 'not_started: run_finishing'],
    ['s3', 'not_started', 'not_started: run_finishing'],
  ])
  expect(d.inquiries[0]!.status).toBe('withdrawn')
  expect(d.finish).toMatchObject({ outcome: 'success', summary: 'done' })
  // The requesting lead attempt ended, but a started step has not: the run is draining, not succeeded.
  expect(d.status).toBe('finishing')
  await h.settle(5000)
  expect(attemptOf(h, id, 'step').map((a) => a.stepId)).toEqual(['s1'])
  // The step ends with evidence: now every admitted attempt is terminated.
  await endRun(h, attemptOf(h, id, 'step', 's1')[0]!.runId!, 'completed', 'long job done')
  await h.until(() => status(id) === 'succeeded')
  expect(detail(id).ownership).toBe('released')
})

test('finish ends finished_with_unresolved when an admitted attempt is not confirmed ended', async () => {
  h = await harness({
    lead: {
      script: byTurn({
        1: async (t) => {
          await t.call('orch.assign', { agent: 'builder', instruction: '[fake:hold]' })
          await t.call('orch.finish', { outcome: 'success', summary: 'done' })
        },
      }),
    },
  })
  const id = await h.create({ gatePolicy: 'none' })
  await h.until(() => attemptOf(h, id, 'step', 's1').some((a) => a.state === 'running'))
  await endRun(h, attemptOf(h, id, 'step', 's1')[0]!.runId!, 'interrupted')
  await h.until(() => status(id) === 'finished_with_unresolved')
  const d = detail(id)
  expect(d.unconfirmed).toHaveLength(1)
  expect(d.ownership).toBe('draining')
  expect(d.endReason).toContain('not confirmed ended')
})

test('cancel of a running step fences every admission until it ends or the person waives; a differently worded replacement is blocked too', async () => {
  const out: OrchReceipt[] = []
  h = await harness({
    lead: {
      script: byTurn({
        1: async (t) => {
          await t.call('orch.assign', {
            agent: 'builder',
            instruction: '[fake:hold] first attempt',
          })
          await t.call('orch.ask', { question: 'ok to cancel?' })
        },
        2: async (t) => {
          out.push(r(await t.call('orch.cancel', { stepId: 's1' })))
          // Not saying `replaces`, and worded differently: the fence still holds.
          out.push(
            r(
              await t.call('orch.assign', {
                agent: 'reviewer',
                instruction: 'something entirely different',
              }),
            ),
          )
          out.push(r(await t.call('orch.cancel', { stepId: 's1' })))
        },
        3: async (t) => {
          await t.call('orch.finish', { outcome: 'partial', summary: 'end' })
        },
      }),
    },
  })
  const id = await h.create({ gatePolicy: 'none' })
  await h.until(
    () =>
      detail(id).inquiries.length === 1 &&
      attemptOf(h, id, 'step', 's1').some((a) => a.state === 'running'),
  )
  const d0 = detail(id)
  await h.orch.inquiryAnswer(id, 'q1', {
    answer: 'yes',
    expectedRevision: d0.inquiries[0]!.revision,
    orchestrationRevision: d0.revision,
  })
  await h.until(() => out.length === 3)
  expect(out.map((o) => o.code ?? o.status)).toEqual(['ok', 'ok', 'already_final'])
  expect(out[0]!.result).toMatchObject({
    stepId: 's1',
    status: 'cancelled',
    admissionsFenced: true,
  })
  await h.settle(3000)
  // The replacement is queued but not admitted: the cancelled run's end is unconfirmed (Stop is not evidence).
  const d = detail(id)
  expect(d.stepsList.map((s) => [s.id, s.status])).toEqual([
    ['s1', 'cancelled'],
    ['s2', 'queued'],
  ])
  expect(attemptOf(h, id, 'step', 's2')).toHaveLength(0)
  expect(d.cancelFence).toHaveLength(1)
  expect(h.orch.summary(id).needsYou).toEqual(
    expect.arrayContaining([expect.objectContaining({ kind: 'cancel_fence', stepId: 's1' })]),
  )
  // The owed Stop was delivered and Hermes cancelled the run: still no termination evidence.
  const s1 = attemptOf(h, id, 'step', 's1')[0]!
  expect(s1.retired).toBe(true)
  expect(s1.stopAcknowledgedAt).not.toBeNull()
  expect(s1.state).toBe('unknown')
  // The person records a waiver ("continue while the cancelled step may still run"): admission resumes.
  await h.orch.waiver(id, { orchestrationRevision: detail(id).revision, acknowledge: true })
  await h.until(() => attemptOf(h, id, 'step', 's2').length === 1)
  expect(detail(id).waiverAt).not.toBeNull()
  expect(detail(id).cancelFence).toHaveLength(0)
  // The cancelled attempt is still not confirmed ended; the run says so at the end.
  await h.until(() => ['finished_with_unresolved', 'succeeded'].includes(status(id)))
  expect(status(id)).toBe('finished_with_unresolved')
})

test('cancel of a queued step needs no fence; replaces shows the lineage in the gate', async () => {
  h = await harness({
    lead: {
      script: byTurn({
        1: async (t) => {
          await t.call('orch.assign', { agent: 'builder', instruction: 'first' })
          await t.call('orch.cancel', { stepId: 's1' })
          await t.call('orch.assign', {
            agent: 'builder',
            instruction: 'second try',
            replaces: 's1',
          })
        },
      }),
    },
  })
  const id = await h.create({ gatePolicy: 'every-step' })
  await h.until(() => detail(id).stepsList.length === 2)
  const d = detail(id)
  expect(d.stepsList.map((s) => s.status)).toEqual(['cancelled', 'pending_gate'])
  expect(d.cancelFence).toHaveLength(0)
  expect(d.gates.map((g) => g.status)).toEqual(['withdrawn', 'open'])
  expect(d.gates[1]!.payload.replaces).toBe('s1')
  await expect(
    h.orch.waiver(id, { orchestrationRevision: d.revision, acknowledge: true }),
  ).rejects.toMatchObject({ status: 409 })
})

test('cancelling a step cascades to its dependents', async () => {
  h = await harness({
    lead: {
      script: byTurn({
        1: async (t) => {
          await t.call('orch.assign', { agent: 'builder', instruction: 'a' })
          await t.call('orch.assign', { agent: 'reviewer', instruction: 'b', after: ['s1'] })
          await t.call('orch.assign', { agent: 'reviewer', instruction: 'c', after: ['s2'] })
          await t.call('orch.cancel', { stepId: 's1' })
        },
      }),
    },
  })
  const id = await h.create({ gatePolicy: 'every-step' })
  await h.until(
    () => detail(id).stepsList.length === 3 && detail(id).stepsList[0]!.status === 'cancelled',
  )
  expect(detail(id).stepsList.map((s) => s.status)).toEqual(['cancelled', 'blocked', 'blocked'])
})
