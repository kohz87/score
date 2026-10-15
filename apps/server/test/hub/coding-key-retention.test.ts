import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { migrate, openDatabase, type ScoreDb } from '../../src/db/index.ts'
import { createIngest, retireIngestKeys, type Ingest } from '../../src/hub/index.ts'
import {
  eventObservation,
  newTranslation,
  runningObservation,
  terminalObservation,
} from '../../src/runtimes/coding/translate.ts'

const migrationDir = fileURLToPath(new URL('../../migrations/', import.meta.url))
const AT = '2026-01-01T00:00:00.000Z'
let dir: string
let db: ScoreDb
let ingest: Ingest

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'score-coding-keys-'))
  db = openDatabase(join(dir, 'score.db'))
  migrate(db, migrationDir)
  ingest = createIngest(db)
})
afterEach(async () => {
  await ingest.close()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

/** A run as the service admits it, with two events and a running mark; `finish` ends it. */
async function drive(runId: string, finish: boolean) {
  db.sqlite
    .prepare(
      "INSERT INTO runs (id, profile, origin, status, started_at, updated_at) VALUES (?, 'builder', 'score', 'queued', ?, ?)",
    )
    .run(runId, AT, AT)
  await ingest.submit({
    source: 'coding:builder',
    identity: `admitted:${runId}`,
    apply: () => [],
  })
  const translation = newTranslation(runId, 'builder', null)
  await ingest.submit(runningObservation(translation))
  await ingest.submit(eventObservation(translation, { kind: 'text', text: 'hello' }, 0))
  await ingest.submit(eventObservation(translation, { kind: 'text', text: 'again' }, 1))
  if (finish)
    await ingest.submit(
      terminalObservation(translation, {
        status: 'completed',
        costKind: 'unknown',
        group: 'released',
      }),
    )
  return translation
}
const identities = (runId: string) =>
  (
    db.sqlite
      .prepare('SELECT identity FROM ingest_keys WHERE identity LIKE ? ORDER BY identity')
      .all(`%${runId}%`) as { identity: string }[]
  ).map((r) => r.identity)

test('S4-007: a finished, delivered, settled run gives its detail keys back and still refuses a replay', async () => {
  const translation = await drive('cr_done', true)
  expect(identities('cr_done')).toHaveLength(5)
  const before = db.sqlite.prepare('SELECT * FROM runs WHERE id = ?').get('cr_done')
  retireIngestKeys(db)
  // The admission and terminal keys stay as the replay guard; the running mark and event keys are gone.
  expect(identities('cr_done')).toEqual(['admitted:cr_done', 'coding:cr_done:terminal'])
  const replays = [
    await ingest.submit(runningObservation(translation)),
    await ingest.submit(eventObservation(translation, { kind: 'text', text: 'hello' }, 0)),
    await ingest.submit(
      terminalObservation(translation, {
        status: 'failed',
        costKind: 'unknown',
        group: 'released',
      }),
    ),
  ]
  expect(replays.map((r) => r.status)).toEqual(['applied', 'applied', 'duplicate'])
  for (const r of replays) if (r.status === 'applied') expect(r.seqs).toEqual([])
  expect(db.sqlite.prepare('SELECT * FROM runs WHERE id = ?').get('cr_done')).toEqual(before)
})

test('S4-007: a pending terminal, an unsettled launch and a live run keep every key', async () => {
  await drive('cr_pending', true)
  db.sqlite
    .prepare(
      "INSERT INTO coding_pending_terminals (run_id, agent_id, info, created_at) VALUES ('cr_pending', 'builder', '{}', ?)",
    )
    .run(AT)
  await drive('cr_unsettled', true)
  db.sqlite
    .prepare(
      `INSERT INTO coding_launches (launch_id, run_id, turn_id, generation, phase, journal_n, updated_at)
       VALUES ('l1', 'cr_unsettled', 't1', 1, 'ended', 1, ?)`,
    )
    .run(AT)
  await drive('cr_live', false)
  await drive('cr_settled', true)
  db.sqlite
    .prepare(
      `INSERT INTO coding_launches (launch_id, run_id, turn_id, generation, phase, journal_n, updated_at)
       VALUES ('l2', 'cr_settled', 't2', 1, 'settled', 1, ?)`,
    )
    .run(AT)
  retireIngestKeys(db)
  expect(identities('cr_pending')).toHaveLength(5)
  expect(identities('cr_unsettled')).toHaveLength(5)
  expect(identities('cr_live')).toHaveLength(4)
  expect(identities('cr_settled')).toHaveLength(2)
  // Once the result is delivered and the launch settles, the next pass reclaims them.
  db.sqlite.prepare('DELETE FROM coding_pending_terminals').run()
  db.sqlite.prepare("UPDATE coding_launches SET phase = 'settled'").run()
  retireIngestKeys(db)
  expect(identities('cr_pending')).toHaveLength(2)
  expect(identities('cr_unsettled')).toHaveLength(2)
  expect(identities('cr_live')).toHaveLength(4)
})
