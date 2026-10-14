import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  codingItemsFor,
  codingUnsentBytes,
  reserveFor,
} from '../../src/domain/orchestration/ops.ts'
import { addCodingAgent, startWorkflow, saveWorkflow } from '../helpers/wf-coding.ts'
import { workerHarness, type WorkerHarness } from '../helpers/worker-harness.ts'
import { agent, definition, edge, end, join as joinNode } from './wf-harness.ts'

// 7.7c F2 (docs/reviews/2026-10-14-7.7c-verify.md): each test is that review's probe, written to fail on the old code.

vi.setConfig({ testTimeout: 180_000, hookTimeout: 30_000 })
let h: WorkerHarness
afterEach(async () => {
  await h?.close()
  h = undefined as never
})

describe('F2 #2 preflight reserves for the submitted concurrency', () => {
  const wide = () => {
    const names = ['n1', 'n2', 'n3', 'n4']
    return definition(
      [
        agent('seed', { agentId: 'cc', instruction: '[fixture:basic] seed' }),
        ...names.map((name) =>
          agent(name, { agentId: 'cc', instruction: `[fixture:basic] ${name}` }),
        ),
        joinNode('j'),
        end(),
      ],
      [
        ...names.map((name) => edge('seed', name)),
        ...names.map((n) => edge(n, 'j')),
        edge('j', 'done'),
      ],
    )
  }

  test('a workflow run that exactly fits at concurrency 1 is accepted; concurrency 2 needs more', async () => {
    h = await workerHarness()
    addCodingAgent(h, 'cc', 'claude-code')
    const wf = saveWorkflow(h, wide())
    const base = await h.orch.workflowPreflight(wf, 1)
    const steps = base.maxSteps
    const quota = base.reserveBytes - (codingUnsentBytes(steps, 2) - codingUnsentBytes(steps, 1))
    expect(quota).toBeLessThan(base.reserveBytes)
    await h.close()
    h = await workerHarness({ orchestrator: { quotaBytes: quota } })
    addCodingAgent(h, 'cc', 'claude-code')
    const id = await startWorkflow(h, wide(), { maxConcurrentSteps: 2 }).catch((e: unknown) => e)
    expect(id).toMatchObject({ status: 409, code: 'quota_exhausted' })
    await expect(startWorkflow(h, wide(), { maxConcurrentSteps: 1 })).resolves.toMatch(/^orc-/)
  })

  test('an orchestration that exactly fits at concurrency 1 is accepted', async () => {
    const quota = reserveFor(12, 20, codingItemsFor(12, 10), codingUnsentBytes(12, 1))
    h = await workerHarness({ orchestrator: { quotaBytes: quota } })
    h.addAgent()
    await expect(h.create({ maxConcurrentSteps: 1 })).resolves.toMatch(/^orc-/)
  })
})
