import { copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { applyJournalEvidence, verifyJournal } from '../../src/domain/orchestration/fence.ts'
import { openMigrated } from '../orchestration/harness-db.ts'
import { addCodingAgent, startWorkflow, wfRunOf } from '../helpers/wf-coding.ts'
import { workerHarness, type WorkerHarness } from '../helpers/worker-harness.ts'
import { agent, definition, edge, end } from './wf-harness.ts'

// 7.7c F2 (docs/reviews/2026-10-14-7.7c-verify.md): each test is that review's probe, written to fail on the old code.

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

describe('F2 #1 renewal replay', () => {
  test('restore, then lift: the renewal count is kept, the predecessor retired, the successor waits held back', async () => {
    h = await workerHarness({ unit: { blocked: () => fence }, orchestrator: { retryMs: 20 } })
    addCodingAgent(h, 'cc', 'claude-code')
    const id = await startWorkflow(
      h,
      definition(
        [
          agent('a', { agentId: 'cc', instruction: '[fixture:basic] write hello', retries: 0 }),
          end(),
        ],
        [edge('a', 'done')],
      ),
    )
    fence = 'A fence is up.'
    await h.until(
      () => rows("SELECT 1 FROM orc_steps WHERE disposition = 'held_back'").length > 0,
      120_000,
    )
    h.db.sqlite.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    copyFileSync(join(h.dir, 'score.db'), join(h.dir, 'before-renewal.db'))
    await h.orch.wfTryAgain(id, 'a', {
      expectedNodeRevision: node(id).revision,
      orchestrationRevision: revision(id),
    })
    const read = h.journal.readOwn()
    if (!read.ok) throw new Error('journal unreadable')
    const renewal = read.entries.find((e) => e.kind === 'renewal')!
    if (renewal.kind !== 'renewal') throw new Error('no renewal')

    const restored = openMigrated(h.dir, 'before-renewal.db')
    const all = (sql: string, ...args: string[]) =>
      restored.sqlite.prepare(sql).all(...args) as Record<string, unknown>[]
    expect(
      applyJournalEvidence(restored.sqlite, read.entries, new Date().toISOString()),
    ).toBeGreaterThan(0)
    expect(all('SELECT renewals FROM wf_nodes WHERE node_id = ?', 'a')).toEqual([{ renewals: 1 }])
    expect(
      all(
        'SELECT state, suspended, input, reserved_usd FROM orc_attempts WHERE id = ?',
        renewal.predecessorId,
      ),
    ).toMatchObject([{ state: 'refused', suspended: 0, input: '', reserved_usd: 0 }])
    // The successor is what a Try again would renew next: unsent, suspended, and its step held back.
    expect(
      all('SELECT state, suspended FROM orc_attempts WHERE id = ?', renewal.successorId),
    ).toEqual([{ state: 'created', suspended: 1 }])
    expect(all("SELECT disposition FROM orc_steps WHERE status = 'blocked'")).toEqual([
      { disposition: 'held_back' },
    ])
    expect(verifyJournal(restored.sqlite, read.entries)).toEqual([])
    // Replaying twice changes nothing more.
    expect(applyJournalEvidence(restored.sqlite, read.entries, new Date().toISOString())).toBe(0)
    restored.close()
  })
})
