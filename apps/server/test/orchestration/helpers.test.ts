// 3.15–3.16 (decision 150): helpers (roles, own slots, scan first) and votes (sharp, split to the lead or the person).
import type { OrchReceipt } from '@score/contract'
import { afterEach, expect, test } from 'vitest'
import { readChoice } from '../../src/domain/orchestration/helpers.ts'
import { byTurn } from '../../src/hermes/fake/fake-lead.ts'
import { harness, type Harness } from './harness.ts'

let h: Harness
afterEach(async () => {
  await h?.close()
  h = undefined as never
})
const r = (value: unknown) => value as OrchReceipt
const HELPERS = {
  agentIds: ['designer', 'reviewer'],
  maxConcurrent: 3,
  maxSteps: 20,
  scan: false,
  splitTo: 'lead' as const,
}
let splitMode = false
const reply = (req: { agentId: string; input: string }) => {
  if (req.input.includes('You are a voting helper')) {
    // Split: the two helpers disagree (the answers alternate between them).
    return { text: splitMode && req.agentId === 'designer' ? '1' : '2', tools: [] }
  }
  if (req.input.includes('You are a scan helper'))
    return { text: 'Stack: TypeScript, pnpm.', tools: [] }
  return { text: 'The step is done.', tools: [] }
}
const steps = (id: string) => h.orch.snapshot(id).orchestration.stepsList

test('scan first: the lead starts only after the helpers read the folder, with their results', async () => {
  const inputs: string[] = []
  let statusesAtTurn1: string[] = []
  h = await harness({
    reply,
    lead: {
      script: byTurn({
        1: async (t) => {
          inputs.push(t.input)
          statusesAtTurn1 = steps(id).map((s) => s.status)
        },
      }),
    },
  })
  const id = await h.create({ helpers: { ...HELPERS, scan: true, scanFolder: '/tmp/repo' } })
  await h.until(() => inputs.length === 1)
  expect(steps(id).map((s) => [s.id, s.helperRole])).toEqual([
    ['h1', 'scan_stack'],
    ['h2', 'scan_scripts'],
    ['h3', 'scan_risks'],
  ])
  expect(statusesAtTurn1).toEqual(['succeeded', 'succeeded', 'succeeded'])
  expect(steps(id)[0]!.instruction).toContain('/tmp/repo')
  expect(inputs[0]).toContain('scan is done')
  expect(inputs[0]).toContain('<<<RESULT h1')
  expect(inputs[0]).toContain('Stack: TypeScript, pnpm.')
  expect(inputs[0]).toContain('Helpers: designer, reviewer')
})

test('a role sends the step to a helper, in the helpers’ own slots and allowance', async () => {
  const out: OrchReceipt[] = []
  h = await harness({
    reply,
    lead: {
      script: byTurn({
        1: async (t) => {
          out.push(
            r(await t.call('orch.assign', { agent: 'builder', instruction: 'build [fake:hold]' })),
          )
          out.push(
            r(
              await t.call('orch.assign', {
                agent: 'designer',
                role: 'search',
                instruction: 'where is auth [fake:hold]',
              }),
            ),
          )
          out.push(
            r(
              await t.call('orch.assign', {
                agent: 'reviewer',
                role: 'audit',
                instruction: 'check the diff [fake:hold]',
              }),
            ),
          )
          out.push(
            r(await t.call('orch.assign', { agent: 'builder', role: 'grep', instruction: 'x' })),
          )
        },
      }),
    },
  })
  const id = await h.create({ maxConcurrentSteps: 1, helpers: HELPERS })
  await h.until(() => steps(id).filter((s) => s.status === 'admitted').length === 3)
  expect(out.map((o) => o.code ?? o.status)).toEqual(['ok', 'ok', 'ok', 'agent_not_allowed'])
  expect(out[1]!.result).toMatchObject({ stepId: 'h1', role: 'search' })
  const search = steps(id).find((s) => s.id === 'h1')!
  expect(search).toMatchObject({ role: 'helper', helperRole: 'search' })
  expect(search.instruction).toMatch(/^You are a search helper/)
  // The lead's own limit is one step at once; its step and both helper steps run together.
  expect(h.rows('SELECT steps_created AS n FROM orchestrations WHERE id = ?', id)).toEqual([
    { n: 1 },
  ])
})

test('a vote with a clear majority comes back sharp', async () => {
  splitMode = false
  const out: OrchReceipt[] = []
  const inputs: string[] = []
  h = await harness({
    reply,
    lead: {
      script: byTurn({
        1: async (t) =>
          void out.push(
            r(
              await t.call('orch.vote', {
                question: 'Which file?',
                options: ['src/a.ts', 'src/hooks.ts'],
                k: 5,
              }),
            ),
          ),
        2: async (t) => void inputs.push(t.input),
      }),
    },
  })
  const id = await h.create({ gatePolicy: 'none', helpers: HELPERS })
  await h.until(() => inputs.length === 1)
  expect(out[0]!.result).toMatchObject({ voteId: 'v1' })
  expect(h.orch.snapshot(id).orchestration.helpers!.votes[0]).toMatchObject({
    status: 'sharp',
    counts: [0, 5],
    choice: 1,
    share: 1,
  })
  expect(inputs[0]).toContain('vote_done v1: sharp: option 2 (1.00)')
  expect(inputs[0]).toContain('Vote v1 (Which file?): sharp → 2. src/hooks.ts')
  // The answers are tallied, not shown to the lead one by one.
  expect(inputs[0]).not.toContain('RESULT h1')
})

test('a split vote goes to the person when they chose that', async () => {
  splitMode = true
  h = await harness({
    reply,
    lead: {
      script: byTurn({
        1: async (t) =>
          void (await t.call('orch.vote', {
            question: 'Which agent?',
            options: ['builder', 'reviewer'],
            k: 4,
          })),
      }),
    },
  })
  const id = await h.create({ gatePolicy: 'none', helpers: { ...HELPERS, splitTo: 'person' } })
  await h.until(
    () => (h.orch.snapshot(id).orchestration.helpers!.votes[0]?.status ?? 'voting') !== 'voting',
  )
  splitMode = false
  const vote = h.orch.snapshot(id).orchestration.helpers!.votes[0]!
  expect(vote).toMatchObject({ status: 'split', counts: [2, 2], choice: null, inquiryId: 'q1' })
  const inquiry = h.orch.snapshot(id).orchestration.inquiries.find((q) => q.id === 'q1')!
  expect(inquiry.status).toBe('open')
  expect(inquiry.question).toContain('The helpers split on: Which agent?')
})

test('votes are off when the person approves every step, and need helpers and allowance', async () => {
  const out: OrchReceipt[] = []
  h = await harness({
    reply,
    lead: {
      script: byTurn({
        1: async (t) => {
          out.push(r(await t.call('orch.vote', { question: 'q', options: ['a', 'b'] })))
        },
      }),
    },
  })
  await h.create({ gatePolicy: 'every-step', helpers: HELPERS })
  await h.until(() => out.length === 1)
  expect(out[0]!.code).toBe('gated')
  await h.close()
  out.length = 0
  h = await harness({
    reply,
    lead: {
      script: byTurn({
        1: async (t) => {
          out.push(r(await t.call('orch.vote', { question: 'q', options: ['a', 'b'], k: 7 })))
        },
      }),
    },
  })
  await h.create({ gatePolicy: 'none', helpers: { ...HELPERS, maxSteps: 5 } })
  await h.until(() => out.length === 1)
  expect(out[0]!.code).toBe('helper_limit')
})

test('the lead cannot be a helper; a scan needs a folder', async () => {
  h = await harness()
  await expect(h.create({ helpers: { ...HELPERS, agentIds: ['lead'] } })).rejects.toThrow(/lead/)
  await expect(h.create({ helpers: { ...HELPERS, scan: true } })).rejects.toThrow(/folder/)
})

test('readChoice reads a number or the exact option', () => {
  const options = ['src/a.ts', 'src/hooks.ts', 'neither']
  expect(readChoice('2', options)).toBe(1)
  expect(readChoice('Option 3.', options)).toBe(2)
  expect(readChoice('src/hooks.ts', options)).toBe(1)
  expect(readChoice('9', options)).toBeNull()
  expect(readChoice('I am not sure', options)).toBeNull()
  // Several numbers: unusable rather than guessed.
  expect(readChoice('1. a 2. b', options)).toBeNull()
  expect(readChoice('between 1 and 2', options)).toBeNull()
})
