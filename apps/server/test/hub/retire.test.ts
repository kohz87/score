import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { migrate, openDatabase, type ScoreDb } from '../../src/db/index.ts'
import {
  createIngest,
  retireIngestKeys,
  type Ingest,
  type Observation,
} from '../../src/hub/index.ts'

const migrationDir = fileURLToPath(new URL('../../migrations/', import.meta.url))
let dir: string
let db: ScoreDb
let ingest: Ingest

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'score-retire-'))
  db = openDatabase(join(dir, 'score.db'))
  migrate(db, migrationDir)
  ingest = createIngest(db)
})

afterEach(async () => {
  await ingest.close()
  db.close()
  rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

function observation(position: number, overrides: Partial<Observation> = {}): Observation {
  return {
    source: 'score',
    identity: `event:${position}`,
    checkpoint: { scope: 'messages', incarnation: 'current', position },
    apply: () => [
      { type: 'message.completed', data: { roomId: 'room', messageId: String(position) } },
    ],
    ...overrides,
  }
}

async function seed(count: number): Promise<void> {
  for (let position = 1; position <= count; position++) await ingest.submit(observation(position))
}

function keys() {
  return db.sqlite.prepare('SELECT identity FROM ingest_keys ORDER BY identity').all()
}

function floors() {
  return db.sqlite.prepare('SELECT * FROM ingest_floors ORDER BY source, scope, incarnation').all()
}

test.each([null, 'current'])(
  'retired positions stay duplicates across database reopen for incarnation %s',
  async (incarnation) => {
    for (let position = 0; position <= 5; position++) {
      await ingest.submit(
        observation(position, { checkpoint: { scope: 'messages', incarnation, position } }),
      )
    }
    expect(retireIngestKeys(db, { keepPositions: 2 })).toEqual({ retired: 4, floors: 1 })
    expect(floors()).toEqual([
      {
        source: 'score',
        scope: 'messages',
        incarnation: incarnation ?? '',
        floor: 3,
        updated_at: expect.any(String),
      },
    ])
    for (const reopen of [false, true]) {
      if (reopen) {
        await ingest.close()
        db.close()
        db = openDatabase(join(dir, 'score.db'))
        migrate(db, migrationDir)
        ingest = createIngest(db)
      }
      const apply = vi.fn(observation(1).apply)
      const listener = vi.fn()
      const unsubscribe = ingest.onCommitted(listener)
      for (const position of [0, 1, 3]) {
        expect(
          await ingest.submit(
            observation(position, {
              apply,
              checkpoint: { scope: 'messages', incarnation, position },
            }),
          ),
        ).toEqual({ status: 'duplicate' })
      }
      expect(
        await ingest.submit(
          observation(2, {
            identity: 'unseen-below-floor',
            apply,
            checkpoint: { scope: 'messages', incarnation, position: 2 },
          }),
        ),
      ).toEqual({ status: 'duplicate' })
      await ingest.flushListeners()
      expect(apply).not.toHaveBeenCalled()
      expect(listener).not.toHaveBeenCalled()
      expect(db.sqlite.prepare('SELECT count(*) AS count FROM events').get()).toEqual({ count: 6 })
      expect(keys()).toEqual([{ identity: 'event:4' }, { identity: 'event:5' }])
      unsubscribe()
    }
  },
)

test('only current incarnation keys at or below the floor retire; other sources, scopes and NULL positions survive', async () => {
  await ingest.submit(
    observation(1, {
      identity: 'old',
      checkpoint: { scope: 'messages', incarnation: 'old', position: 1 },
    }),
  )
  await ingest.submit(
    observation(2, {
      checkpoint: {
        scope: 'messages',
        incarnation: 'current',
        position: 2,
        resetIncarnation: true,
      },
    }),
  )
  await ingest.submit(observation(3))
  await ingest.submit(observation(5))
  await ingest.submit(observation(1, { identity: 'unpositioned', checkpoint: undefined }))
  await ingest.submit(observation(1, { identity: 'other-source', source: 'other' }))
  await ingest.submit(
    observation(1, {
      identity: 'other-scope',
      checkpoint: { scope: 'other', incarnation: 'current', position: 1 },
    }),
  )
  const before = db.sqlite.prepare('SELECT * FROM ingest_keys ORDER BY identity').all()
  expect(retireIngestKeys(db, { keepPositions: 2 })).toEqual({ retired: 2, floors: 1 })
  expect(db.sqlite.prepare('SELECT * FROM ingest_keys ORDER BY identity').all()).toEqual(
    before.filter((row) => row.identity !== 'event:2' && row.identity !== 'event:3'),
  )
  expect(
    await ingest.submit(
      observation(2, {
        identity: 'new-incarnation',
        checkpoint: { scope: 'messages', incarnation: 'next', position: 2, resetIncarnation: true },
      }),
    ),
  ).toEqual({ status: 'applied', seqs: [8] })
})

test('a scope idle for 30 days retires every key through its final position and keeps rejecting them', async () => {
  for (let position = 1; position <= 5; position++)
    await ingest.submit(
      observation(position, { checkpoint: { scope: 'messages', incarnation: null, position } }),
    )
  expect(retireIngestKeys(db, { now: Date.now() })).toEqual({ retired: 0, floors: 0 })
  const later = Date.now() + 31 * 24 * 60 * 60 * 1000
  expect(retireIngestKeys(db, { now: later })).toEqual({ retired: 5, floors: 1 })
  expect(floors()[0]?.floor).toBe(5)
  expect(keys()).toHaveLength(0)
})

test('the floor is written before any delete, then ten deletes use bounded batches', async () => {
  await seed(10)
  const transaction = db.tx.bind(db)
  const deleted: number[] = []
  vi.spyOn(db, 'tx').mockImplementation((fn) => {
    const before = keys().length
    const result = transaction(fn)
    const count = before - keys().length
    // Any transaction that deletes keys must find the floor already in place.
    if (count > 0) expect(floors()[0]?.floor).toBe(10)
    deleted.push(count)
    return result
  })
  expect(retireIngestKeys(db, { keepPositions: 0, batchSize: 3 })).toEqual({
    retired: 10,
    floors: 1,
  })
  expect(deleted.filter((count) => count > 0)).toEqual([3, 3, 3, 1])
  expect(floors()[0]?.floor).toBe(10)
})

test('an interrupted batch never opens a duplicate window, and rerunning completes cleanup', async () => {
  await seed(10)
  const transaction = db.tx.bind(db)
  let batches = 0
  const spy = vi.spyOn(db, 'tx').mockImplementation((fn) =>
    transaction((sqlite) => {
      const before = keys().length
      const result = fn(sqlite)
      if (keys().length < before && ++batches === 2) throw new Error('interrupted batch')
      return result
    }),
  )
  expect(() => retireIngestKeys(db, { keepPositions: 0, batchSize: 3 })).toThrow(
    'interrupted batch',
  )
  expect(keys()).toHaveLength(7)
  // The floor was committed first, so retired positions stay duplicates mid-retirement.
  expect(floors()[0]?.floor).toBe(10)
  expect(db.sqlite.isTransaction).toBe(false)
  spy.mockRestore()
  expect(await ingest.submit(observation(2, { identity: 'redelivered-2' }))).toEqual({
    status: 'duplicate',
  })
  await ingest.close()
  db.close()
  db = openDatabase(join(dir, 'score.db'))
  ingest = createIngest(db)
  expect(retireIngestKeys(db, { keepPositions: 0, batchSize: 3 })).toEqual({
    retired: 7,
    floors: 0,
  })
  expect(keys()).toEqual([])
  expect(floors()[0]?.floor).toBe(10)
  expect(retireIngestKeys(db, { keepPositions: 0, batchSize: 3 })).toEqual({
    retired: 0,
    floors: 0,
  })
})

test('the earliest failure hold lowers the target and remains re-appliable', async () => {
  await seed(4)
  await ingest.submit(observation(20))
  for (const position of [8, 5]) {
    await expect(
      ingest.submit(
        observation(position, {
          apply: () => {
            throw new Error('failed')
          },
        }),
      ),
    ).rejects.toThrow('failed')
  }
  const held = ingest.heldPositions('score', 'messages')
  expect(held).toEqual([8, 5])
  held.length = 0
  expect(ingest.heldPositions('score', 'messages')).toEqual([8, 5])
  expect(ingest.heldPositions('other', 'messages')).toEqual([])
  expect(ingest.heldPositions('score', 'other')).toEqual([])
  await ingest.submit(observation(21))
  expect(db.sqlite.prepare('SELECT cursor FROM ingest_checkpoints').get()).toEqual({ cursor: '20' })
  expect(retireIngestKeys(db, { keepPositions: 0 })).toEqual({ retired: 4, floors: 1 })
  expect(floors()[0]?.floor).toBe(4)
  expect(await ingest.submit(observation(5))).toEqual({ status: 'applied', seqs: [7] })
  expect(ingest.heldPositions('score', 'messages')).toEqual([8])
  ingest.releaseHold('score', 'messages')
  expect(ingest.heldPositions('score', 'messages')).toEqual([])
})

test('a hold at zero prevents retirement entirely', async () => {
  await seed(2)
  await expect(
    ingest.submit(
      observation(0, {
        apply: () => {
          throw new Error('failed')
        },
      }),
    ),
  ).rejects.toThrow('failed')
  expect(retireIngestKeys(db, { keepPositions: 0 })).toEqual({ retired: 0, floors: 0 })
  expect(keys()).toHaveLength(2)
  expect(floors()).toEqual([])
})

test('a lower target never decreases an existing floor or updates its timestamp', async () => {
  await seed(10)
  expect(retireIngestKeys(db, { keepPositions: 2 })).toEqual({ retired: 8, floors: 1 })
  const before = floors()
  expect(retireIngestKeys(db, { keepPositions: 5 })).toEqual({ retired: 0, floors: 0 })
  expect(floors()).toEqual(before)
  expect(keys()).toHaveLength(2)
})

test('floor duplicates preserve checkpoint incarnation reset rules without applying or inserting a key', async () => {
  await seed(5)
  retireIngestKeys(db, { keepPositions: 0 })
  await ingest.submit(
    observation(1, {
      identity: 'next',
      checkpoint: { scope: 'messages', incarnation: 'next', position: 1, resetIncarnation: true },
    }),
  )
  const apply = vi.fn(observation(4).apply)
  await expect(ingest.submit(observation(4, { apply }))).rejects.toThrow(
    'Checkpoint incarnation change requires resetIncarnation',
  )
  expect(db.sqlite.prepare('SELECT cursor, incarnation FROM ingest_checkpoints').get()).toEqual({
    cursor: '1',
    incarnation: 'next',
  })
  expect(
    await ingest.submit(
      observation(4, {
        apply,
        checkpoint: {
          scope: 'messages',
          incarnation: 'current',
          position: 4,
          resetIncarnation: true,
        },
      }),
    ),
  ).toEqual({ status: 'duplicate' })
  expect(db.sqlite.prepare('SELECT cursor, incarnation FROM ingest_checkpoints').get()).toEqual({
    cursor: '4',
    incarnation: 'current',
  })
  expect(apply).not.toHaveBeenCalled()
  expect(keys()).toEqual([{ identity: 'next' }])
  expect(ingest.heldPositions('score', 'messages')).toEqual([])
})

test('default keepPositions is 10000 and batchSize is 5000', () => {
  db.tx((sqlite) => {
    sqlite
      .prepare('INSERT INTO ingest_checkpoints VALUES (?, ?, ?, ?, ?)')
      .run('score', 'messages', '15001', 'current', new Date().toISOString())
    const insert = sqlite.prepare(
      'INSERT INTO ingest_keys (source, identity, created_at, scope, incarnation, position) VALUES (?, ?, ?, ?, ?, ?)',
    )
    for (let position = 1; position <= 5002; position++)
      insert.run(
        'score',
        `event:${position}`,
        new Date().toISOString(),
        'messages',
        'current',
        position,
      )
  })
  const transaction = db.tx.bind(db)
  const deleted: number[] = []
  vi.spyOn(db, 'tx').mockImplementation((fn) => {
    const before = keys().length
    const result = transaction(fn)
    deleted.push(before - keys().length)
    return result
  })
  expect(retireIngestKeys(db)).toEqual({ retired: 5001, floors: 1 })
  expect(deleted.filter((count) => count > 0)).toEqual([5000, 1])
  expect(floors()[0]?.floor).toBe(5001)
  expect(keys()).toEqual([{ identity: 'event:5002' }])
})

test.each([
  { keepPositions: -1 },
  { keepPositions: 1.5 },
  { batchSize: 0 },
  { batchSize: -1 },
  { batchSize: 1.5 },
])('invalid retirement options %j reject before writing', (options) => {
  const transactions = vi.spyOn(db, 'tx')
  expect(() => retireIngestKeys(db, options)).toThrow()
  expect(transactions).not.toHaveBeenCalled()
})

test('migration 0002 preserves existing 0001 keys with NULL position metadata', async () => {
  await ingest.close()
  db.close()
  rmSync(join(dir, 'score.db'))
  const oldMigrations = join(dir, 'old-migrations')
  mkdirSync(oldMigrations)
  cpSync(join(migrationDir, '0001_infra.sql'), join(oldMigrations, '0001_infra.sql'))
  db = openDatabase(join(dir, 'score.db'))
  migrate(db, oldMigrations)
  const now = new Date().toISOString()
  db.sqlite.prepare('INSERT INTO ingest_keys VALUES (?, ?, ?, ?)').run('score', 'legacy', 1, now)
  db.sqlite
    .prepare('INSERT INTO ingest_checkpoints VALUES (?, ?, ?, ?, ?)')
    .run('score', 'messages', '20', 'current', now)
  migrate(db, migrationDir)
  ingest = createIngest(db)
  expect(db.sqlite.prepare('SELECT * FROM ingest_keys').get()).toEqual({
    source: 'score',
    identity: 'legacy',
    first_seq: 1,
    created_at: now,
    scope: null,
    incarnation: null,
    position: null,
  })
  expect(retireIngestKeys(db, { keepPositions: 0 })).toEqual({ retired: 0, floors: 1 })
  expect(keys()).toEqual([{ identity: 'legacy' }])
  expect(await ingest.submit(observation(25, { identity: 'legacy' }))).toEqual({
    status: 'duplicate',
  })
})

test('gate #13 internal random-identity sources retire after 24 hours while replayable sources retain dedupe', async () => {
  const { INTERNAL_OBSERVATION_SOURCES } = await import('../../src/hub/retire.ts')
  for (const source of [...INTERNAL_OBSERVATION_SOURCES, 'bridge:durable']) {
    await ingest.submit({ source, identity: 'old', apply: () => [] })
    await ingest.submit({ source, identity: 'recent', apply: () => [] })
  }
  const now = Date.now()
  db.sqlite
    .prepare("UPDATE ingest_keys SET created_at = ? WHERE identity = 'old'")
    .run(new Date(now - 24 * 60 * 60 * 1000).toISOString())
  db.sqlite
    .prepare(
      "INSERT INTO request_receipts (key, route, body_sha256, status, response, created_at) VALUES ('expired', '/route', 'hash', 200, '{}', ?)",
    )
    .run(new Date(now - 24 * 60 * 60 * 1000).toISOString())
  expect(retireIngestKeys(db, { now }).retired).toBe(INTERNAL_OBSERVATION_SOURCES.length)
  expect(db.sqlite.prepare("SELECT source FROM ingest_keys WHERE identity = 'old'").all()).toEqual([
    { source: 'bridge:durable' },
  ])
  expect(
    db.sqlite.prepare("SELECT count(*) AS n FROM ingest_keys WHERE identity = 'recent'").get()?.n,
  ).toBe(INTERNAL_OBSERVATION_SOURCES.length + 1)
  expect(db.sqlite.prepare('SELECT * FROM request_receipts').all()).toEqual([])
})

test('routine pause and refresh observations are retired with the other random-identity sources', async () => {
  const { INTERNAL_OBSERVATION_SOURCES } = await import('../../src/hub/retire.ts')
  expect(INTERNAL_OBSERVATION_SOURCES).toEqual(
    expect.arrayContaining(['agents', 'briefs', 'team', 'agent-pause', 'task-holds']),
  )
})
