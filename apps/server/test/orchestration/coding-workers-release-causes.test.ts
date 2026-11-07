import { describe, expect, test } from 'vitest'
import { byTurn } from '../../src/hermes/fake/fake-lead.ts'
import { workerHarness, type WorkerHarness } from '../helpers/worker-harness.ts'
import {
  attempt,
  atArming,
  closed,
  gens,
  journalKinds,
  launches,
  nowIso,
  oneStep,
  sql,
  step,
  useWorkerHarness,
} from './coding-workers-helpers.ts'

// 7.7b-1 #5 (design §6): release is decided inside the journal's critical section by the executor's `authorise()`:
// the common admission rules, the phase guard, the prepared expiry, then part 2's checks. Every cause maps to real
// attempt and step states. Real systemd units are faked; the supervisor, socket and journal are real.

let h: WorkerHarness
useWorkerHarness(
  () => h,
  () => {
    h = undefined as never
  },
)

/** Assigns one step and then only waits: it never finishes the run, so a blocked step keeps its suspended attempt. */
const assignOnly = byTurn({
  1: async (t) => {
    await t.call('orch.assign', { agent: 'coder', instruction: '[fixture:basic] write hello' })
    return 'assigned'
  },
  2: async () => 'waiting',
  3: async () => 'waiting',
  4: async () => 'waiting',
})

describe('hold causes: generation 1 is closed, the attempt is sendable again, nothing is counted', () => {
  const cases: [string, string, () => void][] = [
    [
      'paused',
      'paused',
      () => sql("UPDATE orchestrations SET manual_paused_at = ?, status = 'paused'", nowIso()),
    ],
    [
      'hold',
      'hold (team)',
      () => sql('UPDATE team_state SET paused_at = ? WHERE id = 1', nowIso()),
    ],
    [
      'hold',
      'hold (agent)',
      () => sql("INSERT INTO agent_pauses (agent_id, paused_at) VALUES ('coder', ?)", nowIso()),
    ],
    [
      'fenced',
      'fenced',
      () => sql("UPDATE orc_global SET fenced = 1, reason = 'test' WHERE id = 1"),
    ],
  ]
  test.each(cases)('%s (%s)', async (cause, _name, change) => {
    h = await workerHarness({ lead: { script: oneStep() } })
    h.addAgent()
    atArming(change)
    const id = await h.create()
    await closed()
    expect(gens()[0]).toMatchObject({ generation: 1, closed_cause: cause })
    expect(launches()[0]).toMatchObject({ revoked: 1, may_have_executed: 0, revoke_cause: cause })
    expect(journalKinds('send_closed')).toMatchObject([{ generation: 1, cause }])
    expect(journalKinds('send_refused')).toHaveLength(0)
    expect(attempt()).toMatchObject({ refused_total: 0, refused_streak: 0, suspended: 0 })
    // Nothing started the CLI, and the step is still waiting its turn.
    expect(h.cliCalls()).toHaveLength(0)
    expect(step()['status']).toBe('admitted')
    // The hold lifts; the next pump sends generation 2, which runs (never `unknown`).
    sql("UPDATE orchestrations SET manual_paused_at = NULL, status = 'running'")
    sql('UPDATE team_state SET paused_at = NULL WHERE id = 1')
    sql('DELETE FROM agent_pauses')
    sql('UPDATE orc_global SET fenced = 0, reason = NULL WHERE id = 1')
    await h.orch.admissionChanged()
    await h.until(() => h.orch.summary(id).status === 'succeeded', 40_000)
    expect(gens()).toHaveLength(2)
    expect(attempt()).toMatchObject({ state: 'terminated', evidence: 'completed' })
    expect(h.cliCalls()).toHaveLength(1)
    expect(h.errors).toEqual([])
  })

  test('deadline_changed: a deadline that moves earlier while arming is caught at release; the next spec is cut to it', async () => {
    const deadline = new Date(Date.now() + 10 * 60_000).toISOString()
    h = await workerHarness({ lead: { script: oneStep() }, maxTurnMs: 5 * 60_000 })
    h.addAgent()
    const id = await h.create({ deadlineAt: deadline })
    await h.until(() => attempt() !== undefined)
    const earlier = Date.now() + 2 * 60_000
    atArming(() =>
      sql('UPDATE orchestrations SET deadline_at = ?', new Date(earlier).toISOString()),
    )
    await closed()
    expect(gens()[0]).toMatchObject({ closed_cause: 'deadline_changed' })
    await h.until(() => h.orch.summary(id).status === 'succeeded', 40_000)
    // Generation 1 was prepared for now + 5 minutes; generation 2's expiry is the new deadline, not release + 5 minutes.
    const [first, second] = launches()
    expect(Number(first!['deadline_at'])).toBeGreaterThan(earlier)
    expect(Number(second!['deadline_at'])).toBe(earlier)
  })

  test('the part-2 seam: the hook is consulted after the common rules, at the ordering point, and its cause is recorded', async () => {
    const seen: { generation: number; launchId: string; expiry: number }[] = []
    h = await workerHarness({
      lead: { script: oneStep() },
      orchestrator: {
        releaseChecks: {
          policy: (_sqlite, subject) => {
            seen.push({
              generation: subject.generation,
              launchId: subject.launchId,
              expiry: subject.expiry,
            })
            return subject.generation === 1 ? 'hold' : undefined
          },
        },
      },
    })
    h.addAgent()
    const id = await h.create()
    await h.until(() => h.orch.summary(id).status === 'succeeded', 40_000)
    expect(seen.map((s) => s.generation)).toEqual([1, 2])
    expect(seen[0]!.launchId).toBe(gens()[0]!['launch_id'])
    expect(seen[0]!.expiry).toBeGreaterThan(Date.now() - 60_000)
    expect(gens()[0]).toMatchObject({ closed_cause: 'hold' })
    expect(launches()[0]).toMatchObject({ revoke_cause: 'hold', revoked: 1 })
  })
})

describe('budget and unknown cost: the run pauses with today’s reason, the attempt waits', () => {
  test('budget', async () => {
    h = await workerHarness({ lead: { script: oneStep() } })
    h.addAgent()
    atArming(() => sql('UPDATE orchestrations SET budget_usd = 0.01'))
    const id = await h.create({ budgetUsd: 5 })
    await closed()
    await h.until(() => h.orch.summary(id).status === 'paused')
    // The executor's own admission pass may notice the budget first and pause the run, which then reads as `paused` at
    // the release; either way the run is paused for the budget and the launch never ran.
    expect(['budget', 'paused']).toContain(gens()[0]!['closed_cause'])
    expect(h.orch.summary(id)).toMatchObject({ status: 'paused', pauseReason: 'budget' })
    expect(attempt()).toMatchObject({ state: 'created', refused_total: 0 })
    expect(step()['status']).toBe('admitted')
  })

  test('unknown_cost (injected by the part-2 seam)', async () => {
    let cause: string | undefined = 'unknown_cost'
    h = await workerHarness({
      lead: { script: oneStep() },
      orchestrator: { releaseChecks: { limits: () => cause } },
    })
    h.addAgent()
    const id = await h.create()
    await closed()
    await h.until(() => h.orch.summary(id).status === 'paused')
    expect(h.orch.summary(id)).toMatchObject({ status: 'paused', pauseReason: 'unknown_spend' })
    expect(gens()).toHaveLength(1)
    expect(attempt()).toMatchObject({ state: 'created', refused_total: 0 })
    cause = undefined
  })
})

describe('terminal causes: the attempt ends, the step is cancelled, a proven no-launch costs nothing', () => {
  const cases: [string, () => void][] = [
    ['retired', () => sql('UPDATE orc_attempts SET retired = 1')],
    // The owed Stop is also delivered to the runtime, whose own `stop` can win the race; both are terminal causes.
    ['owed_stop|stop', () => sql('UPDATE orc_attempts SET stop_requested_at = ?', nowIso())],
    ['stop', () => sql("UPDATE orchestrations SET status = 'stopping'")],
  ]
  test.each(cases)('%s', async (cause, change) => {
    h = await workerHarness({ lead: { script: oneStep() } })
    h.addAgent()
    atArming(change)
    await h.create({ deadlineAt: new Date(Date.now() + 3_600_000).toISOString() })
    await closed()
    await h.until(() => attempt()['state'] === 'terminated')
    const accepted = cause.split('|')
    expect(accepted).toContain(gens()[0]!['closed_cause'])
    expect(launches()[0]).toMatchObject({ revoked: 1, may_have_executed: 0 })
    expect(accepted).toContain(launches()[0]!['revoke_cause'])
    // Known-zero spend: a proven no-launch is settled at once, with nothing reserved.
    expect(attempt()).toMatchObject({
      state: 'terminated',
      evidence: null,
      spend_usd: 0,
      spend_complete: 1,
      settled: 1,
      reserved_usd: 0,
      refused_total: 0,
    })
    expect(step()).toMatchObject({ status: 'cancelled' })
    expect(accepted).toContain(step()['disposition'])
    expect(journalKinds('send_closed')).toHaveLength(1)
    expect(h.cliCalls()).toHaveLength(0)
  })
})

describe('terminal cause: deadline', () => {
  // The orchestration's own deadline flow (settle, after any transaction that touches the run) stops the run as soon as
  // its clock passes the deadline, and its Stop can reach the runtime before the release decision looks. So the
  // deadline is passed only for the decision itself: its clock is read one hour late, once, synchronously, while the
  // flow and everything else keep the real time. No race, nothing widened.
  test('a deadline already past at the ordering point revokes the launch with cause deadline', async () => {
    h = await workerHarness({ lead: { script: oneStep() } })
    h.addAgent()
    const orch = h.orch as unknown as {
      decideRelease(sqlite: unknown, subject: unknown): unknown
      clock: () => number
    }
    const decide = orch.decideRelease.bind(orch)
    const realClock = orch.clock
    orch.decideRelease = (sqlite, subject) => {
      orch.clock = () => realClock() + 2 * 3_600_000
      try {
        return decide(sqlite, subject)
      } finally {
        orch.clock = realClock
      }
    }
    await h.create({ deadlineAt: new Date(Date.now() + 3_600_000).toISOString() })
    await closed()
    await h.until(() => attempt()['state'] === 'terminated')
    expect(gens()[0]).toMatchObject({ closed_cause: 'deadline' })
    expect(launches()[0]).toMatchObject({
      revoked: 1,
      may_have_executed: 0,
      revoke_cause: 'deadline',
    })
    expect(attempt()).toMatchObject({ state: 'terminated', evidence: null, settled: 1 })
    expect(step()).toMatchObject({ status: 'cancelled', disposition: 'deadline' })
    expect(journalKinds('send_closed')).toHaveLength(1)
    expect(h.cliCalls()).toHaveLength(0)
  })
})

describe('agent_changed and limit: the step is blocked and the attempt is suspended', () => {
  test('agent_changed: the agent’s incarnation moved while the launch was arming', async () => {
    // F1 #8: blocking the step wakes the lead, and a lead that finishes on its second turn legitimately refuses the
    // suspended attempt ("not dispatched: run finishing"). This lead only waits, and the assertions follow an idle executor.
    h = await workerHarness({ lead: { script: assignOnly } })
    h.addAgent()
    atArming(() => sql("UPDATE orc_attempts SET agent_incarnation = 'older'"))
    const id = await h.create()
    await closed()
    await h.until(() => step()['status'] === 'blocked')
    await h.orch.idle()
    expect(gens()[0]).toMatchObject({ closed_cause: 'agent_changed' })
    expect(step()).toMatchObject({ status: 'blocked', disposition: 'agent_changed' })
    expect(attempt()).toMatchObject({ state: 'created', suspended: 1, refused_total: 0 })
    // One attempt per step: no replacement attempt appears, and nothing is dispatched for the suspended one.
    await h.orch.admissionChanged()
    await h.orch.idle()
    expect(h.rows("SELECT id FROM orc_attempts WHERE kind = 'step'")).toHaveLength(1)
    expect(gens()).toHaveLength(1)
    expect(h.orch.summary(id).status).not.toBe('failed')
  })

  test('limit (the part-2 seam): blocked coding_limit, suspended, and the suspended attempt frees its concurrency slot', async () => {
    h = await workerHarness({
      lead: {
        script: byTurn({
          1: async (t) => {
            await t.call('orch.assign', { agent: 'coder', instruction: '[fixture:basic] one' })
            await t.call('orch.assign', { agent: 'second', instruction: '[fixture:basic] two' })
            return 'assigned'
          },
          2: async (t) => {
            // Finish only once nothing is waiting any more: the blocked step is the one the lead can't wait for.
            if (t.steps.some((s) => ['pending_gate', 'queued', 'admitted'].includes(s.status)))
              return 'waiting'
            await t.call('orch.finish', { outcome: 'partial', summary: 'one blocked' })
          },
          3: async (t) => {
            await t.call('orch.finish', { outcome: 'partial', summary: 'one blocked' })
          },
        }),
      },
      orchestrator: {
        releaseChecks: {
          limits: (sqlite, subject) =>
            (
              sqlite
                .prepare('SELECT agent_id FROM orc_attempts WHERE id = ?')
                .get(subject.attemptId) as {
                agent_id: string
              }
            ).agent_id === 'coder'
              ? 'limit'
              : undefined,
        },
      },
    })
    h.addAgent('coder')
    h.addAgent('second', 'codex')
    // Concurrency 1: the second step can only start because the first one's suspended attempt holds no slot.
    const id = await h.create({ allowedAgents: ['coder', 'second'], maxConcurrentSteps: 1 })
    await h.until(() => h.orch.summary(id).status === 'succeeded', 40_000)
    const steps = h.rows<Record<string, unknown>>('SELECT * FROM orc_steps ORDER BY seq')
    expect(steps[0]).toMatchObject({ status: 'blocked', disposition: 'coding_limit' })
    expect(steps[1]).toMatchObject({ status: 'succeeded' })
    expect(
      h
        .rows<{ agent_id: string; suspended: number }>(
          "SELECT agent_id, suspended FROM orc_attempts WHERE kind = 'step' ORDER BY n, agent_id",
        )
        .find((a) => a.agent_id === 'coder'),
    ).toMatchObject({ suspended: 1 })
  })
})

describe('frozen home', () => {
  test('a freeze at release revokes the launch (frozen); the executor writes nothing until reset-history', async () => {
    h = await workerHarness({ lead: { script: oneStep() } })
    h.addAgent()
    atArming(() => h.fence.freeze('test freeze'))
    await h.create()
    await h.until(() => launches().some((l) => l['revoke_cause'] === 'frozen'))
    await h.orch.admissionChanged()
    await h.orch.idle()
    // No closure, no new generation: the frozen home waits for the person.
    expect(journalKinds('send_closed')).toHaveLength(0)
    expect(gens()).toHaveLength(1)
    expect(gens()[0]!['closed_cause']).toBeNull()
  })
})
