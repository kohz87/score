import { afterEach, vi, describe, expect, test } from 'vitest'
import { byTurn } from '../../src/hermes/fake/fake-lead.ts'
import { workerHarness, type WorkerHarness } from '../helpers/worker-harness.ts'

// 7.7b-1 #5 (design §6): release is decided inside the journal's critical section by the executor's `authorise()`:
// the common admission rules, the phase guard, the prepared expiry, then part 2's checks. Every cause maps to real
// attempt and step states. Real systemd units are faked; the supervisor, socket and journal are real.

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 })

let h: WorkerHarness
afterEach(async () => {
  await h?.close()
  h = undefined as never
})

const oneStep = (instruction = '[fixture:basic] write hello') =>
  byTurn({
    1: async (t) => {
      await t.call('orch.assign', { agent: 'coder', instruction })
      return 'assigned'
    },
    2: async (t) => {
      await t.call('orch.finish', { outcome: 'success', summary: 'done' })
    },
  })
const attempt = () =>
  h.rows<Record<string, unknown>>("SELECT * FROM orc_attempts WHERE kind = 'step' ORDER BY n")[0]!
const step = () => h.rows<Record<string, unknown>>('SELECT * FROM orc_steps')[0]!
const gens = () =>
  h.rows<Record<string, unknown>>('SELECT * FROM orc_generations ORDER BY generation')
const launches = () =>
  h.rows<Record<string, unknown>>('SELECT * FROM coding_launches ORDER BY updated_at')
const journalKinds = (kind: string) => {
  const read = h.journal.readOwn()
  if (!read.ok) throw new Error(read.reason)
  return read.entries.filter((entry) => entry.kind === kind)
}
const nowIso = () => new Date().toISOString()

/** Changes the world once, while the unit of generation 1 is being armed (just before the release decision). */
function atArming(change: () => void): void {
  h.fake.hooks.afterStart = () => {
    h.fake.hooks.afterStart = undefined
    change()
  }
}
const sql = (text: string, ...args: (string | number | null)[]) =>
  h.db.sqlite.prepare(text).run(...args)

/** Waits until generation 1 is closed in the database (the closure is applied after the revoke tombstone is read). */
const closed = () => h.until(() => gens().some((g) => g['closed_cause'] !== null))

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
    h = await workerHarness({ lead: { script: oneStep() } })
    h.addAgent()
    atArming(() => sql("UPDATE orc_attempts SET agent_incarnation = 'older'"))
    const id = await h.create()
    await closed()
    await h.until(() => step()['status'] === 'blocked')
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

describe('the decision itself: every rule of authorise() on an attempt that is ready to be released', () => {
  interface Subject {
    orchestrationId: string
    attemptId: string
    generation: number
    launchId: string
    expiry: number
    policyId?: string
    executed?: number
  }
  type Decide = (sqlite: unknown, subject: Subject) => { allowed: boolean; cause?: string }
  let subject: Subject
  let hooks: { policy?: string; limits?: string }

  async function ready() {
    hooks = {}
    h = await workerHarness({
      // The run never finishes, so the orchestration stays `running` while the attempt is put back in a releasable state.
      lead: {
        script: byTurn({
          1: async (t) => {
            await t.call('orch.assign', {
              agent: 'coder',
              instruction: '[fixture:basic] write hello',
            })
            return 'assigned'
          },
          2: async () => 'waiting',
        }),
      },
      orchestrator: {
        releaseChecks: { policy: () => hooks.policy, limits: () => hooks.limits },
      },
    })
    h.addAgent()
    const id = await h.create({ deadlineAt: new Date(Date.now() + 3_600_000).toISOString() })
    await h.until(() => attempt()['state'] === 'terminated', 40_000)
    // Put the finished attempt back at the ordering point: running, its generation open, its handle recorded.
    sql(
      "UPDATE orc_attempts SET state = 'running', evidence = NULL, retired = 0, stop_requested_at = NULL",
    )
    sql('UPDATE orc_generations SET closed_cause = NULL, closed_at = NULL')
    subject = {
      orchestrationId: id,
      attemptId: attempt()['id'] as string,
      generation: 1,
      launchId: gens()[0]!['launch_id'] as string,
      expiry: Date.now() + 60_000,
      // What the runtime prepared the invocation from and what the journal counts (7.7b part 2).
      policyId: h.rows<{ policy_id: string }>('SELECT policy_id FROM orc_worker_policies')[0]!
        .policy_id,
      executed: 0,
    }
  }
  const decide = (over: Partial<Subject> = {}) =>
    (h.orch as unknown as { decideRelease: Decide }).decideRelease(h.db.sqlite, {
      ...subject,
      ...over,
    })
  /** Applies a change, asks, and takes the change back. */
  function under(change: string, ...args: (string | number | null)[]) {
    h.db.sqlite.exec('BEGIN')
    try {
      h.db.sqlite.prepare(change).run(...args)
      return decide()
    } finally {
      h.db.sqlite.exec('ROLLBACK')
    }
  }

  test('a clean attempt is allowed, and each rule says no with its own cause', async () => {
    await ready()
    expect(decide()).toEqual({ allowed: true })
    const no = (cause: string) => ({ allowed: false, cause })
    expect(under('UPDATE orc_attempts SET retired = 1')).toEqual(no('retired'))
    expect(under('UPDATE orc_attempts SET stop_requested_at = ?', nowIso())).toEqual(
      no('owed_stop'),
    )
    expect(under("UPDATE orchestrations SET status = 'stopped'")).toEqual(no('cancel'))
    expect(under("UPDATE orchestrations SET status = 'stopping'")).toEqual(no('stop'))
    expect(under("UPDATE orchestrations SET status = 'finishing'")).toEqual(no('stop'))
    expect(under('UPDATE orc_steps SET after_steps = \'["s9"]\'')).toEqual(no('inputs_withdrawn'))
    expect(
      under('UPDATE orchestrations SET deadline_at = ?', new Date(Date.now() - 1).toISOString()),
    ).toEqual(no('deadline'))
    expect(under("UPDATE orchestrations SET status = 'paused'")).toEqual(no('paused'))
    expect(under('UPDATE orchestrations SET manual_paused_at = ?', nowIso())).toEqual(no('paused'))
    expect(under("UPDATE orc_global SET frozen_reason = 'lost the journal' WHERE id = 1")).toEqual(
      no('frozen'),
    )
    expect(under("UPDATE orc_global SET fenced = 1, reason = 'x' WHERE id = 1")).toEqual(
      no('fenced'),
    )
    expect(under('UPDATE team_state SET paused_at = ? WHERE id = 1', nowIso())).toEqual(no('hold'))
    expect(
      under("INSERT INTO agent_pauses (agent_id, paused_at) VALUES ('coder', ?)", nowIso()),
    ).toEqual(no('hold'))
    expect(under("UPDATE orc_attempts SET agent_incarnation = 'older'")).toEqual(
      no('agent_changed'),
    )
    expect(under('UPDATE orchestrations SET budget_usd = 0.01')).toEqual(no('budget'))
    // Unknown cost: a dollar budget is set, a finished attempt reported none, and nobody accepted that.
    h.db.sqlite.exec('BEGIN')
    try {
      h.db.sqlite.exec('UPDATE orchestrations SET budget_usd = 1000, accepted_unknown_spend = 0')
      h.db.sqlite.exec(
        "UPDATE orc_attempts SET state = 'terminated', spend_usd = NULL, settled = 0 WHERE kind = 'lead'",
      )
      expect(decide()).toEqual(no('unknown_cost'))
    } finally {
      h.db.sqlite.exec('ROLLBACK')
    }
    // The prepared expiry may not outlive the deadline as it stands now.
    expect(
      under(
        'UPDATE orchestrations SET deadline_at = ?',
        new Date(Date.now() + 30_000).toISOString(),
      ),
    ).toEqual(no('deadline_changed'))
  })

  test('the phase guard: only this generation, this launch, an open generation and a live attempt may release', async () => {
    await ready()
    const no = { allowed: false, cause: 'retired' }
    expect(decide({ generation: 2 })).toEqual(no)
    expect(decide({ launchId: 'someone-elses' })).toEqual(no)
    expect(decide({ attemptId: 'unknown-attempt' })).toEqual(no)
    expect(under("UPDATE orc_generations SET closed_cause = 'paused'")).toEqual(no)
    for (const state of ['created', 'terminated', 'unknown', 'refused', 'abandoned'])
      expect(under('UPDATE orc_attempts SET state = ?', state)).toEqual(no)
    // A handle that is not this generation's has no business releasing it.
    expect(under("UPDATE orc_attempts SET run_id = 'another-run' WHERE kind = 'step'")).toEqual(no)
    // `send_started` (no handle yet) is a valid phase; so is `running`.
    expect(under("UPDATE orc_attempts SET state = 'send_started', run_id = NULL")).toEqual({
      allowed: true,
    })
  })

  test('part 2’s checks run after the common rules and only when those allow', async () => {
    await ready()
    hooks.policy = 'agent_changed'
    expect(decide()).toEqual({ allowed: false, cause: 'agent_changed' })
    hooks = { limits: 'limit' }
    expect(decide()).toEqual({ allowed: false, cause: 'limit' })
    hooks = { policy: 'agent_changed', limits: 'limit' }
    // The policy is asked first; the limit only if the policy allows.
    expect(decide()).toEqual({ allowed: false, cause: 'agent_changed' })
    // A common rule wins over the hooks: a retired attempt is `retired` whatever the hooks say.
    expect(under('UPDATE orc_attempts SET retired = 1')).toEqual({
      allowed: false,
      cause: 'retired',
    })
  })
})
