import { afterEach, expect, test } from 'vitest'
import { WorkflowRunSnapshotSchema } from '@score/contract'
import {
  agent,
  branch,
  decide,
  definition,
  edge,
  end,
  gate,
  join,
  node,
  replies,
  run,
  save,
  seedAgent,
  start,
  wfHarness,
  type Harness,
} from './wf-harness.ts'

let h: Harness | undefined
afterEach(async () => {
  await h?.close()
  h = undefined
})
const done = (id: string, status = 'succeeded') => (): boolean => run(h!, id).status === status
const simple = () => definition([agent('a'), end()], [edge('a', 'done')])
const aged = (id: string) => {
  const old = new Date(h!.scheduler.now() - 100 * 24 * 3600 * 1000).toISOString()
  h!.db.sqlite.prepare('UPDATE orchestrations SET ended_at = ?, updated_at = ? WHERE id = ?').run(old, old, id)
}

// Codex 7.1a review, high 1
test('pruning deletes only what the run owned: a message added after release survives', async () => {
  h = await wfHarness()
  const id = await start(h, simple())
  await h.until(done(id))
  const room = h.rows<{ room_id: string }>('SELECT room_id FROM orchestrations WHERE id = ?', id)[0]!.room_id
  const at = new Date(h.scheduler.now()).toISOString()
  h.db.sqlite
    .prepare(
      `INSERT INTO messages (id, room_id, author_kind, "to", parts, refs, streaming, created_at, updated_at) VALUES ('later', ?, 'you', '[]', '[{"kind":"text","text":"hi"}]', '[]', 0, ?, ?)`,
    )
    .run(room, at, at)
  // A brief hangs on it too (an FK reference that would make a blanket delete fail).
  h.db.sqlite.prepare("INSERT INTO briefs (id, room_id, title, started_at, started_by) VALUES ('later', ?, 't', ?, 'you')").run(room, at)
  aged(id)
  expect(h.orch.maintenance().pruned).toBe(1)
  expect(h.rows('SELECT id FROM messages WHERE id = ?', 'later')).toHaveLength(1)
  expect(h.rows('SELECT 1 FROM messages WHERE id LIKE ?', 'reply:%')).toHaveLength(0)
})

// medium: pruning must keep "used"
test('a version stays used after its last run is pruned, so the workflow still cannot be deleted', async () => {
  h = await wfHarness()
  const id = await start(h, simple())
  await h.until(done(id))
  const wf = h.rows<{ workflow_id: string }>('SELECT workflow_id FROM wf_runs WHERE orchestration_id = ?', id)[0]!.workflow_id
  aged(id)
  expect(h.orch.maintenance().pruned).toBe(1)
  const { getWorkflow, deleteWorkflow } = await import('../../src/domain/workflows/definitions.ts')
  expect(getWorkflow(h.db.sqlite, wf).versions[0]!.used).toBe(true)
  expect(() => deleteWorkflow(h!.db.sqlite, wf)).toThrow(/used/i)
})
