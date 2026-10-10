import { copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { Orchestrator } from '../../src/domain/orchestration/executor.ts'
import { GlobalFenceStore } from '../../src/domain/orchestration/fence.ts'
import { createIngest } from '../../src/hub/ingest.ts'
import { McpAccessStore } from '../../src/mcp/access.ts'
import { create, harness, type Harness } from './harness.ts'
import { openMigrated } from './harness-db.ts'

let h: Harness
afterEach(async () => {
  await h?.close()
  h = undefined as never
})

test('after a database-only restore the executor fences: nothing is created or admitted until the person has reviewed the list', async () => {
  h = await harness()
  h.db.sqlite.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  copyFileSync(join(h.dir, 'score.db'), join(h.dir, 'restored.db'))
  const id = await h.create({ gatePolicy: 'none' })
  await h.until(() => h.orch.summary(id).status === 'succeeded')
  // A database from before the run, next to the journal that remembers it.
  const restored = openMigrated(h.dir, 'restored.db')
  const ingest = createIngest(restored)
  const store = new GlobalFenceStore(restored, h.journal)
  expect(store.startupCheck()).toMatchObject({ fenced: true, reasons: ['journal_mismatch'] })
  const kinds = store.view().items.map((item) => item.kind)
  expect(kinds).toContain('attempt')
  expect(kinds).toContain('handle')
  const orch = new Orchestrator({
    db: restored,
    ingest,
    port: h.port,
    access: new McpAccessStore(restored),
    fence: store,
  })
  await expect(orch.create(create())).rejects.toMatchObject({ status: 409, code: 'fenced' })
  expect(
    (await orch.preflight('lead', ['builder'])).checks.find((c) => c.id === 'global_fence')!.status,
  ).toBe('fail')
  // Reviewing the list and lifting is a recorded decision; the same doubts do not come back at the next start.
  store.lift(store.view().revision, 'those runs are in the old history')
  expect(new GlobalFenceStore(restored, h.journal).startupCheck().fenced).toBe(false)
  expect(
    restored.sqlite
      .prepare("SELECT kind FROM orc_history WHERE kind = 'global_fence_lifted'")
      .all(),
  ).toHaveLength(1)
  await ingest.close()
  restored.close()
})
