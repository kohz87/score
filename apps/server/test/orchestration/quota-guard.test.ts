import type { CodingQuota } from '@score/contract'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { quotaCheck, type QuotaSource } from '../../src/domain/orchestration/quota-guard.ts'
import type { LeadScript } from '../../src/hermes/fake/fake-lead.ts'
import { insertCodingAgent, saveCodingQuota } from '../../src/runtimes/coding/store.ts'
import { workerHarness, type WorkerHarness } from '../helpers/worker-harness.ts'

// PLAN 8.6 (decision 91): a coding agent below its quota floor gets no new steps. The lead is refused with the reason (or
// holds the step with ifQuotaLow: ask_owner), a step queued earlier is held with a cause for the lead, and the person's
// three answers decide. Missing, unknown or expired readings never block; running steps are never touched.

vi.setConfig({ testTimeout: 90_000, hookTimeout: 30_000 })

let h: WorkerHarness
afterEach(async () => {
  await h?.close()
  h = undefined as never
})

const inMs = (ms: number): string => new Date(Date.now() + ms).toISOString()
const low = (agentId: string, resetsAt = inMs(3 * 3_600_000), usedPercent = 94): void =>
  saveCodingQuota(h.db.sqlite, agentId, {
    runtime: 'claude-code',
    seenAt: new Date().toISOString(),
    windows: [{ name: '5 hours', group: null, usedPercent, resetsAt }],
    source: 'turn',
  })
const steps = () =>
  h.rows<{ id: string; status: string; disposition: string | null; agent_id: string }>(
    'SELECT id, status, disposition, agent_id FROM orc_steps ORDER BY seq',
  )
const history = (kind: string) =>
  h.rows<{ detail: string }>('SELECT detail FROM orc_history WHERE kind = ?', kind)
const revision = (id: string) => h.orch.summary(id).revision
const holdState = () => h.rows<{ state: string }>('SELECT state FROM orc_quota_holds')[0]?.state

/** Assigns one step to `agent` (with the given extra arguments), remembers the receipt, waits, then finishes. */
function assignOnce(
  agent: string,
  extra: Record<string, unknown>,
  receipts: unknown[],
  then?: { agent: string; extra?: Record<string, unknown> },
): LeadScript {
  return async (t) => {
    if (t.steps.length === 0) {
      const first = await t.call('orch.assign', {
        agent,
        instruction: '[fixture:basic] write hello',
        ...extra,
      })
      receipts.push(first)
      if (first.status === 'refused' && then) {
        const second = await t.call('orch.assign', {
          agent: then.agent,
          instruction: '[fixture:basic] write hello',
          ...then.extra,
        })
        receipts.push(second)
      }
      return 'assigned'
    }
    if (t.steps.every((s) => s.status === 'succeeded')) {
      await t.call('orch.finish', { outcome: 'success', summary: 'done' })
      return 'done'
    }
    return 'waiting'
  }
}

describe('at assignment', () => {
  test('a coding agent below its floor is refused with the reason and who else has room; the lead picks another', async () => {
    const receipts: { status: string; code?: string; result?: Record<string, unknown> }[] = []
    h = await workerHarness({
      lead: { script: assignOnce('coder', {}, receipts, { agent: 'second' }) },
    })
    h.addAgent('coder')
    h.addAgent('second')
    low('coder')
    const id = await h.create({ allowedAgents: ['coder', 'second'] })
    await h.until(() => h.orch.summary(id).status === 'succeeded', 60_000)
    expect(receipts[0]).toMatchObject({
      status: 'refused',
      code: 'quota_low',
      result: { agent: 'coder', window: '5 hours', leftPercent: 6, otherAgents: ['second'] },
    })
    expect(receipts[1]).toMatchObject({ status: 'ok' })
    expect(steps()).toMatchObject([{ agent_id: 'second', status: 'succeeded' }])
    expect(h.errors).toEqual([])
  })

  test('ifQuotaLow: ask_owner creates the step held, and nothing starts until the person answers', async () => {
    const receipts: { status: string }[] = []
    h = await workerHarness({
      lead: {
        script: assignOnce('coder', {}, receipts, {
          agent: 'coder',
          extra: { ifQuotaLow: 'ask_owner' },
        }),
      },
    })
    h.addAgent('coder')
    low('coder')
    const id = await h.create()
    await h.until(() => holdState() === 'held')
    expect(steps()).toMatchObject([{ status: 'queued', disposition: 'quota_low' }])
    expect(h.orch.summary(id).needsYou).toContainEqual(
      expect.objectContaining({
        kind: 'quota_low',
        stepId: 's1',
        agentId: 'coder',
        leftPercent: 6,
      }),
    )
    expect(h.orch.snapshot(id).orchestration.stepsList[0]?.quotaHold).toMatchObject({
      state: 'held',
      window: '5 hours',
    })
    await h.orch.idle()
    expect(h.cliCalls()).toHaveLength(0)
    expect(history('quota_held')).toHaveLength(1)
    // "Use it anyway" admits this step once.
    await h.orch.quotaDecision(id, 's1', {
      answer: 'use_anyway',
      orchestrationRevision: revision(id),
    })
    await h.until(() => h.orch.summary(id).status === 'succeeded', 60_000)
    expect(h.cliCalls()).toHaveLength(1)
    expect(holdState()).toBe('override')
    expect(history('quota_override')).toHaveLength(1)
    expect(h.errors).toEqual([])
  })

  test('a missing reading, an unknown share, a reset that has passed and floor 0 never block', async () => {
    const receipts: { status: string }[] = []
    h = await workerHarness({
      lead: { script: assignOnce('coder', {}, receipts) },
    })
    h.addAgent('coder')
    // A reading whose reset time has passed counts as reset.
    low('coder', inMs(-60_000), 99)
    const id = await h.create()
    await h.until(() => h.orch.summary(id).status === 'succeeded', 60_000)
    expect(receipts[0]).toMatchObject({ status: 'ok' })
    expect(holdState()).toBeUndefined()
  })

  test('the run’s own floor overrides the agent’s, and 0 switches the guard off', async () => {
    const receipts: { status: string }[] = []
    h = await workerHarness({ lead: { script: assignOnce('coder', {}, receipts) } })
    h.addAgent('coder')
    low('coder') // 6% left: under the agent's 10, not under a floor of 5
    const id = await h.create({ quotaFloorPercent: 5 })
    await h.until(() => h.orch.summary(id).status === 'succeeded', 60_000)
    expect(receipts[0]).toMatchObject({ status: 'ok' })
    expect(h.orch.snapshot(id).orchestration.quotaFloorPercent).toBe(5)
  })
})

describe('at admission', () => {
  test('a step queued earlier whose agent dropped below its floor is held and the lead is told', async () => {
    const script: LeadScript = async (t) => {
      if (t.steps.length === 0) {
        const a = await t.call('orch.assign', {
          agent: 'coder',
          instruction: '[fixture:basic] one',
        })
        const id = String((a as { result?: { stepId?: string } }).result?.stepId)
        await t.call('orch.assign', {
          agent: 'second',
          instruction: '[fixture:basic] two',
          after: [id],
        })
        // The second agent's quota runs low after the step was queued.
        low('second')
        return 'assigned'
      }
      return t.steps.every((s) => s.status === 'succeeded') ? 'done' : 'waiting'
    }
    h = await workerHarness({ lead: { script } })
    h.addAgent('coder')
    h.addAgent('second')
    const id = await h.create({ allowedAgents: ['coder', 'second'] })
    await h.until(() => holdState() === 'held', 60_000)
    expect(steps()).toMatchObject([
      { id: 's1', status: 'succeeded' },
      { id: 's2', status: 'queued', disposition: 'quota_low' },
    ])
    // The lead gets a cause it can act on, once.
    const causes = h.rows<{ kind: string; detail: string }>(
      "SELECT kind, detail FROM orc_causes WHERE kind = 'step_held'",
    )
    expect(causes).toHaveLength(1)
    expect(causes[0]!.detail).toMatch(/^s2 is held: second has 6% of its 5-hour limit left until /)
    expect(h.orch.summary(id).needsYou).toContainEqual(
      expect.objectContaining({ kind: 'quota_low', stepId: 's2' }),
    )
    // The lead's next turn (woken by that cause) ends before the person answers.
    await h.until(() =>
      h
        .rows<{ state: string }>("SELECT state FROM orc_attempts WHERE kind = 'lead'")
        .every((a) => a.state === 'terminated'),
    )
    expect(h.cliCalls()).toHaveLength(1)
    // Stop the run: the third answer.
    await h.orch.quotaDecision(id, 's2', { answer: 'stop', orchestrationRevision: revision(id) })
    await h.until(() => h.orch.summary(id).status === 'stopped', 30_000)
    expect(h.cliCalls()).toHaveLength(1)
  })

  test('"Wait until it resets" admits the step by itself once the window has reset', async () => {
    const receipts: { status: string }[] = []
    h = await workerHarness({
      lead: {
        script: assignOnce('coder', {}, receipts, {
          agent: 'coder',
          extra: { ifQuotaLow: 'ask_owner' },
        }),
      },
    })
    h.addAgent('coder')
    low('coder', inMs(2_500))
    const id = await h.create()
    await h.until(() => holdState() === 'held')
    await h.orch.quotaDecision(id, 's1', { answer: 'wait', orchestrationRevision: revision(id) })
    expect(holdState()).toBe('waiting')
    // No card while the person has chosen to wait.
    expect(h.orch.summary(id).needsYou.some((item) => item.kind === 'quota_low')).toBe(false)
    expect(h.cliCalls()).toHaveLength(0)
    await h.until(() => h.orch.summary(id).status === 'succeeded', 60_000)
    expect(h.cliCalls()).toHaveLength(1)
    expect(history('quota_waited')).toHaveLength(1)
    expect(holdState()).toBeUndefined()
    expect(h.errors).toEqual([])
  })

  test('lowering the run’s floor lets a held step go on; answering a step that isn’t held is a conflict', async () => {
    const receipts: { status: string }[] = []
    h = await workerHarness({
      lead: {
        script: assignOnce('coder', {}, receipts, {
          agent: 'coder',
          extra: { ifQuotaLow: 'ask_owner' },
        }),
      },
    })
    h.addAgent('coder')
    low('coder')
    const id = await h.create()
    await h.until(() => holdState() === 'held')
    await expect(
      h.orch.quotaDecision(id, 's9', { answer: 'wait', orchestrationRevision: revision(id) }),
    ).rejects.toMatchObject({ status: 404 })
    await h.orch.limits(id, { quotaFloorPercent: 5, orchestrationRevision: revision(id) })
    await h.until(() => h.orch.summary(id).status === 'succeeded', 60_000)
    expect(holdState()).toBeUndefined()
    await expect(
      h.orch.quotaDecision(id, 's1', { answer: 'wait', orchestrationRevision: revision(id) }),
    ).rejects.toMatchObject({ status: 409 })
  })
})

describe('Antigravity readings', () => {
  const usage = (fresh: boolean): QuotaSource => ({
    antigravity: (): CodingQuota | null =>
      fresh
        ? {
            runtime: 'antigravity',
            seenAt: new Date().toISOString(),
            source: 'usage',
            windows: [
              {
                name: '5 hours',
                group: 'Gemini Models',
                usedPercent: 40,
                resetsAt: inMs(3_600_000),
              },
              {
                name: '5 hours',
                group: 'Claude and GPT models',
                usedPercent: 97,
                resetsAt: inMs(3_600_000),
              },
            ],
          }
        : null,
    refresh: async () => undefined,
  })
  const addAntigravity = (model: string | null) =>
    insertCodingAgent(h.db.sqlite, {
      id: 'agy',
      name: 'agy',
      role: '',
      runtime: 'antigravity',
      workspace: h.workspace,
      permission: 'read-only',
      model,
      style: { color: '#19C39A', shape: 'hexagon' },
      createdAt: new Date().toISOString(),
    })

  test('only the model’s own group counts; a failed or stale read never blocks', async () => {
    h = await workerHarness()
    addAntigravity('claude-sonnet-5-5-high')
    const run = { quota_floor_percent: null }
    const at = Date.now()
    expect(quotaCheck(h.db.sqlite, usage(true), run, 'agy', at)).toMatchObject({
      group: 'Claude and GPT models',
      leftPercent: 3,
    })
    expect(quotaCheck(h.db.sqlite, usage(false), run, 'agy', at)).toBeNull()
    expect(quotaCheck(h.db.sqlite, undefined, run, 'agy', at)).toBeNull()
    h.db.sqlite.exec("UPDATE coding_agents SET model = NULL WHERE id = 'agy'")
    expect(quotaCheck(h.db.sqlite, usage(true), run, 'agy', at)).toBeNull()
    h.db.sqlite.exec(
      "UPDATE coding_agents SET quota_floor_percent = 0, model = 'claude-opus-5-5-low' WHERE id = 'agy'",
    )
    expect(quotaCheck(h.db.sqlite, usage(true), run, 'agy', at)).toBeNull()
    expect(quotaCheck(h.db.sqlite, usage(true), { quota_floor_percent: 2 }, 'agy', at)).toBeNull()
    expect(
      quotaCheck(h.db.sqlite, usage(true), { quota_floor_percent: 10 }, 'agy', at),
    ).not.toBeNull()
  })
})
