import { afterEach, vi, describe, expect, test } from 'vitest'
import { byTurn } from '../../src/hermes/fake/fake-lead.ts'
import { workerHarness, type WorkerHarness } from '../helpers/worker-harness.ts'

// 7.7b-2 #0 (design §6): `beginSend` and the release decision ask ONE admission function. Each rule is exercised at
// both real boundaries with the same database change: before the send (nothing may be dispatched) and at the release
// ordering point (the launch is revoked with the rule's cause). Changing a rule in `admissionDenial` changes both.

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 })

let h: WorkerHarness
afterEach(async () => {
  await h?.close()
  h = undefined as never
})

const sql = (text: string, ...args: (string | number | null)[]) =>
  h.db.sqlite.prepare(text).run(...args)
const nowIso = () => new Date().toISOString()
const gens = () => h.rows<Record<string, unknown>>('SELECT * FROM orc_generations')

const rules: { cause: string; apply: () => void; lift: () => void }[] = [
  {
    cause: 'hold',
    apply: () => sql('UPDATE team_state SET paused_at = ? WHERE id = 1', nowIso()),
    lift: () => sql('UPDATE team_state SET paused_at = NULL WHERE id = 1'),
  },
  {
    cause: 'hold',
    apply: () =>
      sql("INSERT INTO agent_pauses (agent_id, paused_at) VALUES ('coder', ?)", nowIso()),
    lift: () => sql('DELETE FROM agent_pauses'),
  },
  {
    cause: 'fenced',
    apply: () => sql("UPDATE orc_global SET fenced = 1, reason = 'test' WHERE id = 1"),
    lift: () => sql('UPDATE orc_global SET fenced = 0, reason = NULL WHERE id = 1'),
  },
  {
    cause: 'paused',
    apply: () => sql('UPDATE orchestrations SET manual_paused_at = ?', nowIso()),
    lift: () => sql('UPDATE orchestrations SET manual_paused_at = NULL'),
  },
]

describe.each(rules)('rule $cause', ({ cause, apply, lift }) => {
  const nth = rules.findIndex((r) => r.apply === apply)
  test(`${nth}: denied before the send`, async () => {
    h = await workerHarness({
      lead: {
        script: byTurn({
          1: async (t) => {
            await t.call('orch.assign', { agent: 'coder', instruction: '[fixture:basic] hello' })
            return 'assigned'
          },
          2: async (t) => {
            await t.call('orch.finish', { outcome: 'success', summary: 'done' })
          },
        }),
      },
    })
    h.addAgent()
    // The step is admitted; the rule changes between that admission and the send (the real ordering the send re-checks).
    const orch = h.orch as unknown as { dispatch(id: string): Promise<boolean> }
    const dispatch = orch.dispatch.bind(orch)
    let changed = false
    orch.dispatch = (attemptId) => {
      const kind = h.rows<{ kind: string }>(
        'SELECT kind FROM orc_attempts WHERE id = ?',
        attemptId,
      )[0]
      if (kind?.kind === 'step' && !changed) {
        changed = true
        apply()
      }
      return dispatch(attemptId)
    }
    const id = await h.create()
    await h.until(() => changed)
    await new Promise((resolve) => setTimeout(resolve, 700))
    expect(gens()).toHaveLength(0)
    expect(h.cliCalls()).toHaveLength(0)
    lift()
    await h.orch.admissionChanged()
    await h.until(() => h.orch.summary(id).status === 'succeeded', 40_000)
    expect(gens()).toHaveLength(1)
  })

  test(`${nth}: denied at the release ordering point, with the rule's cause`, async () => {
    h = await workerHarness({
      lead: {
        script: byTurn({
          1: async (t) => {
            await t.call('orch.assign', { agent: 'coder', instruction: '[fixture:basic] hello' })
            return 'assigned'
          },
          2: async (t) => {
            await t.call('orch.finish', { outcome: 'success', summary: 'done' })
          },
        }),
      },
    })
    h.addAgent()
    h.fake.hooks.afterStart = () => {
      h.fake.hooks.afterStart = undefined
      apply()
    }
    await h.create()
    await h.until(() => gens().some((g) => g['closed_cause'] !== null))
    expect(gens()[0]).toMatchObject({ closed_cause: cause })
    expect(h.cliCalls()).toHaveLength(0)
  })
})
