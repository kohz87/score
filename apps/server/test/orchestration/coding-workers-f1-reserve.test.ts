import { describe, expect, test } from 'vitest'
import { ORCH_LIMITS } from '@score/contract'
import {
  CODING_ITEM_EXTRA_BYTES,
  codingUnsentBytes,
  codingItemsFor,
  reserveFor,
  CODING_OUTPUT_BYTES,
  CODING_RESULT_BYTES,
} from '../../src/domain/orchestration/ops.ts'
import { byTurn } from '../../src/hermes/fake/fake-lead.ts'
import { workerHarness, type WorkerHarness } from '../helpers/worker-harness.ts'
import { oneStep, revision, sql, useWorkerHarness } from './coding-workers-helpers.ts'

// 7.7b-F1: regression tests for the code review of 2026-10-14 (docs/reviews/2026-10-14-7.7b-code-review.md). Each test
// is that review's probe, written to fail on the code the review found.

let h: WorkerHarness
useWorkerHarness(
  () => h,
  () => {
    h = undefined as never
  },
)

// The room for unsent inputs of a default run (12 steps, 2 at once) is part of the partition (F1 #6 of 7.7c).
const UNSENT = codingUnsentBytes(12, 2)

describe('#7 coding inventory has its own part of the reserve', () => {
  const orch = () => h.rows<Record<string, number>>('SELECT * FROM orchestrations')[0]!

  test('observations that use up the ordinary allowance can’t spend the coding part: the result is still kept', async () => {
    h = await workerHarness({ lead: { script: oneStep() } })
    h.addAgent()
    const id = await h.create()
    // Only the coding part and the protected control reserve are left: no ordinary room for an observation row.
    sql(
      'UPDATE orchestrations SET stored_bytes = reserve_bytes - coding_reserve_bytes - 262144 - 3000',
    )
    await h.until(() => h.orch.summary(id).status === 'succeeded', 40_000)
    expect(h.rows("SELECT 1 FROM tool_calls WHERE run_id LIKE 'cr_%'")).toHaveLength(0)
    expect(
      h.rows<{ result_text: string }>(
        'SELECT result_text FROM orc_attempts WHERE kind = ?',
        'step',
      )[0]!.result_text,
    ).toBeTruthy()
    // What the coding step kept is charged to the coding part.
    expect(orch()['coding_stored_bytes']).toBeGreaterThan(0)
  })

  test('maximum-sized inventory after the ordinary room is gone never reaches the control reserve (F2 #4)', async () => {
    h = await workerHarness({ lead: { script: byTurn({ 1: async () => 'waiting' }) } })
    h.addAgent()
    const id = await h.create({ codingSteps: 1 })
    // Observations have used all the ordinary room: only the coding part and the control reserve remain.
    sql(
      'UPDATE orchestrations SET coding_stored_bytes = 0, stored_bytes = reserve_bytes - coding_reserve_bytes - ?',
      ORCH_LIMITS.controlReserveBytes,
    )
    // One item's largest inventory: the input, two copies of the longest result, the retained reply and the run output.
    const resultCopy = CODING_RESULT_BYTES + 128
    const largest =
      ORCH_LIMITS.stepInputBytes + 2 * resultCopy + CODING_RESULT_BYTES + CODING_OUTPUT_BYTES
    h.db.sqlite
      .prepare(
        'UPDATE orchestrations SET stored_bytes = stored_bytes + ?, coding_stored_bytes = coding_stored_bytes + ? WHERE id = ?',
      )
      .run(largest, largest, id)
    const row = orch()
    expect(row['reserve_bytes']! - row['stored_bytes']!).toBeGreaterThanOrEqual(
      ORCH_LIMITS.controlReserveBytes,
    )
  })

  test('every retained copy of the result is charged: the step result and attempt result, the run output and coding_run_results', async () => {
    h = await workerHarness({ lead: { script: oneStep() } })
    h.addAgent()
    const id = await h.create()
    await h.until(() => h.orch.summary(id).status === 'succeeded', 40_000)
    const reply = h.rows<{ reply: string }>('SELECT reply FROM coding_run_results')[0]!.reply
    const result = h.rows<{ result: string }>('SELECT result FROM orc_steps')[0]!.result
    const output = h.rows<{ output: string | null }>(
      "SELECT output FROM runs WHERE id LIKE 'cr_%'",
    )[0]!.output
    expect(orch()['coding_stored_bytes']).toBeGreaterThanOrEqual(
      Buffer.byteLength(result) * 2 + Buffer.byteLength(output ?? '') + Buffer.byteLength(reply),
    )
  })

  test('lowering then restoring codingSteps does not reserve twice (F2 #5)', async () => {
    const quota = reserveFor(12, 20, codingItemsFor(12, 10), UNSENT)
    h = await workerHarness({
      lead: { script: byTurn({ 1: async () => 'waiting', 2: async () => 'waiting' }) },
      orchestrator: { quotaBytes: quota },
    })
    h.addAgent()
    const id = await h.create({ codingSteps: 10 })
    const reserved = orch()['reserve_bytes']
    expect(orch()['coding_reserve_bytes']).toBe(10 * CODING_ITEM_EXTRA_BYTES + UNSENT)
    await h.orch.limits(id, { codingSteps: 4, orchestrationRevision: revision(id) })
    expect(orch()['coding_reserve_bytes']).toBe(10 * CODING_ITEM_EXTRA_BYTES + UNSENT)
    await h.orch.limits(id, { codingSteps: 10, orchestrationRevision: revision(id) })
    expect(orch()['coding_steps']).toBe(10)
    expect(orch()['reserve_bytes']).toBe(reserved)
    expect(orch()['coding_reserve_bytes']).toBe(10 * CODING_ITEM_EXTRA_BYTES + UNSENT)
  })

  test('raising codingSteps grows the reserve by the new items; a database without room refuses it', async () => {
    // The database holds exactly what a default run (10 coding items) reserves, which is also what preflight asks for.
    const quota = reserveFor(12, 20, codingItemsFor(12, 10), UNSENT)
    h = await workerHarness({
      lead: {
        script: byTurn({
          1: async () => 'waiting',
          2: async () => 'waiting',
          3: async () => 'waiting',
        }),
      },
      orchestrator: { quotaBytes: quota },
    })
    h.addAgent()
    const id = await h.create({ codingSteps: 4 })
    const base = reserveFor(12, 20, codingItemsFor(12, 4), UNSENT)
    expect(orch()['reserve_bytes']).toBe(base)
    expect(orch()['coding_reserve_bytes']).toBe(4 * CODING_ITEM_EXTRA_BYTES + UNSENT)
    await h.orch.limits(id, { codingSteps: 6, orchestrationRevision: revision(id) })
    expect(orch()['reserve_bytes']).toBe(base + 2 * CODING_ITEM_EXTRA_BYTES)
    expect(orch()['coding_reserve_bytes']).toBe(6 * CODING_ITEM_EXTRA_BYTES + UNSENT)
    // Six more items (12 in all) are more than the database has room for.
    await expect(
      h.orch.limits(id, { codingSteps: 12, orchestrationRevision: revision(id) }),
    ).rejects.toMatchObject({ status: 409, code: 'quota_exhausted' })
    expect(orch()['coding_steps']).toBe(6)
    expect(orch()['reserve_bytes']).toBe(base + 2 * CODING_ITEM_EXTRA_BYTES)
  })
})
