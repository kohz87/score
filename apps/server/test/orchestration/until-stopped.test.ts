import type { OrchReceipt } from '@score/contract'
import { afterEach, expect, test } from 'vitest'
import { byTurn, type LeadScript } from '../../src/hermes/fake/fake-lead.ts'
import { harness, type Harness } from './harness.ts'

// 3.27.0 (DECISIONS 162): a lead-decides run may go on until the person stops it, with a spend cap.
let h: Harness
afterEach(async () => {
  await h?.close()
  h = undefined as never
})
const status = (id: string) => h.orch.summary(id).status

function recording(script: Record<number, LeadScript>) {
  const log: Record<number, OrchReceipt[]> = {}
  const lead = byTurn(
    Object.fromEntries(
      Object.entries(script).map(([turn, run]) => [
        turn,
        async (t) => {
          log[Number(turn)] = []
          await run({
            ...t,
            call: async (...args: Parameters<typeof t.call>) => {
              const result = await t.call(...args)
              log[Number(turn)]!.push(result as OrchReceipt)
              return result
            },
          })
        },
      ]),
    ),
  )
  return { lead, log }
}

test('a run that goes on until stopped needs a spend cap', async () => {
  h = await harness()
  await expect(h.create({ untilStopped: true })).rejects.toMatchObject({ status: 400 })
  const id = await h.create({ untilStopped: true, budgetUsd: 1000 })
  expect(h.orch.summary(id).untilStopped).toBe(true)
  const [row] = h.rows<{ until_stopped: number; max_steps: number }>(
    'SELECT until_stopped, max_steps FROM orchestrations WHERE id = ?',
    id,
  )
  expect(row).toEqual({ until_stopped: 1, max_steps: 30 })
  // An ordinary run keeps its caps.
  const plain = await h.create({ maxSteps: 3 })
  expect(h.orch.summary(plain).untilStopped).toBe(false)
})

test('no step cap: the lead can assign past the stored step count', async () => {
  const { lead, log } = recording({
    1: async (t) => {
      await t.call('orch.assign', { agent: 'builder', instruction: 'one' })
      await t.call('orch.assign', { agent: 'builder', instruction: 'two' })
      await t.call('orch.finish', { outcome: 'partial', summary: 'enough' })
    },
  })
  h = await harness({ lead: { script: lead } })
  const id = await h.create({ untilStopped: true, budgetUsd: 1000 })
  // The stored cap is only a reserve size; lower it to prove the check is skipped.
  h.db.sqlite.prepare('UPDATE orchestrations SET max_steps = 1 WHERE id = ?').run(id)
  await h.until(() => status(id) !== 'running')
  expect(log[1]!.map((r) => r.code ?? r.status)).toEqual(['ok', 'ok', 'ok'])
})

test('no lead-turn cap: used-up turns don’t pause the run', async () => {
  const { lead, log } = recording({
    1: async (t) => {
      await t.call('orch.assign', { agent: 'builder', instruction: 'only step' })
    },
    2: async (t) => {
      await t.call('orch.finish', { outcome: 'success', summary: 'done' })
    },
  })
  h = await harness({ lead: { script: lead } })
  const id = await h.create({ untilStopped: true, budgetUsd: 1000 })
  h.db.sqlite.prepare('UPDATE orchestrations SET max_lead_turns = 1 WHERE id = ?').run(id)
  await h.until(() => status(id) !== 'running')
  expect(['finishing', 'succeeded']).toContain(status(id))
  expect(h.orch.summary(id).pauseReason ?? null).toBeNull()
  expect(log[1]!.map((r) => r.code ?? r.status)).toEqual(['ok'])
})
