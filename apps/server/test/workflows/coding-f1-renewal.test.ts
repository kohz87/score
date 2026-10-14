import { copyFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { GlobalFenceStore, verifyJournal } from '../../src/domain/orchestration/fence.ts'
import { openMigrated } from '../orchestration/harness-db.ts'
import { addCodingAgent, startWorkflow, wfRunOf } from '../helpers/wf-coding.ts'
import { workerHarness, type WorkerHarness } from '../helpers/worker-harness.ts'
import { agent, definition, edge, end } from './wf-harness.ts'

// 7.7c F1 #2: a decision about a coding node reaches the node's CURRENT attempt, never the retired predecessor of a renewal.

vi.setConfig({ testTimeout: 180_000, hookTimeout: 30_000 })
let h: WorkerHarness
let fence: string | null = null
afterEach(async () => {
  await h?.close()
  h = undefined as never
  fence = null
})

const rows = (sql: string, ...args: (string | number)[]) =>
  h.rows<Record<string, unknown>>(sql, ...args)
const node = (id: string) => wfRunOf(h, id).nodeStates.find((n) => n.nodeId === 'a')!
const revision = (id: string) => h.orch.workflowSummary(id).revision
const flow = () =>
  definition(
    [agent('a', { agentId: 'cc', instruction: '[fixture:basic] write hello', retries: 0 }), end()],
    [edge('a', 'done')],
  )

describe('renewal then new settings', () => {
  test('the remap goes to the fresh attempt, which then runs; the retired predecessor is not suspended', async () => {
    h = await workerHarness({ unit: { blocked: () => fence }, orchestrator: { retryMs: 20 } })
    addCodingAgent(h, 'cc', 'claude-code')
    const id = await startWorkflow(h, flow())
    fence = 'A fence is up.'
    await h.until(
      () => rows("SELECT 1 FROM orc_steps WHERE disposition = 'held_back'").length > 0,
      120_000,
    )
    await h.orch.wfTryAgain(id, 'a', {
      expectedNodeRevision: node(id).revision,
      orchestrationRevision: revision(id),
    })
    // The agent's settings change while the renewed attempt waits; lifting the fence blocks it as `agent_changed`.
    writeFileSync(join(h.dir, 'ws-cc', 'CLAUDE.md'), 'new instructions')
    fence = null
    await h.until(
      () => rows("SELECT 1 FROM orc_steps WHERE disposition = 'agent_changed'").length > 0,
      60_000,
    )
    const [old, fresh] = rows(
      "SELECT id, suspended, state, policy_id FROM orc_attempts WHERE kind = 'step' ORDER BY n",
    )
    expect(old).toMatchObject({ state: 'refused', suspended: 0 })
    expect(fresh).toMatchObject({ state: 'created', suspended: 1 })
    const fix = (await h.orch.preflight('lead', ['cc'])).workers[0]!.policyId!
    await h.orch.wfPolicyRemap(id, 'a', {
      policyId: fix,
      expectedNodeRevision: node(id).revision,
      orchestrationRevision: revision(id),
    })
    expect(rows('SELECT policy_id FROM orc_attempts WHERE id = ?', fresh!['id'] as string)).toEqual(
      [{ policy_id: fix }],
    )
    await h.until(() => wfRunOf(h, id).status === 'succeeded', 60_000)
    expect(h.cliCalls()).toHaveLength(1)
  })
})

describe('renewals are journaled', () => {
  test('F1 #5: a database restored from before a renewal is detected, also after compaction', async () => {
    h = await workerHarness({ unit: { blocked: () => fence }, orchestrator: { retryMs: 20 } })
    addCodingAgent(h, 'cc', 'claude-code')
    const id = await startWorkflow(h, flow())
    fence = 'A fence is up.'
    await h.until(
      () => rows("SELECT 1 FROM orc_steps WHERE disposition = 'held_back'").length > 0,
      120_000,
    )
    // The backup is taken before the renewal; the successor stays unsent behind the fence.
    h.db.sqlite.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    copyFileSync(join(h.dir, 'score.db'), join(h.dir, 'before-renewal.db'))
    await h.orch.wfTryAgain(id, 'a', {
      expectedNodeRevision: node(id).revision,
      orchestrationRevision: revision(id),
    })
    expect(node(id)).toMatchObject({ renewals: 1 })
    const entries = () => {
      const read = h.journal.readOwn()
      if (!read.ok) throw new Error('journal unreadable')
      return read.entries
    }
    expect(entries().filter((e) => e.kind === 'renewal')).toMatchObject([
      {
        nodeId: 'a',
        renewals: 1,
        predecessorId: expect.any(String),
        successorId: expect.any(String),
      },
    ])
    // The honest database agrees with its journal, before and after compaction.
    expect(verifyJournal(h.db.sqlite, entries())).toEqual([])
    h.orch.maintenance()
    expect(verifyJournal(h.db.sqlite, entries())).toEqual([])
    // The old database lacks the renewal: its count went back and its successor attempt never existed.
    const restored = openMigrated(h.dir, 'before-renewal.db')
    const mismatches = verifyJournal(restored.sqlite, entries())
    expect(mismatches.map((m) => m.detail)).toContainEqual(
      expect.stringContaining('Try again for a'),
    )
    expect(new GlobalFenceStore(restored, h.journal).startupCheck()).toMatchObject({
      fenced: true,
    })
    restored.close()
  })
})
