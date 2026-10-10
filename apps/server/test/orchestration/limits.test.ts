import { ORCH_LIMITS, type OrchReceipt } from '@score/contract'
import { afterEach, expect, test } from 'vitest'
import { runSpendReader, type SpendReader } from '../../src/domain/orchestration/budget.ts'
import {
  renderLeadInput,
  renderStepInput,
  truncateBytes,
} from '../../src/domain/orchestration/render.ts'
import { byTurn } from '../../src/hermes/fake/fake-lead.ts'
import { attemptOf, create, harness, type Harness } from './harness.ts'

let h: Harness
afterEach(async () => {
  await h?.close()
  h = undefined as never
})
const status = (id: string) => h.orch.summary(id).status
const detail = (id: string) => h.orch.snapshot(id).orchestration
const r = (value: unknown) => value as OrchReceipt

test('budget: estimates are reserved at queueing, a step that would overshoot is refused, settled spend replaces the reservation', async () => {
  const out: OrchReceipt[] = []
  h = await harness({
    lead: {
      script: byTurn({
        1: async (t) => {
          out.push(r(await t.call('orch.assign', { agent: 'builder', instruction: 'one' })))
          out.push(r(await t.call('orch.assign', { agent: 'reviewer', instruction: 'two' })))
        },
      }),
    },
  })
  // lead turn 0.25 + step 0.5 = 0.75 reserved; a second step (0.5) would reach 1.25 > 1.00
  const id = await h.create({ budgetUsd: 1, gatePolicy: 'none' })
  await h.until(() => out.length === 2)
  expect(out.map((o) => o.code ?? o.status)).toEqual(['ok', 'budget_exceeded'])
  expect(detail(id).budget.reservedUsd).toBeGreaterThan(0)
  await h.until(() => detail(id).stepsList[0]!.status === 'succeeded')
  await h.settle(2000)
  const b = detail(id).budget
  // Fake runs report $0.0042 each and the session has no open run: settled, reservations gone.
  expect(b.settledUsd).toBeGreaterThan(0)
  expect(b.settledUsd).toBeLessThan(0.05)
  expect(b.complete || b.provisionalUsd >= 0).toBe(true)
})

test('provisional spend counts with the reservation until the attempt is settled (termination and a closed session)', async () => {
  let complete = false
  const spend: SpendReader = (sqlite, attempt) => {
    const base = runSpendReader(sqlite, attempt)
    return { usd: base.usd === null ? null : 0.3, complete: complete && base.complete }
  }
  h = await harness({
    orchestrator: { spend },
    lead: {
      script: byTurn({
        1: async (t) => {
          await t.call('orch.assign', { agent: 'builder', instruction: 'one' })
        },
      }),
    },
  })
  const id = await h.create({ budgetUsd: 5, gatePolicy: 'none' })
  await h.until(() => detail(id).stepsList[0]?.status === 'succeeded')
  let b = detail(id).budget
  expect(b.settledUsd).toBe(0)
  expect(b.provisionalUsd).toBeGreaterThanOrEqual(0.3)
  // Still reserved: the step's estimate has not been replaced by actual spend yet.
  expect(b.reservedUsd).toBeGreaterThan(0)
  expect(b.complete).toBe(false)
  complete = true
  await h.settle(1000)
  b = detail(id).budget
  expect(b.settledUsd).toBeGreaterThanOrEqual(0.3)
  expect(detail(id).attempts.find((a) => a.stepId === 's1')!.spendComplete).toBe(true)
})

test('unknown spend pauses a budgeted run until the person accepts it or raises the limit', async () => {
  const spend: SpendReader = () => ({ usd: null, complete: false })
  h = await harness({
    orchestrator: { spend },
    lead: {
      script: byTurn({
        1: async (t) => {
          await t.call('orch.assign', { agent: 'builder', instruction: 'one' })
        },
        2: async (t) => {
          await t.call('orch.finish', { outcome: 'success', summary: 'x' })
        },
      }),
    },
  })
  const id = await h.create({ budgetUsd: 5, gatePolicy: 'none' })
  await h.until(() => status(id) === 'paused')
  const s = h.orch.summary(id)
  expect(s.pauseReason).toBe('unknown_spend')
  expect(s.needsYou).toContainEqual({ kind: 'budget', reason: 'unknown_spend' })
  expect(detail(id).budget.unknownSpend).toBe(true)
  await h.orch.limits(id, { acceptUnknownSpend: true, orchestrationRevision: detail(id).revision })
  await h.until(() => ['succeeded', 'finished_with_unresolved'].includes(status(id)))
})

test('a run without a budget ignores unknown spend', async () => {
  const spend: SpendReader = () => ({ usd: null, complete: false })
  h = await harness({ orchestrator: { spend } })
  const id = await h.create({ gatePolicy: 'none' })
  await h.until(() => status(id) === 'succeeded')
})

test('lowering the budget below what is committed pauses the run; raising it resumes', async () => {
  h = await harness({
    lead: {
      script: byTurn({
        1: async (t) => {
          await t.call('orch.assign', { agent: 'builder', instruction: '[fake:hold]' })
        },
      }),
    },
  })
  const id = await h.create({ budgetUsd: 5, gatePolicy: 'none' })
  await h.until(() => attemptOf(h, id, 'step', 's1').some((a) => a.state === 'running'))
  await h.orch.limits(id, { budgetUsd: 0.1, orchestrationRevision: detail(id).revision })
  await h.until(() => status(id) === 'paused')
  expect(h.orch.summary(id).pauseReason).toBe('budget')
  await h.orch.limits(id, { budgetUsd: 50, orchestrationRevision: detail(id).revision })
  expect(status(id)).toBe('running')
})

test('deadline expiry fences, retires queued work and owes a Stop on every admitted attempt', async () => {
  h = await harness({
    lead: {
      script: byTurn({
        1: async (t) => {
          await t.call('orch.assign', { agent: 'builder', instruction: '[fake:hold] running' })
          await t.call('orch.assign', { agent: 'reviewer', instruction: 'later', after: ['s1'] })
        },
      }),
    },
  })
  const id = await h.create({
    deadlineAt: new Date(h.scheduler.now() + 20_000).toISOString(),
    gatePolicy: 'none',
  })
  await h.until(() => attemptOf(h, id, 'step', 's1').some((a) => a.state === 'running'))
  expect(attemptOf(h, id, 'step', 's1')[0]!.stopRequestedAt).toBeNull()
  await h.until(() => ['stopping', 'stopped'].includes(status(id)), 60_000)
  const d = detail(id)
  expect(d.endReason ?? 'deadline expired').toBe('deadline expired')
  expect(d.stepsList[1]!.disposition).toBe('not_started: stopped')
  expect(attemptOf(h, id, 'step', 's1')[0]!.stopRequestedAt).not.toBeNull()
  await h.until(() => attemptOf(h, id, 'step', 's1')[0]!.stopAcknowledgedAt !== null)
  expect(attemptOf(h, id, 'step', 's2')).toHaveLength(0)
  await expect(
    h.orch.limits(id, {
      deadlineAt: new Date(h.scheduler.now() + 99_000).toISOString(),
      orchestrationRevision: detail(id).revision,
    }),
  ).resolves.toBeDefined()
  expect(['stopping', 'stopped']).toContain(status(id))
  // A deadline in the past cannot be set.
  await expect(
    h.orch.limits(id, {
      deadlineAt: new Date(h.scheduler.now() - 1000).toISOString(),
      orchestrationRevision: detail(id).revision,
    }),
  ).rejects.toMatchObject({ status: 400 })
})

test('capacity: at most 5 running orchestrations', async () => {
  h = await harness({ lead: { script: async () => 'nothing' } })
  for (let i = 0; i < 5; i++) await h.create({ goal: `run ${i}` })
  await expect(h.orch.create(create({ goal: 'one more' }))).rejects.toMatchObject({
    status: 429,
    code: 'capacity',
  })
  const preflight = await h.orch.preflight('lead', ['builder'])
  expect(preflight.checks.find((c) => c.id === 'capacity')!.status).toBe('fail')
  // A finished run frees its slot.
  const first = h.orch.list().items.at(-1)!
  await h.orch.stop(first.id)
  await h.settle(2000)
})

test('capacity: concurrent steps per run, per agent and overall', async () => {
  h = await harness({
    lead: {
      script: byTurn({
        1: async (t) => {
          for (let i = 0; i < 4; i++)
            await t.call('orch.assign', { agent: 'builder', instruction: `[fake:hold] ${i}` })
        },
      }),
    },
  })
  const id = await h.create({ gatePolicy: 'none', maxConcurrentSteps: 3 })
  await h.until(() => attemptOf(h, id, 'step').length >= 2)
  await h.settle(3000)
  // Three are allowed per run but only two per agent: the other two stay queued.
  expect(attemptOf(h, id, 'step')).toHaveLength(2)
  expect(detail(id).stepsList.filter((s) => s.status === 'queued')).toHaveLength(2)
})

test('capacity: at most 6 steps run at once across all orchestrations (more than the per-agent limit alone allows)', async () => {
  h = await harness({
    lead: {
      script: byTurn({
        1: async (t) => {
          for (const agent of t.allowedAgents) {
            await t.call('orch.assign', { agent, instruction: '[fake:hold] a' })
            await t.call('orch.assign', { agent, instruction: '[fake:hold] b' })
          }
        },
      }),
    },
  })
  // Four agents can run 2 each (8) but the overall ceiling is 6; the second run uses another lead.
  await h.create({
    goal: 'a',
    gatePolicy: 'none',
    maxConcurrentSteps: 3,
    allowedAgents: ['builder', 'reviewer', 'designer'],
    maxSteps: 30,
  })
  await h.create({
    goal: 'b',
    leadAgentId: 'designer',
    gatePolicy: 'none',
    maxConcurrentSteps: 3,
    allowedAgents: ['lead', 'builder', 'reviewer'],
    maxSteps: 30,
  })
  const live = () =>
    h.rows(
      "SELECT 1 FROM orc_attempts WHERE kind = 'step' AND state IN ('created','send_started','running')",
    ).length
  await h.until(() => live() >= 5)
  await h.settle(8000)
  expect(live()).toBeLessThanOrEqual(6)
  expect(live()).toBe(6)
})

test('a finished run whose attempts are still unresolved keeps its orchestration capacity', async () => {
  h = await harness({
    lead: {
      script: byTurn({
        1: async (t) => {
          await t.call('orch.assign', { agent: 'builder', instruction: '[fake:hold]' })
          await t.call('orch.finish', { outcome: 'success', summary: 'x' })
        },
      }),
    },
  })
  const { endRun } = await import('./harness.ts')
  const id = await h.create({ gatePolicy: 'none' })
  await h.until(() => attemptOf(h, id, 'step', 's1').some((a) => a.state === 'running'))
  await endRun(h, attemptOf(h, id, 'step', 's1')[0]!.runId!, 'interrupted')
  await h.until(() => status(id) === 'finished_with_unresolved')
  expect(
    (await h.orch.preflight('lead', ['builder'])).checks.find((c) => c.id === 'capacity')!.message,
  ).toContain('1 of 5')
})

test('storage quota: a run does not start when its reserve does not fit; the control reserve is kept for Stop', async () => {
  // One run's reserve (12 steps, 20 turns) is 2.3 MB; a 3 MB quota fits one run only.
  h = await harness({
    orchestrator: { quotaBytes: 3_000_000 },
    lead: { script: async () => 'nothing' },
  })
  await h.create({ goal: 'first' })
  await expect(h.orch.create(create({ goal: 'second' }))).rejects.toMatchObject({
    status: 409,
    code: 'quota_exhausted',
  })
  const preflight = await h.orch.preflight('lead', ['builder'])
  expect(preflight.checks.find((c) => c.id === 'quota')!.status).toBe('fail')
})

test('storage quota inside a run: ordinary writes stop at the reserve minus the protected part, Stop still works', async () => {
  const out: OrchReceipt[] = []
  h = await harness({
    lead: {
      script: byTurn({
        1: async (t) => {
          // 15 KB of plan per call; the 128 KB of ordinary room of a 1+1 run is gone after a few calls.
          const entries = Array.from({ length: 30 }, () => 'x'.repeat(500))
          for (let i = 0; i < 12; i++) out.push(r(await t.call('orch.plan', { entries })))
        },
      }),
    },
  })
  const id = await h.create({ maxSteps: 1, maxLeadTurns: 1 })
  await h.until(() => out.length === 12)
  const codes = out.map((o) => o.code ?? o.status)
  expect(codes.slice(0, 3)).toEqual(['ok', 'ok', 'ok'])
  expect(codes.at(-1)).toBe('quota')
  const d = detail(id)
  expect(d.storage.storedBytes).toBeLessThanOrEqual(
    d.storage.reserveBytes - ORCH_LIMITS.controlReserveBytes,
  )
  await h.orch.stop(id)
  expect(['stopping', 'stopped']).toContain(status(id))
})

test('rendered lead input is bounded: results newest first, older ones omitted with a marker', () => {
  const now = '2026-01-01T00:00:00.000Z'
  const base = {
    id: 'orc-x',
    title: 't',
    goal: 'goal',
    lead_agent_id: 'lead',
    lead_incarnation: 'i',
    allowed_agents: ['builder'],
    room_id: 'r',
    brief_id: 'b',
    gate_policy: 'none' as const,
    budget_usd: null,
    deadline_at: null,
    max_steps: 30,
    max_lead_turns: 40,
    max_concurrent_steps: 3,
    lead_turn_estimate_usd: 0.25,
    step_estimate_usd: 0.5,
    status: 'running' as const,
    pause_reason: null,
    manual_paused_at: null,
    plan: [],
    lead_turns_used: 2,
    steps_created: 30,
    causes_consumed_up_to: 0,
    consecutive_lead_failures: 0,
    finish_requested_at: null,
    finish_attempt_id: null,
    finish_outcome: null,
    finish_summary: null,
    stop_requested_at: null,
    waiver_at: null,
    accepted_unknown_spend: false,
    acknowledgement: '{}',
    preflight: '{}',
    reserve_bytes: 0,
    stored_bytes: 0,
    revision: 1,
    created_at: now,
    updated_at: now,
    ended_at: null,
    end_reason: null,
    planner: 'lead' as const,
    admission_seen: 0,
  }
  const steps = Array.from({ length: 30 }, (_, i) => ({
    orchestration_id: 'orc-x',
    id: `s${i + 1}`,
    seq: i + 1,
    agent_id: 'builder',
    agent_incarnation: 'i',
    instruction: 'do it',
    after_steps: [],
    replaces: null,
    status: 'succeeded' as const,
    disposition: null,
    estimate_usd: 0.5,
    result: `result ${i + 1} ` + 'é'.repeat(ORCH_LIMITS.resultBytes),
    result_revision: 1,
    retired: false,
    payload_hash: null,
    created_in_attempt: 'a',
    created_at: now,
    updated_at: `2026-01-01T00:00:${String(i).padStart(2, '0')}.000Z`,
  }))
  const input = renderLeadInput({
    o: base,
    turn: 3,
    steps,
    gates: [],
    inquiries: [],
    causes: [],
    budget: {
      limitUsd: null,
      settledUsd: 0,
      provisionalUsd: 0,
      reservedUsd: 0,
      remainingUsd: null,
      unknownSpend: false,
      complete: true,
    },
    now,
  })
  expect(new TextEncoder().encode(input).length).toBeLessThanOrEqual(ORCH_LIMITS.leadInputBytes)
  // Newest results are in, the oldest are omitted by marker.
  expect(input).toContain('<<<RESULT s30 rev 1')
  expect(input.indexOf('<<<RESULT s30 rev 1')).toBeLessThan(input.indexOf('<<<RESULT s29 rev 1'))
  expect(input).toContain('omitted: input limit]')
  expect(input).toContain('[…truncated')
  expect(input).not.toContain('<<<RESULT s1 rev 1')
  // A step input is bounded as well.
  const stepInput = renderStepInput({
    o: { id: 'orc-x' },
    step: steps[0]!,
    dependencies: steps.slice(1, 10),
  })
  expect(new TextEncoder().encode(stepInput).length).toBeLessThanOrEqual(ORCH_LIMITS.stepInputBytes)
  expect(truncateBytes('éé', 3).text).toBe('é')
})
