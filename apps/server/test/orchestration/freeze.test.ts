import { afterEach, expect, test, vi } from 'vitest'
import { resetDatabaseHistory } from '../../src/history-reset.ts'
import { byTurn } from '../../src/hermes/fake/fake-lead.ts'
import { attemptOf, harness, type Harness } from './harness.ts'

// FV #1 (decision 71): a frozen home dispatches nothing and delivers no Stop; reset-history never re-sends.

let h: Harness
afterEach(async () => {
  await h?.close()
})

const HOLD = 'This home is a copy of installation 0123456789abcdef.'

test('a frozen home dispatches no attempt; unfrozen, the same attempt goes out', async () => {
  h = await harness()
  const start = vi.spyOn(h.port, 'startRun')
  h.fence.setHardBlock(HOLD)
  const id = await h.create()
  await h.settle(3000)
  expect(start).not.toHaveBeenCalled()
  expect(attemptOf(h, id, 'lead').every((a) => a.state === 'created')).toBe(true)
  h.fence.setHardBlock(null)
  await h.until(() => start.mock.calls.length > 0)
})

test('a frozen home delivers no owed Stop (the probe: an inherited source handle), then delivers it once unfrozen', async () => {
  h = await harness({
    lead: {
      script: byTurn({
        1: async (t) => {
          await t.call('orch.assign', { agent: 'builder', instruction: '[fake:hold]' })
        },
      }),
    },
  })
  const stop = vi.spyOn(h.port, 'stopRun')
  const id = await h.create({ gatePolicy: 'none' })
  await h.until(() => attemptOf(h, id, 'step', 's1').some((a) => a.state === 'running'))
  h.fence.setHardBlock(HOLD)
  await h.orch.stop(id)
  await h.settle(3000)
  expect(stop).not.toHaveBeenCalled()
  h.fence.setHardBlock(null)
  await h.until(() => stop.mock.calls.length > 0)
})

test('after reset-history a retired attempt’s owed Stop is never delivered and nothing is dispatched again', async () => {
  h = await harness({
    lead: {
      script: byTurn({
        1: async (t) => {
          await t.call('orch.assign', { agent: 'builder', instruction: '[fake:hold]' })
        },
      }),
    },
  })
  const stop = vi.spyOn(h.port, 'stopRun')
  const start = vi.spyOn(h.port, 'startRun')
  const id = await h.create({ gatePolicy: 'none' })
  await h.until(() => attemptOf(h, id, 'step', 's1').some((a) => a.state === 'running'))
  h.fence.setHardBlock(HOLD)
  await h.orch.stop(id)
  const sent = start.mock.calls.length
  resetDatabaseHistory(h.db.sqlite, new Date().toISOString())
  h.fence.setHardBlock(null)
  await h.settle(3000)
  expect(stop).not.toHaveBeenCalled()
  expect(start.mock.calls.length).toBe(sent)
  expect(h.rows("SELECT state, unknown_reason FROM orc_attempts WHERE kind = 'step'")).toEqual([
    { state: 'unknown', unknown_reason: 'history_reset' },
  ])
})
