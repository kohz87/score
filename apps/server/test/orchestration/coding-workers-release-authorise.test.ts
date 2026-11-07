import { describe, expect, test } from 'vitest'
import { byTurn } from '../../src/hermes/fake/fake-lead.ts'
import { workerHarness, type WorkerHarness } from '../helpers/worker-harness.ts'
import { attempt, gens, nowIso, sql, useWorkerHarness } from './coding-workers-helpers.ts'

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
      // The run never finishes (turn 2 only waits); the executor may still pause it as having no wake source.
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
    // The run is `running` here by construction, not by luck: once the step ended, the executor may have found nothing
    // to wake the lead for and paused the run itself (`no_wake_source`), whenever its pump got to it. Put it back in the
    // same synchronous stretch as the rest, so that no pump can run between this and the decisions below.
    sql(
      "UPDATE orchestrations SET status = 'running', pause_reason = NULL, manual_paused_at = NULL",
    )
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
