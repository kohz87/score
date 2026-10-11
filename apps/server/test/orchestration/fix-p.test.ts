import { afterEach, expect, test } from 'vitest'
import { harness, type Harness } from './harness.ts'

let h: Harness
afterEach(async () => {
  await h?.close()
  h = undefined as never
})

test('SCORE-017: a rolled-back transaction leaves the fingerprint and ownership caches unpublished', async () => {
  h = await harness()
  const id = await h.create()
  await h.settle(300)
  const sqlite = h.db.sqlite
  const revision = () => h.orch.snapshot(id).orchestration.revision
  const before = revision()
  const history = () =>
    h
      .rows<{ detail: string }>(
        "SELECT detail FROM orc_history WHERE kind = 'ownership' ORDER BY id",
      )
      .map((row) => JSON.parse(row.detail).state)
  const upserts = () =>
    h.rows("SELECT 1 FROM events WHERE type = 'orchestration.upserted'").length
  const historyBefore = history()
  const upsertsBefore = upserts()

  const caches = h.orch as unknown as {
    fingerprints: Map<string, string>
    ownershipSeen: Map<string, string>
  }
  const seen = { fingerprint: caches.fingerprints.get(id), ownership: caches.ownershipSeen.get(id) }

  // The failure comes after finalize ran: the event inserts at the end of the transaction abort and roll it all back.
  sqlite.exec(
    "CREATE TRIGGER boom BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'injected'); END",
  )
  await expect(Promise.resolve(h.orch.stop(id))).rejects.toThrow()
  sqlite.exec('DROP TRIGGER boom')
  expect(revision()).toBe(before)
  expect(history()).toEqual(historyBefore)
  expect({
    fingerprint: caches.fingerprints.get(id),
    ownership: caches.ownershipSeen.get(id),
  }).toEqual(seen)

  // The identical projection must now be recorded, not skipped as "already seen".
  await h.orch.stop(id)
  expect(revision()).toBeGreaterThan(before)
  expect(upserts()).toBeGreaterThan(upsertsBefore)
})
