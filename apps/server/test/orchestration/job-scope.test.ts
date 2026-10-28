// 3.14 (owner: "the workbench and work tabs are always empty"): a job started as an orchestration links to its run, whose
// turns are recorded on the run room's own job; the linked job's results and workbench count them.
import { afterEach, expect, test } from 'vitest'
import { jobScope } from '../../src/domain/exchanges/results.ts'
import { harness, type Harness } from './harness.ts'

let h: Harness
afterEach(async () => {
  await h?.close()
  h = undefined as never
})

test('a linked job counts the jobs of its run’s room; any other job only itself', async () => {
  h = await harness()
  const id = await h.create()
  await h.settle()
  const room = h.rows<{ room_id: string }>(
    'SELECT room_id FROM orchestrations WHERE id = ?',
    id,
  )[0]!.room_id
  const roomJobs = h
    .rows<{ id: string }>('SELECT id FROM jobs WHERE room_id = ?', room)
    .map((row) => row.id)
  expect(roomJobs.length).toBeGreaterThan(0)
  const template = h.rows<Record<string, unknown>>(
    'SELECT * FROM jobs WHERE room_id = ? LIMIT 1',
    room,
  )[0]!
  const linked = {
    ...template,
    id: 'job_linked',
    // Any existing room will do for the link (the team room in the app).
    room_id: room,
    is_default: 0,
    recipe_kind: 'orchestration',
    recipe_ref: id,
  }
  const keys = Object.keys(linked)
  h.db.sqlite
    .prepare(`INSERT INTO jobs (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`)
    .run(...(Object.values(linked) as (string | number | null)[]))
  expect(jobScope(h.db.sqlite, 'job_linked').sort()).toEqual(['job_linked', ...roomJobs].sort())
  expect(jobScope(h.db.sqlite, roomJobs[0]!)).toEqual([roomJobs[0]])
})
