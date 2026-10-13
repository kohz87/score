import { afterEach, expect, test, vi } from 'vitest'
import { codingItemsFor, reserveFor } from '../../src/domain/orchestration/ops.ts'
import { byTurn } from '../../src/hermes/fake/fake-lead.ts'
import { workerHarness, type WorkerHarness } from '../helpers/worker-harness.ts'

// 7.7b-3 #2 (design §11): the reserve of a coding item, policy snapshots and observations charged to the run, unlaunched
// inputs kept as hashes, and pruning.

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 })

let h: WorkerHarness
afterEach(async () => {
  await h?.close()
  h = undefined as never
})

const status = (id: string) => h.orch.summary(id).status
const orch = () => h.rows<Record<string, number>>('SELECT * FROM orchestrations')[0]!
const SECRET_TASK = 'write hello and mention zebra-quartz-77'
const oneStep = byTurn({
  1: async (t) => {
    await t.call('orch.assign', { agent: 'coder', instruction: `[fixture:basic] ${SECRET_TASK}` })
    return 'assigned'
  },
  2: async (t) => {
    await t.call('orch.finish', { outcome: 'success', summary: 'done' })
  },
})

test('a run with a coding worker reserves the coding items on top of the ordinary reserve', async () => {
  h = await workerHarness({ lead: { script: oneStep } })
  h.addAgent()
  const id = await h.create()
  expect(orch()['reserve_bytes']).toBe(reserveFor(12, 20, codingItemsFor(12, 10)))
  expect(orch()['reserve_bytes']).toBeGreaterThan(reserveFor(12, 20))
  await h.until(() => status(id) === 'succeeded', 40_000)
})

test('the policy snapshot and the coding run’s tool rows are charged to the run', async () => {
  h = await workerHarness({ lead: { script: oneStep } })
  h.addAgent()
  const id = await h.create()
  const created = orch()['stored_bytes']!
  const policy = h.rows<{ policy: string; reach: string }>(
    'SELECT policy, reach FROM orc_worker_policies',
  )[0]!
  const goal = 'Write the release notes'
  expect(created).toBeGreaterThanOrEqual(
    Buffer.byteLength(goal) +
      1024 +
      Buffer.byteLength(policy.policy) +
      Buffer.byteLength(policy.reach),
  )
  await h.until(() => status(id) === 'succeeded', 40_000)
  const tools = h.rows("SELECT 1 FROM tool_calls WHERE run_id LIKE 'cr_%'")
  expect(tools.length).toBeGreaterThan(0)
  // Each kept tool row was charged its whole bounded size at the start.
  expect(orch()['stored_bytes']! - created).toBeGreaterThanOrEqual(
    tools.length * (2048 + 2000 + 256),
  )
})

test('tool rows are dropped once the run has no room, and the run still completes', async () => {
  h = await workerHarness({ lead: { script: oneStep } })
  h.addAgent()
  const id = await h.create()
  // Room for the lead's commands but not for another observation row: only the protected reserve is left.
  h.db.sqlite
    .prepare('UPDATE orchestrations SET stored_bytes = reserve_bytes - 262144 - 3000')
    .run()
  await h.until(() => status(id) === 'succeeded', 40_000)
  expect(h.rows("SELECT 1 FROM tool_calls WHERE run_id LIKE 'cr_%'")).toHaveLength(0)
})

test('a generation that launched nothing keeps only the hash of its input; the launched one keeps its text', async () => {
  h = await workerHarness({
    lead: { script: oneStep },
    orchestrator: {
      releaseChecks: { limits: (_s, subject) => (subject.generation === 1 ? 'hold' : undefined) },
    },
  })
  h.addAgent()
  const id = await h.create()
  await h.until(() => status(id) === 'succeeded', 40_000)
  const intents = h.rows<{ generation: number; payload: string }>(
    'SELECT generation, payload FROM command_intents WHERE orchestration_attempt_id IS NOT NULL ORDER BY generation',
  )
  expect(intents.map((i) => i.generation)).toEqual([1, 2])
  const [first, second] = intents.map((i) => JSON.parse(i.payload) as Record<string, string>)
  expect(first!['input']).toBe('')
  expect(first!['inputSha256']).toMatch(/^[0-9a-f]{64}$/)
  expect(intents[0]!.payload).not.toContain('zebra-quartz-77')
  expect(second!['input']).toContain('zebra-quartz-77')
  // Pruning removes every generation's intent.
  h.db.sqlite.prepare("UPDATE orchestrations SET ended_at = '2020-01-01T00:00:00.000Z'").run()
  expect(h.orch.maintenance().pruned).toBe(1)
  expect(
    h.rows('SELECT 1 FROM command_intents WHERE orchestration_attempt_id IS NOT NULL'),
  ).toHaveLength(0)
})
