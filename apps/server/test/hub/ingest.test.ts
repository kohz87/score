import { StreamEventSchema, type StreamEvent } from '@score/contract'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { migrate, openDatabase, type ScoreDb } from '../../src/db/index.ts'
import {
  createIngest,
  defineLifecycle,
  guardedUpsert,
  headSeq,
  snapshot,
  type DeepReadonly,
  type DomainEventDraft,
  type GuardedUpsertResult,
  type Observation,
} from '../../src/hub/index.ts'

const migrationDir = fileURLToPath(new URL('../../migrations/', import.meta.url))
const now = '2026-10-06T12:00:00.000Z'
const lifecycle = defineLifecycle({
  states: ['queued', 'running', 'completed', 'failed'],
  terminal: ['completed', 'failed'],
  order: ['queued', 'running', 'completed', 'failed'],
})
let dir: string
let db: ScoreDb
let ingest: ReturnType<typeof createIngest>
const connections: DatabaseSync[] = []
let expectListenerErrors: boolean
let listenerLog: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  expectListenerErrors = false
  listenerLog = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  dir = mkdtempSync(join(tmpdir(), 'score-ingest-'))
  db = openDatabase(join(dir, 'score.db'))
  migrate(db, migrationDir)
  db.sqlite.exec('CREATE TABLE test_runs (id TEXT PRIMARY KEY, state TEXT, updated_at TEXT) STRICT')
  ingest = createIngest(db, { clock: () => Date.parse(now) })
})

afterEach(async () => {
  await ingest.drain()
  await ingest.flushListeners()
  await ingest.close()
  if (!expectListenerErrors) expect(listenerLog).not.toHaveBeenCalled()
  for (const connection of connections.splice(0)) connection.close()
  db.close()
  rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

function draft(id: string): DomainEventDraft {
  return { type: 'message.completed', data: { messageId: id, roomId: 'room' } }
}

function observation(identity: string, overrides: Partial<Observation> = {}): Observation {
  return {
    source: 'score',
    identity,
    checkpoint: {
      scope: 'runs',
      position:
        Number(identity) ||
        ({ one: 1, two: 2, three: 3, four: 4, broken: 10 } as Record<string, number>)[identity] ||
        0,
      incarnation: 'incarnation-1',
    },
    apply({ sqlite, now }) {
      sqlite
        .prepare('INSERT INTO test_runs (id, state, updated_at) VALUES (?, ?, ?)')
        .run(identity, 'queued', now)
      return [draft(identity)]
    },
    ...overrides,
  }
}

function rows(table: string) {
  return db.read((sqlite) => sqlite.prepare(`SELECT * FROM ${table}`).all())
}

function persistedEvents(): StreamEvent[] {
  return db.read((sqlite) =>
    sqlite
      .prepare('SELECT seq, ts, type, data FROM events ORDER BY seq')
      .all()
      .map((row) =>
        StreamEventSchema.parse({
          ...row,
          data: JSON.parse(String(row.data)),
        }),
      ),
  )
}

function secondConnection(): DatabaseSync {
  const connection = new DatabaseSync(join(dir, 'score.db'))
  connections.push(connection)
  return connection
}

test('one transaction commits projection, validated envelopes, first seq and checkpoint', async () => {
  const apply = vi.fn((ctx: Parameters<Observation['apply']>[0]) => {
    expect(ctx.sqlite.isTransaction).toBe(true)
    expect(ctx.now).toBe(now)
    observation('one').apply(ctx)
    return [draft('one'), draft('two')]
  })
  expect(await ingest.submit(observation('one', { apply }))).toEqual({
    status: 'applied',
    seqs: [1, 2],
  })
  expect(apply).toHaveBeenCalledOnce()
  expect(rows('test_runs')).toEqual([{ id: 'one', state: 'queued', updated_at: now }])
  expect(persistedEvents()).toEqual([
    { ...draft('one'), seq: 1, ts: now },
    { ...draft('two'), seq: 2, ts: now },
  ])
  expect(rows('ingest_keys')).toEqual([
    {
      source: 'score',
      identity: 'one',
      first_seq: 1,
      created_at: now,
      scope: 'runs',
      incarnation: 'incarnation-1',
      position: 1,
    },
  ])
  expect(rows('ingest_checkpoints')).toEqual([
    {
      source: 'score',
      scope: 'runs',
      cursor: '1',
      incarnation: 'incarnation-1',
      updated_at: now,
    },
  ])
})

test('normalized event JSON matches live delivery and the parsed replay envelope', async () => {
  const delivered: DeepReadonly<StreamEvent>[] = []
  ingest.onCommitted((events) => {
    delivered.push(...events)
  })
  const event = {
    type: 'message.completed' as const,
    data: { messageId: 'one', roomId: 'room', extra: 'discard this field' },
  }
  await ingest.submit(observation('one', { apply: () => [event] }))
  const stored = rows('events')[0]
  expect(stored).toBeDefined()
  const data: unknown = JSON.parse(String(stored?.data))
  expect(data).toEqual({ messageId: 'one', roomId: 'room' })
  expect(data).not.toHaveProperty('extra')
  expect(data).toEqual(delivered[0]?.data)
  const replay = StreamEventSchema.parse({ ...stored, data })
  expect(replay).toEqual(delivered[0])
  expect(delivered).toEqual([{ seq: 1, ts: now, type: event.type, data }])
})

test('duplicates skip apply and fan-out but advance the checkpoint without changing the ingest key', async () => {
  const listener = vi.fn()
  ingest.onCommitted(listener)
  await ingest.submit(observation('one'))
  const before = rows('ingest_keys')
  const apply = vi.fn(() => {
    throw new Error('Duplicate must never apply')
  })
  expect(
    await ingest.submit(
      observation('one', {
        apply,
        checkpoint: { scope: 'runs', position: 2, incarnation: null, resetIncarnation: true },
      }),
    ),
  ).toEqual({ status: 'duplicate' })
  expect(apply).not.toHaveBeenCalled()
  expect(listener).toHaveBeenCalledOnce()
  expect(rows('test_runs')).toEqual([{ id: 'one', state: 'queued', updated_at: now }])
  expect(persistedEvents()).toHaveLength(1)
  expect(rows('ingest_keys')).toEqual(before)
  expect(rows('ingest_checkpoints')).toEqual([
    { source: 'score', scope: 'runs', cursor: '2', incarnation: null, updated_at: now },
  ])
})

test('dedupe is durable across ingest instances and source identities are independent', async () => {
  await ingest.submit(observation('one'))
  await ingest.close()
  ingest = createIngest(db)
  const restarted = ingest
  expect(await restarted.submit(observation('one'))).toEqual({ status: 'duplicate' })
  expect(
    await restarted.submit(observation('one', { source: 'kanban', apply: () => [draft('other')] })),
  ).toEqual({ status: 'applied', seqs: [2] })
  expect(rows('ingest_keys')).toHaveLength(2)
})

test('zero-event observations commit projection and checkpoint with a NULL first_seq and no fan-out', async () => {
  const listener = vi.fn()
  ingest.onCommitted(listener)
  expect(
    await ingest.submit(
      observation('one', {
        apply(ctx) {
          observation('one').apply(ctx)
          return []
        },
      }),
    ),
  ).toEqual({
    status: 'applied',
    seqs: [],
  })
  expect(rows('ingest_keys')).toEqual([
    {
      source: 'score',
      identity: 'one',
      first_seq: null,
      created_at: now,
      scope: 'runs',
      incarnation: 'incarnation-1',
      position: 1,
    },
  ])
  expect(rows('ingest_checkpoints')).toHaveLength(1)
  expect(persistedEvents()).toEqual([])
  expect(listener).not.toHaveBeenCalled()
  expect(await ingest.submit(observation('one'))).toEqual({ status: 'duplicate' })
  expect(rows('test_runs')).toEqual([{ id: 'one', state: 'queued', updated_at: now }])
})

test('checkpoint scopes and sources are independent, and omitting a checkpoint leaves them untouched', async () => {
  await ingest.submit(observation('one'))
  await ingest.submit(
    observation('two', { checkpoint: { scope: 'messages', position: 2, incarnation: null } }),
  )
  await ingest.submit(observation('three', { source: 'kanban' }))
  const checkpoints = rows('ingest_checkpoints')
  expect(checkpoints).toHaveLength(3)
  await ingest.submit(observation('four', { checkpoint: undefined }))
  expect(rows('ingest_checkpoints')).toEqual(checkpoints)
  await ingest.submit(observation('one', { checkpoint: undefined }))
  expect(rows('ingest_checkpoints')).toEqual(checkpoints)
})

test.each(['apply throws', 'invalid second event', 'async apply', 'invalid checkpoint write'])(
  '%s rolls back projection, every event, ingest key and checkpoint; a retry can apply',
  async (failure) => {
    const listener = vi.fn()
    ingest.onCommitted(listener)
    let obs = observation('broken', {
      apply(ctx) {
        observation('broken').apply(ctx)
        if (failure === 'apply throws') throw new Error('abort')
        if (failure === 'async apply') {
          // Exercise an untyped producer violating the synchronous API.
          return Promise.resolve([]) as unknown as DomainEventDraft[]
        }
        if (failure === 'invalid second event') {
          return [
            draft('valid'),
            { type: 'message.completed', data: { messageId: '', roomId: 'room' } },
          ]
        }
        ctx.sqlite.exec(`CREATE TRIGGER reject_checkpoint BEFORE INSERT ON ingest_checkpoints
          BEGIN SELECT RAISE(ABORT, 'checkpoint failed'); END`)
        return [draft('valid')]
      },
    })
    await expect(ingest.submit(obs)).rejects.toThrow()
    for (const table of ['test_runs', 'events', 'ingest_keys', 'ingest_checkpoints']) {
      expect(rows(table)).toEqual([])
    }
    expect(listener).not.toHaveBeenCalled()
    expect(db.sqlite.isTransaction).toBe(false)
    obs = observation('broken')
    expect(await ingest.submit(obs)).toEqual({ status: 'applied', seqs: [1] })
  },
)

test('failed projection update preserves existing projection and checkpoint', async () => {
  await ingest.submit(observation('one'))
  const before = {
    projection: rows('test_runs'),
    events: rows('events'),
    keys: rows('ingest_keys'),
    checkpoints: rows('ingest_checkpoints'),
  }
  await expect(
    ingest.submit(
      observation('two', {
        apply({ sqlite }) {
          sqlite.exec("UPDATE test_runs SET state = 'completed'")
          throw new Error('abort update')
        },
      }),
    ),
  ).rejects.toThrow('abort update')
  expect(rows('test_runs')).toEqual(before.projection)
  expect(rows('events')).toEqual(before.events)
  expect(rows('ingest_keys')).toEqual(before.keys)
  expect(rows('ingest_checkpoints')).toEqual(before.checkpoints)
})

test('queued submissions stay FIFO across rejection', async () => {
  const order: string[] = []
  ingest.onCommitted((events) => {
    order.push(`commit:${events[0]?.seq}`)
  })
  const submissions = ['one', 'broken', 'two', 'three'].map((id) =>
    ingest.submit(
      observation(id, {
        apply(ctx) {
          order.push(id)
          if (id === 'broken') throw new Error('abort')
          return observation(id).apply(ctx)
        },
      }),
    ),
  )
  const settled = Promise.allSettled(submissions)
  expect(order).toEqual([])
  await ingest.drain()
  expect(order).toEqual(['one', 'commit:1', 'broken', 'two', 'commit:2', 'three', 'commit:3'])
  expect((await settled).map((result) => result.status)).toEqual([
    'fulfilled',
    'rejected',
    'fulfilled',
    'fulfilled',
  ])
  expect(rows('test_runs').map((row) => row.id)).toEqual(['one', 'two', 'three'])
})

test('listeners see committed envelopes in sequence order through a separate connection', async () => {
  const reader = secondConnection()
  const captured: unknown[] = []
  const listener = vi.fn((events: DeepReadonly<StreamEvent[]>) => {
    captured.push({
      inTransaction: db.sqlite.isTransaction,
      projections: reader.prepare('SELECT id FROM test_runs').all(),
      seqs: reader.prepare('SELECT seq FROM events ORDER BY seq').all(),
      key: reader.prepare('SELECT first_seq FROM ingest_keys').get(),
      checkpoint: reader.prepare('SELECT cursor FROM ingest_checkpoints').get(),
      events,
    })
  })
  ingest.onCommitted(listener)
  await ingest.submit(
    observation('one', {
      apply(ctx) {
        observation('one').apply(ctx)
        return [draft('one'), draft('two')]
      },
    }),
  )
  await ingest.flushListeners()
  expect(listener).toHaveBeenCalledOnce()
  expect(captured).toEqual([
    {
      inTransaction: false,
      projections: [{ id: 'one' }],
      seqs: [{ seq: 1 }, { seq: 2 }],
      key: { first_seq: 1 },
      checkpoint: { cursor: '1' },
      events: persistedEvents(),
    },
  ])
  expect(listenerLog).not.toHaveBeenCalled()
})

test('throwing listeners are logged, other listeners run, and unsubscribing stops delivery', async () => {
  expectListenerErrors = true
  const log = listenerLog
  const failure = new Error('listener failed')
  const unsubscribe = ingest.onCommitted(() => {
    throw failure
  })
  const listener = vi.fn()
  ingest.onCommitted(listener)
  expect(await ingest.submit(observation('one'))).toEqual({ status: 'applied', seqs: [1] })
  await ingest.flushListeners()
  expect(log).toHaveBeenCalledExactlyOnceWith('Ingest committed listener failed', failure)
  expect(listener).toHaveBeenCalledOnce()
  unsubscribe()
  unsubscribe()
  await ingest.submit(observation('two'))
  await ingest.flushListeners()
  expect(log).toHaveBeenCalledOnce()
  expect(listener).toHaveBeenCalledTimes(2)
})

test('async listener failures are logged and pending listeners do not block the writer', async () => {
  expectListenerErrors = true
  const log = listenerLog
  const failure = new Error('async listener failed')
  ingest.onCommitted(async () => {
    throw failure
  })
  const { promise, resolve } = Promise.withResolvers<void>()
  ingest.onCommitted(() => promise)
  const listener = vi.fn()
  ingest.onCommitted(listener)
  const submitted = Promise.all([
    ingest.submit(observation('one')),
    ingest.submit(observation('two')),
  ])
  await ingest.drain()
  expect(await submitted).toEqual([
    { status: 'applied', seqs: [1] },
    { status: 'applied', seqs: [2] },
  ])
  resolve()
  await ingest.flushListeners()
  expect(log).toHaveBeenCalledTimes(2)
  expect(log).toHaveBeenCalledWith('Ingest committed listener failed', failure)
  expect(listener).toHaveBeenCalledTimes(2)
  resolve()
})

test('reentrant listener submissions stay behind already queued observations and drain waits for them', async () => {
  const results: Promise<unknown>[] = []
  ingest.onCommitted((events) => {
    if (events[0]?.seq === 1) results.push(ingest.submit(observation('three')))
  })
  results.push(ingest.submit(observation('one')), ingest.submit(observation('two')))
  await ingest.drain()
  await Promise.all(results)
  expect(rows('test_runs').map((row) => row.id)).toEqual(['one', 'two', 'three'])
  expect(persistedEvents().map((event) => event.seq)).toEqual([1, 2, 3])
})

test('delayed observations cannot regress projections or emit misleading events, but advance checkpoints', async () => {
  const outcomes: GuardedUpsertResult[] = []
  for (const [index, state] of [
    'queued',
    'running',
    'queued',
    'completed',
    'running',
    'failed',
    'completed',
  ].entries()) {
    await ingest.submit(
      observation(String(index), {
        apply({ sqlite }) {
          const result = guardedUpsert(sqlite, {
            table: 'test_runs',
            key: { id: 'run' },
            stateColumn: 'state',
            lifecycle,
            values: { state, updated_at: String(index) },
          })
          outcomes.push(result)
          return result === 'applied' ? [draft(String(index))] : []
        },
      }),
    )
  }
  expect(outcomes).toEqual([
    'applied',
    'applied',
    'ignored_regression',
    'applied',
    'ignored_terminal',
    'ignored_terminal',
    'ignored_terminal',
  ])
  expect(rows('test_runs')).toEqual([{ id: 'run', state: 'completed', updated_at: '3' }])
  expect(persistedEvents().map((event) => event.data)).toEqual(
    ['0', '1', '3'].map((id) => draft(id).data),
  )
  expect(rows('ingest_keys')).toHaveLength(7)
  expect(rows('ingest_checkpoints')[0]?.cursor).toBe('6')
})

test('snapshot holds projection and head in one WAL read while another connection commits both', async () => {
  await ingest.submit(observation('one'))
  const writer = secondConnection()
  const read = snapshot(db, (sqlite) => {
    expect(sqlite.isTransaction).toBe(true)
    const before = sqlite.prepare('SELECT id FROM test_runs ORDER BY id').all()
    writer.exec('BEGIN IMMEDIATE')
    writer.prepare('INSERT INTO test_runs VALUES (?, ?, ?)').run('two', 'queued', now)
    writer
      .prepare('INSERT INTO events (ts, type, data) VALUES (?, ?, ?)')
      .run(now, 'message.completed', JSON.stringify(draft('two').data))
    writer.exec('COMMIT')
    expect(sqlite.prepare('SELECT id FROM test_runs ORDER BY id').all()).toEqual(before)
    expect(headSeq(sqlite)).toBe(1)
    return before
  })
  expect(read).toEqual({ asOfSeq: 1, data: [{ id: 'one' }] })
  expect(
    snapshot(db, (sqlite) => sqlite.prepare('SELECT id FROM test_runs ORDER BY id').all()),
  ).toEqual({
    asOfSeq: 2,
    data: [{ id: 'one' }, { id: 'two' }],
  })
})

test('snapshot establishes its read before calling a reader that triggers a concurrent commit', async () => {
  await ingest.submit(observation('one'))
  const writer = secondConnection()
  expect(
    snapshot(db, (sqlite) => {
      writer.exec('DELETE FROM test_runs')
      return sqlite.prepare('SELECT id FROM test_runs').all()
    }),
  ).toEqual({ asOfSeq: 1, data: [{ id: 'one' }] })
})

test('head is zero initially, survives pruning, and subsequent events keep increasing', async () => {
  expect(headSeq(db.sqlite)).toBe(0)
  expect(snapshot(db, () => [])).toEqual({ asOfSeq: 0, data: [] })
  await ingest.submit(observation('one'))
  await ingest.submit(observation('two'))
  db.tx((sqlite) => sqlite.exec('DELETE FROM events'))
  expect(headSeq(db.sqlite)).toBe(2)
  expect(snapshot(db, (sqlite) => sqlite.prepare('SELECT * FROM events').all())).toEqual({
    asOfSeq: 2,
    data: [],
  })
  expect(await ingest.submit(observation('three'))).toEqual({ status: 'applied', seqs: [3] })
})

test('snapshot errors and async readers release the transaction', () => {
  expect(() =>
    snapshot(db, () => {
      throw new Error('read failed')
    }),
  ).toThrow('read failed')
  expect(db.sqlite.isTransaction).toBe(false)
  expect(() => snapshot(db, () => Promise.resolve([]))).toThrow('must be synchronous')
  expect(db.sqlite.isTransaction).toBe(false)
  expect(snapshot(db, () => 'ok')).toEqual({ asOfSeq: 0, data: 'ok' })
})

test.each([
  { source: '' },
  { identity: '' },
  { checkpoint: { scope: '', position: 1, incarnation: null } },
])('invalid metadata %j rejects without writes and does not wedge the writer', async (metadata) => {
  await expect(ingest.submit(observation('one', metadata))).rejects.toThrow()
  expect(rows('ingest_keys')).toEqual([])
  expect(rows('test_runs')).toEqual([])
  expect(await ingest.submit(observation('two'))).toEqual({ status: 'applied', seqs: [1] })
})

test('1,000 sequential observations preserve strict seq order within a few seconds', async () => {
  const started = performance.now()
  for (let index = 1; index <= 1000; index++) {
    expect(await ingest.submit(observation(String(index)))).toEqual({
      status: 'applied',
      seqs: [index],
    })
  }
  expect(persistedEvents().map((event) => event.seq)).toEqual(
    Array.from({ length: 1000 }, (_, index) => index + 1),
  )
  expect(rows('test_runs')).toHaveLength(1000)
  expect(performance.now() - started).toBeLessThan(3000)
})

test('only one ingest owns a ScoreDb until close drains and releases it', async () => {
  expect(() => createIngest(db)).toThrow('already has an open ingest')
  const submitted = ingest.submit(observation('one'))
  const closed = ingest.close()
  expect(ingest.close()).toBe(closed)
  expect(() => createIngest(db)).toThrow('already has an open ingest')
  await expect(ingest.submit(observation('two'))).rejects.toThrow('closed')
  expect(() => ingest.onCommitted(() => {})).toThrow('closed')
  await closed
  expect(await submitted).toEqual({ status: 'applied', seqs: [1] })
  ingest = createIngest(db)
  expect(await ingest.submit(observation('two'))).toEqual({ status: 'applied', seqs: [2] })
})

test.each(['seq', 'data', 'batch'] as const)(
  'a listener mutating %s throws without altering later delivery, storage or the result',
  async (target) => {
    expectListenerErrors = true
    ingest.onCommitted((batch) => {
      if (target === 'seq') {
        // @ts-expect-error Deliberately violate the deeply readonly subscriber API.
        batch[0]!.seq = 99
      } else if (target === 'data' && batch[0]?.type === 'message.completed') {
        // @ts-expect-error Deliberately mutate a nested, frozen payload.
        batch[0].data.messageId = 'mutated'
      } else {
        // @ts-expect-error Deliberately mutate the frozen batch array.
        batch.length = 0
      }
    })
    const captured: DeepReadonly<StreamEvent[]>[] = []
    ingest.onCommitted((batch) => {
      captured.push(batch)
    })
    const result = await ingest.submit(observation('one'))
    await ingest.flushListeners()
    expect(result).toEqual({ status: 'applied', seqs: [1] })
    expect(captured).toEqual([persistedEvents()])
    expect(captured[0]?.[0]?.seq).toBe(1)
    expect(captured[0]?.[0]?.data).toEqual(draft('one').data)
    expect(Object.isFrozen(captured[0])).toBe(true)
    expect(Object.isFrozen(captured[0]?.[0])).toBe(true)
    expect(Object.isFrozen(captured[0]?.[0]?.data)).toBe(true)
    expect(listenerLog).toHaveBeenCalledExactlyOnceWith(
      'Ingest committed listener failed',
      expect.any(TypeError),
    )
  },
)

test('each async listener delivers batches in order while the writer and other listeners continue', async () => {
  const gate = Promise.withResolvers<void>()
  const started: number[] = []
  const delivered: number[] = []
  const fast: number[] = []
  ingest.onCommitted(async (batch) => {
    const seq = batch[0]!.seq
    started.push(seq)
    if (seq === 1) await gate.promise
    delivered.push(seq)
  })
  ingest.onCommitted((batch) => {
    fast.push(batch[0]!.seq)
  })
  try {
    await Promise.all([ingest.submit(observation('one')), ingest.submit(observation('two'))])
    await ingest.drain()
    expect(headSeq(db.sqlite)).toBe(2)
    expect(started).toEqual([1])
    expect(delivered).toEqual([])
    expect(fast).toEqual([1, 2])
    let flushed = false
    const flush = ingest.flushListeners().then(() => {
      flushed = true
    })
    await Promise.resolve()
    expect(flushed).toBe(false)
    gate.resolve()
    await flush
    expect(started).toEqual([1, 2])
    expect(delivered).toEqual([1, 2])
    expect(listenerLog).not.toHaveBeenCalled()
  } finally {
    gate.resolve()
  }
})

function cursor(scope = 'runs', source = 'score') {
  return db.sqlite
    .prepare('SELECT cursor, incarnation FROM ingest_checkpoints WHERE source = ? AND scope = ?')
    .get(source, scope)
}

test('checkpoint positions never regress on delayed duplicate or lower observations', async () => {
  await ingest.submit(observation('10'))
  await ingest.submit(observation('20'))
  const before = rows('ingest_checkpoints')
  expect(await ingest.submit(observation('10'))).toEqual({ status: 'duplicate' })
  await ingest.submit(observation('15'))
  expect(rows('ingest_checkpoints')).toEqual(before)
  expect(cursor()).toEqual({ cursor: '20', incarnation: 'incarnation-1' })
})

test.each(['retry', 'release'] as const)(
  'a failed checkpoint holds later progress until %s, with other scopes and sources unaffected',
  async (resolution) => {
    await ingest.submit(observation('9'))
    await expect(
      ingest.submit(
        observation('10', {
          apply(ctx) {
            observation('10').apply(ctx)
            throw new Error('failed ten')
          },
        }),
      ),
    ).rejects.toThrow('failed ten')
    expect(await ingest.submit(observation('11'))).toEqual({ status: 'applied', seqs: [2] })
    expect(cursor()).toEqual({ cursor: '9', incarnation: 'incarnation-1' })
    expect(rows('test_runs').map((row) => row.id)).toEqual(['9', '11'])
    await ingest.submit(
      observation('other-scope', {
        checkpoint: { scope: 'messages', position: 50, incarnation: null },
      }),
    )
    await ingest.submit(
      observation('other-source', {
        source: 'kanban',
        checkpoint: { scope: 'runs', position: 60, incarnation: null },
      }),
    )
    expect(cursor('messages')).toEqual({ cursor: '50', incarnation: null })
    expect(cursor('runs', 'kanban')).toEqual({ cursor: '60', incarnation: null })
    if (resolution === 'retry') {
      await ingest.submit(observation('10'))
      expect(cursor()?.cursor).toBe('10')
    } else {
      ingest.releaseHold('score', 'runs')
    }
    expect(await ingest.submit(observation('11'))).toEqual({ status: 'duplicate' })
    expect(cursor()?.cursor).toBe('11')
    expect(
      rows('test_runs')
        .map((row) => row.id)
        .filter((id) => id === '10'),
    ).toHaveLength(resolution === 'retry' ? 1 : 0)
  },
)

test('multiple failed positions retain the earliest barrier until each retry commits', async () => {
  await ingest.submit(observation('1'))
  for (const position of ['10', '12']) {
    await expect(
      ingest.submit(
        observation(position, {
          apply() {
            throw new Error('failed')
          },
        }),
      ),
    ).rejects.toThrow('failed')
  }
  await ingest.submit(observation('13'))
  expect(cursor()?.cursor).toBe('1')
  await ingest.submit(observation('12'))
  expect(cursor()?.cursor).toBe('1')
  await ingest.submit(observation('10'))
  expect(cursor()?.cursor).toBe('10')
  await ingest.submit(observation('13'))
  expect(cursor()?.cursor).toBe('13')
})

test.each([null, 'new-incarnation'])(
  'incarnation reset to %s requires explicit authorization and rolls back on mismatch',
  async (incarnation) => {
    await ingest.submit(observation('20'))
    const checkpoint = { scope: 'runs', position: 1, incarnation }
    await expect(ingest.submit(observation('reset', { checkpoint }))).rejects.toThrow(
      'requires resetIncarnation',
    )
    expect(rows('test_runs').map((row) => row.id)).toEqual(['20'])
    expect(rows('events')).toHaveLength(1)
    expect(rows('ingest_keys')).toHaveLength(1)
    expect(cursor()?.cursor).toBe('20')
    await ingest.submit(
      observation('reset', { checkpoint: { ...checkpoint, resetIncarnation: true } }),
    )
    expect(cursor()).toEqual({ cursor: '1', incarnation })
  },
)

test('a null incarnation cannot switch to a string without reset', async () => {
  await ingest.submit(
    observation('one', { checkpoint: { scope: 'runs', position: 1, incarnation: null } }),
  )
  await expect(ingest.submit(observation('two'))).rejects.toThrow('requires resetIncarnation')
  expect(cursor()).toEqual({ cursor: '1', incarnation: null })
})

test('a hold with no stored checkpoint leaves it absent until the failed observation succeeds', async () => {
  await expect(
    ingest.submit(
      observation('10', {
        apply() {
          throw new Error('failed')
        },
      }),
    ),
  ).rejects.toThrow()
  await ingest.submit(observation('11'))
  expect(cursor()).toBeUndefined()
  await ingest.submit(observation('10'))
  expect(cursor()?.cursor).toBe('10')
})

test('holds are in-memory and restart resumes from the durable checkpoint', async () => {
  await ingest.submit(observation('9'))
  await expect(
    ingest.submit(
      observation('10', {
        apply() {
          throw new Error('failed')
        },
      }),
    ),
  ).rejects.toThrow()
  await ingest.submit(observation('11'))
  await ingest.close()
  expect(cursor()?.cursor).toBe('9')
  ingest = createIngest(db)
  await ingest.submit(observation('10'))
  expect(cursor()?.cursor).toBe('10')
})

test.each(['AsyncFunction', 'AsyncGeneratorFunction'] as const)(
  'native %s apply is rejected before invocation',
  async (kind) => {
    let invoked = false
    const callback =
      kind === 'AsyncFunction'
        ? async ({ sqlite }: Parameters<Observation['apply']>[0]) => {
            invoked = true
            sqlite.exec("INSERT INTO test_runs VALUES ('late', 'queued', '')")
            return []
          }
        : async function* ({ sqlite }: Parameters<Observation['apply']>[0]) {
            invoked = true
            sqlite.exec("INSERT INTO test_runs VALUES ('late', 'queued', '')")
            yield draft('one')
          }
    await expect(
      ingest.submit(observation('one', { apply: callback as unknown as Observation['apply'] })),
    ).rejects.toThrow('must be synchronous')
    expect(invoked).toBe(false)
    expect(rows('test_runs')).toEqual([])
    expect(rows('events')).toEqual([])
    expect(rows('ingest_keys')).toEqual([])
  },
)

test('unexpected async continuation cannot write after rollback through connection, cached method or statement', async () => {
  const gate = Promise.withResolvers<void>()
  const errors: unknown[] = []
  let continuation: Promise<void> | undefined
  await expect(
    ingest.submit(
      observation('one', {
        apply({ sqlite }) {
          sqlite.exec("INSERT INTO test_runs VALUES ('before', 'queued', '')")
          const cachedExec = sqlite.exec
          const statement = sqlite.prepare("INSERT INTO test_runs VALUES ('after', 'queued', '')")
          const cachedRun = statement.run
          continuation = (async () => {
            await gate.promise
            for (const write of [
              () => sqlite.exec("INSERT INTO test_runs VALUES ('late', 'queued', '')"),
              () => cachedExec("INSERT INTO test_runs VALUES ('cached', 'queued', '')"),
              () => statement.run(),
              () => cachedRun(),
            ]) {
              try {
                write()
              } catch (error) {
                errors.push(error)
              }
            }
          })()
          return continuation as unknown as DomainEventDraft[]
        },
      }),
    ),
  ).rejects.toThrow('must be synchronous')
  gate.resolve()
  await continuation
  expect(errors).toHaveLength(4)
  for (const error of errors) expect(error).toBeInstanceOf(Error)
  for (const table of ['test_runs', 'events', 'ingest_keys', 'ingest_checkpoints'])
    expect(rows(table)).toEqual([])
})

test('escaped transaction access expires after a successful commit too', async () => {
  let escaped: DatabaseSync | undefined
  await ingest.submit(
    observation('one', {
      apply(ctx) {
        escaped = ctx.sqlite
        return observation('one').apply(ctx)
      },
    }),
  )
  expect(() => escaped!.exec('DELETE FROM test_runs')).toThrow()
  expect(rows('test_runs')).toHaveLength(1)
})

test('transaction acquisition failure holds checkpoints just like an apply failure', async () => {
  await ingest.submit(observation('9'))
  vi.spyOn(db, 'tx').mockImplementationOnce(() => {
    throw new Error('database busy')
  })
  await expect(ingest.submit(observation('10'))).rejects.toThrow('database busy')
  await ingest.submit(observation('11'))
  expect(cursor()?.cursor).toBe('9')
  await ingest.submit(observation('10'))
  await ingest.submit(observation('11'))
  expect(cursor()?.cursor).toBe('11')
})

test('checkpoint holds also cover metadata failures with a valid source and position', async () => {
  await ingest.submit(observation('9'))
  await expect(ingest.submit(observation('10', { identity: '' }))).rejects.toThrow()
  await ingest.submit(observation('11'))
  expect(cursor()?.cursor).toBe('9')
  await ingest.submit(observation('10'))
  expect(cursor()?.cursor).toBe('10')
})

test('observation metadata is captured at submission and cannot redirect its checkpoint or ingest key', async () => {
  const obs = observation('one')
  const submitted = ingest.submit(obs)
  obs.identity = 'different'
  obs.checkpoint!.position = 50
  obs.checkpoint!.scope = 'other'
  await submitted
  expect(rows('ingest_keys')[0]?.identity).toBe('one')
  expect(cursor()?.cursor).toBe('1')
  expect(cursor('other')).toBeUndefined()
})

test('escaped SQLite write iterators expire with their transaction', async () => {
  let iterator: NodeJS.Iterator<Record<string, import('node:sqlite').SQLOutputValue>> | undefined
  await ingest.submit(
    observation('one', {
      apply({ sqlite }) {
        iterator = sqlite
          .prepare("INSERT INTO test_runs VALUES ('late', 'queued', '') RETURNING id")
          .iterate()
        return []
      },
    }),
  )
  expect(() => iterator!.next()).toThrow()
  expect(rows('test_runs')).toEqual([])
})

test('unexpected promise rejections are handled when a late write throws', async () => {
  const gate = Promise.withResolvers<void>()
  let late: Promise<void> | undefined
  await expect(
    ingest.submit(
      observation('one', {
        apply({ sqlite }) {
          late = (async () => {
            await gate.promise
            sqlite.exec("INSERT INTO test_runs VALUES ('late', 'queued', '')")
          })()
          return late as unknown as DomainEventDraft[]
        },
      }),
    ),
  ).rejects.toThrow('must be synchronous')
  gate.resolve()
  await expect(late).rejects.toThrow()
  expect(rows('test_runs')).toEqual([])
})

test('old unsubscribe handles do not remove a later registration of the same callback', async () => {
  const listener = vi.fn()
  const unsubscribe = ingest.onCommitted(listener)
  unsubscribe()
  ingest.onCommitted(listener)
  unsubscribe()
  await ingest.submit(observation('one'))
  await ingest.flushListeners()
  expect(listener).toHaveBeenCalledOnce()
})

test('SCORE-033: close waits for a committed listener held at an await', async () => {
  let release!: () => void
  const held = new Promise<void>((resolve) => (release = resolve))
  const log: string[] = []
  let entered!: () => void
  const inside = new Promise<void>((resolve) => (entered = resolve))
  ingest.onCommitted(async () => {
    entered()
    await held
    log.push('listener done')
  })
  await ingest.submit(observation('one'))
  await inside
  const closed = ingest.close().then(() => log.push('closed'))
  for (let turn = 0; turn < 5; turn++) await new Promise((resolve) => setImmediate(resolve))
  expect(log).toEqual([])
  release()
  await closed
  expect(log).toEqual(['listener done', 'closed'])
})
