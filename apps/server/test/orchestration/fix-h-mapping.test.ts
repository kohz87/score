import type { OrchReceipt } from '@score/contract'
import { expect, test } from 'vitest'
import { byTurn } from '../../src/hermes/fake/fake-lead.ts'
import {
  A,
  B,
  detail,
  replaceBuilder,
  seedBuilder,
  startHarness,
  startup,
  status,
} from './fix-h-helpers.ts'
import { attemptOf } from './harness.ts'

test('fix-h 3: an agent replaced after Start and before the assignment is refused until the person remaps, then the lead continues', async () => {
  const receipts: OrchReceipt[] = []
  const h = await startHarness({
    lead: {
      script: byTurn({
        1: async (t) => {
          await t.call('orch.ask', { question: 'ready?' })
        },
        2: async (t) => {
          receipts.push(
            (await t.call('orch.assign', {
              agent: 'builder',
              instruction: 'first try',
            })) as OrchReceipt,
          )
        },
        3: async (t) => {
          receipts.push(
            (await t.call('orch.assign', {
              agent: 'builder',
              instruction: 'after remap',
            })) as OrchReceipt,
          )
        },
      }),
    },
  })
  seedBuilder()
  const id = await h.create({ gatePolicy: 'none' })
  await h.until(() => detail(id).inquiries.length === 1)
  expect(h.rows('SELECT incarnation FROM orc_agent_map WHERE agent_id = ?', 'builder')).toEqual([
    { incarnation: A },
  ])
  replaceBuilder()
  await h.orch.inquiryAnswer(id, 'q1', {
    answer: 'yes',
    expectedRevision: 1,
    orchestrationRevision: detail(id).revision,
  })
  await h.until(() => receipts.length === 1)
  expect(receipts[0]).toMatchObject({ status: 'refused', code: 'agent_changed' })
  expect(detail(id).stepsList).toHaveLength(0)
  expect(h.orch.summary(id).needsYou).toContainEqual({
    kind: 'remap',
    agentId: 'builder',
    role: 'agent',
    frozenIncarnation: A,
    currentIncarnation: B,
  })
  // A decision paired with the wrong incarnations is a conflict and changes nothing.
  await expect(
    h.orch.remap(id, {
      agentId: 'builder',
      frozenIncarnation: B,
      currentIncarnation: B,
      orchestrationRevision: detail(id).revision,
      acknowledge: true,
    }),
  ).rejects.toMatchObject({ status: 409 })
  await expect(
    h.orch.remap(id, {
      agentId: 'builder',
      frozenIncarnation: A,
      currentIncarnation: B,
      orchestrationRevision: detail(id).revision - 1,
      acknowledge: true,
    }),
  ).rejects.toMatchObject({ status: 409 })
  await h.orch.remap(id, {
    agentId: 'builder',
    frozenIncarnation: A,
    currentIncarnation: B,
    orchestrationRevision: detail(id).revision,
    acknowledge: true,
  })
  expect(h.orch.summary(id).needsYou.some((n) => n.kind === 'remap')).toBe(false)
  // The journal holds it, so a database that loses it is fenced; the honest one is not.
  expect(startup().check.fenced).toBe(false)
  await h.until(() => receipts.length === 2)
  expect(receipts[1]).toMatchObject({ status: 'ok' })
  await h.until(() => detail(id).stepsList[0]?.status === 'succeeded')
  h.db.sqlite.prepare("UPDATE orc_agent_map SET incarnation = ? WHERE agent_id = 'builder'").run(A)
  expect(startup().check.fenced).toBe(true)
})

test('fix-h 3: an agent replaced between the assignment and the send blocks the step and asks for a remap', async () => {
  const h = await startHarness({
    lead: {
      script: byTurn({
        1: async (t) => {
          await t.call('orch.assign', { agent: 'builder', instruction: 'x' })
        },
      }),
    },
  })
  seedBuilder()
  const id = await h.create({ gatePolicy: 'every-step' })
  await h.until(() => detail(id).gates.length === 1)
  replaceBuilder()
  await h.orch.gateDecision(id, 'g1', {
    decision: 'approve',
    expectedRevision: 1,
    orchestrationRevision: detail(id).revision,
  })
  await h.until(() => detail(id).stepsList[0]!.status === 'blocked')
  expect(attemptOf(h, id, 'step')).toHaveLength(0)
  expect(h.orch.summary(id).needsYou.map((n) => n.kind)).toContain('remap')
})

test('fix-h 3: a step whose incarnation is not the frozen mapping is blocked before the send, even when the agent is current', async () => {
  const h = await startHarness({
    lead: {
      script: byTurn({
        1: async (t) => {
          await t.call('orch.assign', { agent: 'builder', instruction: 'x' })
        },
      }),
    },
  })
  seedBuilder()
  const id = await h.create({ gatePolicy: 'every-step' })
  await h.until(() => detail(id).gates.length === 1)
  // Replaced and put back (A -> B -> A) while the person remapped to B: the step carries A, the mapping says B.
  h.db.sqlite.prepare("UPDATE orc_agent_map SET incarnation = ? WHERE agent_id = 'builder'").run(B)
  await h.orch.gateDecision(id, 'g1', {
    decision: 'approve',
    expectedRevision: 1,
    orchestrationRevision: detail(id).revision,
  })
  await h.until(() => detail(id).stepsList[0]!.status === 'blocked')
  expect(detail(id).stepsList[0]!.disposition).toContain('agent_changed')
  expect(attemptOf(h, id, 'step')).toHaveLength(0)
})

test('fix-h 3: a replaced lead pauses the run and the remap decision resumes it', async () => {
  const h = await startHarness({
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
  expect(h.orch.summary(id).needsYou).toContainEqual(
    expect.objectContaining({ kind: 'remap', agentId: 'lead', role: 'lead' }),
  )
  await h.orch.remap(id, {
    agentId: 'lead',
    frozenIncarnation: A,
    currentIncarnation: B,
    orchestrationRevision: detail(id).revision,
    acknowledge: true,
  })
  expect(h.rows('SELECT lead_incarnation FROM orchestrations WHERE id = ?', id)).toEqual([
    { lead_incarnation: B },
  ])
  await h.until(() => attemptOf(h, id, 'lead').length === 2)
  expect(status(id)).not.toBe('paused')
})
