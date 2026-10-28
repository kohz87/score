// 3.14 (owner, 2026-10-28: "we should make both automatic", "can we make it until tasks end?", a step stuck for 14 min):
// automatic votes before each of the lead's steps, automatic audits after, an unlimited helper allowance, and the
// person stopping one step.
import type { OrchReceipt } from '@score/contract'
import { afterEach, expect, test } from 'vitest'
import { byTurn } from '../../src/hermes/fake/fake-lead.ts'
import { harness, type Harness } from './harness.ts'

let h: Harness
afterEach(async () => {
  await h?.close()
  h = undefined as never
})
const r = (value: unknown) => value as OrchReceipt
let voteAnswer = '1'
const reply = (req: { agentId: string; input: string }) => {
  if (req.input.includes('You are a voting helper')) return { text: voteAnswer, tools: [] }
  if (req.input.includes('You are an audit helper')) return { text: 'clean', tools: [] }
  return { text: 'The step is done.', tools: [] }
}
const HELPERS = {
  agentIds: ['designer', 'reviewer'],
  maxConcurrent: 3,
  maxSteps: null,
  scan: false,
  splitTo: 'lead' as const,
  autoVote: true,
  autoVoteK: 3,
  autoAudit: false,
}
const steps = (id: string) => h.orch.snapshot(id).orchestration.stepsList

test('a step the voters approve starts after the tally; the lead hears the verdict', async () => {
  voteAnswer = '1'
  const out: OrchReceipt[] = []
  const inputs: string[] = []
  h = await harness({
    reply,
    lead: {
      script: byTurn({
        1: async (t) =>
          void out.push(
            r(await t.call('orch.assign', { agent: 'builder', instruction: 'build it' })),
          ),
        2: async (t) => void inputs.push(t.input),
      }),
    },
  })
  const id = await h.create({ gatePolicy: 'none', helpers: HELPERS })
  await h.until(() => steps(id).find((s) => s.id === 's1')?.status === 'succeeded')
  expect(out[0]!.result).toMatchObject({ stepId: 's1', voteId: 'v1' })
  const vote = h.orch.snapshot(id).orchestration.helpers!.votes[0]!
  expect(vote).toMatchObject({ stepId: 's1', status: 'sharp', choice: 0, counts: [3, 0, 0] })
  // The step started only after the tally.
  const voted = h.rows<{ tallied_at: string }>(
    'SELECT tallied_at FROM orc_votes WHERE id = ?',
    'v1',
  )[0]!.tallied_at
  const sent = h.rows<{ created_at: string }>(
    "SELECT created_at FROM orc_attempts WHERE step_id = 's1' AND orchestration_id = ?",
    id,
  )[0]!
  expect(sent.created_at >= voted).toBe(true)
  await h.until(() => inputs.length === 1)
  expect(inputs[0]).toContain('s1 goes ahead: the voters agreed')
})

test('a step the voters reject does not start, and the lead is told to reassign it', async () => {
  voteAnswer = '2'
  const inputs: string[] = []
  h = await harness({
    reply,
    lead: {
      script: byTurn({
        1: async (t) =>
          void (await t.call('orch.assign', { agent: 'builder', instruction: 'build it' })),
        2: async (t) => void inputs.push(t.input),
      }),
    },
  })
  const id = await h.create({ gatePolicy: 'none', helpers: HELPERS })
  await h.until(() => inputs.length === 1)
  expect(steps(id).find((s) => s.id === 's1')).toMatchObject({ status: 'rejected' })
  expect(h.orch.snapshot(id).orchestration.attempts.some((a) => a.stepId === 's1')).toBe(false)
  expect(inputs[0]).toContain('No: another agent should do it')
})

test('a split vote with "ask me" puts the step behind the person’s approval', async () => {
  // Alternating answers across two voters: designer says 1, reviewer says 3.
  h = await harness({
    reply: (req) =>
      req.input.includes('You are a voting helper')
        ? { text: req.agentId === 'designer' ? '1' : '3', tools: [] }
        : { text: 'done', tools: [] },
    lead: {
      script: byTurn({
        1: async (t) =>
          void (await t.call('orch.assign', { agent: 'builder', instruction: 'build it' })),
      }),
    },
  })
  const id = await h.create({
    gatePolicy: 'none',
    helpers: { ...HELPERS, autoVoteK: 4, splitTo: 'person' },
  })
  await h.until(() => steps(id).find((s) => s.id === 's1')?.status === 'pending_gate')
  const s1 = steps(id).find((s) => s.id === 's1')!
  expect(s1.gateId).not.toBeNull()
  expect(h.orch.snapshot(id).orchestration.gates.find((g) => g.id === s1.gateId)?.status).toBe(
    'open',
  )
})

test('no automatic votes when the person approves every step', async () => {
  h = await harness({
    reply,
    lead: {
      script: byTurn({
        1: async (t) => void (await t.call('orch.assign', { agent: 'builder', instruction: 'x' })),
      }),
    },
  })
  const id = await h.create({ gatePolicy: 'every-step', helpers: HELPERS })
  await h.until(() => steps(id).length === 1)
  await h.settle()
  expect(h.orch.snapshot(id).orchestration.helpers!.votes).toEqual([])
  expect(h.orch.snapshot(id).orchestration.helpers!.autoVote).toBe(false)
})

test('an automatic audit follows each of the lead’s steps that succeeds; the allowance can be unlimited', async () => {
  h = await harness({
    reply,
    lead: {
      script: byTurn({
        1: async (t) =>
          void (await t.call('orch.assign', { agent: 'builder', instruction: 'build the feed' })),
      }),
    },
  })
  const id = await h.create({
    gatePolicy: 'none',
    helpers: { ...HELPERS, autoVote: false, autoAudit: true },
  })
  await h.until(() => steps(id).some((s) => s.helperRole === 'audit' && s.status === 'succeeded'))
  const audit = steps(id).find((s) => s.helperRole === 'audit')!
  expect(audit).toMatchObject({ role: 'helper', result: 'clean' })
  expect(audit.instruction).toContain('<<<STEP s1')
  expect(audit.instruction).toContain('build the feed')
  // Audits don't audit themselves.
  expect(steps(id).filter((s) => s.helperRole === 'audit')).toHaveLength(1)
  expect(h.orch.snapshot(id).orchestration.helpers!.maxSteps).toBeNull()
})

test('the person stops one running step; the lead is told and the job goes on', async () => {
  const inputs: string[] = []
  h = await harness({
    reply,
    lead: {
      script: byTurn({
        1: async (t) =>
          void (await t.call('orch.assign', {
            agent: 'builder',
            instruction: 'slow work [fake:hold]',
          })),
        2: async (t) => void inputs.push(t.input),
      }),
    },
  })
  const id = await h.create({ gatePolicy: 'none' })
  await h.until(() =>
    h.orch.snapshot(id).orchestration.attempts.some((a) => a.stepId === 's1' && a.runId),
  )
  const s1 = steps(id).find((s) => s.id === 's1')!
  expect(s1.lastActivityAt).toEqual(expect.any(String))
  await h.orch.stopStep(id, 's1', { orchestrationRevision: h.orch.summary(id).revision })
  expect(steps(id).find((s) => s.id === 's1')!.status).toBe('cancelled')
  // Score delivers the Stop; once the agent's run has ended, the lead gets its next turn.
  await h.until(() => inputs.length === 1)
  expect(inputs[0]).toContain('step_cancelled s1: stopped by the person')
  await expect(
    h.orch.stopStep(id, 's1', { orchestrationRevision: h.orch.summary(id).revision }),
  ).rejects.toThrow(/already/)
})
