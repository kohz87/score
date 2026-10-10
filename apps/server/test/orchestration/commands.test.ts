import type { OrchReceipt } from '@score/contract'
import { afterEach, expect, test } from 'vitest'
import { byTurn } from '../../src/hermes/fake/fake-lead.ts'
import { attemptOf, harness, type Harness } from './harness.ts'

let h: Harness
afterEach(async () => {
  await h?.close()
  h = undefined as never
})
const status = (id: string) => h.orch.summary(id).status
const r = (value: unknown) => value as OrchReceipt

test('a repeated commandId with the same payload returns the stored receipt and changes nothing (lost reply)', async () => {
  const out: OrchReceipt[] = []
  h = await harness({
    lead: {
      script: byTurn({
        1: async (t) => {
          out.push(r(await t.call('orch.assign', { agent: 'builder', instruction: 'work' }, 'c1')))
          // The reply was lost; the lead sends the identical call again, then verifies with orch.receipt.
          out.push(r(await t.call('orch.assign', { agent: 'builder', instruction: 'work' }, 'c1')))
          out.push(r(await t.call('orch.receipt', {}, 'c1')))
          out.push(r(await t.call('orch.receipt', {}, 'never-sent')))
        },
      }),
    },
  })
  const id = await h.create()
  await h.until(() => h.orch.snapshot(id).orchestration.stepsList.length === 1)
  await h.settle()
  expect(out.map((o) => o.status)).toEqual(['ok', 'ok', 'ok', 'not_found'])
  expect(out[1]).toEqual(out[0])
  expect(out[2]).toEqual(out[0])
  expect(h.orch.snapshot(id).orchestration.stepsList).toHaveLength(1)
  expect(h.rows("SELECT 1 FROM orc_commands WHERE command_id = 'c1'")).toHaveLength(1)
})

test('the same commandId with a different payload conflicts and mutates nothing', async () => {
  const out: OrchReceipt[] = []
  h = await harness({
    lead: {
      script: byTurn({
        1: async (t) => {
          out.push(r(await t.call('orch.assign', { agent: 'builder', instruction: 'work' }, 'c1')))
          out.push(
            r(
              await t.call(
                'orch.assign',
                { agent: 'builder', instruction: 'different work' },
                'c1',
              ),
            ),
          )
          out.push(r(await t.call('orch.note', { text: 'a note' }, 'c1')))
        },
      }),
    },
  })
  const id = await h.create()
  await h.until(() => out.length === 3)
  expect(out.map((o) => o.status)).toEqual(['ok', 'conflict', 'conflict'])
  expect(out[1]!.code).toBe('command_id_reused')
  expect(h.orch.snapshot(id).orchestration.stepsList).toHaveLength(1)
})

test('command ids are scoped to the lead attempt: another turn may reuse one', async () => {
  const out: OrchReceipt[] = []
  h = await harness({
    lead: {
      script: byTurn({
        1: async (t) => {
          out.push(r(await t.call('orch.assign', { agent: 'builder', instruction: 'one' }, 'same')))
        },
        2: async (t) => {
          out.push(
            r(await t.call('orch.assign', { agent: 'reviewer', instruction: 'two' }, 'same')),
          )
          await t.call('orch.finish', { outcome: 'success', summary: 'x' })
        },
      }),
    },
  })
  const id = await h.create()
  await h.until(() => status(id) === 'succeeded')
  expect(out.map((o) => [o.status, o.result?.stepId])).toEqual([
    ['ok', 's1'],
    ['ok', 's2'],
  ])
})

test('while the lead attempt admission is not recorded yet the call is told to retry and nothing is stored', async () => {
  const out: OrchReceipt[] = []
  h = await harness({
    lead: {
      script: byTurn({
        1: async (t) => {
          const attempt = attemptOf(h, h.orch.list().items[0]!.id, 'lead')[0]!
          h.db.sqlite
            .prepare("UPDATE orc_attempts SET state = 'send_started' WHERE id = ?")
            .run(attempt.id)
          out.push(r(await t.call('orch.note', { text: 'early' }, 'e1')))
          expect(h.rows('SELECT 1 FROM orc_commands')).toHaveLength(0)
          h.db.sqlite
            .prepare("UPDATE orc_attempts SET state = 'running' WHERE id = ?")
            .run(attempt.id)
          out.push(r(await t.call('orch.note', { text: 'early' }, 'e1')))
        },
      }),
    },
  })
  const id = await h.create()
  await h.until(() => out.length === 2)
  expect(out.map((o) => [o.status, o.code])).toEqual([
    ['retry', 'admission_pending'],
    ['ok', undefined],
  ])
  expect(h.rows('SELECT 1 FROM orc_commands')).toHaveLength(1)
  expect(id).toBeTruthy()
})

test('after orch.finish further commands are sealed, but stored receipts can still be read', async () => {
  const out: OrchReceipt[] = []
  h = await harness({
    lead: {
      script: byTurn({
        1: async (t) => {
          out.push(r(await t.call('orch.finish', { outcome: 'success', summary: 'done' }, 'f1')))
          out.push(r(await t.call('orch.note', { text: 'after' }, 'n1')))
          out.push(r(await t.call('orch.finish', { outcome: 'success', summary: 'done' }, 'f1')))
          out.push(r(await t.call('orch.receipt', {}, 'f1')))
        },
      }),
    },
  })
  const id = await h.create()
  await h.until(() => status(id) === 'succeeded')
  expect(out.map((o) => o.status)).toEqual(['ok', 'refused', 'ok', 'ok'])
  expect(out[1]!.code).toBe('sealed')
})
