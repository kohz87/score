// 3.14 (decision 150): the advisor, consulted by Score at three checkpoints; advice is data, never a veto.
import type { OrchReceipt } from '@score/contract'
import { afterEach, expect, test } from 'vitest'
import { byTurn } from '../../src/hermes/fake/fake-lead.ts'
import type { CheckResult, CheckSpawner } from '../../src/runtimes/check/spawn-check.ts'
import { endRun, harness, type Harness } from './harness.ts'

let h: Harness
afterEach(async () => {
  await h?.close()
  h = undefined as never
})
const r = (value: unknown) => value as OrchReceipt
const status = (id: string) => h.orch.summary(id).status
const advisorInputs: string[] = []
const reply = (req: { agentId: string; input: string }) => {
  if (req.input.startsWith('You are the advisor')) {
    advisorInputs.push(req.input)
    return { text: 'Add a test step before the release notes.', tools: [] }
  }
  return { text: 'The step is done.', tools: [] }
}
const consults = (id: string) => h.orch.snapshot(id).orchestration.advisor?.consults ?? []

test('before the plan: work waits for the advice, which reaches the lead quoted', async () => {
  advisorInputs.length = 0
  const out: OrchReceipt[] = []
  const inputs: string[] = []
  h = await harness({
    reply,
    lead: {
      script: byTurn({
        1: async (t) => {
          out.push(r(await t.call('orch.plan', { entries: ['write the notes'] })))
          out.push(r(await t.call('orch.assign', { agent: 'builder', instruction: 'write' })))
        },
        2: async (t) => {
          inputs.push(t.input)
          out.push(r(await t.call('orch.assign', { agent: 'builder', instruction: 'write' })))
        },
      }),
    },
  })
  const id = await h.create({ advisorAgentId: 'reviewer' })
  await h.until(() => out.length === 3)
  expect(out[1]).toMatchObject({ status: 'refused', code: 'advice_pending' })
  expect(out[2]!.status).toBe('ok')
  expect(advisorInputs[0]).toContain('Checkpoint: before plan')
  expect(advisorInputs[0]).toContain('1. write the notes')
  expect(inputs[0]).toContain('<<<ADVICE adv1')
  expect(inputs[0]).toContain('Add a test step before the release notes.')
  // The consult is not part of the lead's work: not in its step list, not counted against its steps.
  expect(inputs[0]).not.toMatch(/^- adv1 /m)
  expect(h.orch.summary(id).stepsCreated ?? 1).toBeLessThanOrEqual(1)
  expect(consults(id)).toEqual([
    expect.objectContaining({
      checkpoint: 'before_plan',
      status: 'succeeded',
      advice: 'Add a test step before the release notes.',
    }),
  ])
  expect(h.orch.snapshot(id).orchestration.stepsList.find((s) => s.id === 'adv1')?.role).toBe(
    'advisor',
  )
})

test('before done: the first successful finish waits for advice; the lead may then finish anyway', async () => {
  const out: OrchReceipt[] = []
  h = await harness({
    reply,
    lead: {
      script: byTurn({
        1: async (t) => {
          out.push(r(await t.call('orch.finish', { outcome: 'success', summary: 'done' })))
        },
        2: async (t) => {
          out.push(r(await t.call('orch.finish', { outcome: 'success', summary: 'done' })))
        },
      }),
    },
  })
  const id = await h.create({ advisorAgentId: 'reviewer' })
  await h.until(() => status(id) === 'succeeded')
  expect(out.map((o) => o.code ?? o.status)).toEqual(['advice_pending', 'ok'])
  expect(consults(id).map((c) => c.checkpoint)).toEqual(['before_done'])
})

test('a partial or failed finish never waits for the advisor', async () => {
  h = await harness({
    reply,
    lead: {
      script: byTurn({
        1: async (t) => void (await t.call('orch.finish', { outcome: 'partial', summary: 'half' })),
      }),
    },
  })
  const id = await h.create({ advisorAgentId: 'reviewer' })
  await h.until(() => status(id) === 'succeeded')
  expect(consults(id)).toEqual([])
})

test('the same failure twice: the advisor is asked once about it', async () => {
  const out: OrchReceipt[] = []
  h = await harness({
    reply,
    lead: {
      script: byTurn({
        1: async (t) => void (await t.call('orch.assign', { agent: 'builder', instruction: 'a' })),
        2: async (t) => {
          out.push(
            r(
              await t.call('orch.assign', {
                agent: 'builder',
                instruction: 'build one [fake:hold]',
              }),
            ),
          )
          out.push(
            r(
              await t.call('orch.assign', {
                agent: 'builder',
                instruction: 'build two [fake:hold]',
              }),
            ),
          )
        },
      }),
    },
  })
  const id = await h.create({ advisorAgentId: 'reviewer', maxConcurrentSteps: 2 })
  await h.until(
    () =>
      h.orch
        .snapshot(id)
        .orchestration.attempts.filter((a) => a.kind === 'step' && a.stepId !== 'adv1' && a.runId)
        .length === 2,
  )
  const steps = h.orch
    .snapshot(id)
    .orchestration.attempts.filter((a) => a.kind === 'step' && a.stepId !== 'adv1')
  await endRun(h, steps[0]!.runId!, 'failed', 'Error: cannot find module ./x 1234')
  await h.settle()
  expect(consults(id).map((c) => c.checkpoint)).toEqual(['before_plan'])
  await endRun(h, steps[1]!.runId!, 'failed', 'Error: cannot find module ./x 5678')
  await h.until(() => consults(id).length === 2)
  expect(consults(id)[1]).toMatchObject({ checkpoint: 'repeat_failure' })
  expect(consults(id)[1]!.reason).toMatch(/failed the same way/)
})

test('the lead cannot cancel, depend on or replace a consult', async () => {
  const out: OrchReceipt[] = []
  h = await harness({
    reply,
    lead: {
      script: byTurn({
        1: async (t) => {
          await t.call('orch.plan', { entries: ['x'] })
          out.push(r(await t.call('orch.cancel', { stepId: 'adv1' })))
        },
        2: async (t) => {
          out.push(
            r(await t.call('orch.assign', { agent: 'builder', instruction: 'x', after: ['adv1'] })),
          )
          out.push(
            r(
              await t.call('orch.assign', { agent: 'builder', instruction: 'x', replaces: 'adv1' }),
            ),
          )
        },
      }),
    },
  })
  await h.create({ advisorAgentId: 'reviewer' })
  await h.until(() => out.length === 3)
  expect(out.map((o) => o.code)).toEqual(['unknown_step', 'bad_dependency', 'bad_replaces'])
})

test('with a check: the before-done consult does not make the pass stale', async () => {
  let finishCheck!: (result: CheckResult) => void
  const checks: CheckSpawner = async () => ({
    stop() {},
    done: new Promise<CheckResult>((resolve) => (finishCheck = resolve)),
  })
  const out: OrchReceipt[] = []
  h = await harness({
    reply,
    orchestrator: { checks },
    lead: {
      script: byTurn({
        1: async (t) => void (await t.call('orch.check', {})),
        2: async (t) =>
          out.push(r(await t.call('orch.finish', { outcome: 'success', summary: 'x' }))),
        3: async (t) =>
          out.push(r(await t.call('orch.finish', { outcome: 'success', summary: 'x' }))),
      }),
    },
  })
  const id = await h.create({
    advisorAgentId: 'reviewer',
    check: { command: 'pnpm test', workspace: '/tmp/repo', timeoutSec: 600, when: 'finish' },
  })
  await h.until(() => finishCheck !== undefined)
  finishCheck({ exitCode: 0, signal: null, timedOut: false, stopped: false, output: 'ok' })
  await h.until(() => status(id) === 'succeeded')
  expect(out.map((o) => o.code ?? o.status)).toEqual(['advice_pending', 'ok'])
})

test('the advisor cannot be the lead', async () => {
  h = await harness()
  await expect(h.create({ advisorAgentId: 'lead' })).rejects.toThrow(/another agent than the lead/)
})
